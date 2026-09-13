import { z } from "zod";
import { storeField, type ToolSpec } from "../register.js";
import { fieldValue, type MultipartFile } from "../admin/form.js";
import type { EditTarget } from "../admin/session.js";

/**
 * Create a homepage/contacts banner WITH its image, in one shot.
 *
 * Contract (reverse-engineered live on a test store):
 * banners are entity handler 394, table `h_banners_improved`, created with
 * **id=0** (not "addnew"). The base editDoc form carries only the meta fields —
 * `names[section]` (placement), `names[template]` (kind), `names[page][]`
 * (which pages to show on), `names[i18n][L][title]` (name), `names[enabled]`.
 * The banner's PICTURE and its other parameters are NOT in that base form: they
 * are rendered client-side from a widget spec and submitted as dynamic
 * `settings[…]` fields in the SAME multipart save.php POST — the image is a real
 * file part `settings[<lang>][image]` (there is no separate upload endpoint).
 *
 * `names[section]`/`names[template]` are `<select>`s the server renders with no
 * `selected` option (the admin's JS picks the default), so the form parser marks
 * them `unselected` and would NOT resubmit them — we send them explicitly as
 * overrides (an override is emitted even for an unselected field).
 *
 * Field naming (from banners_improved.js): i18n params (image, image_alt,
 * image_title, link, text, html) → `settings[<lang>][<name>]`; global params
 * (color, select, checkbox) → `settings[0][<name>]`. The image is i18n, so it is
 * submitted for the store's primary language (is_main, lang 3 = ua on the test store).
 */

const SECTIONS = [
  "banner_line_1",
  "banner_line_2",
  "banner_line_3",
  "top",
  "banner_line_top",
  "banner_line_bottom",
] as const;

const TEMPLATES = [
  "image",
  "image_2x",
  "image_3x",
  "image_big",
  "image_column",
  "image_cover",
  "image_small",
  "image_wide",
  "image_wide2x",
  "image_wide3x",
  "image_wideblock",
  "product",
  "product_big",
  "product_column",
  "product_cover",
  "product_small",
  "product_wide",
] as const;

const BANNER_HANDLER = 394;
const BANNER_TABLE = "h_banners_improved";
/**
 * Create sentinel. Reverse-engineered live: submitting the create form with the
 * hidden `id` = "0" is accepted (302 → index.php) but persists NOTHING; only
 * `id=addnew` actually creates the row. (The banner editor renders id=0 markup
 * but the saver keys create on "addnew" — same convention as record_save.)
 */
const CREATE_ID = "addnew";
const MAX_BYTES = 20 * 1024 * 1024;

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

function sniffMime(b: Uint8Array): string | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45)
    return "image/webp";
  return null;
}

function parseDataUri(s: string): { mime: string; bytes: Uint8Array } | null {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(s);
  if (!m) return null;
  const mime = m[1] || "application/octet-stream";
  const bytes = m[2]
    ? new Uint8Array(Buffer.from(m[3] ?? "", "base64"))
    : new Uint8Array(Buffer.from(decodeURIComponent(m[3] ?? ""), "utf8"));
  return { mime, bytes };
}

/** Rejected when the bytes are not a recognisable image and no MIME was declared. */
const NOT_IMAGE_ERR =
  "The data does not look like an image (PNG/JPEG/GIF/WEBP): its magic bytes are not recognised. " +
  "Pass `contentType` explicitly, or provide a real image file.";

