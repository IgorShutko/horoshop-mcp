import { randomBytes } from "node:crypto";
import { parse } from "node-html-parser";

const CRLF = "\r\n";

/**
 * The legacy admin (`/adminLegacy/`) that sits behind the React panel guards its
 * write endpoints with a fixed literal, not a per-request CSRF token — the real
 * protection is the session cookie. Every editor form carries this value.
 */
export const CHECKCODE = "yamete_kudasai";

/**
 * Horoshop stores every translatable field under a numeric language index, e.g.
 * `names[i18n][3][seo_title]`. These indexes are platform-wide, not per-store.
 */
export const LANG_INDEX: Record<string, number> = { ru: 1, ua: 3, en: 4, pl: 5, ro: 6 };
export const INDEX_LANG: Record<number, string> = { 1: "ru", 3: "ua", 4: "en", 5: "pl", 6: "ro" };

export interface FormField {
  name: string;
  value: string;
  /** True for a checkbox/radio input — its value is only submitted when "checked". */
  checkbox?: boolean;
  /**
   * True when this field is a `<select>` the server rendered with no `selected`
   * option: its real value is unknown to us, so it must not be resubmitted. See
   * `unselected` on SelectInfo.
   */
  unselected?: boolean;
}

export interface SelectInfo {
  value: string;
  options: Array<{ value: string; label: string }>;
  /**
   * The server rendered no `selected` option, so `value` is NOT the record's
   * current value — it is unknown. A browser would submit the first option, but
   * the admin's own JS fixes the selection up at load time, so replaying the
   * first option is how you silently overwrite real data.
   */
  unselected?: boolean;
}

export interface ParsedForm {
  action: string;
  method: string;
  enctype: string;
  /** Every replayable field in document order (dup checkbox kept, file input dropped). */
  fields: FormField[];
  fieldNames: Set<string>;
  hidden: Record<string, string>;
  selects: Record<string, SelectInfo>;
  hasFileInput: boolean;
  /**
   * Names of EVERY `<input type=file>` on the form, in document order.
   *
   * File inputs are (correctly) kept OUT of `fields`: a browser submits an empty
   * part for an untouched one, and replaying a filename as a text value would be
   * nonsense. But dropping the NAME as well made the whole class unreachable —
   * with only the `hasFileInput` flag, an uploader had to hardcode the field name
   * it wanted, so every media field without a named tool (brand logo, benefit
   * image, colour icon, payment icon, avatars, the external-service file, a
   * product's image slots) had no write path at all. Keeping the names here is
   * what lets a generic upload address them and validate the target against the
   * form instead of guessing.
   */
  fileFields: string[];
  /**
   * Names of EVERY checkbox/radio input on the form, checked or not.
   *
   * `fields` only carries the CHECKED ones (an unchecked box is not submitted),
   * so it cannot answer "is this name a checkbox?". That question matters for
   * reporting: a checkbox is almost always preceded by a hidden input of the same
   * name carrying the 0 default, which then shows up in `hidden` with the OPPOSITE
   * value to the real one (`names[enabled]` reads "1" in fields and "0" in hidden).
   * Two people independently misread that pair — one concluded a set of live
   * filter presets was "empty/disabled" when it was neither. Knowing the name is a
   * checkbox is what lets a reader be told which of the two is the value.
   */
  checkboxNames: Set<string>;
}

/** Every `<form>`/`</form>` tag in a document, in source order. */
const FORM_TAG_RE = /<\/?form\b[^>]*>/gi;
/** The editor form's own open tag: `name=editDoc`, quoted with ' or " or bare. */
const EDITDOC_RE = /\bname\s*=\s*(?:"editDoc"|'editDoc'|editDoc\b)/i;

/**
 * Blank out the parts of a document where a literal `<form` is TEXT, not markup:
 * comments, `<script>`, `<style>` and `<textarea>` bodies. Each match is replaced
 * by the same number of spaces, so every offset in the returned string still
 * points at the same character of the original — the mask is used only to LOCATE
 * tags; the slicing is done on the real HTML.
 *
 * This is what keeps `sliceNamedForm` from over-capturing: a `<form` inside a
 * product description textarea or an inline script would otherwise push the
 * nesting depth up and swallow the NEXT form's inputs into a product's save.
 */
function maskInert(html: string): string {
  const blank = (m: string): string => " ".repeat(m.length);
  return html
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, blank)
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, blank)
    .replace(/<textarea\b[\s\S]*?<\/textarea\s*>/gi, blank);
}

/**
 * Read a `<form>` open tag's attributes straight out of the raw source.
 *
 * Deliberately not DOM: the product editor renders `action=/adminLegacy/save.php`
 * with NO quotes, so anything that needs the action must tolerate a bare value.
 */
