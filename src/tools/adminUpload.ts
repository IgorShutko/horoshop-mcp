import { z } from "zod";
import { createHash } from "node:crypto";
import { storeField, type ToolSpec } from "../register.js";
import { fieldValue, type MultipartFile, type ParsedForm } from "../admin/form.js";
import { resolveEntity } from "../admin/entities.js";
import type { EditTarget } from "../admin/session.js";

/**
 * Real file upload into the admin panel.
 *
 * Contract (reverse-engineered live on a test store):
 * the media fields on the general-settings form and the cover image on a
 * category are plain `<input type=file>`s inside the same
 * `<form name=editDoc enctype=multipart/form-data action=/adminLegacy/save.php>`
 * — there is NO separate upload endpoint. Each file field is a triple:
 *   `extra[<field>][file]`  — the bytes (what a browser sends when you pick one)
 *   `extra[<field>][id]`    — id of the already-uploaded image (hidden)
 *   `extra[<field>][value]` — preview path (hidden)
 * favicon is the exception: `extra[favicon][file]` + `extra[favicon][helper]`,
 * no id. To upload we resend the whole form (read-modify-write) with a real
 * `[file]` part carrying the bytes; the server stores it into `[value]`.
 *
 * Field model (verified live): the `[id]` on each media field is a STABLE row
 * id — it does NOT change when you swap the picture. The image itself lives in
 * `[value]` (empty = no image, a `/content/…` path = set). So an upload is
 * proven by `[value]` going from empty to a path, and the revert to "no image"
 * is the admin's own removeImage flow (`removeImage(recordId, fieldId)`), not a
 * re-pointing of `[id]`.
 */

const SETTINGS_URL = "/adminLegacy/utils/site_settings.php?checkcode=yamete_kudasai";

/** handler/handlertable for the site-pages tree (categories carry the cover image). */
const PAGES_HANDLER = 4;
const PAGES_TABLE = "pages";

interface UploadTarget {
  /** Base field name; the file part is `${base}[file]`, the id `${base}[id]`. */
  base: string;
  label: string;
  /** favicon-style field: has `[helper]`, no `[id]` — cannot be restored by id. */
  noId?: boolean;
  /**
   * Where the field lives:
   *  - "settings"  — the general-settings singleton form
   *  - "category"  — a category edit form (needs `id`)
   *  - "record"    — ANY admin entity's edit form (needs `entity` + `id`)
   */
  scope: "settings" | "category" | "record";
  /** Entity slug for scope="record" (resolved through the entity registry). */
  entity?: string;
  /**
   * scope="record" fields whose file input has NO `[id]`/`[value]` siblings —
   * the whole triple is just the file part (external_service_files, a product's
   * image slot). Upload is then proven by the form/asset, not by `[value]`.
   */
  fileOnly?: boolean;
  defaultMime: string;
  defaultExt: string;
}

/**
 * NAMED targets. The eight originals are settings/category media; the rest are
 * the per-entity media fields the coverage census counted as UNREACHABLE — every
 * one is a plain `<input type=file>` inside that entity's own editDoc form, so
 * the same read-modify-write multipart save.php carries it. Field names verified
 * live on the test store (each with its `[id]`/`[value]` siblings, except where noted).
 */
