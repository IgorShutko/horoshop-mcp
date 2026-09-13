import { z } from "zod";
import { storeField, type ToolSpec } from "../register.js";
import { payloadFileField, withPayloadFile } from "../admin/payloadFile.js";
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

/**
 * Catalog categories (site-pages tree, handler 4 / table `pages`) as named
 * create/update tools — the piece the "semantic core → structure" pipeline needs
 * so a whole category tree can be built (title + SEO + SEO-text + cover + flags)
 * in one call instead of hand-driving the generic record_save.
 *
 * Contract (reverse-engineered live on a test store):
 *
 * A category is a node of the site tree edited by
 *   `edit.php?id=<id>&handler=4&handlertable=pages&showPages`
 * (create: `id=addnew&parent=<parentPageId>`), form → save.php (multipart).
 *
 * TWO STEPS ARE UNAVOIDABLE. The blank CREATE form does NOT render the category
 * `extra[…]` block at all (no seo_text, no image, no discount/flags): those
 * fields only appear once the node exists and its template is set. So:
 *   1. create the node — names[parent], names[handler] (the display template,
 *      e.g. 381 "КАТАЛОГ: Товар"), names[i18n][L][title], SEO meta
 *      (names[i18n][L][seo_title|seo_keywords|seo_description|h1_title]),
 *      names[name][slug] + names[name][parent] (see slug note);
 *   2. re-open the new record (its extra block now renders) and write the
 *      SEO-text, the category flags and the cover.
 *
 * SEO-TEXT ≠ page text. It is `extra[i18n][L][seo_text]` (a text page uses
 * `extra[i18n][L][text]`). NAMESPACE: a default-template category keeps it in
 * `extra[…]`; a custom-template one (e.g. the store's product template 381,
 * Стікери 460, Футболки 461) moves the whole block to `extra_parent[…]` because
 * `extra[…]` is taken by the custom template. Resolved from the form at runtime,
 * exactly like the category-cover uploader (extra[image] vs extra_parent[image]).
 *
 * SLUG. The slug is NOT a plain field: it is owned by the `zteel.params.url`
 * widget, which keeps its own p_name tree. Writing `names[name][slug]` persists
 * ONLY when `names[name][parent]` = the p_name-row id of the page parent —
 * resolved via AdminClient.resolveUrlParent (mirrors the admin's own JS). Omit it
 * and the slug is silently dropped and the storefront 404s. Proven: with the
 * resolved parent the category renders at `/<slug>/` (HTTP 200).
 *
 * COVER. The cover is a plain `<input type=file name="<base>[image][file]">` in
 * the same editDoc form; sending its bytes to save.php persists (base is
 * extra[image] or extra_parent[image], resolved from the form). No separate
 * upload endpoint / "cloud_upload" (that primitive does not exist — see adminBlog).
 */

const PAGES_HANDLER = 4;
const PAGES_TABLE = "pages";
/** The cover / extra-block namespaces a category can use, in priority order. */
const COVER_BASES = ["extra[image]", "extra_parent[image]"] as const;
const MAX_BYTES = 20 * 1024 * 1024;
const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
};

const LANGS = ["ua", "ru"] as const;
type Lang = (typeof LANGS)[number];

/** Human key → the raw `names[i18n][L][<raw>]` SEO-meta sub-field (lives on the node form). */
const META_FIELDS = {
  seoTitle: "seo_title",
  seoKeywords: "seo_keywords",
  seoDescription: "seo_description",
  h1: "h1_title",
} as const;
type MetaKey = keyof typeof META_FIELDS;
const META_KEYS = Object.keys(META_FIELDS) as MetaKey[];

function langShape() {
  const s: Record<string, z.ZodTypeAny> = {
    title: z.string().optional(),
    seoTitle: z.string().optional(),
    seoKeywords: z.string().optional(),
    seoDescription: z.string().optional(),
    h1: z.string().optional(),
    seoText: z.string().optional(),
  };
  return s;
}

const imageShape = z
  .object({
    url: z.string().optional().describe("Image URL fetched server-side (or a data: URI)."),
    base64: z.string().optional().describe("Image bytes as base64 (or a data: URI)."),
    filename: z.string().optional().describe("Override the sent filename."),
    contentType: z.string().optional().describe("Override the sent MIME type."),
  })
  .optional();

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

async function resolveImage(
  client: any,
  src: { url?: string; base64?: string; contentType?: string },
): Promise<{ bytes: Uint8Array; mime: string }> {
  for (const raw of [src.base64, src.url]) {
    if (typeof raw === "string" && raw.startsWith("data:")) {
      const d = parseDataUri(raw);
      if (d) return { bytes: d.bytes, mime: d.mime };
    }
  }
  const explicit = typeof src.contentType === "string" && src.contentType.length ? src.contentType : null;
  if (typeof src.base64 === "string" && src.base64.length) {
    const bytes = new Uint8Array(Buffer.from(src.base64, "base64"));
    if (bytes.length === 0) throw new Error("base64 decoded to 0 bytes — is it valid base64?");
    const sniffed = sniffMime(bytes);
    if (!sniffed && !explicit) throw new Error(NOT_IMAGE_ERR);
    return { bytes, mime: sniffed ?? explicit ?? "" };
  }
  if (typeof src.url === "string" && src.url.length) {
    const r = await client.admin.fetchBytes(src.url);
    if (r.httpStatus >= 400) throw new Error(`Fetching the image URL returned HTTP ${r.httpStatus}.`);
    if (r.bytes.length === 0) throw new Error(`The image URL returned 0 bytes (HTTP ${r.httpStatus}).`);
    const sniffed = sniffMime(r.bytes);
    const ct = r.contentType ? r.contentType.split(";")[0].trim() : "";
    const ctIsImage = /^image\//i.test(ct);
    if (!sniffed && !ctIsImage && !explicit) throw new Error(NOT_IMAGE_ERR);
    return { bytes: r.bytes, mime: sniffed ?? (ctIsImage ? ct : explicit ?? "") };
  }
  throw new Error("No image source: pass `url`, `base64`, or a data: URI.");
}