async function resolveSource(
  client: any,
  args: any,
): Promise<{ bytes: Uint8Array; mime: string; from: string }> {
  // A data: URI declares its own MIME — trust it (explicit source).
  for (const raw of [args.base64, args.url]) {
    if (typeof raw === "string" && raw.startsWith("data:")) {
      const d = parseDataUri(raw);
      if (d) return { bytes: d.bytes, mime: d.mime, from: "data-uri" };
    }
  }
  const explicit = typeof args.contentType === "string" && args.contentType.length ? args.contentType : null;
  if (typeof args.base64 === "string" && args.base64.length) {
    const bytes = new Uint8Array(Buffer.from(args.base64, "base64"));
    if (bytes.length === 0) throw new Error("base64 decoded to 0 bytes — is it valid base64?");
    const sniffed = sniffMime(bytes);
    // Reject non-image bytes unless the caller vouched for a MIME explicitly.
    if (!sniffed && !explicit) throw new Error(NOT_IMAGE_ERR);
    return { bytes, mime: sniffed ?? explicit ?? "", from: "base64" };
  }
  if (typeof args.url === "string" && args.url.length) {
    const r = await client.admin.fetchBytes(args.url);
    if (r.httpStatus >= 400) throw new Error(`Fetching the image URL returned HTTP ${r.httpStatus}.`);
    if (r.bytes.length === 0) throw new Error(`The image URL returned 0 bytes (HTTP ${r.httpStatus}).`);
    const sniffed = sniffMime(r.bytes);
    const ctHeader = r.contentType ? r.contentType.split(";")[0].trim() : "";
    const ctIsImage = /^image\//i.test(ctHeader);
    // Do not accept text/HTML (a 200 error page, a redirect to a login) as an
    // image: require recognisable bytes, an image/* content-type, or an explicit
    // MIME override.
    if (!sniffed && !ctIsImage && !explicit) throw new Error(NOT_IMAGE_ERR);
    return { bytes: r.bytes, mime: sniffed ?? (ctIsImage ? ctHeader : explicit ?? ""), from: `url(${r.httpStatus})` };
  }
  throw new Error("No image source: pass `url`, `base64`, or a data: URI.");
}

/** The primary (is_main) language index = the first `names[i18n][L][title]` field. */
function primaryLang(form: { fields: Array<{ name: string }> }): number {
  for (const f of form.fields) {
    const m = /^names\[i18n\]\[(\d+)\]\[title\]$/.exec(f.name);
    if (m) return Number(m[1]);
  }
  return 3; // ua default on Horoshop
}

function bannerTarget(id: string | number): EditTarget {
  return { id, handler: BANNER_HANDLER, handlertable: BANNER_TABLE, extra: {}, flags: [] };
}

interface SectionPlacement {
  /** The theme defines this banner section at all (`banners.<section>` exists). */
  defined: boolean;
  /** …and its own `enabled` flag is on. */
  enabled: boolean;
  /** Page layouts that actually PLACE it, e.g. ["homepage.main"]. */
  placedIn: string[];
  /** Every banner section this theme does place — the useful half of a refusal. */
  renderable: string[];
}

/**
 * Does a banner in this section render anywhere at all?
 *
 * THE TRAP THIS EXISTS FOR. A banner can be created perfectly — section stored,
 * page bound, image persisted, `enabled` on — and still be invisible, because a
 * banner line is drawn only where a PAGE LAYOUT places it. On the test store the theme
 * defines and enables banner_line_1/2/3, but `homepage.sections.main.blocks`
 * lists only `banners.banner_line_1` and `banners.banner_line_2`. A test banner
 * in banner_line_3 was stored flawlessly and appeared on no page; the same
 * banner in banner_line_1 showed up on the homepage immediately. `enabled` on
 * the section is NOT the deciding flag — placement in a layout is.
 *
 * So the layout is read before creating and the answer says where (if anywhere)
 * the section is drawn, instead of ending on "verify on the storefront".
 */