const TARGETS: Record<string, UploadTarget> = {
  header_logo: { base: "extra[header_logo_image]", label: "Логотип в шапке", scope: "settings", defaultMime: "image/png", defaultExt: "png" },
  footer_logo: { base: "extra[footer_logo_image]", label: "Логотип в футере", scope: "settings", defaultMime: "image/png", defaultExt: "png" },
  print_logo: { base: "extra[print_logo_image]", label: "Логотип для печати/счетов", scope: "settings", defaultMime: "image/png", defaultExt: "png" },
  mobile_logo: { base: "extra[mobile_logo]", label: "Логотип для мобильной версии", scope: "settings", defaultMime: "image/png", defaultExt: "png" },
  og_image: { base: "extra[og_image_main]", label: "OG-изображение для соцсетей", scope: "settings", defaultMime: "image/jpeg", defaultExt: "jpg" },
  favicon: { base: "extra[favicon]", label: "Favicon", scope: "settings", noId: true, defaultMime: "image/x-icon", defaultExt: "ico" },
  watermark: { base: "extra[watermark]", label: "Водяной знак на фото товаров", scope: "settings", defaultMime: "image/png", defaultExt: "png" },
  category_cover: { base: "extra[image]", label: "Обложка категории", scope: "category", defaultMime: "image/jpeg", defaultExt: "jpg" },
  brand_logo: { base: "names[logo]", label: "Логотип бренда", scope: "record", entity: "brands", defaultMime: "image/png", defaultExt: "png" },
  benefit_image: { base: "names[image]", label: "Картинка преимущества магазина", scope: "record", entity: "benefits", defaultMime: "image/png", defaultExt: "png" },
  color_icon: { base: "names[icon]", label: "Картинка цвета", scope: "record", entity: "colors", defaultMime: "image/png", defaultExt: "png" },
  filter_color_icon: { base: "names[icon]", label: "Картинка цвета для фильтра", scope: "record", entity: "filter_colors", defaultMime: "image/png", defaultExt: "png" },
  payment_icon: { base: "payment_type[icon]", label: "Иконка способа оплаты", scope: "record", entity: "payment_methods", defaultMime: "image/png", defaultExt: "png" },
  admin_avatar: { base: "names[avatar]", label: "Аватар админа", scope: "record", entity: "admins", defaultMime: "image/jpeg", defaultExt: "jpg" },
  customer_avatar: { base: "names[avatar]", label: "Аватар клиента", scope: "record", entity: "customers", defaultMime: "image/jpeg", defaultExt: "jpg" },
  service_file: {
    base: "names[file][files][0]",
    label: "Файл верификации для внешнего сервиса",
    scope: "record",
    entity: "external_service_files",
    fileOnly: true,
    defaultMime: "text/plain",
    defaultExt: "txt",
  },
};
const TARGET_KEYS = Object.keys(TARGETS) as [string, ...string[]];

/** 20 MB ceiling — a logo/favicon is tiny; this only guards against a bad URL. */
const MAX_BYTES = 20 * 1024 * 1024;

/**
 * Ceiling for handing the REPLACED image back inline as base64.
 * A logo/favicon/cover is a few KB; anything past this is not a brand asset and
 * embedding it would bloat the tool answer, so over the cap we return the digest
 * and say plainly that the old picture is gone.
 */
const PREV_CAPTURE_MAX = 256 * 1024;

/**
 * Capture the image a replace is about to destroy.
 *
 * MEASURED on the test store, and it is the whole reason this exists: replacing a filled
 * media field does NOT keep the old file. Horoshop reports a fresh random name
 * in `[value]`, but the bytes at the PREVIOUS path are overwritten with the new
 * picture (old path → 200 serving the NEW image; the freshly reported path 404s
 * until the next save settles). And `[value]` is not writable — a record_save
 * that sets it answers `saved:false`. So neither the path nor the file can be
 * recovered AFTER the fact: "download the old URL later" retrieves the
 * replacement, not the original.
 *
 * Therefore the only revert that exists is the one prepared BEFORE the write.
 */
async function capturePrevious(
  client: any,
  store: string | undefined,
  path: string | null,
): Promise<Record<string, unknown> | null> {
  if (!path) return null;
  try {
    const r = await client.admin.fetchAsset(store, path);
    if (!r.ok) {
      return { value: path, captured: false, httpStatus: r.httpStatus, reason: `the current file does not serve (HTTP ${r.httpStatus}) — there is nothing to capture.` };
    }
    const url = r.url;
    const buf = Buffer.from(r.bytes);
    const sha256 = createHash("sha256").update(buf).digest("hex");
    const contentType = r.contentType ? r.contentType.split(";")[0].trim() : null;
    if (buf.length > PREV_CAPTURE_MAX) {
      return {
        value: path,
        captured: false,
        bytes: buf.length,
        sha256,
        contentType,
        reason: `the replaced image is ${buf.length} bytes, over the ${PREV_CAPTURE_MAX}-byte inline cap — it is NOT returned here and this replace is therefore NOT revertible. Download ${url} and keep it yourself BEFORE running with dryRun:false.`,
      };
    }
    return { value: path, captured: true, bytes: buf.length, sha256, contentType, base64: buf.toString("base64") };
  } catch (e) {
    return { value: path, captured: false, reason: `could not fetch the current file: ${(e as Error).message}` };
  }
}

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
  "image/bmp": "bmp",
};

