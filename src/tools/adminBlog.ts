import { z } from "zod";
import { storeField, type ToolSpec } from "../register.js";
import { payloadFileField, previewValue, withPayloadFile } from "../admin/payloadFile.js";
import {
  COMPACT_NOTE,
  appendDescription,
  assertNoSpliceConflict,
  compactPreview,
  compactVerified,
  prependDescription,
  splice,
  verboseField,
  wasCompacted,
} from "../admin/changes.js";
import {
  PLACEHOLDER_GUARD_DOC,
  allowPlaceholderLossField,
  assertPlaceholdersKept,
  placeholderOverrideNote,
  placeholderPreviewNote,
  scanPlaceholderLoss,
} from "../admin/placeholders.js";
import { fieldValue, LANG_INDEX, type MultipartFile, type ParsedForm } from "../admin/form.js";
import type { EditTarget } from "../admin/session.js";
import { articleInRubric, resolveBlogNode } from "../admin/newsTree.js";

/**
 * Blog / news articles (handler 172, table h_news) as named create/update tools.
 *
 * Contract (reverse-engineered live on a test store):
 * an article is a self-standing record edited by
 *   `edit.php?id=<id>&handler=172&handlertable=h_news&showPages`
 * (create: `id=addnew&parent=<blogNodeId>`) whose <form name=editDoc> posts to
 * `save.php` as multipart. Every field lives under `names[...]`:
 *   - text/SEO, per language index L (ru=1, ua=3):
 *       names[i18n][L][title|announce|text|h1_title|seo_title|seo_keywords|seo_description]
 *   - names[date], names[name][slug]
 *   - names[act] (publish), names[promo], names[disallow_comments]
 *   - cover image  : names[cover][file]  (+ hidden [id]/[value])
 *   - inline image : names[img][file]    (+ hidden [id]/[value])
 *
 * COVER MECHANISM — proven, no "cloud_upload" involved. The task premise was that
 * the cover needed a separate `lookup.php load=cloud_upload` AJAX. That mechanism
 * does not exist (the string "cloud_upload" in the import-images Vue bundle is a
 * Quasar Material *icon name*, not an endpoint). The only real "cloud upload" is
 * the bulk catalog-image pipeline (aws-api.horoshop.ua/upload_images/upload-image,
 * Bearer cloudToken + a per-image awsKey issued by /api/import-images/check that
 * matches a FILENAME to a product SKU, then an assign step) — a product-gallery
 * importer, not a generic uploader, and the wrong tool for a blog cover.
 *
 * The blog cover is a plain `<input type=file name="names[cover][file]">` inside
 * the same editDoc form, exactly like a logo or a category cover. Sending its real
 * bytes as a multipart part to save.php PERSISTS: verified live — names[cover][value]
 * went from "" to a `/content/…jpg` path, the file was a real image on the CDN
 * (HTTP 200, image/*), and it rendered on the storefront `/blog/<id>/` page. So the
 * cover is uploaded through the very same `AdminClient.save(store, form, {}, files)`
 * path that the logo/category-cover uploader already uses — additive, save()
 * unchanged.
 */

/** handler / table for blog articles. Same across stores; record ids are per-store. */
const NEWS_HANDLER = 172;
const NEWS_TABLE = "h_news";
/**
 * Fallback «Блог» listing node id, used only when the node cannot be discovered by
 * title from the page tree (resolveBlogNode). On the test store the blog node is 1001, but
 * this id is PER-STORE — on other stores 1001 may be a different section entirely,
 * which is exactly why a new post used to land in the wrong rubric. The default
 * rubric is now resolved by title; this constant is just the last resort.
 */
const DEFAULT_BLOG_PARENT = 1001;

const LANGS = ["ua", "ru"] as const;
type Lang = (typeof LANGS)[number];

/** Human field key → the raw `names[i18n][L][<raw>]` sub-field name. */
const I18N_FIELDS = {
  title: "title",
  announce: "announce",
  text: "text",
  h1: "h1_title",
  seoTitle: "seo_title",
  seoKeywords: "seo_keywords",
  seoDescription: "seo_description",
} as const;
type I18nKey = keyof typeof I18N_FIELDS;
const I18N_KEYS = Object.keys(I18N_FIELDS) as I18nKey[];

/** A per-language content block (all optional). */
const langShape = () => {
  const s: Record<string, z.ZodTypeAny> = {};
  for (const k of I18N_KEYS) s[k] = z.string().optional();
  return s;
};

/** Image source: a URL to fetch server-side, base64 bytes, or a data: URI in either. */
const imageShape = z
  .object({
    url: z.string().optional().describe("Image URL fetched server-side (or a data: URI)."),
    base64: z.string().optional().describe("Image bytes as base64 (or a data: URI)."),
    filename: z.string().optional().describe("Override the sent filename."),
    contentType: z.string().optional().describe("Override the sent MIME type."),
  })
  .optional();