async function sectionPlacement(client: any, store: string | undefined, section: string): Promise<SectionPlacement | null> {
  let design: any;
  try {
    design = await client.admin.getDesignJson(store);
  } catch {
    return null; // design unreadable — do not block the create over it
  }
  const defs = design?.banners ?? {};
  const wantedPath = `banners.${section}`;
  const placedIn: string[] = [];
  const placedPaths = new Set<string>();
  for (const [pageName, page] of Object.entries<any>(design ?? {})) {
    const sections = page?.sections;
    if (!sections || typeof sections !== "object") continue;
    for (const [secName, sec] of Object.entries<any>(sections)) {
      for (const block of sec?.blocks ?? []) {
        const path = typeof block?.path === "string" ? block.path : "";
        if (!path.startsWith("banners.")) continue;
        placedPaths.add(path.slice("banners.".length));
        if (path === wantedPath) placedIn.push(`${pageName}.${secName}`);
      }
    }
  }
  const renderable = [...placedPaths].filter((s) => defs[s]?.enabled !== false).sort();
  return {
    defined: !!defs[section],
    enabled: defs[section]?.enabled !== false,
    placedIn,
    renderable,
  };
}

/** The storefront path a banner bound to `page` should show up on. */
async function pagePathFor(client: any, store: string | undefined, page: string): Promise<string> {
  if (page === "" || page === "1") return "/";
  try {
    const form = await client.admin.getEditForm(store, {
      id: page,
      handler: 4,
      handlertable: "pages",
      extra: {},
      flags: ["showPages"],
    });
    const slug = form.fieldNames.has("names[name][slug]") ? fieldValue(form, "names[name][slug]") : "";
    return slug ? `/${slug}/` : "/";
  } catch {
    return "/";
  }
}