function pageTarget(id: string | number): EditTarget {
  return { id, handler: PAGES_HANDLER, handlertable: PAGES_TABLE, extra: {}, flags: ["showPages"] };
}

/** Sniff a MIME from the leading magic bytes (PNG/JPEG/GIF/WEBP/ICO/BMP). */
function sniffMime(b: Uint8Array): string | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45)
    return "image/webp";
  if (b.length >= 4 && b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00) return "image/x-icon";
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return "image/bmp";
  return null;
}

/** Parse a `data:` URI into {mime, bytes}; returns null if not a data URI. */
function parseDataUri(s: string): { mime: string; bytes: Uint8Array } | null {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(s);
  if (!m) return null;
  const mime = m[1] || "application/octet-stream";
  const isB64 = !!m[2];
  const data = m[3] ?? "";
  const bytes = isB64
    ? new Uint8Array(Buffer.from(data, "base64"))
    : new Uint8Array(Buffer.from(decodeURIComponent(data), "utf8"));
  return { mime, bytes };
}

/** Rejected when the bytes are not a recognisable image and no MIME was declared. */
const NOT_IMAGE_ERR =
  "The data is not recognised as an image (PNG/JPEG/GIF/WEBP/ICO/BMP): its magic bytes match none of them. " +
  "Pass `contentType` explicitly, or provide a real image file.";

/**
 * Resolve the upload bytes + a best-guess MIME from whatever source the caller
 * gave: a URL to fetch, a base64 blob, or a data: URI (in url or base64).
 *
 * Guards against silently uploading junk: base64/url sources that do not sniff
 * as a known image, carry no image/* content-type (url), and have no explicit
 * `contentType` override are rejected before a plan is built — otherwise a
 * random base64 blob would ship with a fabricated MIME. A data: URI declares its
 * own MIME, so it is trusted; `contentType` is the escape hatch for exotic types.
 */
async function resolveSource(
  client: any,
  store: string | undefined,
  args: any,
  anyBytes = false,
): Promise<{ bytes: Uint8Array; mime: string; from: string }> {
  // data: URI can arrive in either field — it declares its own MIME (explicit).
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
    // `anyBytes` targets are not image fields at all (a verification .txt/.html),
    // so requiring image magic bytes there would reject the only correct payload.
    if (!sniffed && !explicit && !anyBytes) throw new Error(NOT_IMAGE_ERR);
    return { bytes, mime: sniffed ?? explicit ?? "", from: "base64" };
  }
  if (typeof args.url === "string" && args.url.length) {
    const r = await client.admin.fetchBytes(args.url);
    if (r.httpStatus >= 400) throw new Error(`Fetching the image URL returned HTTP ${r.httpStatus}.`);
    if (r.bytes.length === 0) throw new Error(`The image URL returned 0 bytes (HTTP ${r.httpStatus}).`);
    const sniffed = sniffMime(r.bytes);
    const ctHeader = r.contentType ? r.contentType.split(";")[0].trim() : "";
    const ctIsImage = /^image\//i.test(ctHeader);
    // Reject a text/HTML body (an error page, a login redirect) served as the URL.
    if (!sniffed && !ctIsImage && !explicit && !anyBytes) throw new Error(NOT_IMAGE_ERR);
    return {
      bytes: r.bytes,
      mime: sniffed ?? (ctIsImage ? ctHeader : explicit ?? (anyBytes ? ctHeader : "")),
      from: `url(${r.httpStatus})`,
    };
  }
  throw new Error("No image source: pass `url`, `base64`, or a data: URI.");
}