async function coverPart(
  client: any,
  base: string,
  src: { url?: string; base64?: string; filename?: string; contentType?: string },
): Promise<MultipartFile> {
  const { bytes, mime } = await resolveImage(client, src);
  if (bytes.length > MAX_BYTES) throw new Error(`Image is ${bytes.length} bytes, over the ${MAX_BYTES}-byte cap.`);
  const contentType = src.contentType || mime || "image/jpeg";
  const ext = MIME_EXT[contentType.toLowerCase()] ?? "jpg";
  const filename = src.filename || `cover.${ext}`;
  // `base` already ends with [image] (extra[image] / extra_parent[image]); the
  // file part is <base>[file], mirroring the category-cover uploader.
  return { name: `${base}[file]`, filename, contentType, bytes };
}

function pageTarget(id: string | number, parent?: number): EditTarget {
  const extra: Record<string, string | number> = {};
  if (parent !== undefined) extra.parent = parent;
  return { id, handler: PAGES_HANDLER, handlertable: PAGES_TABLE, extra, flags: ["showPages"] };
}

/** The cover/extra namespace present on this category form (extra vs extra_parent). */
function resolveBase(form: ParsedForm): string | null {
  for (const base of COVER_BASES) {
    if (form.fieldNames.has(`${base}[id]`) || form.fieldNames.has(`${base}[value]`)) return base;
  }
  return null;
}
/** The extra-block prefix, e.g. base "extra_parent[image]" → "extra_parent". */
const nsOf = (base: string) => base.replace(/\[image\]$/, "");

/** Ids of the pages currently under `parent` (from the documented pages/export). */
async function pageIdsUnder(client: any, store: string | undefined, parent: number): Promise<Set<string>> {
  const body = await client.call(store, "pages/export", {}).catch(() => ({}));
  const arr: any[] = body?.response?.pages ?? (Array.isArray(body?.response) ? body.response : []);
  return new Set(arr.filter((p) => String(p.parent) === String(parent)).map((p) => String(p.id)));
}

/**
 * Pick the display template (names[handler]) for a new category. Honour an
 * explicit `template`; otherwise auto-detect the catalog product template from
 * the create form's options (the "КАТАЛОГ …" entry, preferring the one naming
 * "товар"). Returns the chosen value + the full option list for diagnostics.
 */
function pickTemplate(
  form: ParsedForm,
  explicit: string | number | undefined,
): { template: string | null; options: Array<{ value: string; label: string }> } {
  const sel = form.selects["names[handler]"];
  const options = sel?.options?.filter((o) => /^\d+$/.test(o.value)) ?? [];
  if (explicit !== undefined && explicit !== null && String(explicit).length) {
    return { template: String(explicit), options };
  }
  const catalog = options.filter((o) => /катал/i.test(o.label));
  const withGoods = catalog.find((o) => /товар|product/i.test(o.label));
  const chosen = withGoods ?? catalog[0] ?? null;
  return { template: chosen?.value ?? null, options };
}

/** Build the per-language SEO-meta overrides (they live on the node form). */
function metaOverrides(args: any): Record<string, string> {
  const set: Record<string, string> = {};
  const blocks: Record<Lang, any> = { ua: args, ru: args.ru ?? {} };
  for (const lang of LANGS) {
    const L = LANG_INDEX[lang];
    const block = blocks[lang];
    if (!block) continue;
    if (typeof block.title === "string") set[`names[i18n][${L}][title]`] = block.title;
    for (const key of META_KEYS) {
      const v = block[key];
      if (typeof v === "string") set[`names[i18n][${L}][${META_FIELDS[key]}]`] = v;
    }
  }
  return set;
}

/** Build the extra-block overrides (seo_text + flags) in the resolved namespace. */
function extraOverrides(args: any, ns: string): Record<string, string> {
  const set: Record<string, string> = {};
  const blocks: Record<Lang, any> = { ua: args, ru: args.ru ?? {} };
  for (const lang of LANGS) {
    const L = LANG_INDEX[lang];
    const v = blocks[lang]?.seoText;
    if (typeof v === "string") set[`${ns}[i18n][${L}][seo_text]`] = v;
  }
  if (args.discount !== undefined && args.discount !== null) set[`${ns}[discount]`] = String(args.discount);
  if (typeof args.inPopularMenu === "boolean") set[`${ns}[in_popular_menu]`] = args.inPopularMenu ? "1" : "0";
  if (typeof args.showNav === "boolean") set[`${ns}[show_nav]`] = args.showNav ? "1" : "0";
  if (typeof args.showPagesOnly === "boolean") set[`${ns}[show_pages_only]`] = args.showPagesOnly ? "1" : "0";
  if (args.listView !== undefined && args.listView !== null) set[`${ns}[list_view]`] = String(args.listView);
  return set;
}

const seoTextRe = /\[seo_text\]$/;

/**
 * Ask the storefront, as a buyer, whether a path actually resolves.
 *
 * THE REASON THIS EXISTS: `record_save entity=pages id=addnew` + `page_seo_set`
 * both answered "created / persisted / all changes verified" for a page that
 * returned 404 on the storefront in both languages. "Verified" meant "the field
 * reads back in the admin form" — which is true and useless when the record has
 * no URL. A create that claims success must be able to say whether a buyer can
 * open the thing, so the answer carries a real HTTP status, not an inference.
 *
 * Never throws: a storefront that is down or behind an anti-bot must not fail an
 * otherwise-good create — it reports `null` and says the check did not run.
 */
async function storefrontStatus(client: any, store: string | undefined, path: string): Promise<number | null> {
  try {
    const r = await client.shop.page(store, path);
    return typeof r?.httpStatus === "number" ? r.httpStatus : null;
  } catch {
    return null;
  }
}