const MAX_BYTES = 20 * 1024 * 1024;
const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
};

function sniffMime(b: Uint8Array): string | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45)
    return "image/webp";
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return "image/bmp";
  return null;
}

function parseDataUri(s: string): { mime: string; bytes: Uint8Array } | null {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(s);
  if (!m) return null;
  const mime = m[1] || "application/octet-stream";
  const data = m[3] ?? "";
  const bytes = m[2]
    ? new Uint8Array(Buffer.from(data, "base64"))
    : new Uint8Array(Buffer.from(decodeURIComponent(data), "utf8"));
  return { mime, bytes };
}

const NOT_IMAGE_ERR =
  "The data is not recognised as an image (PNG/JPEG/GIF/WEBP/BMP): its magic bytes match none of them. " +
  "Pass `contentType` explicitly, or provide a real image file.";

const WEBP_REJECT_ERR =
  "Horoshop's blog cover/image pipeline produces a BROKEN file from a WEBP source: it registers a " +
  "/content/…jpg path in the DB but writes a 404 / 0-byte file, so the picture is a dead link on the " +
  "storefront. There is no image library here to convert it. Pass a JPEG or PNG instead.";

/**
 * True when the source is (or is declared as) WEBP. Detected without a fetch
 * from the URL extension, a data: URI's own MIME, or an explicit contentType,
 * and — when a fetch already happened — from the resolved/sniffed MIME (the
 * response content-type or the magic bytes). Covers the dry-run (no fetch) and
 * the real-upload (fetched) paths alike.
 */