/**
 * The edit form the target's file input lives on. scope="record" resolves the
 * entity through the same registry the generic reader/writer use, so any admin
 * entity's media field is reachable with its own handler/handlertable/flags.
 */
async function readForm(
  client: any,
  store: string | undefined,
  t: UploadTarget,
  id: string | number | undefined,
): Promise<ParsedForm & { url: string }> {
  if (t.scope === "settings") return client.admin.getFormFromUrl(store, SETTINGS_URL);
  if (id === undefined || id === null || id === "") {
    throw new Error(
      t.scope === "category" ? "category_cover requires `id` (the category id)." : "This target requires `id` (the record id).",
    );
  }
  if (t.scope === "category") return client.admin.getEditForm(store, pageTarget(id));
  const known = resolveEntity(t.entity!);
  if (!known) throw new Error(`Unknown entity "${t.entity}" behind this upload target.`);
  // Same per-store handler resolution as the generic tools. No-op for
  // every current upload target, but the rule must not have two versions.
  const ent = await client.admin.entityForStore(store, known);
  return client.admin.getEditForm(store, {
    id,
    handler: ent.handler,
    handlertable: ent.handlertable,
    extra: {},
    flags: ent.flags ?? [],
  });
}

/** The record id the removeImage flow keys on: the settings singleton is 1. */
function recordIdFor(t: UploadTarget, id: string | number | undefined): string {
  return t.scope === "settings" ? "1" : String(id);
}

/**
 * A category's cover lives in a different namespace depending on its template:
 * a default-template category/page carries `extra[image][*]`, while a
 * custom-template category (Стікери 1082, Футболки 1083 — extra_handler 460/461)
 * moves it to `extra_parent[image][*]` because `extra[…]` is taken by the custom
 * template. The static `t.base` guessed `extra[image]` for both, so uploads to a
 * custom-template category were a silent no-op and removes threw. Resolve the
 * real base from the form the same way admin.ts::textFieldName resolves the body
 * field — pick whichever base's `[id]`/`[value]` is actually present.
 *
 * Returns null for a category form that carries NEITHER base: that means the id
 * did not resolve to an editable category (a blank create form is echoed back),
 * which the caller reports as "category not found".
 */
const CATEGORY_COVER_BASES = ["extra[image]", "extra_parent[image]"] as const;

function resolveBase(form: ParsedForm, t: UploadTarget): string | null {
  if (t.scope === "category") {
    for (const base of CATEGORY_COVER_BASES) {
      if (form.fieldNames.has(`${base}[id]`) || form.fieldNames.has(`${base}[value]`)) return base;
    }
    return null;
  }
  if (t.scope === "record") {
    // A record's media field is only really there if the FORM says so. `[id]`/
    // `[value]` prove the full triple; a fileOnly target is proven by the file
    // input's own name (that is the only part the admin renders for it).
    if (form.fieldNames.has(`${t.base}[id]`) || form.fieldNames.has(`${t.base}[value]`)) return t.base;
    if (form.fileFields.includes(`${t.base}[file]`)) return t.base;
    return null;
  }
  return t.base;
}

/**
 * Free-form target: any `<input type=file>` on any admin record's form.
 *
 * The named TARGETS above cover the fields worth naming, but the class is open —
 * a product's image slots are `modifications[0][images][old_images][<imgId>][img]`,
 * whose id is per-record and cannot be a constant. So `entity` + `id` + `field`
 * addresses a file input directly, VALIDATED against the form's own file inputs
 * (which is what `ParsedForm.fileFields` exists for), never guessed.
 *
 * The `[file]` suffix convention does not hold for every such field (the product
 * one ends `[img]`), so here the field name IS the file part, and the `[id]` /
 * `[value]` siblings are derived by stripping the last `[…]` segment — present
 * for the media triples, absent for the rest.
 */
function customBaseOf(field: string): string | null {
  return /\[[^[\]]+\]$/.test(field) ? field.replace(/\[[^[\]]+\]$/, "") : null;
}