/** Pick the «Текстовая страница» display template out of names[handler]'s options. */
function pickTextTemplate(
  form: ParsedForm,
  explicit: string | number | undefined,
): { template: string | null; options: Array<{ value: string; label: string }> } {
  const sel = form.selects["names[handler]"];
  const options = sel?.options?.filter((o) => /^\d+$/.test(o.value)) ?? [];
  if (explicit !== undefined && explicit !== null && String(explicit).length) {
    return { template: String(explicit), options };
  }
  const byLabel = options.find((o) => /текстов|тексто|text\s*page|информацион/i.test(o.label));
  return { template: (byLabel ?? options.find((o) => o.value === "201"))?.value ?? null, options };
}

/**
 * The page BODY field in the resolved namespace.
 *
 * A text page keeps its body in `extra[i18n][L][text]`; a category keeps its
 * SEO-text in `extra[i18n][L][seo_text]` (see the header note). Resolving it off
 * the real form rather than assuming means a page created on a non-default
 * template still writes into the field its own editor renders.
 */
function bodyFieldName(form: ParsedForm, ns: string, lang: number): string | null {
  for (const raw of ["text", "seo_text"]) {
    const name = `${ns}[i18n][${lang}][${raw}]`;
    if (form.fieldNames.has(name)) return name;
  }
  return null;
}

/**
 * `append` / `prepend` shape for the category SEO-text. Only seo_text is spliceable
 * — it is the only field here that is long enough for resending it to be the
 * problem (16 KB is the measured worst case), and the only one where re-typing
 * someone else's HTML risks corrupting live content.
 */
const seoTextSpliceShape = z
  .object({
    seoText: z.string().optional().describe("Delta for the Ukrainian category SEO-text."),
    ru: z.object({ seoText: z.string().optional() }).optional().describe("Delta for the Russian category SEO-text."),
  })
  .optional();

const createSchema = {
  ...storeField,
  parent: z.number().int().describe("Parent page id to create the category under (e.g. the «Каталог» root)."),
  title: z.string().describe("Category title (Ukrainian / primary language). Required."),
  slug: z.string().optional().describe("URL slug (latin). Omit to auto-transliterate from the title."),
  seoTitle: z.string().optional().describe("SEO <title> (UA)."),
  seoKeywords: z.string().optional().describe("SEO keywords (UA)."),
  seoDescription: z.string().optional().describe("SEO meta description (UA)."),
  h1: z.string().optional().describe("H1 heading (UA)."),
  seoText: z.string().optional().describe("Category SEO-text HTML (UA) — the extra[i18n][L][seo_text] block, NOT the page body."),
  ru: z
    .object(langShape())
    .optional()
    .describe("Russian (i18n index 1) block: title / seoTitle / seoKeywords / seoDescription / h1 / seoText."),
  discount: z.union([z.number(), z.string()]).optional().describe("Category-wide discount %, extra[discount]."),
  inPopularMenu: z.boolean().optional().describe("Show in the popular menu (extra[in_popular_menu])."),
  showNav: z.boolean().optional().describe("Show the filter/nav sidebar (extra[show_nav])."),
  showPagesOnly: z.boolean().optional().describe("Show subcategories only, no products (extra[show_pages_only])."),
  listView: z.union([z.number(), z.string()]).optional().describe("Product list view mode (extra[list_view])."),
  inMenu: z.boolean().optional().describe("Show the category in the main menu (names[inmenu])."),
  template: z
    .union([z.number().int(), z.string()])
    .optional()
    .describe("Display template id (names[handler]). Omit to auto-pick the store's «КАТАЛОГ: Товар» template."),
  cover: imageShape.describe("Category cover image (<base>[image][file]) — uploaded via direct multipart. url / base64 / data URI."),
  dryRun: z.boolean().optional().describe("Default true: preview the plan without creating. Set false to create."),
};

const updateSchema = {
  ...storeField,
  id: z.union([z.number().int(), z.string()]).describe("Category (page) id to update."),
  parent: z.number().int().optional().describe("Parent page id (needed to resolve the slug tree when changing the slug)."),
  title: z.string().optional().describe("New title (UA)."),
  slug: z.string().optional().describe("New URL slug (latin) — requires `parent` to resolve the URL tree."),
  seoTitle: z.string().optional().describe("New SEO title (UA)."),
  seoKeywords: z.string().optional().describe("New SEO keywords (UA)."),
  seoDescription: z.string().optional().describe("New SEO meta description (UA)."),
  h1: z.string().optional().describe("New H1 (UA)."),
  seoText: z.string().optional().describe("New category SEO-text HTML (UA)."),
  ru: z.object(langShape()).optional().describe("Russian (index 1) block to update."),
  discount: z.union([z.number(), z.string()]).optional().describe("Category discount % (extra[discount])."),
  inPopularMenu: z.boolean().optional().describe("Show in popular menu."),
  showNav: z.boolean().optional().describe("Show the filter/nav sidebar."),
  showPagesOnly: z.boolean().optional().describe("Show subcategories only."),
  listView: z.union([z.number(), z.string()]).optional().describe("Product list view mode."),
  inMenu: z.boolean().optional().describe("Show in the main menu (names[inmenu])."),
  cover: imageShape.describe("Replace the cover image (<base>[image][file]), direct multipart."),
  append: seoTextSpliceShape.describe(
    appendDescription("{\"seoText\":\"<h3>Доставка</h3>…\"} for Ukrainian and/or {\"ru\":{\"seoText\":\"…\"}} for Russian, glued onto the END of the stored category SEO-text"),
  ),
  prepend: seoTextSpliceShape.describe(prependDescription("the same {seoText, ru:{seoText}} shape as `append`")),
  verbose: verboseField,
  allowPlaceholderLoss: allowPlaceholderLossField,
  payloadFile: payloadFileField("horoshop_admin_category_update"),
  dryRun: z.boolean().optional().describe("Default true: preview the changes without saving. Set false to persist."),
};