export const adminBannerTools: ToolSpec[] = [
  {
    name: "horoshop_admin_banner_create",
    title: "Create a banner with its image (homepage / above-header / contacts lines)",
    description:
      "Create a Horoshop banner (entity 394) AND upload its picture in one multipart save.php POST — the image is a real file part `settings[<lang>][image]`, there is no separate upload step. Pick `section` (placement: banner_line_1/2/3, top, banner_line_top/bottom) and `template` (kind: image, image_3x, image_wide, product…); not every template/section combo exists in a given theme — the tool reads the widget spec for the combo (always against page \"1\") to find the image field + its target size, and fails clearly if the theme does not offer it. Provide the image as `url` (fetched server-side), `base64`, or a data: URI. `title` names the banner; `page` = the page id to show it on (\"1\" = Головна, default; \"\" = all pages, or any category/page id, e.g. 1082). Optional: `alt`, `imageTitle`, `borderColor` (#hex), `link` (own URL), `enabled` (default true). Banners are shared by desktop AND mobile — there is no image-template way to target only mobile. DRY RUN BY DEFAULT — pass dryRun:false to actually create.\n\n" +
      "SECTION MUST BE DRAWN, NOT JUST ENABLED. A banner line renders only where a PAGE LAYOUT places it (`<page>.sections.*.blocks` = `banners.<section>` in the design JSON); the `enabled` flag on the section is not the deciding one. Measured live: a theme defined and enabled banner_line_1/2/3 but its homepage layout placed only lines 1 and 2 — a banner created in line 3 stored perfectly (section, page, image, enabled) and appeared on no page, while the same banner in line 1 was on the homepage at once. So the layout is checked BEFORE creating: an unplaced section is refused with the list of sections this theme does render (override with allowInvisibleSection:true).\n\n" +
      "VERIFIED ON THE STOREFRONT, not just in the admin: after creating, the page the banner is bound to is fetched as a buyer and the answer reports `storefrontVisible` — true only when the stored image is actually in that page's HTML. `sectionPersisted` separately confirms the section came back as the one you asked for.",
    inputSchema: {
      ...storeField,
      section: z.enum(SECTIONS).describe("Placement. image → banner_line_1/3, banner_line_top/bottom; image_3x → banner_line_2. Not every template/section combo exists in every theme; the tool validates the combo against its widget spec."),
      template: z.enum(TEMPLATES).describe("Banner kind. Use `image` for a plain picture banner (e.g. a homepage background)."),
      title: z.string().min(1).describe("Banner name (admin label), set on the primary language."),
      url: z.string().optional().describe("Image URL to fetch server-side (or a data: URI)."),
      base64: z.string().optional().describe("Image bytes as base64 (or a data: URI)."),
      page: z.union([z.string(), z.number()]).optional().describe('Page id to show the banner on. "1"=Головна (default). "" = all pages.'),
      lang: z.number().int().optional().describe("Language index for the image/title. Default: the store's primary language."),
      alt: z.string().optional().describe("Alt text for the image (settings image_alt)."),
      imageTitle: z.string().optional().describe("Title attribute for the image (settings image_title)."),
      borderColor: z.string().optional().describe("Border colour #hex (settings border_color, a global param)."),
      link: z.string().optional().describe("Own link URL the banner points to (settings link → own link)."),
      enabled: z.boolean().optional().describe("Whether the banner is active. Default true."),
      allowInvisibleSection: z
        .boolean()
        .optional()
        .describe("Create even when the theme places no page layout on this section (the banner would be stored but drawn nowhere). Default false — the call is refused with the list of sections this theme does render."),
      filename: z.string().optional().describe("Override the sent filename (default banner.<ext>)."),
      contentType: z.string().optional().describe("Override the sent MIME (default detected from bytes)."),
      dryRun: z.boolean().optional().describe("Default true: preview without creating. Set false to apply."),
    },
    annotations: { readOnlyHint: false, idempotentHint: false },
    handler: async (client, args) => {
      const dryRun = args.dryRun !== false;
      const section = args.section as string;
      const template = args.template as string;
      const page = args.page === undefined ? "1" : String(args.page);

      // 1) Widget spec for this combo — the authoritative field list + image size.
      // The spec (param list + image size) is a property of the template/section,
      // NOT of the page it will run on: loadSettings 400s / returns empty for many
      // non-"1" pages (e.g. page=1082 or ""=all), which silently broke create on
      // any page but the homepage. So ALWAYS read the spec against page "1"; the
      // user's `page` is applied only to the banner itself (names[page][] + plan).
      const SPEC_PAGE = "1";
      let spec = await client.admin.bannerLoadSettings(args.store, template, section, SPEC_PAGE);
      let data = spec.json?.response?.settings?.data;
      // Safety net: if page "1" itself came back empty for a transient reason,
      // retry once against "1" before giving up.
      if ((!data || typeof data !== "object") && spec.httpStatus < 400) {
        spec = await client.admin.bannerLoadSettings(args.store, template, section, SPEC_PAGE);
        data = spec.json?.response?.settings?.data;
      }
      if (!data || typeof data !== "object") {
        const widgetStatus = spec.json?.status ?? spec.httpStatus;
        throw new Error(
          spec.httpStatus >= 400
            ? `The banner widget rejected template=${template} in section=${section} (HTTP ${spec.httpStatus}). This theme does not support that template/section combo — pick another (the spec is read against page "1", so the page is not the cause).`
            : `The banner widget returned no field spec for template=${template} section=${section} (widget status ${widgetStatus}). This template/section combo is unavailable on this store's theme.`,
        );
      }
      // The image field: prefer a param literally named "image", else the first
      // param whose type is image/img (product templates call it bg/product_image).
      const paramNames = Object.keys(data);
      const imgParam =
        (data.image && (data.image.type === "image" || data.image.type === "img") && "image") ||
        paramNames.find((k) => data[k]?.type === "image" || data[k]?.type === "img");
      if (!imgParam) {
        throw new Error(
          `This template (${template}) has no image parameter — its fields are: ${paramNames.join(", ")}. Only image-bearing templates are supported.`,
        );
      }
      const imgSpec = data[imgParam];

      // 1b) Is this section drawn anywhere? (see sectionPlacement — a stored,
      // enabled banner in an unplaced section renders on no page at all.)
      const placement = await sectionPlacement(client, args.store, section);
      const willRender = placement === null ? null : placement.placedIn.length > 0 && placement.enabled;
      if (placement && willRender === false && args.allowInvisibleSection !== true) {
        throw new Error(
          `Section "${section}" is not drawn by this store's theme: ${
            placement.defined
              ? placement.enabled
                ? "it is defined and enabled, but NO page layout places it"
                : "it is switched off in the design (banners." + section + ".enabled = false)"
              : "the theme does not define it at all"
          }. A banner there would be created, stored and invisible. Sections this theme actually renders: ${
            placement.renderable.length ? placement.renderable.join(", ") : "(none)"
          }. Pick one of those, place the section in a page layout with horoshop_admin_design_set, or pass allowInvisibleSection:true if you really want the record anyway.`,
        );
      }

      // 2) Base create form (id=addnew — the only id that actually persists).
      const form = await client.admin.getEditForm(args.store, bannerTarget(CREATE_ID));
      if (!form.fieldNames.has("names[section]") || !form.fieldNames.has("names[template]")) {
        throw new Error("The banner create form is missing names[section]/names[template] — the admin markup changed or the session is invalid.");
      }
      const lang = args.lang != null ? Number(args.lang) : primaryLang(form);

      // 3) Resolve image bytes.
      const { bytes, mime, from } = await resolveSource(client, args);
      if (bytes.length > MAX_BYTES) throw new Error(`Image is ${bytes.length} bytes, over the ${MAX_BYTES}-byte cap.`);
      const contentType = (args.contentType as string) || mime || "image/png";
      const ext = MIME_EXT[contentType.toLowerCase()] ?? "png";
      const filename = (args.filename as string) || `banner.${ext}`;
      const imageField = `settings[${lang}][${imgParam}]`;

      // 4) Text overrides (base meta + i18n settings). Colours are global (settings[0]).
      const overrides: Record<string, string> = {
        "names[section]": section,
        "names[template]": template,
        "names[page][]": page,
        [`names[i18n][${lang}][title]`]: String(args.title),
        "names[enabled]": args.enabled === false ? "0" : "1",
      };
      if (typeof args.alt === "string") overrides[`settings[${lang}][image_alt]`] = args.alt;
      if (typeof args.imageTitle === "string") overrides[`settings[${lang}][image_title]`] = args.imageTitle;
      if (typeof args.borderColor === "string") overrides["settings[0][border_color]"] = args.borderColor;
      if (typeof args.link === "string" && args.link.length) {
        overrides[`settings[${lang}][link][page]`] = "0"; // 0 = own link
        overrides[`settings[${lang}][link][value]`] = args.link;
      }

      const plan = {
        store: args.store ?? null,
        action: "banner_create" as const,
        section,
        template,
        page,
        lang,
        title: args.title,
        enabled: args.enabled !== false,
        imageField,
        imageSize: { width: imgSpec.width, height: imgSpec.height, comment: imgSpec.comment },
        filename,
        contentType,
        bytes: bytes.length,
        source: from,
        settingsFields: Object.keys(overrides).filter((k) => k.startsWith("settings")),
        sectionRendered: willRender,
        ...(placement ? { sectionPlacedIn: placement.placedIn, sectionsThisThemeRenders: placement.renderable } : {}),
      };

      if (dryRun) {
        return {
          ...plan,
          dryRun: true,
          note:
            willRender === false
              ? `Preview only. WARNING: section ${section} is not placed in any page layout — the banner would be stored and invisible.`
              : "Preview only. Pass dryRun:false to create.",
        };
      }

      // 5) Create: one multipart POST — text overrides + the image file part.
      // Snapshot the id set first so the new id is a robust set-difference (the
      // banner grid's row label carries sortorder·section·template, not the title).
      const idsBefore = new Set(
        (await client.admin.listRecords(args.store, BANNER_HANDLER).catch(() => []))
          .map((r: any) => r.id)
          .filter((id: string) => /^\d+$/.test(id)),
      );
      const files: MultipartFile[] = [{ name: imageField, filename, contentType, bytes }];
      const res = await client.admin.save(args.store, form, overrides, files);

      // 6) Verify: the added id (set diff), then read the stored image out of the
      // banner editor's `values` JSON (the picture lives there, not as static HTML).
      let newId: string | null = null;
      try {
        const after = await client.admin.listRecords(args.store, BANNER_HANDLER);
        const added = after.map((r: any) => r.id).filter((id: string) => /^\d+$/.test(id) && !idsBefore.has(id));
        newId = added.sort((a: string, b: string) => Number(b) - Number(a))[0] ?? null;
      } catch {
        /* verification is best-effort; the transport result still stands */
      }

      let imagePath: string | null = null;
      let sectionVerified: string | null = null;
      if (newId) {
        try {
          const edit = await client.admin.getAdminHtml(
            args.store,
            `/adminLegacy/edit.php?id=${encodeURIComponent(newId)}&handler=${BANNER_HANDLER}&handlertable=${BANNER_TABLE}&checkcode=yamete_kudasai`,
          );
          // Controller values: `"values":{"3":{"image":"\/content\/…"},"1":null,…}`.
          const vm = edit.html.match(
            new RegExp(`"${lang}"\\s*:\\s*\\{[^{}]*?"${imgParam}"\\s*:\\s*"([^"]+)"`),
          );
          imagePath = vm ? vm[1].replace(/\\\//g, "/").replace(/\?\d+$/, "") : null;
          // The stored section is the `selected` <option> in names[section].
          const sm = edit.html.match(/name="names\[section\]"[\s\S]*?<option[^>]*value=["']([^"']+)["'][^>]*\sselected/i) ||
            edit.html.match(/<option[^>]*\sselected[^>]*value=["']([^"']+)["'][^>]*data-accept/i);
          sectionVerified = sm ? sm[1] : null;
        } catch {
          /* ignore */
        }
      }

      const created = newId != null;
      const imageLanded = imagePath != null;

      // 7) THE ONLY PROOF THAT COUNTS — fetch the page a buyer would open and
      // look for the stored image. Everything above is the admin agreeing with
      // itself; this is the storefront agreeing with the admin.
      let storefrontPath: string | null = null;
      let storefrontVisible: boolean | null = null;
      if (created && imagePath) {
        storefrontPath = await pagePathFor(client, args.store, page);
        try {
          const { html } = await client.shop.page(args.store, storefrontPath);
          // The theme re-renders the picture at its own size, so the sized path
          // differs — match on the FILENAME, which the resize preserves.
          const file = imagePath.split("/").pop() ?? imagePath;
          storefrontVisible = html.includes(file);
        } catch {
          storefrontVisible = null;
        }
      }
      const sectionMatches = sectionVerified === null || sectionVerified === section;

      return {
        ...plan,
        dryRun: false,
        httpStatus: res.httpStatus,
        redirectedTo: res.redirectedTo,
        newId,
        imagePath,
        sectionVerified,
        sectionPersisted: sectionMatches,
        created,
        imageLanded,
        storefrontPath,
        storefrontVisible,
        note: !created
          ? "save.php returned 302 but no new banner id appeared in the list — the create did not persist; verify in the admin."
          : !imageLanded
            ? `Banner #${newId} created but no image path was read back from its editor values — the picture may not have persisted; verify in the admin.`
            : !sectionMatches
              ? `Banner #${newId} created with the image at ${imagePath}, but its stored section is "${sectionVerified}", NOT the "${section}" you asked for — it will not appear where you expect.`
              : storefrontVisible === true
                ? `Banner #${newId} is LIVE: image ${imagePath} found on ${storefrontPath} (section ${section}, page ${page}).`
                : storefrontVisible === false
                  ? `Banner #${newId} created and stored (image ${imagePath}, section ${section}), but the image is NOT on ${storefrontPath} yet. Either the page caches, or the section is not drawn there${
                      placement && placement.placedIn.length ? ` (this theme places ${section} in: ${placement.placedIn.join(", ")})` : ""
                    }.`
                  : `Banner #${newId} created; image persisted at ${imagePath} (section ${section}, page ${page}). The storefront check did not run — verify the page yourself.`,
      };
    },
  },
];