function formAttrs(openTag: string): { action: string; method: string; enctype: string } {
  const get = (n: string): string => {
    const m = new RegExp(`\\b${n}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(openTag);
    return m ? (m[1] ?? m[2] ?? m[3] ?? "") : "";
  };
  return { action: get("action"), method: (get("method") || "post").toLowerCase(), enctype: get("enctype") };
}

/**
 * Cut the source region of the named form out of the page, by string.
 *
 * WHY THIS EXISTS — the product editor. `node-html-parser` DROPS the product
 * form entirely: on `edit.php?handler=17` it reports 3 forms and the product's
 * `<form name='editDoc' id='product_edit_form'>` (126 inputs) is not among them —
 * its children get hoisted to the root and ~30 of them vanish with it. The DOM
 * lookup then falls through to the first `<form>` on the page, which is the
 * two-line `#switch_view_type` toggle, so the whole product editor read back as
 * ONE field (`mod_viewtype`): `record_get` returned nothing and `record_save`
 * rejected every patch, because it validates names against `fieldNames`. That is
 * 111 of the 119 fields the coverage census counted as unreachable.
 *
 * The region is located by counting `<form>` opens and closes from the target
 * tag (so a genuinely nested form is still matched to ITS close), over the
 * inert-masked copy of the page. Returns the open tag plus the INNER html —
 * parsing the inner html alone gives the parser nothing to drop.
 */
function sliceNamedForm(html: string, nameRe: RegExp): { open: string; inner: string } | null {
  const mask = maskInert(html);
  const tags: Array<{ start: number; end: number; open: boolean }> = [];
  for (const m of mask.matchAll(FORM_TAG_RE)) {
    const start = m.index ?? 0;
    tags.push({ start, end: start + m[0].length, open: m[0][1] !== "/" });
  }
  const from = tags.findIndex((t) => t.open && nameRe.test(html.slice(t.start, t.end)));
  if (from === -1) return null;
  let depth = 0;
  for (let k = from; k < tags.length; k++) {
    depth += tags[k].open ? 1 : -1;
    if (depth === 0) {
      return { open: html.slice(tags[from].start, tags[from].end), inner: html.slice(tags[from].end, tags[k].start) };
    }
  }
  return null;
}

/** Field harvest over one scope (a `<form>` element, or the root of a form's inner html). */
function collectFields(scope: {
  querySelectorAll: (sel: string) => any[];
}): Pick<ParsedForm, "fields" | "hidden" | "selects" | "hasFileInput" | "checkboxNames" | "fileFields"> {
  const fields: FormField[] = [];
  const hidden: Record<string, string> = {};
  const selects: Record<string, SelectInfo> = {};
  const checkboxNames = new Set<string>();
  const fileFields: string[] = [];
  let hasFileInput = false;

  for (const el of scope.querySelectorAll("input, select, textarea")) {
    const name = el.getAttribute("name");
    if (!name) continue;
    const tag = el.rawTagName.toLowerCase();

    if (tag === "input") {
      const type = (el.getAttribute("type") ?? "text").toLowerCase();
      if (type === "file") {
        // The name is REMEMBERED (fileFields) but the field is still not
        // replayable — see the fileFields doc on ParsedForm.
        hasFileInput = true;
        if (!fileFields.includes(name)) fileFields.push(name);
        continue;
      }
      if (type === "checkbox" || type === "radio") {
        // Unchecked boxes are simply not submitted; the paired hidden carries the 0.
        // The NAME is recorded either way — that is what identifies a hidden+checkbox
        // pair to the readers (see checkboxNames).
        checkboxNames.add(name);
        if (el.hasAttribute("checked")) {
          fields.push({ name, value: el.getAttribute("value") ?? "on", checkbox: true });
        }
        continue;
      }
      const value = el.getAttribute("value") ?? "";
      fields.push({ name, value });
      if (type === "hidden") hidden[name] = value;
    } else if (tag === "textarea") {
      // `.text` decodes entities to the exact string the browser would submit.
      fields.push({ name, value: el.text });
    } else if (tag === "select") {
      const options = el.querySelectorAll("option").map((o: any) => ({
        value: o.getAttribute("value") ?? "",
        label: o.text.trim(),
      }));
      const selected = el.querySelectorAll("option").find((o: any) => o.hasAttribute("selected"));
      if (selected) {
        const value = selected.getAttribute("value") ?? "";
        selects[name] = { value, options };
        fields.push({ name, value });
      } else {
        // No `selected` option: the record's real value is NOT in this markup.
        // Falling back to options[0] is what silently rewrote `names[parent]` to
        // "[выберите]"=0 and dropped pages out of the tree (404 on the storefront)
        // while save.php answered 302 and the re-read "confirmed" the 0.
        // Proven on the test store: omitting the field preserves the stored value;
        // sending 0 destroys it. So: report the value as unknown and don't replay it.
        selects[name] = { value: "", options, unselected: true };
        fields.push({ name, value: "", unselected: true });
      }
    }
  }
  return { fields, hidden, selects, hasFileInput, checkboxNames, fileFields };
}

/**
 * Parse a legacy editor page into a faithful, replayable field set.
 *
 * Three gotchas, all learned the expensive way:
 *
 * 0. The DOM parser silently loses whole forms on the admin's malformed markup —
 *    see `sliceNamedForm`. So the `name=editDoc` form is cut out of the SOURCE
 *    first and parsed on its own, and the DOM result is kept as a fallback: the
 *    raw slice is used only when it yields strictly more fields, which makes this
 *    change incapable of regressing any editor that already parsed.
 *
 * 1. Boolean HTML attributes (`selected`, `checked`) come with no value, so they
 *    must be tested with presence, never with a truthy value read. Missing the
 *    selected `<option>` silently drops `names[handler]` (the page template) and
 *    `save.php` then accepts the POST but persists nothing.
 *
 * 2. Some selects are rendered with NO `selected` option at all and are fixed up
 *    client-side by the admin's own JS — `names[parent]` on the pages editor is
 *    the known case. A browser would submit the first option ("[выберите]" = 0),
 *    and replaying that detaches the page from the tree: the storefront starts
 *    404ing while save.php returns 302 and a re-read happily "confirms" the 0,
 *    because the same unselected markup reads back as 0 forever. Such fields are
 *    marked `unselected` and omitted from the rebuilt body, which is proven to
 *    preserve the stored value.
 */
export function parseEditForm(html: string): ParsedForm {
  const root = parse(html);
  const form = root.querySelector("form[name=editDoc]") ?? root.querySelector("form");

  // RAW-SLICE PATH — the product editor's form never survives the DOM parse.
  // Cut it from the source and harvest it standalone; keep whichever read is
  // richer, so no editor that already worked can lose a field to this change.
  const slice = sliceNamedForm(html, EDITDOC_RE);
  const sliced = slice ? collectFields(parse(slice.inner)) : null;
  const domFields = form ? collectFields(form) : null;

  if (!form && !sliced) {
    throw new Error(
      "No editor <form> in the response — the admin session is likely invalid, or the id/handler does not resolve to an editable record.",
    );
  }

  const useSlice = !!sliced && (!domFields || sliced.fields.length > domFields.fields.length);
  const picked = (useSlice ? sliced : domFields)!;
  const attrs = useSlice
    ? formAttrs(slice!.open)
    : {
        action: form!.getAttribute("action") ?? "",
        method: (form!.getAttribute("method") ?? "post").toLowerCase(),
        enctype: form!.getAttribute("enctype") ?? "",
      };

  return {
    ...attrs,
    fields: picked.fields,
    fieldNames: new Set(picked.fields.map((f) => f.name)),
    hidden: picked.hidden,
    selects: picked.selects,
    hasFileInput: picked.hasFileInput,
    checkboxNames: picked.checkboxNames,
    fileFields: picked.fileFields,
  };
}

/**
 * A real (non-empty) file part to attach to a multipart body: the actual bytes
 * plus the filename and content-type the server needs to accept them. This is
 * how a chosen `<input type=file>` is submitted, as opposed to the empty part a
 * browser sends for a file input left untouched (`emptyFileField`).
 */
export interface MultipartFile {
  /** Exact form field name, e.g. `extra[favicon][file]`. */
  name: string;
  /** Filename the server records / sniffs the extension from. */
  filename: string;
  /** MIME type, e.g. `image/png`, `image/x-icon`. */
  contentType: string;
  /** The raw file bytes. */
  bytes: Uint8Array;
}

/**
 * Rebuild the editor's multipart body from the parsed fields plus a patch.
 *
 * This is read-modify-write: every original field is resent verbatim so
 * `save.php` never wipes a value we did not touch. Overrides replace matching
 * fields in place; override names that were not in the form are appended.
 *
 * Two file modes, mutually exclusive per call:
 *  - `emptyFileField` (text-only saves): the form has a file input but nothing
 *    is being uploaded, so we mirror the empty file part a browser always sends
 *    for an untouched input. The body stays a plain UTF-8 **string** — every
 *    existing text writer (page SEO, records, settings) takes this path
 *    unchanged, byte for byte.
 *  - `files` (real uploads): one or more parts carry actual bytes. Now the body
 *    can no longer be a string (binary is not valid UTF-8), so it is assembled
 *    as a **Uint8Array**: the text parts are UTF-8-encoded, then each file's raw
 *    bytes are spliced in between CRLF-delimited headers. `emptyFileField` is
 *    ignored in this mode — the real part is the file part.
 *
 * The return `body` is therefore `string` for the text path and `ArrayBuffer`
 * for the upload path — both are direct members of fetch's BodyInit, so the
 * caller passes it through untouched. (An `ArrayBuffer` is used rather than a
 * `Uint8Array` because TS 5.7+'s generic `Uint8Array<ArrayBufferLike>` no longer
 * matches undici's `BodyInit` cleanly, while `ArrayBuffer` still does.)
 */
export function buildMultipart(
  fields: FormField[],
  overrides: Record<string, string | string[]>,
  opts: { emptyFileField?: string; files?: MultipartFile[] } = {},
): { boundary: string; body: string | ArrayBuffer } {
  const boundary = `----horoshopmcp${randomBytes(10).toString("hex")}`;
  // The text portion is built as a string exactly as before — this keeps the
  // no-upload path identical to the original implementation.
  let body = "";
  const applied = new Set<string>();
  const part = (name: string, value: string) => {
    body += `--${boundary}${CRLF}Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}${value}${CRLF}`;
  };
  // An override value may be a string (scalar field, unchanged behaviour) or an
  // array (a multi-value field such as the indexed-filter `names[filters][]`
  // multi-select, whose several values are submitted as REPEATED same-named
  // parts — impossible to express as one key in a JSON patch). Arrays emit one
  // part per element; a scalar emits exactly one, byte-identical to before.
  const emit = (name: string, value: string | string[]) => {
    if (Array.isArray(value)) for (const v of value) part(name, v);
    else part(name, value);
  };

  for (const f of fields) {
    if (Object.prototype.hasOwnProperty.call(overrides, f.name)) {
      const ov = overrides[f.name];
      // Turning a checkbox off: it is "on" purely by being present, so omit it
      // rather than send a 0 (which PHP still reads as set). The paired hidden,
      // if any, still carries the 0 through its own override below. (Arrays never
      // apply to checkboxes, so this guard only fires for the scalar case.)
      if (f.checkbox && !Array.isArray(ov) && ov !== f.value) {
        applied.add(f.name);
        continue;
      }
      emit(f.name, ov);
      applied.add(f.name);
    } else if (f.unselected) {
      // A select the server left unselected: we do not know its stored value, so
      // replaying our guess would overwrite it. Omitting the field preserves it.
      continue;
    } else {
      part(f.name, f.value);
    }
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (!applied.has(name)) emit(name, value);
  }

  const files = opts.files ?? [];
  if (files.length === 0) {
    // TEXT PATH — unchanged. Empty file part (if any) then the closing boundary,
    // returned as a plain UTF-8 string, exactly as the original did.
    if (opts.emptyFileField) {
      body +=
        `--${boundary}${CRLF}Content-Disposition: form-data; name="${opts.emptyFileField}"; filename=""${CRLF}` +
        `Content-Type: application/octet-stream${CRLF}${CRLF}${CRLF}`;
    }
    body += `--${boundary}--${CRLF}`;
    return { boundary, body };
  }

  // UPLOAD PATH — the text parts are already in `body`; encode them, then append
  // each file part (headers as UTF-8, bytes raw) and the closing boundary.
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [enc.encode(body)];
  for (const f of files) {
    const header =
      `--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="${f.name}"; filename="${f.filename}"${CRLF}` +
      `Content-Type: ${f.contentType}${CRLF}${CRLF}`;
    chunks.push(enc.encode(header));
    chunks.push(f.bytes);
    chunks.push(enc.encode(CRLF));
  }
  chunks.push(enc.encode(`--${boundary}--${CRLF}`));

  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  // `out` is freshly allocated with byteOffset 0 spanning the whole buffer, so
  // its ArrayBuffer is exactly the body bytes — hand that to fetch.
  return { boundary, body: out.buffer };
}

/**
 * Rebuild a form body as x-www-form-urlencoded (for editors that post to a
 * "modern" route rather than multipart save.php, e.g. `/languages/save/`).
 * Same read-modify-write and checkbox-uncheck semantics as buildMultipart.
 */
export function buildUrlencoded(fields: FormField[], overrides: Record<string, string>): string {
  const params = new URLSearchParams();
  const applied = new Set<string>();
  for (const f of fields) {
    if (Object.prototype.hasOwnProperty.call(overrides, f.name)) {
      const ov = overrides[f.name];
      if (f.checkbox && ov !== f.value) {
        applied.add(f.name);
        continue;
      }
      params.append(f.name, ov);
      applied.add(f.name);
    } else if (f.unselected) {
      continue; // unknown stored value — see buildMultipart
    } else {
      params.append(f.name, f.value);
    }
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (!applied.has(name)) params.append(name, value);
  }
  return params.toString();
}

/**
 * A field's effective submitted value: the LAST occurrence wins, matching how
 * the browser and PHP resolve a hidden+checkbox pair (hidden 0, then checkbox 1).
 */
export function fieldValue(form: ParsedForm, name: string): string {
  let value = "";
  let found = false;
  for (const f of form.fields) {
    if (f.name === name) {
      value = f.value;
      found = true;
    }
  }
  return found ? value : "";
}

export interface BookValue {
  id: string;
  value: string;
  /**
   * The admin offers a trash icon for this value.
   *
   * Not cosmetic: a value that is IN USE by products renders
   * `class='control_del_disabled'` with no link, while a free one renders
   * `class='control_del'` carrying `savers/books.php?id=<value>&delvalue=<book>`.
   * That is the platform's own "is it safe to delete" answer, so it is read here
   * rather than guessed — deleting a value products depend on is not something to
   * find out afterwards.
   */
  deletable?: boolean;
}

/**
 * Parse the values of an attribute-value dictionary ("book", handler 207) from
 * its `forms/books.php` page. Each value row carries a hidden `names[n][id]`
 * (the value id) and a `.title` cell (the display text).
 */
export function parseBookValues(html: string): BookValue[] {
  // Pair each value-id input with the first title that follows it in the source,
  // by position — a leading section header (`.title` = "Свойства справочника")
  // sits before the first row, so it is never paired to a value.
  const idMatches = [
    ...html.matchAll(
      /name=['"]names\[\d+\]\[id\]['"][^>]*?value=['"](\d+)['"]|value=['"](\d+)['"][^>]*?name=['"]names\[\d+\]\[id\]['"]/g,
    ),
  ].map((m) => ({ id: m[1] ?? m[2] ?? "", pos: m.index ?? 0 }));
  const titleMatches = [...html.matchAll(/class=['"]?title['"]?>\s*<div>([^<]*)<\/div>/g)].map((m) => ({
    title: (m[1] ?? "").replace(/\s+/g, " ").trim(),
    pos: m.index ?? 0,
  }));
  // Each row's delete control, by the id the trash link carries — an in-use value
  // renders `control_del_disabled` and no link at all (see BookValue.deletable).
  // NOT `[^>]*` between the class and the URL: the trash link's onclick is an
  // arrow function (`makeConfirm({…})(() => window.location="…")`), so the `>` of
  // `=>` ends a negated-`>` run and every row read as non-deletable.
  const deletable = new Set(
    [...html.matchAll(/class=['"]control_del['"][\s\S]{0,300}?books\.php\?id=(\d+)&delvalue=(\d+)/g)].map((m) => m[1]),
  );
  return idMatches
    .filter((im) => im.id)
    .map((im) => {
      const t = titleMatches.find((tm) => tm.pos > im.pos);
      return { id: im.id, value: t ? t.title : "", deletable: deletable.has(im.id) };
    });
}

export interface TemplateParam {
  /** Param id — the handle for editing/deleting this field. */
  id: string;
  /** Human label shown in the admin and on the storefront. */
  title: string;
  /** The API field name: exactly what catalog_import/export calls it. */
  name: string;
  /** Human type, e.g. "Выбор из списка", "Строка". */
  type: string;
  /** Dictionary this field draws its values from, when it is a book-backed select. */
  book?: string;
}

export interface TemplateGroup {
  id: string;
  title: string;
  params: TemplateParam[];
}

/**
 * Parse a data template's characteristic schema out of `forms/handlers.php?edit=<id>`.
 *
 * This is the answer to "which characteristics does this category actually have"
 * — the question that makes catalog_import silently drop a field when you get it
 * wrong. The template editor never exposes the schema as form fields (its <form>
 * carries only 6 meta inputs), it renders it as a sortable list: groups are
 * `li#groupItem_<gid>` and each field is `li#listItem_<pid>` whose cells are
 * title / name / type.
 */
export function parseTemplateSchema(html: string): TemplateGroup[] {
  const groups: TemplateGroup[] = [];
  for (const g of html.matchAll(/<li id='groupItem_(\d+)'>([\s\S]*?)(?=<li id='groupItem_|$)/g)) {
    const body = g[2] ?? "";
    const params: TemplateParam[] = [];
    for (const p of body.matchAll(/<li id='listItem_(\d+)'>([\s\S]*?)<\/li>/g)) {
      const cells = [...(p[2] ?? "").matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) =>
        (c[1] ?? "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim(),
      );
      const typeCell = cells[3] ?? "";
      const book = typeCell.match(/Справочник:\s*([^)]*)\)/)?.[1]?.trim();
      params.push({
        id: p[1] ?? "",
        title: cells[1] ?? "",
        name: cells[2] ?? "",
        type: typeCell.replace(/\s*\(.*$/, "").trim(),
        ...(book ? { book } : {}),
      });
    }
    groups.push({
      id: g[1] ?? "",
      title: (body.match(/<b>([^<]*)<\/b>/)?.[1] ?? "").trim(),
      params,
    });
  }
  return groups;
}

export interface GridRow {
  id: string;
  label: string;
  cells: string[];
  /**
   * Text of the `<td>` that HOLDS the hidden `names[n][id]` input — on the
   * products grid (handler 17) that cell is the «Код» column, i.e. the article.
   *
   * Structural, not positional: the id input is rendered INSIDE the code cell,
   * so this survives a store that reorders or hides columns, whereas "cells[0]"
   * does not (and `cells` drops empty cells, so its indices are not even stable
   * across rows). This is what lets a bulk tool map article → internal product
   * id in ONE paged walk instead of two requests per article.
   */
  code?: string;
  /**
   * Values of the row's editable grid inputs, keyed by the field name inside
   * `names[n][…]` (e.g. price, price_old, display_in_showcase). These are the
   * cells the admin lets you type into once a row is selected — the surface
   * `dataGridUpdateValues` writes back. A checkbox reports "1"/"0".
   */
  editable?: Record<string, string>;
}

export interface RedirectTarget {
  /** Target entity type (handler dict: 4=pages, 17=catalog, 172=news, 349=brands…). */
  handler: string;
  /** Target record id the old URIs 301 to. */
  record: string;
  title: string;
  currentUrl: string;
  /** The old URIs pointing at this record; `id` is the history_id used to delete. */
  oldUris: Array<{ id: string; uri: string }>;
}

/**
 * Parse the redirects page (`utils/p_url_history.php`). Unlike a datagrid its
 * rows are server-rendered: each `[data-record]` block is a target record, with
 * a list of old URIs (each `<input data-id=history_id value=oldUri>`).
 *
 * Column layout (5 tds, verified live): [0]=«Старые ссылки» (the old-URI widget),
 * [1]=«Ссылка» (the target's CURRENT canonical path — the real destination),
 * [2]=«Суффикс» (the URL suffix, e.g. "/"), [3]=«Шаблон», [4]=«Запись» (title).
 * The destination the 301 actually sends to is «Ссылка» + «Суффикс» (e.g.
 * "/katalog" + "/" → "/katalog/"); the home page has an empty link, i.e. "/".
 * The earlier code read the destination from td[2] («Суффикс»), which is "/" for
 * every row — hence the misleading "all redirects go to /". We now read td[1]
 * (+ suffix) so `currentUrl` is the true target URL.
 */
export function parseRedirects(html: string): RedirectTarget[] {
  const root = parse(html);
  const out: RedirectTarget[] = [];
  for (const tr of root.querySelectorAll("tr")) {
    const div = tr.querySelector("[data-record]");
    if (!div) continue;
    const oldUris = div
      .querySelectorAll("input")
      .map((i) => ({ id: i.getAttribute("data-id") ?? "", uri: i.getAttribute("value") ?? "" }))
      .filter((x) => x.id && x.id !== "0");
    const tds = tr.querySelectorAll("td");
    const link = tds[1]?.text.trim() ?? "";
    const suffix = tds[2]?.text.trim() ?? "";
    // Destination = canonical link + suffix; the homepage's link is empty → "/".
    const currentUrl = (link + suffix) || "/";
    out.push({
      handler: div.getAttribute("data-handler") ?? "",
      record: div.getAttribute("data-record") ?? "",
      title: tds.length ? tds[tds.length - 1].text.trim() : "",
      currentUrl,
      oldUris,
    });
  }
  return out;
}

/**
 * The datagrid's pager, parsed language-independently.
 *
 * Every grid fragment (reload / changePage / setPerPage) carries a
 * `<div class="datagrid-pager"><div class="pages"><span>FROM–TO</span> WORD TOTAL</div>`
 * block, where WORD is the localised "of" ("из" on a ru admin, "з" on a ua one,
 * "of" on en). Parsing that word is a trap (one tested admin is ru, another ua),
 * so we read the numbers only: the range is the first two, the grand total is the
 * LAST number. `to − from + 1` is the effective page size (perPage) the grid is
 * currently serving. Returns null when there is no pager (an empty grid, or a
 * non-grid fragment).
 */
export function parseGridPager(html: string): { from: number; to: number; total: number } | null {
  const root = parse(html);
  const el = root.querySelector(".datagrid-pager .pages") ?? root.querySelector(".pages");
  if (!el) return null;
  const nums = (el.text.match(/\d+/g) ?? []).map(Number);
  if (nums.length === 0) return null;
  const total = nums[nums.length - 1];
  // "FROM–TO of TOTAL" → 3 numbers; a single-page grid may render just "TOTAL".
  const from = nums.length >= 2 ? nums[0] : 1;
  const to = nums.length >= 3 ? nums[1] : total;
  return { from, to, total };
}

/** A datagrid column that can be filtered server-side. */
export interface GridColumn {
  /** The column id the grid's filter action expects as `param`. */
  param: string;
  /** Header label as the admin renders it ("Ключ", "Язык", "Значение"). */
  label: string;
  /** Filter widget kind: input (substring), select (checkbox set), number, date. */
  type: string;
}

/**
 * The filterable columns of a grid fragment.
 *
 * Every `<th>` renders its own filter widget whose handler is
 * `dataGridControl('filter', '<hid>','<type>','<param>', …)` — that `param` is the
 * column id the server-side filter keys on. Column ids are per-installation, so
 * they must be READ here, never hardcoded: the interface-translation grid uses
 * 5314/5315/5316 on one store and could use anything on another.
 *
 * This is what makes a 4000-row grid usable at all — see AdminClient.searchRecords.
 */
export function parseGridColumns(html: string): GridColumn[] {
  // Deliberately RAW-TEXT, not DOM. The grid's <thead> is malformed enough that a
  // real parser gives up on it — each <th> carries `class` TWICE and the rows end
  // `</tr></td>` — and node-html-parser then reports 2 headers out of 5, with the
  // filter widgets missing entirely. Splitting on the `<th` boundary is safe here
  // because header cells never nest, and it survives markup a parser will not.
  const out: GridColumn[] = [];
  const seen = new Set<string>();
  const segments = html.split(/<th\b/i).slice(1);
  for (const seg of segments) {
    const f = /dataGridControl\(\s*'filter'\s*,\s*'[^']*'\s*,\s*'([^']*)'\s*,\s*'([^']*)'/.exec(seg);
    if (!f) continue;
    const [, type, param] = f;
    if (!param || seen.has(param)) continue;
    seen.add(param);
    // The sortable header link sits before the filter widget in the same cell.
    const l = /class=['"]?sort['"]?[^>]*>([^<]*)</.exec(seg.slice(0, f.index));
    out.push({ param, label: (l?.[1] ?? "").replace(/\s+/g, " ").trim(), type });
  }
  return out;
}

/** Yes/no cells in every admin locale — a column of these identifies nothing. */
const BOOLISH_RE = /^(так|ні|да|нет|yes|no|y|n|\+|-|—|)$/i;
/** A date cell (2026.07.17, 17.07.2026, 2026-07-17…). */
const DATEISH_RE = /^\d{2,4}[.\-/]\d{1,2}[.\-/]\d{1,4}([ T]\d{1,2}:\d{2})?$/;
/** A purely numeric / money cell. */
const NUMERIC_RE = /^[\d\s.,%₴$€]+$/;

/**
 * Choose which grid columns make a human label — FIX for "11 rows, 11 identical
 * labels".
 *
 * `parseGridRows` used to take the first three non-empty cells of each row. On the
 * blog grid those are [published, rubric, date], so 11 different articles all came
 * back as «Так · Політика конфіденційності · 2026.07.17» — the TITLE sits in cell
 * 4 and never made it into the label, leaving the records indistinguishable in
 * `admin_list`.
 *
 * The columns are therefore scored ACROSS THE WHOLE ROW SET, where "informative"
 * is measurable: a column whose value differs per row identifies a record, one
 * that reads «Так» on every row does not. Static shape breaks the tie for a
 * single-row grid (a title-looking cell beats a date beats a flag).
 */
export function pickLabelColumns(rows: GridRow[], max = 3): number[] {
  const width = rows.reduce((n, r) => Math.max(n, r.cells.length), 0);
  if (width === 0) return [];
  const scored: Array<{ i: number; score: number }> = [];
  for (let i = 0; i < width; i++) {
    const values = rows.map((r) => (r.cells[i] ?? "").trim());
    const nonEmpty = values.filter((v) => v !== "");
    if (nonEmpty.length === 0) continue;
    const distinct = new Set(values).size / Math.max(rows.length, 1);
    const avgLen = nonEmpty.reduce((n, v) => n + v.length, 0) / nonEmpty.length;
    const boolish = nonEmpty.every((v) => BOOLISH_RE.test(v));
    const dateish = nonEmpty.every((v) => DATEISH_RE.test(v));
    const numeric = !dateish && nonEmpty.every((v) => NUMERIC_RE.test(v));
    const wordy = nonEmpty.some((v) => /[\p{L}]/u.test(v) && /\s/.test(v));
    const score =
      distinct * 3 +
      (avgLen >= 12 ? 1.5 : avgLen >= 6 ? 0.5 : 0) +
      (wordy ? 1 : 0) -
      (boolish ? 5 : 0) -
      (dateish ? 2 : 0) -
      (numeric ? 1.5 : 0);
    scored.push({ i, score });
  }
  const picked = scored
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, max)
    .filter((c, idx) => idx === 0 || c.score > 0) // never drop every column, but skip junk
    .map((c) => c.i)
    .sort((a, b) => a - b);
  return picked;
}

/** Cap one cell so a 2 KB description cell cannot become the label. */
const labelCell = (s: string): string => (s.length > 120 ? `${s.slice(0, 120)}…` : s);

/**
 * Rebuild every row's `label` from the columns that actually distinguish the rows.
 * Mutates in place and returns the same array (callers keep their references).
 * `cells` is untouched — anything that wants the raw grid still has it.
 */
export function relabelGridRows<T extends GridRow[]>(rows: T): T {
  if (rows.length === 0) return rows;
  const cols = pickLabelColumns(rows);
  if (cols.length === 0) return rows;
  for (const r of rows) {
    const parts = cols.map((i) => (r.cells[i] ?? "").trim()).filter((v) => v !== "");
    if (parts.length) r.label = parts.map(labelCell).join(" · ");
  }
  return rows;
}

/**
 * Parse the row fragment returned by `ajax.datagrid.php?load=dataGridReload`.
 * Each `<tr id="dataGridRow_k">` carries the record id in a hidden
 * `names[n][id]` input; the visible cells give a human label.
 *
 * The per-row label here is a first approximation (the leading cells); the caller
 * refines it across the whole result set with `relabelGridRows`, which is the only
 * place the columns can be compared.
 */
/**
 * The visible text of one grid cell.
 *
 * FIX: a `<td>` in the products grid ships an inline `<script>` next to
 * the value — the price column renders
 * `<span>299.00</span><input …><script>$('input.form_input_4508').numberMask({…`
 * — and `td.text` concatenates script source with content, so the row's human
 * label came back as
 * «ZZW8-CHAR-001 · ZZW8 Тест Характеристики · 0.00 $('input.form_input_4536').numberMask({…».
 * The value is still in there, buried in jQuery. Drop `<script>`/`<style>`
 * subtrees before reading the text; `id`, `cells`, `code` and `editable` are all
 * derived from this or from the inputs, so they stay exactly as they were except
 * for losing the JS noise.
 */
function cellText(td: { querySelectorAll: (s: string) => Array<{ remove: () => void }>; text: string }): string {
  for (const junk of td.querySelectorAll("script, style")) junk.remove();
  return td.text.replace(/\s+/g, " ").trim();
}

export function parseGridRows(html: string): GridRow[] {
  const root = parse(html);
  const rows: GridRow[] = [];
  for (const tr of root.querySelectorAll("tr")) {
    const rid = tr.getAttribute("id") ?? "";
    if (!rid.startsWith("dataGridRow_")) continue;
    const idInput = tr
      .querySelectorAll("input")
      .find((i) => /\[\d+\]\[id\]$/.test(i.getAttribute("name") ?? "") && i.getAttribute("type") === "hidden");
    const id = idInput?.getAttribute("value") ?? "";
    if (!id) continue;
    const tds = tr.querySelectorAll("td");
    // cellText strips the cell's inline <script> first — see its comment. Reading
    // the text BEFORE the `code`/`editable` lookups is deliberate: those go
    // through the cell's INPUTS, which cellText never touches.
    const cellsRaw = tds.map((td) => cellText(td));
    const cells = cellsRaw.filter((t) => t.length > 0);
    // The code/article cell is the one CONTAINING the id input, not a fixed index.
    const codeIdx = tds.findIndex((td) =>
      td.querySelectorAll("input").some((i) => i.getAttribute("name") === idInput?.getAttribute("name")),
    );
    const code = (codeIdx >= 0 ? cellsRaw[codeIdx] : "") || undefined;

    // Editable cells: every `names[n][field]` control that is not the id itself.
    // A checkbox column renders TWO inputs under one name (hidden "0" + checkbox
    // "1"), exactly like a real form — so read the checkbox's checked state and
    // let it win, which is what the admin's own dataGridUpdateValues does.
    const editable: Record<string, string> = {};
    for (const input of tr.querySelectorAll("input, select, textarea")) {
      const name = input.getAttribute("name") ?? "";
      const m = /^names\[\d+\]\[([^\]]+)\]$/.exec(name);
      if (!m || m[1] === "id") continue;
      const type = (input.getAttribute("type") ?? "").toLowerCase();
      if (type === "checkbox") editable[m[1]] = input.hasAttribute("checked") ? "1" : "0";
      else if (type === "hidden" && m[1] in editable) continue; // checkbox already spoke
      else editable[m[1]] = input.getAttribute("value") ?? "";
    }

    rows.push({
      id,
      label: cells.slice(0, 3).join(" · "),
      cells,
      ...(code ? { code } : {}),
      ...(Object.keys(editable).length ? { editable } : {}),
    });
  }
  return rows;
}