const pageCreateSchema = {
  ...storeField,
  parent: z.number().int().optional().describe("Parent page id to create the page under. Default 1 («Головна») — the level the store's info pages live on."),
  title: z.string().describe("Page title (Ukrainian / primary language). Required."),
  slug: z.string().optional().describe("URL slug (latin). Omit to auto-transliterate from the title."),
  seoTitle: z.string().optional().describe("SEO <title> (UA)."),
  seoKeywords: z.string().optional().describe("SEO keywords (UA)."),
  seoDescription: z.string().optional().describe("SEO meta description (UA)."),
  h1: z.string().optional().describe("H1 heading (UA)."),
  text: z.string().optional().describe("Page BODY HTML (UA) — extra[i18n][L][text], the visible content of the page."),
  ru: z
    .object({
      title: z.string().optional(),
      seoTitle: z.string().optional(),
      seoKeywords: z.string().optional(),
      seoDescription: z.string().optional(),
      h1: z.string().optional(),
      text: z.string().optional(),
    })
    .optional()
    .describe("Russian (i18n index 1) block: title / seoTitle / seoKeywords / seoDescription / h1 / text."),
  inMenu: z.boolean().optional().describe("Show the page in the site menu (names[inmenu]). Default: leave the form's default."),
  template: z
    .union([z.number().int(), z.string()])
    .optional()
    .describe("Display template id (names[handler]). Omit to auto-pick the store's «Текстовая страница» template."),
  dryRun: z.boolean().optional().describe("Default true: preview the plan without creating. Set false to create."),
};