export const adminUploadTools: ToolSpec[] = [
  {
    name: "horoshop_admin_upload_image",
    title: "Upload a file into any admin media field (logos, favicon, covers, brand/benefit/colour/payment images, avatars)",
    description:
      "Upload a real file into the admin panel through the same multipart save.php the browser uses — there is no separate upload endpoint. Two ways to address the destination.\n\n" +
      "1) `target` — a named field:\n" +
      "• general settings: header_logo, footer_logo, print_logo, mobile_logo, og_image, favicon, watermark\n" +
      "• category_cover (needs `id` = the category; the namespace — `extra[image]` on a default-template category, `extra_parent[image]` on a custom-template one — is resolved from the form, and an unknown id reports \"category not found\")\n" +
      "• per-record media (needs `id` = that record's id, from horoshop_admin_list): brand_logo (brands), benefit_image (benefits), color_icon (colors), filter_color_icon (filter_colors), payment_icon (payment_methods), admin_avatar (admins), customer_avatar (customers), service_file (external_service_files — a verification .txt/.html, not an image, so any bytes are accepted).\n\n" +
      "2) `entity` + `id` + `field` — ANY `<input type=file>` on that record's form, for fields whose name is per-record and cannot be named in advance. The classic case is a product image slot: `entity:\"products\", id:515, field:\"modifications[0][images][old_images][149956][img]\"` REPLACES the picture in that slot. Read the exact names from horoshop_admin_record_get (`fileFields`); the field is validated against the form's real file inputs, so a typo is refused instead of silently uploading nowhere.\n\n" +
      "Provide the bytes as `url` (fetched server-side), `base64`, or a data: URI. Read-modify-write: every other field on the form is preserved. Success is verified TWICE: the field's stored path (`[value]`) must go from empty to a `/content/…` path (`changed:true`), AND that file is then fetched from the storefront (`asset.ok`) — because Horoshop registers the path independently of storing the image, so a source it cannot process (a corrupt PNG, some WEBPs) produces a green `changed:true` pointing at a 404. Fields that have no `[value]` sibling (service_file, a product image slot) report `verifiedBy:\"transport\"` and must be checked on the storefront yourself. DRY RUN BY DEFAULT — pass dryRun:false to actually upload.\n\n" +
      "Net-zero / revert, and the two cases are NOT the same. Into an EMPTY field: `remove:true` (same target/field, no source) clears it via the admin's removeImage flow and the field is unset again — a clean round trip. The `[id]` is a stable field id (it does not change on upload), so the picture is cleared by removeImage, not by re-pointing an id. (favicon uses [helper], not [id]; a field with no `[id]` sibling cannot be removed this way.)\n\n" +
      "Over a FILLED field, replacing DESTROYS the previous image and `remove:true` is NOT a revert — it unsets the field instead of restoring the old picture. Measured on the test store: the old file is overwritten in place (the previous path then serves the REPLACEMENT), `[value]` is not writable (a record_save that sets it answers `saved:false`), and the freshly reported path can 404 until the save settles. So nothing recovers the old image after the fact — \"just download the previous URL later\" fetches the replacement. Because of that this tool captures it BEFORE writing: when the target already holds an image, the answer carries `previousImage` {value, bytes, sha256, contentType, base64} — on the DRY RUN as well, so the preview hands you the only copy that will exist before you commit. Restore by re-uploading `previousImage.base64` into the same target. The IMAGE comes back byte-for-byte; the URL does not — Horoshop names every upload afresh, so the restored file lands at a new /content/… path. Images over 256 KB are not embedded: you get the sha256 and an explicit warning that the replace is not revertible, and you must save the file yourself first.",
    inputSchema: {
      ...storeField,
      target: z.enum(TARGET_KEYS).optional().describe("Named destination field. See the list in the description. Mutually exclusive with `field`."),
      entity: z
        .union([z.number().int(), z.string()])
        .optional()
        .describe("Entity slug/handler for the free-form path (used with `field`), e.g. \"products\", \"brands\"."),
      field: z
        .string()
        .optional()
        .describe("Exact file-input name to upload into, e.g. \"modifications[0][images][old_images][149956][img]\". Requires `entity` + `id`. Validated against the form's real file inputs."),
      id: z.union([z.number().int(), z.string()]).optional().describe("Record id — required for category_cover, every per-record target, and the free-form path."),
      url: z.string().optional().describe("File URL to fetch server-side (or a data: URI)."),
      base64: z.string().optional().describe("File bytes as base64 (or a data: URI)."),
      filename: z.string().optional().describe("Override the sent filename (default derived from target + detected type)."),
      contentType: z.string().optional().describe("Override the sent MIME type (default detected from bytes)."),
      remove: z
        .boolean()
        .optional()
        .describe("Revert: clear the target's image (removeImage) instead of uploading. Returns the field to unset. Ignores any source."),
      dryRun: z.boolean().optional().describe("Default true: preview without uploading. Set false to apply."),
    },
    annotations: { readOnlyHint: false, idempotentHint: false },
    handler: async (client, args) => {
      // Named target, or a free-form (entity, field) one synthesised on the spot.
      const custom = typeof args.field === "string" && args.field.length > 0;
      if (custom && args.target) {
        throw new Error("Pass EITHER `target` (a named field) OR `entity`+`field` (a free-form one), not both.");
      }
      if (!custom && !args.target) {
        throw new Error(
          `Nothing to upload into: pass \`target\` (one of ${TARGET_KEYS.join(", ")}) or \`entity\`+\`id\`+\`field\` for a free-form file input.`,
        );
      }
      if (custom && (args.entity === undefined || args.id === undefined)) {
        throw new Error("The free-form path needs `entity` AND `id` alongside `field`.");
      }
      const customEntity = custom ? resolveEntity(args.entity as string | number) : undefined;
      if (custom && !customEntity) throw new Error(`Unknown admin entity "${args.entity}".`);
      const t: UploadTarget = custom
        ? {
            base: customBaseOf(args.field as string) ?? (args.field as string),
            label: `${customEntity!.slug}.${args.field}`,
            scope: "record",
            entity: customEntity!.slug,
            fileOnly: true,
            defaultMime: "image/jpeg",
            defaultExt: "jpg",
          }
        : TARGETS[args.target as string];
      /** The file part's own name: free-form fields are NOT always `<base>[file]`. */
      const fileFieldFor = (base: string): string => (custom ? (args.field as string) : `${base}[file]`);
      const dryRun = args.dryRun !== false;
      // The concrete field triple is derived from the base RESOLVED off the real
      // form (category cover can be extra[image] or extra_parent[image]), so it
      // is computed after readForm in each path, not from the static t.base.
      const fields = (base: string) => ({
        fileField: fileFieldFor(base),
        idField: `${base}[id]`,
        valueField: `${base}[value]`,
      });
      /** Resolve the base or fail with a clear message (not-found / wrong form). */
      const baseOrThrow = (form: ParsedForm): string => {
        // Free-form: the field name IS the address — validate it against the
        // form's own file inputs rather than resolving a media base.
        if (custom) {
          const wanted = args.field as string;
          if (!form.fileFields.includes(wanted)) {
            throw new Error(
              `"${wanted}" is not a file input on ${customEntity!.slug} record ${String(args.id)}. Its file inputs are: ${
                form.fileFields.length ? form.fileFields.join(", ") : "(none — this record's form has no file field)"
              }.`,
            );
          }
          return t.base;
        }
        const base = resolveBase(form, t);
        if (base === null) {
          // The id does not open a record with this media field (Horoshop echoes a
          // blank create form for a bad id, and a record of the wrong type simply
          // has no such input).
          throw new Error(
            t.scope === "category"
              ? `category ${String(args.id)} not found — its edit form has no cover-image field (neither extra[image] nor extra_parent[image]). Check the id with horoshop_admin_list.`
              : `${args.target}: record ${String(args.id)} of "${t.entity}" has no ${t.base}[file] field on its form — check the id with horoshop_admin_list entity=${t.entity}. Its file inputs are: ${
                  form.fileFields.length ? form.fileFields.join(", ") : "(none)"
                }.`,
          );
        }
        return base;
      };

      // ---- Revert path: removeImage (clear the field back to unset). ---------
      if (args.remove === true) {
        if (t.noId) {
          throw new Error(`${args.target} uses [helper], not [id]; removeImage cannot key it. Revert a favicon by re-uploading the original bytes.`);
        }
        const form = await readForm(client, args.store, t, args.id);
        const { idField, valueField } = fields(baseOrThrow(form));
        if (!form.fieldNames.has(idField)) {
          throw new Error(
            `Field ${idField} is not on this form — this file field has no [id] sibling, so the admin's removeImage flow cannot key it. Nothing to remove.`,
          );
        }
        const param = fieldValue(form, idField);
        const recordId = recordIdFor(t, args.id);
        const currentValue = form.fieldNames.has(valueField) ? fieldValue(form, valueField) : "";
        if (dryRun) {
          return { store: args.store ?? null, target: args.target ?? t.label, action: "remove", recordId, fieldId: param, currentImage: currentValue || "(none)", dryRun: true };
        }
        const res = await client.admin.removeImage(args.store, recordId, param);
        const after = await readForm(client, args.store, t, args.id);
        const nowValue = after.fieldNames.has(valueField) ? fieldValue(after, valueField) : "";
        const cleared = nowValue === "";
        return {
          store: args.store ?? null,
          target: args.target ?? t.label,
          action: "remove",
          dryRun: false,
          httpStatus: res.httpStatus,
          status: res.status,
          recordId,
          fieldId: param,
          wasImage: currentValue || null,
          nowImage: nowValue || null,
          cleared,
          note: cleared ? "Image removed and verified: the field is unset again." : `removeImage returned "${res.status ?? res.httpStatus}" but [value] is still "${nowValue}".`,
        };
      }

      // ---- Upload path -------------------------------------------------------
      const form = await readForm(client, args.store, t, args.id);
      // Resolve the base first: for a category this also detects a non-existent id
      // (empty create form → "not found") BEFORE the generic no-file-input guard,
      // which would otherwise mislead with "field is not present here".
      const { fileField, idField, valueField } = fields(baseOrThrow(form));
      if (!form.hasFileInput) {
        throw new Error(`This form has no file input — the ${args.target ?? args.field} field is not present here.`);
      }
      // A `[value]` sibling is what makes an upload PROVABLE. Some file fields
      // (favicon, the external-service file, a product image slot) have none, so
      // say which proof this call can actually give instead of implying one.
      const hasValue = form.fieldNames.has(valueField);
      const hasId = form.fieldNames.has(idField);
      const previousId = hasId ? fieldValue(form, idField) : null;
      const previousValue = hasValue ? fieldValue(form, valueField) : null;

      // Non-image fields (a verification .txt, and free-form slots whose payload
      // the caller vouches for) must not be rejected for failing image magic.
      const anyBytes = t.fileOnly === true;
      const { bytes, mime, from } = await resolveSource(client, args.store, args, anyBytes);
      if (bytes.length > MAX_BYTES) {
        throw new Error(`File is ${bytes.length} bytes, over the ${MAX_BYTES}-byte cap.`);
      }
      const contentType = (args.contentType as string) || mime || t.defaultMime;
      const ext = MIME_EXT[contentType.toLowerCase()] ?? t.defaultExt;
      const filename = (args.filename as string) || `${String(args.target ?? "upload")}.${ext}`;

      // REPLACING A FILLED FIELD DESTROYS THE OLD PICTURE, so it is captured
      // here — on the dry run too, which is the point: the preview hands you the
      // only copy that will ever exist BEFORE you commit. remove:true reverts to
      // "unset", never to the previous image; see capturePrevious().
      const previousImage = previousValue ? await capturePrevious(client, args.store, previousValue) : null;
      const revertable = !!previousImage && previousImage.captured === true;

      const plan = {
        store: args.store ?? null,
        target: args.target ?? t.label,
        ...(custom ? { entity: customEntity!.slug, field: args.field } : {}),
        ...(t.scope !== "settings" ? { id: String(args.id) } : {}),
        action: "upload" as const,
        fileField,
        filename,
        contentType,
        bytes: bytes.length,
        source: from,
        previousId,
        previousValue,
        ...(previousImage ? { previousImage } : {}),
        verifiedBy: hasValue ? ("[value]" as const) : ("transport" as const),
        note: !previousValue
          ? hasId
            ? "The field is empty, so this is a first upload — revert with remove:true (same target)."
            : "The field is empty and has no [id] sibling — remove:true cannot revert it."
          : revertable
            ? `REPLACING A FILLED FIELD. The old image is overwritten and is NOT recoverable afterwards (remove:true only unsets the field, [value] is not writable, and the previous path serves the REPLACEMENT once this runs). Its bytes are therefore returned here as previousImage.base64 — that is the only way back. To restore it: horoshop_admin_upload_image with the same target and base64 = previousImage.base64, dryRun:false. NOTE the restore lands under a NEW /content/… filename: Horoshop names every upload afresh, so the IMAGE returns, the URL does not.`
            : `REPLACING A FILLED FIELD and the old image could NOT be captured (${String(previousImage?.reason ?? "unknown")}). This replace is NOT revertible — nothing here can restore the previous picture.`,
      };

      if (dryRun) return { ...plan, dryRun: true };

      const files: MultipartFile[] = [{ name: fileField, filename, contentType, bytes }];
      const res = await client.admin.save(args.store, form, {}, files);

      const after = await readForm(client, args.store, t, args.id);
      const newId = hasId ? fieldValue(after, idField) : null;
      const newValue = after.fieldNames.has(valueField) ? fieldValue(after, valueField) : null;
      // The [id] is a stable field id — the picture landing is proven by [value]
      // becoming a non-empty path. Fields without a [value] can only report the
      // transport outcome, and they say so (`verifiedBy`) rather than claiming a
      // verification they did not make.
      const changed = hasValue ? !!newValue && newValue !== previousValue : res.httpStatus < 400;
      // A REGISTERED PATH IS NOT A STORED FILE. Horoshop writes the `[value]`
      // path into the record before (and independently of) materialising the
      // image, so a source it cannot process — a corrupt PNG, a WEBP on some
      // pipelines — yields `changed:true` pointing at a path that answers
      // {"message":"image: /not_found not found"}. Caught exactly that way here:
      // a hand-made PNG with a bad IDAT CRC uploaded "successfully" into three
      // fields and every one of the three assets 404'd. So the file is fetched.
      const asset = changed && newValue ? await client.admin.verifyAsset(args.store, newValue) : null;
      const assetOk = asset ? asset.ok : null;
      return {
        ...plan,
        dryRun: false,
        httpStatus: res.httpStatus,
        newId,
        newValue,
        changed,
        ...(asset ? { asset: { ok: asset.ok, httpStatus: asset.httpStatus, contentType: asset.contentType, bytes: asset.bytes } } : {}),
        note: !hasValue
          ? `Submitted (HTTP ${res.httpStatus}). This field has no [value] to read back, so the save is NOT verified here — check the asset on the storefront / in the admin.`
          : !changed
            ? "Upload submitted but the image path did not change — the save may have been rejected; verify on the storefront."
            : assetOk === false
              ? `The record now points at ${newValue}, but that file does NOT serve (HTTP ${asset!.httpStatus}, ${asset!.contentType ?? "no content-type"}, ${asset!.bytes} bytes) — the path was registered and the image was NOT stored. This is what a source Horoshop cannot process looks like (a corrupt or unsupported image); re-upload a valid one, and clear this half-set field with remove:true.`
              : `Uploaded and verified: image path is now ${newValue} and the file serves (${asset!.contentType}, ${asset!.bytes} bytes).` +
                (previousValue
                  ? revertable
                    ? " The image this REPLACED is in previousImage.base64 — re-upload it with the same target to put the old picture back (it returns under a new /content/… name; the URL is not restorable)."
                    : ` The image this REPLACED could not be captured (${String(previousImage?.reason ?? "unknown")}) and is now GONE.`
                  : hasId
                    ? " The field was empty, so remove:true reverts this cleanly."
                    : ""),
      };
    },
  },
];