function looksLikeWebpSource(
  src: { url?: string; base64?: string; contentType?: string } | undefined,
  resolvedMime = "",
): boolean {
  if (resolvedMime.toLowerCase() === "image/webp") return true;
  if (!src) return false;
  if (typeof src.contentType === "string" && /webp/i.test(src.contentType)) return true;
  for (const raw of [src.url, src.base64]) {
    if (typeof raw !== "string") continue;
    if (/^data:image\/webp/i.test(raw)) return true;
    if (/\.webp(\?|#|$)/i.test(raw)) return true;
  }
  return false;
}

/** Resolve {bytes, mime} from a url / base64 / data-uri image source (mirrors the uploader). */
async function resolveImage(
  client: any,
  src: { url?: string; base64?: string; contentType?: string },
): Promise<{ bytes: Uint8Array; mime: string; from: string }> {
  for (const raw of [src.base64, src.url]) {
    if (typeof raw === "string" && raw.startsWith("data:")) {
      const d = parseDataUri(raw);
      if (d) return { bytes: d.bytes, mime: d.mime, from: "data-uri" };
    }
  }
  const explicit = typeof src.contentType === "string" && src.contentType.length ? src.contentType : null;
  if (typeof src.base64 === "string" && src.base64.length) {
    const bytes = new Uint8Array(Buffer.from(src.base64, "base64"));
    if (bytes.length === 0) throw new Error("base64 decoded to 0 bytes — is it valid base64?");
    const sniffed = sniffMime(bytes);
    if (!sniffed && !explicit) throw new Error(NOT_IMAGE_ERR);
    return { bytes, mime: sniffed ?? explicit ?? "", from: "base64" };
  }
  if (typeof src.url === "string" && src.url.length) {
    const r = await client.admin.fetchBytes(src.url);
    if (r.httpStatus >= 400) throw new Error(`Fetching the image URL returned HTTP ${r.httpStatus}.`);
    if (r.bytes.length === 0) throw new Error(`The image URL returned 0 bytes (HTTP ${r.httpStatus}).`);
    const sniffed = sniffMime(r.bytes);
    const ct = r.contentType ? r.contentType.split(";")[0].trim() : "";
    const ctIsImage = /^image\//i.test(ct);
    if (!sniffed && !ctIsImage && !explicit) throw new Error(NOT_IMAGE_ERR);
    return { bytes: r.bytes, mime: sniffed ?? (ctIsImage ? ct : explicit ?? ""), from: `url(${r.httpStatus})` };
  }
  throw new Error("No image source: pass `url`, `base64`, or a data: URI.");
}

/** Turn a resolved image into the multipart part for a `names[<field>][file]` input. */
async function coverPart(
  client: any,
  fieldBase: string,
  src: { url?: string; base64?: string; filename?: string; contentType?: string },
): Promise<MultipartFile> {
  const { bytes, mime } = await resolveImage(client, src);
  if (looksLikeWebpSource(src, mime)) throw new Error(WEBP_REJECT_ERR);
  if (bytes.length > MAX_BYTES) throw new Error(`Image is ${bytes.length} bytes, over the ${MAX_BYTES}-byte cap.`);
  const contentType = src.contentType || mime || "image/jpeg";
  const ext = MIME_EXT[contentType.toLowerCase()] ?? "jpg";
  const filename = src.filename || `${fieldBase.includes("cover") ? "cover" : "image"}.${ext}`;
  return { name: `${fieldBase}[file]`, filename, contentType, bytes };
}

/** Build the `names[...]` override map from the tool args (text/SEO/flags/slug/date). */
function buildOverrides(args: any): Record<string, string> {
  const set: Record<string, string> = {};
  // Per-language i18n content. Top-level fields are the UA (primary) block; a `ru`
  // object carries the Russian block. Only provided keys are written (RMW keeps the rest).
  const blocks: Record<Lang, any> = { ua: args, ru: args.ru ?? {} };
  for (const lang of LANGS) {
    const L = LANG_INDEX[lang];
    const block = blocks[lang];
    if (!block) continue;
    for (const key of I18N_KEYS) {
      const v = block[key];
      if (typeof v === "string") set[`names[i18n][${L}][${I18N_FIELDS[key]}]`] = v;
    }
  }
  if (typeof args.slug === "string") set["names[name][slug]"] = args.slug;
  if (typeof args.date === "string") set["names[date]"] = args.date;
  if (typeof args.active === "boolean") set["names[act]"] = args.active ? "1" : "0";
  if (typeof args.promo === "boolean") set["names[promo]"] = args.promo ? "1" : "0";
  if (typeof args.disallowComments === "boolean")
    set["names[disallow_comments]"] = args.disallowComments ? "1" : "0";
  return set;
}

/**
 * `append`/`prepend` shape for an article. Restricted to the two LONG fields —
 * body and announce are the ones measured at 15–19 KB, i.e. the ones where
 * resending the existing text to add a paragraph is the actual problem.
 */
const SPLICEABLE = ["text", "announce"] as const;
const bodySpliceShape = z
  .object({
    text: z.string().optional().describe("Delta for the Ukrainian body HTML."),
    announce: z.string().optional().describe("Delta for the Ukrainian announce."),
    ru: z
      .object({ text: z.string().optional(), announce: z.string().optional() })
      .optional()
      .describe("Deltas for the Russian body / announce."),
  })
  .optional();

function editTarget(id: string | number, parent?: number): EditTarget {
  const extra: Record<string, string | number> = {};
  if (parent !== undefined) extra.parent = parent;
  return { id, handler: NEWS_HANDLER, handlertable: NEWS_TABLE, extra, flags: ["showPages"] };
}

/** Read the cover/img current path off a parsed article form. */
function mediaPaths(form: ParsedForm): { cover: string; img: string } {
  return {
    cover: form.fieldNames.has("names[cover][value]") ? fieldValue(form, "names[cover][value]") : "",
    img: form.fieldNames.has("names[img][value]") ? fieldValue(form, "names[img][value]") : "",
  };
}

/**
 * A clone of a parsed form with one field name dropped from the replay set. Used
 * to OMIT `names[parent]` from an update save.php POST: the edit form re-seeds
 * that <select> to a default rubric that does NOT reflect storage, so resending it
 * would silently MOVE the article. Omitting it preserves the stored rubric (see
 * admin/newsTree.ts). The original form is left intact for reads.
 */
function withoutField<T extends ParsedForm>(form: T, name: string): T {
  const fields = form.fields.filter((f) => f.name !== name);
  return { ...form, fields, fieldNames: new Set(fields.map((f) => f.name)) };
}

const createSchema = {
  ...storeField,
  title: z.string().describe("Article title (Ukrainian / primary language). Required."),
  announce: z.string().optional().describe("Short announce / preview text (UA)."),
  text: z.string().optional().describe("Article body HTML (UA)."),
  h1: z.string().optional().describe("H1 heading (UA); defaults to the title on the storefront if empty."),
  seoTitle: z.string().optional().describe("SEO <title> (UA)."),
  seoKeywords: z.string().optional().describe("SEO keywords (UA)."),
  seoDescription: z.string().optional().describe("SEO meta description (UA)."),
  ru: z
    .object(langShape())
    .optional()
    .describe("Russian (i18n index 1) block: title/announce/text/h1/seoTitle/seoKeywords/seoDescription."),
  slug: z.string().optional().describe("URL slug (names[name][slug]). Blog URLs are id-based, so this is optional."),
  date: z.string().optional().describe("Publish date YYYY-MM-DD (names[date]); defaults to the form's prefilled today."),
  active: z.boolean().optional().describe("Publish the article (names[act]). Default: published (true)."),
  promo: z.boolean().optional().describe("Promo flag (names[promo])."),
  disallowComments: z.boolean().optional().describe("Disable comments (names[disallow_comments])."),
  cover: imageShape.describe("Cover image (names[cover][file]) — recommended 1200×400. Uploaded via direct multipart."),
  image: imageShape.describe("Inline/preview image (names[img][file]) — recommended 1200×800, min 200×200."),
  rubric: z
    .number()
    .int()
    .optional()
    .describe(
      "Rubric / listing node id — the real h_news.parent the article lists under (its section: «Блог», a news rubric…). Discover ids with horoshop_admin_list pages. Default: the store's «Блог» node, found by title (per-store; do NOT assume a fixed id).",
    ),
  parent: z.number().int().optional().describe("Deprecated alias of `rubric` (kept for back-compat)."),
  payloadFile: payloadFileField("horoshop_admin_blog_post_create"),
  dryRun: z.boolean().optional().describe("Default true: preview the plan without creating. Set false to create."),
};

const updateSchema = {
  ...storeField,
  id: z.union([z.number().int(), z.string()]).describe("Article id to update (from horoshop_admin_list blog_posts)."),
  title: z.string().optional().describe("New title (UA)."),
  announce: z.string().optional().describe("New announce (UA)."),
  text: z.string().optional().describe("New body HTML (UA)."),
  h1: z.string().optional().describe("New H1 (UA)."),
  seoTitle: z.string().optional().describe("New SEO title (UA)."),
  seoKeywords: z.string().optional().describe("New SEO keywords (UA)."),
  seoDescription: z.string().optional().describe("New SEO meta description (UA)."),
  ru: z.object(langShape()).optional().describe("Russian (index 1) block to update."),
  slug: z.string().optional().describe("New URL slug."),
  date: z.string().optional().describe("New publish date YYYY-MM-DD."),
  active: z.boolean().optional().describe("Publish/unpublish (names[act])."),
  promo: z.boolean().optional().describe("Promo flag."),
  disallowComments: z.boolean().optional().describe("Disable comments."),
  cover: imageShape.describe("Replace the cover image (names[cover][file]), direct multipart."),
  image: imageShape.describe("Replace the inline image (names[img][file])."),
  rubric: z
    .number()
    .int()
    .optional()
    .describe(
      "MOVE the article to this rubric / listing node id (writes h_news.parent). Omit to KEEP the current rubric — a plain update never moves it. Find node ids with horoshop_admin_list pages.",
    ),
  parent: z.number().int().optional().describe("Deprecated alias of `rubric` (kept for back-compat)."),
  append: bodySpliceShape.describe(
    appendDescription("{\"text\":\"<p>…</p>\"} / {\"announce\":\"…\"} for Ukrainian and/or {\"ru\":{\"text\":\"…\"}} for Russian, glued onto the END of the stored body"),
  ),
  prepend: bodySpliceShape.describe(prependDescription("the same {text, announce, ru:{…}} shape as `append`")),
  verbose: verboseField,
  allowPlaceholderLoss: allowPlaceholderLossField,
  payloadFile: payloadFileField("horoshop_admin_blog_post_update"),
  dryRun: z.boolean().optional().describe("Default true: preview the changes without saving. Set false to persist."),
};

export const adminBlogTools: ToolSpec[] = [
  {
    name: "horoshop_admin_blog_post_create",
    title: "Create a blog / news article (with optional cover)",
    description:
      "Create a blog/news article (handler 172, h_news) in the store's «Блог» rubric. The rubric (which section the article lists under — its h_news.parent) is set explicitly and defaults to the «Блог» node discovered by title (per-store; not a hardcoded id), so a new post no longer lands in whatever section id happens to be the platform default. Pass `rubric` to file it elsewhere. Writes title/announce/body/H1 and full SEO (title/keywords/description) per language — top-level fields are Ukrainian (primary), an optional `ru` object adds Russian — plus slug, publish date, and the act/promo/disallow-comments flags. A `cover` (recommended 1200×400) and/or `image` (1200×800) are uploaded as real files through the same multipart save.php the admin uses; the article is created first, then the cover is attached to the new record and VERIFIED by re-reading it (names[cover][value] must become a /content/… path). Provide each image as `url` (fetched server-side), `base64`, or a data: URI. Returns the new article id and confirms it landed in the chosen rubric. DRY RUN BY DEFAULT — pass dryRun:false to actually create. To remove a test article afterwards use horoshop_admin_record_delete entity=blog_posts (parent auto-resolves). " +
      "⚠ NOT FULLY ATOMIC, AND THE ARTICLE IS LIVE THE MOMENT IT EXISTS. `active` defaults to TRUE, so the record is created PUBLISHED before the cover is attached. If the image then fails to resolve (a 404 on the URL is enough) this call throws and all you see is the fetch error — while a published, cover-less article is already sitting on /blog/. Retrying blind gives you two of them in front of readers. If you are creating from an image URL you do not fully trust, pass `active:false` and publish after the cover verified; if it did throw, check horoshop_admin_list entity=blog_posts parent=<rubric> before you retry. " +
      "IMAGE FORMAT: WEBP is refused up front (by URL extension, data-URI prefix or content-type) — Horoshop registers a webp path and then serves a broken file, which is worse than a clear refusal. Send JPEG or PNG. " +
      "BULK PAYLOAD FROM DISK: article bodies are 15\u201319 KB and do not fit in a tool argument. Pass `payloadFile` \u2014 an ABSOLUTE path to a JSON file carrying the same argument names (e.g. {\"title\":\"\u2026\",\"text\":\"<18 KB of HTML>\",\"ru\":{\"text\":\"\u2026\"}}) \u2014 instead of hand-rolling a raw getEditForm+save, which is what relocated 10 live articles into the wrong rubric once. Mutually exclusive with the inline content fields; dryRun unchanged.",
    inputSchema: createSchema,
    annotations: { readOnlyHint: false, idempotentHint: false },
    handler: async (client, rawArgs) => {
      const args = withPayloadFile(rawArgs, createSchema, "horoshop_admin_blog_post_create");
      const src = args.payloadFileUsed ? { payloadFile: args.payloadFileUsed } : {};
      // The RUBRIC (h_news.parent) the article lists under. Prefer the caller's
      // rubric/parent; otherwise the store's real «Блог» node discovered by title
      // (per-store id — a hardcoded default drops posts into the wrong section on
      // stores whose node ids differ). This value is written EXPLICITLY as
      // names[parent] below (authoritative), not left to the form's seeded select.
      const rubricArg = args.rubric ?? args.parent;
      const parent = rubricArg ?? (await resolveBlogNode(client, args.store, DEFAULT_BLOG_PARENT));
      const rubricSource = rubricArg != null ? "argument" : "resolved «Блог» node (by title)";
      const overrides = buildOverrides(args);
      // Publish by default on create unless the caller said otherwise.
      if (args.active === undefined) overrides["names[act]"] = "1";
      // Write the rubric explicitly. The create form seeds names[parent] from the
      // &parent= query, but an explicit override is authoritative even when the
      // seed is wrong (proven live: seed 1001 + override 686 → article in 686).
      overrides["names[parent]"] = String(parent);
      if (!overrides[`names[i18n][${LANG_INDEX.ua}][title]`]) {
        throw new Error("`title` is required to create an article.");
      }

      // An explicit slug PERSISTS only when names[name][parent] (the p_name url-tree
      // row of the blog node) rides along in the same submit — the article slug is
      // owned by the same zteel.params.url widget as the category slug. Without it
      // save.php silently drops the slug (SILENT-FAIL) and the article is reachable
      // only by /blog/<id>/; with it the article also renders at /<slug>/. Resolving
      // with record_id 0 is a non-mutating read (mirrors the category create).
      let slugResolved: string | null = null;
      if (typeof args.slug === "string" && args.slug.length) {
        const r = await client.admin.resolveUrlParent(args.store, parent, args.slug, 0);
        if (r.parent) {
          overrides["names[name][parent]"] = r.parent;
          slugResolved = r.parent;
        }
      }

      const hasCover = !!(args.cover && (args.cover.url || args.cover.base64));
      const hasImage = !!(args.image && (args.image.url || args.image.base64));
      // Reject a WEBP source up front (even in dry-run) — Horoshop's pipeline
      // writes a broken file from webp. Cheap detection: URL extension / data-URI
      // MIME / explicit contentType, no fetch needed.
      if (hasCover && looksLikeWebpSource(args.cover)) throw new Error(WEBP_REJECT_ERR);
      if (hasImage && looksLikeWebpSource(args.image)) throw new Error(WEBP_REJECT_ERR);

      if (args.dryRun !== false) {
        return {
          store: args.store ?? null,
          action: "create",
          dryRun: true,
          rubric: parent,
          rubricSource,
          ...src,
          willSet: Object.fromEntries(Object.entries(overrides).map(([k, v]) => [k, previewValue(v)])),
          slug: typeof args.slug === "string" && args.slug.length ? args.slug : null,
          slugResolved:
            typeof args.slug === "string" && args.slug.length
              ? slugResolved
                ? `name-parent ${slugResolved} → /${args.slug}/`
                : "UNRESOLVED (slug may not persist — url widget returned no parent)"
              : null,
          cover: hasCover ? "will upload (direct multipart names[cover][file])" : null,
          image: hasImage ? "will upload (direct multipart names[img][file])" : null,
          note: "Set dryRun:false to create. The article is created first, then any cover/image is attached and verified.",
        };
      }

      // 1. Create the article (text/SEO/flags) and find its new id by diffing the grid.
      const form = await client.admin.getEditForm(args.store, editTarget("addnew", parent));
      const idsBefore = new Set(
        (await client.admin.listRecords(args.store, NEWS_HANDLER, { parent, perPage: 160 }).catch(() => [])).map(
          (r: any) => String(r.id),
        ),
      );
      const createRes = await client.admin.save(args.store, form, overrides);
      const after = await client.admin
        .listRecords(args.store, NEWS_HANDLER, { parent, perPage: 160 })
        .catch(() => [] as any[]);
      const fresh = after.filter((r: any) => !idsBefore.has(String(r.id)));
      const newId = fresh.length === 1 ? String(fresh[0].id) : null;
      if (!newId) {
        return {
          store: args.store ?? null,
          action: "create",
          dryRun: false,
          created: fresh.length > 0,
          httpStatus: createRes.httpStatus,
          note:
            fresh.length > 1
              ? `Created but ${fresh.length} new rows appeared at once (ambiguous): ${fresh.map((r: any) => r.id).join(", ")}.`
              : `Submitted (HTTP ${createRes.httpStatus}) but no new article appeared in the list — the save was likely rejected. Check horoshop_admin_list entity=blog_posts parent=${parent}.`,
        };
      }

      // 2. Attach cover/image (if any) to the freshly created record and verify.
      let coverPath: string | null = null;
      let imagePath: string | null = null;
      let coverAsset: Awaited<ReturnType<typeof client.admin.verifyAsset>> | null = null;
      let imageAsset: Awaited<ReturnType<typeof client.admin.verifyAsset>> | null = null;
      if (hasCover || hasImage) {
        const recForm = await client.admin.getEditForm(args.store, editTarget(newId));
        const files: MultipartFile[] = [];
        if (hasCover) files.push(await coverPart(client, "names[cover]", args.cover));
        if (hasImage) files.push(await coverPart(client, "names[img]", args.image));
        await client.admin.save(args.store, recForm, {}, files);
        const verifyForm = await client.admin.getEditForm(args.store, editTarget(newId));
        const paths = mediaPaths(verifyForm);
        coverPath = hasCover ? paths.cover || null : null;
        imagePath = hasImage ? paths.img || null : null;
        // The path changing proves only the DB row; fetch the file itself so a
        // registered-but-broken asset is reported as uploaded:false, not a lie.
        if (coverPath) coverAsset = await client.admin.verifyAsset(args.store, coverPath);
        if (imagePath) imageAsset = await client.admin.verifyAsset(args.store, imagePath);
      }
      // "uploaded" is true only when the path exists AND the file really serves.
      const coverUploaded = hasCover ? !!coverPath && !!coverAsset?.ok : null;
      const imageUploaded = hasImage ? !!imagePath && !!imageAsset?.ok : null;
      const brokenAsset =
        (hasCover && coverPath && !coverAsset?.ok) || (hasImage && imagePath && !imageAsset?.ok);

      // Verify the slug landed (read it back from the fresh record).
      let slugInfo: { requested: string; persisted: string | null; link: string | null } | null = null;
      if (typeof args.slug === "string" && args.slug.length) {
        const sf = await client.admin.getEditForm(args.store, editTarget(newId));
        const stored = sf.fieldNames.has("names[name][slug]") ? fieldValue(sf, "names[name][slug]") : "";
        slugInfo = { requested: args.slug, persisted: stored || null, link: stored ? `/${stored}/` : null };
      }

      // The `after` list was scoped to the target rubric, so the new id appearing
      // in it IS proof the article landed there (no separate read needed).
      const rubricConfirmed = fresh.some((r: any) => String(r.id) === newId);
      return {
        store: args.store ?? null,
        action: "create",
        dryRun: false,
        created: true,
        newId,
        rubric: parent,
        rubricConfirmed,
        httpStatus: createRes.httpStatus,
        setFields: Object.keys(overrides),
        slug: slugInfo,
        cover: hasCover
          ? { uploaded: coverUploaded, path: coverPath, assetStatus: coverAsset?.httpStatus ?? null, contentType: coverAsset?.contentType ?? null }
          : null,
        image: hasImage
          ? { uploaded: imageUploaded, path: imagePath, assetStatus: imageAsset?.httpStatus ?? null, contentType: imageAsset?.contentType ?? null }
          : null,
        note: brokenAsset
          ? `Article ${newId} created, but an uploaded image path is registered while the FILE does not serve (HTTP ${(hasCover && coverPath && !coverAsset?.ok ? coverAsset?.httpStatus : imageAsset?.httpStatus) ?? "?"} / not an image). This is the Horoshop broken-file case — re-upload a JPEG/PNG, not webp.`
          : (hasCover && !coverPath) || (hasImage && !imagePath)
            ? `Article ${newId} created, but an image did not persist (names[…][value] stayed empty) — verify on the storefront.`
            : `Created article ${newId}${coverPath ? ` with cover ${coverPath}` : ""}. Verify at /blog/${newId}/.`,
      };
    },
  },
  {
    name: "horoshop_admin_blog_post_update",
    title: "Update a blog / news article (text, SEO, cover)",
    description:
      "Update an existing blog/news article (handler 172, h_news) by id. Read-modify-write: only the fields you pass change, everything else (including an existing cover AND the current rubric) is preserved. Sets title/announce/body/H1 and SEO per language (top-level = Ukrainian, optional `ru` object = Russian), plus slug/date and the act/promo/disallow-comments flags. Pass `rubric` to MOVE the article to another listing node (writes h_news.parent) — omit it and the rubric is left untouched (a plain edit never moves the article, which the old read-modify-write did by accident). Pass `cover` and/or `image` (as url/base64/data URI) to replace those pictures via direct multipart. Verifies by re-reading the article (text fields must read back, a replaced cover's path must change) and, for a move, by confirming the article now appears in the target rubric's grid. DRY RUN BY DEFAULT — pass dryRun:false to persist. " +
      "BULK PAYLOAD FROM DISK: an article body is 15\u201319 KB and will not fit in a tool argument \u2014 that size limit is exactly why an operator once bypassed this tool for a raw read-modify-write and moved 10 published articles into the wrong rubric. Pass `payloadFile`, an ABSOLUTE path to a JSON file with the same argument names (e.g. {\"ru\":{\"title\":\"\u2026\",\"text\":\"<18 KB>\"}}); the rubric stays protected exactly as it does inline. Mutually exclusive with the inline content fields. " +
      "ADD TO THE BODY WITHOUT RESENDING IT: `append` / `prepend` splice a delta onto the STORED text/announce ({\"text\":\"\u2026\"} for UA, {\"ru\":{\"text\":\"\u2026\"}} for RU) \u2014 no 18 KB round-trip, no risk of re-typing the existing article wrong. Conflicts with the replacing field for the same cell are an error. " +
      "ANSWER SIZE: a persisted long field is reported as {length, tail, sha256} rather than echoed as from+to+now; a failure keeps expected/actual previews and the first differing offset. verbose:true restores the full diff. " +
      PLACEHOLDER_GUARD_DOC,
    inputSchema: updateSchema,
    annotations: { readOnlyHint: false, idempotentHint: true },
    handler: async (client, rawArgs) => {
      const args = withPayloadFile(rawArgs, updateSchema, "horoshop_admin_blog_post_update");
      const src = args.payloadFileUsed ? { payloadFile: args.payloadFileUsed } : {};
      // Text/SEO/flag/slug/date overrides only — the rubric (names[parent]) is
      // handled separately below so it is never verified against the unreliable
      // form read-back.
      const textOverrides = buildOverrides(args);
      const moveTo = args.rubric ?? args.parent; // move the article to this rubric, or undefined = keep
      const hasCover = !!(args.cover && (args.cover.url || args.cover.base64));
      const hasImage = !!(args.image && (args.image.url || args.image.base64));
      const spliceCells = (m: any): string[] =>
        m
          ? [
              ...SPLICEABLE.filter((k) => typeof m[k] === "string").map((k) => `ua.${k}`),
              ...SPLICEABLE.filter((k) => typeof m.ru?.[k] === "string").map((k) => `ru.${k}`),
            ]
          : [];
      const spliceKeys = [...new Set([...spliceCells(args.append), ...spliceCells(args.prepend)])];
      if (Object.keys(textOverrides).length === 0 && !hasCover && !hasImage && moveTo == null && spliceKeys.length === 0) {
        throw new Error("Nothing to update — pass at least one text/SEO/flag field, an append/prepend delta, a cover, an image, or a rubric.");
      }
      const verbose = args.verbose === true;

      const form = await client.admin.getEditForm(args.store, editTarget(args.id));
      if (!form.fieldNames.has("names[cover][id]") && !form.fieldNames.has("names[i18n][3][title]")) {
        throw new Error(`Article ${args.id} not found — its edit form has no blog fields. Check the id with horoshop_admin_list entity=blog_posts.`);
      }

      // APPEND / PREPEND onto the stored body: an article body is 15–19 KB, and
      // resending it whole just to add a closing paragraph is exactly the pressure
      // that once pushed an operator off these tools and onto a raw RMW.
      const setCells = [
        ...SPLICEABLE.filter((k) => typeof (args as any)[k] === "string").map((k) => `ua.${k}`),
        ...SPLICEABLE.filter((k) => typeof args.ru?.[k] === "string").map((k) => `ru.${k}`),
      ];
      assertNoSpliceConflict(setCells, spliceKeys, "text/announce");
      const spliced: Record<string, { mode: string; delta: string }> = {};
      for (const key of spliceKeys) {
        const [lang, logical] = key.split(".") as [Lang, (typeof SPLICEABLE)[number]];
        const src2 = (m: any) => (lang === "ua" ? m?.[logical] : m?.ru?.[logical]);
        const pre = src2(args.prepend);
        const app = src2(args.append);
        const field = `names[i18n][${LANG_INDEX[lang]}][${I18N_FIELDS[logical]}]`;
        if (!form.fieldNames.has(field)) {
          throw new Error(`append/prepend target ${key} (${field}) is not on article ${args.id}'s form — nothing to splice onto.`);
        }
        const from = fieldValue(form, field);
        const to = splice({ current: from, append: app, prepend: pre });
        if (from === to) continue;
        textOverrides[field] = to;
        spliced[field] = {
          mode: [typeof pre === "string" ? "prepend" : "", typeof app === "string" ? "append" : ""].filter(Boolean).join("+"),
          delta: `${pre ?? ""}${app ?? ""}`,
        };
      }
      // An explicit slug needs its url-tree parent resolved to persist (see create).
      // Use the target rubric when moving, else the form's names[parent] seed.
      if (typeof args.slug === "string" && args.slug.length) {
        const blogParentRaw = form.fieldNames.has("names[parent]") ? fieldValue(form, "names[parent]") : "";
        const blogParent = moveTo != null ? String(moveTo) : blogParentRaw || String(DEFAULT_BLOG_PARENT);
        const r = await client.admin.resolveUrlParent(args.store, blogParent, args.slug, args.id);
        if (r.parent) textOverrides["names[name][parent]"] = r.parent;
      }
      const before = mediaPaths(form);
      const planned: Array<Record<string, any>> = Object.entries(textOverrides).map(([field, to]) => {
        const from = fieldValue(form, field);
        const s = spliced[field];
        return s
          ? { field, mode: s.mode, from, to, delta: s.delta, length: { before: from.length, delta: s.delta.length, after: to.length } }
          : { field, from, to };
      });

      // TEMPLATE TOKENS — see admin/placeholders.ts.
      const placeholderWarnings = scanPlaceholderLoss(planned);

      if (args.dryRun !== false) {
        return {
          store: args.store ?? null,
          action: "update",
          id: String(args.id),
          dryRun: true,
          ...src,
          ...(placeholderWarnings.length
            ? { placeholderWarnings, placeholderNote: placeholderPreviewNote(placeholderWarnings) }
            : {}),
          willChange: planned.map((p) => compactPreview(p, verbose)),
          rubricMove: moveTo != null ? { to: moveTo, field: "names[parent]" } : "unchanged (names[parent] omitted so the stored rubric is preserved)",
          cover: hasCover ? "will replace (names[cover][file])" : null,
          image: hasImage ? "will replace (names[img][file])" : null,
        };
      }

      assertPlaceholdersKept(placeholderWarnings, args.allowPlaceholderLoss === true);

      // Build what actually gets posted. Moving → override names[parent] to the
      // target (authoritative). Not moving → DROP names[parent] entirely so the
      // form's re-seeded default select can't silently relocate the article.
      const saveOverrides: Record<string, string> = { ...textOverrides };
      let saveForm = form;
      if (moveTo != null) saveOverrides["names[parent]"] = String(moveTo);
      else saveForm = withoutField(form, "names[parent]");

      const files: MultipartFile[] = [];
      if (hasCover) files.push(await coverPart(client, "names[cover]", args.cover));
      if (hasImage) files.push(await coverPart(client, "names[img]", args.image));
      const res = await client.admin.save(args.store, saveForm, saveOverrides, files.length ? files : undefined);

      const after = await client.admin.getEditForm(args.store, editTarget(args.id));
      const changes = planned.map((p) => {
        const now = fieldValue(after, p.field as string);
        return { ...p, now, persisted: now === p.to };
      });
      const afterPaths = mediaPaths(after);
      const coverChanged = hasCover ? afterPaths.cover !== "" && afterPaths.cover !== before.cover : null;
      const imageChanged = hasImage ? afterPaths.img !== "" && afterPaths.img !== before.img : null;
      // A move is verified against the GRID (the form's names[parent] does not
      // reflect storage), not the form read-back.
      let rubricMove: { to: number; moved: boolean } | null = null;
      if (moveTo != null) {
        const moved = await articleInRubric(client, args.store, NEWS_HANDLER, args.id, moveTo).catch(() => false);
        rubricMove = { to: moveTo, moved };
      }
      const textOk = changes.every((c) => c.persisted);
      const moveOk = rubricMove ? rubricMove.moved : true;
      const reported = changes.map((c) => compactVerified(c, verbose));
      const compacted = wasCompacted(reported);
      return {
        store: args.store ?? null,
        action: "update",
        id: String(args.id),
        dryRun: false,
        saved: textOk && coverChanged !== false && imageChanged !== false && moveOk,
        httpStatus: res.httpStatus,
        ...src,
        ...(placeholderWarnings.length
          ? { placeholderLossAllowed: placeholderWarnings, placeholderNote: placeholderOverrideNote(placeholderWarnings) }
          : {}),
        changes: reported,
        rubricMove: rubricMove ?? "unchanged (rubric preserved)",
        cover: hasCover ? { changed: coverChanged, path: afterPaths.cover || null, was: before.cover || null } : null,
        image: hasImage ? { changed: imageChanged, path: afterPaths.img || null, was: before.img || null } : null,
        note:
          (!moveOk
            ? `Text saved, but the article did not appear in rubric ${moveTo} — check the node id with horoshop_admin_list pages.`
            : textOk
              ? "Saved and verified by re-reading the article."
              : "Some text fields did not persist — check field values / admin validation.") +
          (compacted ? ` ${COMPACT_NOTE}` : ""),
      };
    },
  },
];