export const adminCategoryTools: ToolSpec[] = [
  {
    name: "horoshop_admin_page_create",
    title: "Create an info/text page that actually opens on the storefront",
    description:
      "Create a text/info page (Доставка, Оплата, Про нас, Гарантія…) under `parent` in one call, WITH a working URL. Writes the title and full SEO meta per language (top-level fields = Ukrainian, an optional `ru` object = Russian), persists the URL slug, and writes the page BODY. Returns the new id, the slug, the link and a REAL storefront HTTP status for it. " +
      "WHERE THE BODY LANDS IS RESOLVED, NOT FIXED: the text goes into `<ns>[i18n][L][text]` when the chosen template renders that field, and FALLS BACK to `<ns>[i18n][L][seo_text]` when it does not. Both report success, so on a non-default template your page body can end up in the SEO-text block instead of the body — read the field names in `bodyPersisted` to see which one actually took it. `bodySkipped` appears only when the form has neither. " +
      "USE THIS INSTEAD OF horoshop_admin_record_save entity=pages id=addnew: a page's slug is not a plain field but is owned by the `zteel.params.url` widget, and writing names[name][slug] persists ONLY when names[name][parent] carries the resolved p_name-row id. Without it the slug is dropped in silence — the record is created, the admin form reads back fine, page_seo_set reports \"all changes verified\", and the storefront answers 404 in every language. Measured live: created that way /zz2a-testpage/ → 404; the same record with the resolved parent → 200. " +
      "Two steps internally (the blank create form does not render the extra block): the node is created, then the body is written to its extra block and verified by re-reading. The display template (names[handler]) auto-picks the store's «Текстовая страница» unless you pass `template`. DRY RUN BY DEFAULT — pass dryRun:false to create. Remove a page with horoshop_admin_record_delete entity=pages.",
    inputSchema: pageCreateSchema,
    annotations: { readOnlyHint: false, idempotentHint: false },
    handler: async (client, args) => {
      const parent = args.parent === undefined ? 1 : Number(args.parent);
      const titleUa = typeof args.title === "string" ? args.title : "";
      if (!titleUa) throw new Error("`title` is required to create a page.");

      // 1) Blank create form + the text-page display template.
      const form = await client.admin.getEditForm(args.store, pageTarget("addnew", parent));
      if (!form.fieldNames.has("names[handler]")) {
        throw new Error("The page create form has no names[handler] select — the admin markup changed or the session is invalid.");
      }
      const { template, options } = pickTextTemplate(form, args.template);
      if (!template) {
        throw new Error(
          `Could not auto-detect a text-page template. Pass 'template' explicitly — available names[handler] options: ${options
            .map((o) => `${o.value}=${o.label}`)
            .join(", ")}.`,
        );
      }

      // 2) THE WHOLE POINT — resolve the URL sub-tree parent, else the slug is
      // dropped and the page 404s while every report says "verified".
      const slugSeed = typeof args.slug === "string" && args.slug.length ? args.slug : titleUa;
      const resolved = await client.admin.resolveUrlParent(args.store, parent, slugSeed, 0);
      const slug = typeof args.slug === "string" && args.slug.length ? args.slug : resolved.slug;

      const nodeOverrides: Record<string, string> = {
        "names[parent]": String(parent),
        "names[handler]": String(template),
        ...metaOverrides(args),
      };
      if (slug) {
        nodeOverrides["names[name][slug]"] = slug;
        if (resolved.parent) nodeOverrides["names[name][parent]"] = resolved.parent;
      }
      if (typeof args.inMenu === "boolean") nodeOverrides["names[inmenu]"] = args.inMenu ? "1" : "0";

      const bodies: Record<Lang, string | undefined> = { ua: args.text, ru: args.ru?.text };
      const hasBody = LANGS.some((l) => typeof bodies[l] === "string");

      if (args.dryRun !== false) {
        return {
          store: args.store ?? null,
          action: "page_create",
          dryRun: true,
          parent,
          template: `${template}${options.find((o) => o.value === String(template)) ? ` (${options.find((o) => o.value === String(template))!.label})` : ""}`,
          slug,
          slugResolved: resolved.parent
            ? `name-parent ${resolved.parent}`
            : "UNRESOLVED — the slug would NOT persist and the page would 404; check `parent`",
          link: slug ? `/${slug}/` : null,
          nodeFields: Object.keys(nodeOverrides),
          body: hasBody ? LANGS.filter((l) => typeof bodies[l] === "string").map((l) => `${l}.text`) : null,
          note: "Set dryRun:false to create. The node is created first, then the body is written to its extra block; the answer carries the storefront's real HTTP status for the new URL.",
        };
      }

      // 3) Create the node; identify it by diffing the tree under `parent`.
      const before = await pageIdsUnder(client, args.store, parent);
      const createRes = await client.admin.save(args.store, form, nodeOverrides);
      const after = await pageIdsUnder(client, args.store, parent);
      const fresh = [...after].filter((id) => !before.has(id));
      const newId = fresh.length === 1 ? fresh[0] : null;
      if (!newId) {
        return {
          store: args.store ?? null,
          action: "page_create",
          dryRun: false,
          created: fresh.length > 0,
          httpStatus: createRes.httpStatus,
          storefrontReachable: false,
          note:
            fresh.length > 1
              ? `Created but ${fresh.length} new pages appeared at once (ambiguous): ${fresh.join(", ")}.`
              : `Submitted (HTTP ${createRes.httpStatus}) but no new page appeared under ${parent} — the save was likely rejected. Check horoshop_admin_list entity=pages.`,
        };
      }

      // 4) Body into the extra block (it only renders once the node exists).
      const recForm = await client.admin.getEditForm(args.store, pageTarget(newId, parent));
      const base = resolveBase(recForm);
      const ns = base ? nsOf(base) : "extra";
      const bodyPersisted: Record<string, boolean> = {};
      const bodySkipped: string[] = [];
      if (hasBody) {
        const extras: Record<string, string> = {};
        for (const lang of LANGS) {
          const v = bodies[lang];
          if (typeof v !== "string") continue;
          const field = bodyFieldName(recForm, ns, LANG_INDEX[lang]);
          if (!field) {
            bodySkipped.push(`${lang}.text (no ${ns}[i18n][${LANG_INDEX[lang]}][text] on this template's form)`);
            continue;
          }
          extras[field] = v;
        }
        if (Object.keys(extras).length) {
          await client.admin.save(args.store, recForm, extras);
          const verify = await client.admin.getEditForm(args.store, pageTarget(newId, parent));
          for (const [field, value] of Object.entries(extras)) bodyPersisted[field] = fieldValue(verify, field) === value;
        }
      }

      // 5) Read the slug the record ACTUALLY kept, then ask the storefront.
      const finalForm = await client.admin.getEditForm(args.store, pageTarget(newId, parent));
      const finalSlug = finalForm.fieldNames.has("names[name][slug]") ? fieldValue(finalForm, "names[name][slug]") : "";
      const link = finalSlug ? `/${finalSlug}/` : null;
      const front = link ? await storefrontStatus(client, args.store, link) : null;
      const reachable = front === null ? null : front >= 200 && front < 400;
      const bodyOk = Object.values(bodyPersisted).every(Boolean);

      return {
        store: args.store ?? null,
        action: "page_create",
        dryRun: false,
        created: true,
        newId,
        httpStatus: createRes.httpStatus,
        template: String(template),
        namespace: ns,
        slug: finalSlug || null,
        link,
        storefrontStatus: front,
        storefrontReachable: reachable,
        bodyPersisted,
        ...(bodySkipped.length ? { bodySkipped } : {}),
        note: !finalSlug
          ? `Page ${newId} was created but kept NO slug, so it has no URL and the storefront will 404. The URL-tree parent resolved to "${resolved.parent || "(nothing)"}" — check that \`parent\` (${parent}) is a real page id.`
          : reachable === false
            ? `Page ${newId} created at ${link}, but the storefront answered HTTP ${front} — it is NOT reachable by a buyer yet. (A brand-new page can need a moment; re-check before assuming it is broken.)`
            : reachable === null
              ? `Created page ${newId} at ${link}. The storefront check did not run (the shop did not answer) — verify the URL yourself.`
              : `Created page ${newId} at ${link} — storefront HTTP ${front}.${bodyOk ? "" : " Part of the body did not persist; verify in the admin."}`,
      };
    },
  },
  {
    name: "horoshop_admin_category_create",
    title: "Create a catalog category (SEO + SEO-text + cover) in one call",
    description:
      "Create a catalog category under `parent` in one call — the tool the «semantic core → structure» pipeline uses to build a category tree. Writes the title and full SEO meta (title/keywords/description/H1) per language (top-level fields = Ukrainian, an optional `ru` object = Russian), attempts the URL slug (auto-transliterated from the title unless you pass `slug`), and sets the category SEO-text (extra[i18n][L][seo_text] — NOT the page body), the discount and the in-popular-menu / show-nav / show-pages-only / list-view flags. A `cover` image (url / base64 / data URI) is uploaded as a real file through the same multipart save.php. Two-step internally: the node is created, then its extra block + cover are written and VERIFIED by re-reading (seo_text reads back, cover's [value] becomes a /content/… path). The display template (names[handler]) auto-picks the store's «КАТАЛОГ: Товар» template unless you pass `template`. Returns the new category id, slug and storefront link. DRY RUN BY DEFAULT — pass dryRun:false to create. Remove a test category with horoshop_admin_record_delete entity=pages (parent = the same parent). " +
      "⚠ THE SLUG IS NOT GUARANTEED. Horoshop accepts it only when the title/slug is unique in that URL sub-tree; on a collision it stores the category WITHOUT a public URL and reports nothing. The category then exists, reads back fine and carries all its SEO — and simply is not on the storefront (seen live: category 1085). READ THE `slug` / `link` FIELDS OF THE ANSWER, not the note: `slug:null` means the category has no address. Fix it by giving the category a distinct title, or set the slug afterwards on a unique name. " +
      "⚠ NOT ATOMIC, BUT NO LONGER SILENT ABOUT IT — the two steps can still fail apart, and when step 2 fails the answer now tells you so instead of throwing. A cover that will not download (a 404 on the image URL is enough) no longer costs you `newId` and no longer voids the SEO block: the cover part is skipped, the SEO-text and flags are still written, and you get `created:true` + `newId` + `partialFailure:{cover:\"…\", categoryExists:true, cleanup:\"…\"}` with a note naming the exact reason. So a step-2 failure is never mistaken for \"nothing was created\" — the earlier behaviour left an orphan in the tree that the caller had no id for (measured live: orphans 1084 and 1094) and a blind retry then made a second one. Rollback is deliberately NOT done: deleting a node that already holds your title and SEO is a destructive act to take on your behalf, and a failed rollback would leave the orphan anyway. On a partialFailure, either finish the category with horoshop_admin_category_update or delete it with horoshop_admin_record_delete entity=pages id=<newId> parent=<parent> — the answer prints that exact command.",
    inputSchema: createSchema,
    annotations: { readOnlyHint: false, idempotentHint: false },
    handler: async (client, args) => {
      const parent = Number(args.parent);
      const titleUa = typeof args.title === "string" ? args.title : "";
      if (!titleUa) throw new Error("`title` is required to create a category.");

      // 1) Read the blank create form and choose the display template.
      const form = await client.admin.getEditForm(args.store, pageTarget("addnew", parent));
      if (!form.fieldNames.has("names[handler]")) {
        throw new Error("The category create form has no names[handler] select — the admin markup changed or the session is invalid.");
      }
      const { template, options } = pickTemplate(form, args.template);
      if (!template) {
        throw new Error(
          `Could not auto-detect a catalog template. Pass 'template' explicitly — available names[handler] options: ${options
            .map((o) => `${o.value}=${o.label}`)
            .join(", ")}.`,
        );
      }

      // 2) Resolve the URL sub-tree parent so the slug persists (else storefront 404s).
      const slugSeed = typeof args.slug === "string" && args.slug.length ? args.slug : titleUa;
      const resolved = await client.admin.resolveUrlParent(args.store, parent, slugSeed, 0);
      const slug = typeof args.slug === "string" && args.slug.length ? args.slug : resolved.slug;

      const meta = metaOverrides(args);
      const nodeOverrides: Record<string, string> = {
        "names[parent]": String(parent),
        "names[handler]": String(template),
        ...meta,
      };
      if (slug) {
        nodeOverrides["names[name][slug]"] = slug;
        if (resolved.parent) nodeOverrides["names[name][parent]"] = resolved.parent;
      }
      if (typeof args.inMenu === "boolean") nodeOverrides["names[inmenu]"] = args.inMenu ? "1" : "0";

      const hasCover = !!(args.cover && (args.cover.url || args.cover.base64));
      const willExtras = extraOverrides(args, "extra"); // ns filled in for real at step 2

      if (args.dryRun !== false) {
        return {
          store: args.store ?? null,
          action: "category_create",
          dryRun: true,
          parent,
          template: `${template}${options.find((o) => o.value === String(template)) ? ` (${options.find((o) => o.value === String(template))!.label})` : ""}`,
          slug,
          slugResolved: resolved.parent ? `name-parent ${resolved.parent}` : "UNRESOLVED (slug may not persist)",
          nodeFields: Object.keys(nodeOverrides),
          extraFields: Object.keys(willExtras).map((k) => k.replace(/^extra/, "extra|extra_parent")),
          cover: hasCover ? "will upload after create (<base>[image][file])" : null,
          note: "Set dryRun:false to create. Node is created first, then SEO-text/flags/cover are written to its extra block and verified.",
        };
      }

      // 3) Create the node; find its new id by diffing the pages tree under `parent`.
      const before = await pageIdsUnder(client, args.store, parent);
      const createRes = await client.admin.save(args.store, form, nodeOverrides);
      const after = await pageIdsUnder(client, args.store, parent);
      const fresh = [...after].filter((id) => !before.has(id));
      const newId = fresh.length === 1 ? fresh[0] : null;
      if (!newId) {
        return {
          store: args.store ?? null,
          action: "category_create",
          dryRun: false,
          created: fresh.length > 0,
          httpStatus: createRes.httpStatus,
          note:
            fresh.length > 1
              ? `Created but ${fresh.length} new pages appeared at once (ambiguous): ${fresh.join(", ")}.`
              : `Submitted (HTTP ${createRes.httpStatus}) but no new page appeared under ${parent} — the save was likely rejected. Check horoshop_admin_list entity=pages parent=${parent}.`,
        };
      }

      // 4) Step 2 — write the extra block (seo_text + flags) and the cover.
      //
      // ATOMICITY. From this line on the node EXISTS. Every failure below
      // used to escape as an exception and take `newId` with it: the caller saw a
      // bare "Fetching the image URL returned HTTP 404." and reasonably concluded
      // nothing had been created, while the tree had gained an orphan nobody knew
      // to clean up (measured twice — orphans 1084 and 1094). A "ложный ПРОВАЛ" is
      // the same defect as a false OK, pointed the other way.
      //
      // The answer is PARTIAL SUCCESS, not rollback. Deleting the node we just
      // made would be a destructive act taken on the caller's behalf, on a record
      // that already carries their title and SEO — and a rollback that itself
      // fails leaves the orphan AND a clean error, which is strictly worse than
      // what we have now. Returning the id costs the caller one decision and can
      // never destroy anything; auto-delete can. So: report the id, report the
      // exact reason the rest failed, and say how to remove it if unwanted.
      //
      // A broken cover also no longer voids the SEO block: only the cover part is
      // skipped, the rest of the write goes ahead.
      let ns = "extra";
      let extrasSaved = true;
      let coverPath: string | null = null;
      let coverError: string | null = null;
      let phase2Error: string | null = null;
      let finalSlug = slug;
      const seoTextPersisted: Record<string, boolean> = {};

      try {
        const recForm = await client.admin.getEditForm(args.store, pageTarget(newId, parent));
        const base = resolveBase(recForm);
        ns = base ? nsOf(base) : "extra";
        const extras = extraOverrides(args, ns);
        const files: MultipartFile[] = [];
        if (hasCover) {
          try {
            if (!base) throw new Error("the category form has no cover namespace (extra[image] / extra_parent[image])");
            files.push(await coverPart(client, base, args.cover));
          } catch (e) {
            coverError = e instanceof Error ? e.message : String(e);
          }
        }
        if (Object.keys(extras).length || files.length) {
          await client.admin.save(args.store, recForm, extras, files.length ? files : undefined);
          const verify = await client.admin.getEditForm(args.store, pageTarget(newId, parent));
          for (const field of Object.keys(extras)) {
            if (seoTextRe.test(field)) seoTextPersisted[field] = fieldValue(verify, field) === extras[field];
          }
          extrasSaved = Object.values(seoTextPersisted).every(Boolean);
          if (base) {
            const cv = verify.fieldNames.has(`${base}[value]`) ? fieldValue(verify, `${base}[value]`) : "";
            coverPath = cv || null;
          }
        }

        // 5) Read the persisted slug for the returned link.
        const finalForm = await client.admin.getEditForm(args.store, pageTarget(newId, parent));
        finalSlug = finalForm.fieldNames.has("names[name][slug]") ? fieldValue(finalForm, "names[name][slug]") : slug;
      } catch (e) {
        phase2Error = e instanceof Error ? e.message : String(e);
        extrasSaved = false;
      }

      const coverFailed = hasCover && (!!coverError || !coverPath);
      const partial = !!coverError || !!phase2Error || !extrasSaved || coverFailed;
      const cleanup = `horoshop_admin_record_delete entity=pages id=${newId} parent=${parent}`;

      return {
        store: args.store ?? null,
        action: "category_create",
        dryRun: false,
        created: true,
        newId,
        httpStatus: createRes.httpStatus,
        template: String(template),
        namespace: ns,
        slug: finalSlug || null,
        link: finalSlug ? `/${finalSlug}/` : null,
        seoTextPersisted,
        extrasSaved,
        cover: hasCover ? { uploaded: !!coverPath, path: coverPath, ...(coverError ? { error: coverError } : {}) } : null,
        ...(partial
          ? {
              partialFailure: {
                ...(coverError ? { cover: coverError } : {}),
                ...(!coverError && coverFailed ? { cover: "the upload went through but the category's image field came back empty" } : {}),
                ...(phase2Error ? { extraBlock: phase2Error } : {}),
                ...(!phase2Error && !extrasSaved ? { extraBlock: "part of the SEO-text / flags block did not read back after saving" } : {}),
                categoryExists: true,
                cleanup,
              },
            }
          : {}),
        note: partial
          ? `PARTIAL SUCCESS — the category EXISTS (id ${newId}${finalSlug ? `, /${finalSlug}/` : ""}), but part of step 2 failed: ` +
            [
              coverError ? `cover not uploaded — ${coverError}` : coverFailed ? "cover not uploaded — the image field came back empty" : "",
              phase2Error ? `extra block not written — ${phase2Error}` : !extrasSaved ? "part of the SEO-text / flags did not persist" : "",
            ]
              .filter(Boolean)
              .join("; ") +
            `. This is NOT a failed create: do not retry blindly or you get a second category. Either finish it with horoshop_admin_category_update (id ${newId}), or remove it with ${cleanup}.` +
            (finalSlug
              ? ""
              : ` It also has NO PUBLIC URL: the slug did not persist (usually a title collision in this sub-tree).`)
          : `Created category ${newId}${finalSlug ? ` at /${finalSlug}/` : ""}${hasCover ? ` with cover ${coverPath}` : ""}.` +
            (finalSlug
              ? ""
              : ` NO PUBLIC URL: the slug did not persist (usually a title collision in this sub-tree), so the category exists in the admin but is not reachable on the storefront. Give it a distinct title and set the slug again.`),
      };
    },
  },
  {
    name: "horoshop_admin_category_update",
    title: "Update a catalog category (title, SEO, SEO-text, flags, cover)",
    description:
      "Update an existing catalog category by id. Read-modify-write: only the fields you pass change. Sets title + SEO meta per language (top-level = Ukrainian, `ru` object = Russian), the category SEO-text (extra[i18n][L][seo_text], namespace resolved automatically), the discount and menu/nav/list-view flags, and replaces the cover (url / base64 / data URI) via direct multipart. To change the slug pass `slug` AND `parent` (the URL tree parent is re-resolved — this is what makes a rename persist; see below). Verifies by re-reading: SEO-text must read back and a replaced cover's [value] path must change. DRY RUN BY DEFAULT — pass dryRun:false to persist. " +
      "RENAMING THE URL OF AN EXISTING CATEGORY WORKS, and `parent` is what makes it work. Re-measured live end to end: a category created at /zzw13-slug-before/ was updated with slug+parent; the form field `names[name][slug]` read back as the new value, the NEW address then answered HTTP 200 and the OLD one HTTP 301 — Horoshop lays that redirect itself, you do not have to add one. This REPLACES an earlier note claiming the rename does not persist: that was measured before the URL-tree parent was re-resolved on update, and it is no longer true. The old behaviour is still what you get if you omit `parent` — the save is accepted and the old address stays — so pass both. Creating the category at the wanted address (horoshop_admin_category_create) remains the cheaper route when it does not exist yet. " +
      "BULK PAYLOAD FROM DISK: a category's SEO text runs to 16 KB and will not fit in a tool argument — do NOT hand-roll a getEditForm+save for it. Pass `payloadFile`, an ABSOLUTE path to a JSON file with the same argument names (e.g. {\"seoText\":\"…\",\"ru\":{\"seoText\":\"<16 KB>\"}}). Mutually exclusive with the inline content fields; dryRun works the same. " +
      "ADD A BLOCK WITHOUT RESENDING THE TEXT: to extend an existing SEO-text rather than rewrite it, pass `append` (or `prepend`) — {\"seoText\":\"…\"} for Ukrainian, {\"ru\":{\"seoText\":\"…\"}} for Russian. The stored 16 KB is read, the delta is glued on, and the result is written; the existing copy never travels through the conversation and cannot be corrupted in transit. Conflicts with `seoText` for the same language are an error. " +
      "ANSWER SIZE: a persisted long value is reported as {length, tail, sha256}, not echoed as from+to+now; a failed one keeps expected/actual previews and the first differing offset. verbose:true restores the full diff. " +
      PLACEHOLDER_GUARD_DOC,
    inputSchema: updateSchema,
    annotations: { readOnlyHint: false, idempotentHint: true },
    handler: async (client, rawArgs) => {
      const args = withPayloadFile(rawArgs, updateSchema, "horoshop_admin_category_update");
      const src = args.payloadFileUsed ? { payloadFile: args.payloadFileUsed } : {};
      const form = await client.admin.getEditForm(args.store, pageTarget(args.id, args.parent));
      const base = resolveBase(form);
      if (!base) {
        throw new Error(`Category ${args.id} not found — its edit form has no cover/extra block (neither extra[image] nor extra_parent[image]). Check the id with horoshop_admin_list entity=pages.`);
      }
      const ns = nsOf(base);

      const nodeOverrides: Record<string, string> = { ...metaOverrides(args) };
      if (typeof args.inMenu === "boolean") nodeOverrides["names[inmenu]"] = args.inMenu ? "1" : "0";
      // Slug change needs the resolved URL-tree parent (else it silently drops).
      let slugResolved: string | null = null;
      if (typeof args.slug === "string" && args.slug.length) {
        if (args.parent === undefined) {
          throw new Error("Changing `slug` needs `parent` (the category's parent page id) to resolve the URL tree.");
        }
        const r = await client.admin.resolveUrlParent(args.store, Number(args.parent), args.slug, args.id);
        nodeOverrides["names[name][slug]"] = args.slug;
        if (r.parent) nodeOverrides["names[name][parent]"] = r.parent;
        slugResolved = r.parent || null;
      }
      const extras = extraOverrides(args, ns);
      const overrides: Record<string, string> = { ...nodeOverrides, ...extras };

      // APPEND / PREPEND onto the STORED SEO-text: a category's seo_text runs to
      // 16 KB, so "add one block at the end" must not mean shipping 16 KB back.
      const spliceCells = (m: any): string[] =>
        m ? (["ua", "ru"] as const).filter((l) => typeof (l === "ua" ? m.seoText : m.ru?.seoText) === "string").map((l) => `${l}.seoText`) : [];
      const setCells = [
        ...(typeof args.seoText === "string" ? ["ua.seoText"] : []),
        ...(typeof args.ru?.seoText === "string" ? ["ru.seoText"] : []),
      ];
      assertNoSpliceConflict(setCells, [...spliceCells(args.append), ...spliceCells(args.prepend)], "seoText");
      const spliced: Record<string, { mode: string; delta: string }> = {};
      for (const lang of LANGS) {
        const pre = lang === "ua" ? args.prepend?.seoText : args.prepend?.ru?.seoText;
        const app = lang === "ua" ? args.append?.seoText : args.append?.ru?.seoText;
        if (typeof pre !== "string" && typeof app !== "string") continue;
        const field = `${ns}[i18n][${LANG_INDEX[lang]}][seo_text]`;
        if (!form.fieldNames.has(field)) {
          throw new Error(
            `append/prepend target ${lang}.seoText (${field}) is not on category ${args.id}'s form — nothing to splice onto. Write it with \`seoText\` instead.`,
          );
        }
        const from = fieldValue(form, field);
        const to = splice({ current: from, append: app, prepend: pre });
        if (from === to) continue;
        overrides[field] = to;
        spliced[field] = {
          mode: [typeof pre === "string" ? "prepend" : "", typeof app === "string" ? "append" : ""].filter(Boolean).join("+"),
          delta: `${pre ?? ""}${app ?? ""}`,
        };
      }

      const hasCover = !!(args.cover && (args.cover.url || args.cover.base64));
      if (Object.keys(overrides).length === 0 && !hasCover) {
        throw new Error("Nothing to update — pass at least one title/SEO/SEO-text/flag field, an append/prepend delta, a slug, or a cover.");
      }
      const verbose = args.verbose === true;

      const planned: Array<Record<string, any>> = Object.entries(overrides).map(([field, to]) => {
        const from = fieldValue(form, field);
        const s = spliced[field];
        return s
          ? { field, mode: s.mode, from, to, delta: s.delta, length: { before: from.length, delta: s.delta.length, after: to.length } }
          : { field, from, to };
      });
      const beforeCover = form.fieldNames.has(`${base}[value]`) ? fieldValue(form, `${base}[value]`) : "";
      // TEMPLATE TOKENS — see admin/placeholders.ts.
      const placeholderWarnings = scanPlaceholderLoss(planned);

      if (args.dryRun !== false) {
        return {
          store: args.store ?? null,
          action: "category_update",
          id: String(args.id),
          dryRun: true,
          namespace: ns,
          slugResolved,
          ...src,
          ...(placeholderWarnings.length
            ? { placeholderWarnings, placeholderNote: placeholderPreviewNote(placeholderWarnings) }
            : {}),
          willChange: planned.map((p) => compactPreview(p, verbose)),
          cover: hasCover ? "will replace (<base>[image][file])" : null,
        };
      }
      assertPlaceholdersKept(placeholderWarnings, args.allowPlaceholderLoss === true);

      const files: MultipartFile[] = [];
      if (hasCover) files.push(await coverPart(client, base, args.cover));
      const res = await client.admin.save(args.store, form, overrides, files.length ? files : undefined);

      const verify = await client.admin.getEditForm(args.store, pageTarget(args.id, args.parent));
      const changes = planned.map((p) => {
        const now = fieldValue(verify, p.field as string);
        return { ...p, now, persisted: now === p.to };
      });
      const afterCover = verify.fieldNames.has(`${base}[value]`) ? fieldValue(verify, `${base}[value]`) : "";
      const coverChanged = hasCover ? afterCover !== "" && afterCover !== beforeCover : null;
      const textOk = changes.every((c) => c.persisted);
      const reported = changes.map((c) => compactVerified(c, verbose));
      const compacted = wasCompacted(reported);
      return {
        store: args.store ?? null,
        action: "category_update",
        id: String(args.id),
        dryRun: false,
        namespace: ns,
        saved: textOk && coverChanged !== false,
        httpStatus: res.httpStatus,
        ...src,
        ...(placeholderWarnings.length
          ? { placeholderLossAllowed: placeholderWarnings, placeholderNote: placeholderOverrideNote(placeholderWarnings) }
          : {}),
        changes: reported,
        cover: hasCover ? { changed: coverChanged, path: afterCover || null, was: beforeCover || null } : null,
        note:
          (textOk ? "Saved and verified by re-reading the category." : "Some fields did not persist — check field names / admin validation.") +
          (compacted ? ` ${COMPACT_NOTE}` : ""),
      };
    },
  },
];
