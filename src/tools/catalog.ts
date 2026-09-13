import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { storeField, type ToolSpec } from "../register.js";
import { staleBuildWarning } from "../buildInfo.js";
import { isRetryableNetworkError } from "../admin/retry.js";
import { LANG_INDEX } from "../admin/form.js";
import { languageStates } from "../admin/languageState.js";
import { checkCharacteristicNames, fetchImportPreflight, type CharSchemaReport } from "../admin/templateGuard.js";
import { answerBytes, responseSizeLimit, sizeRefusal } from "../sizeGate.js";

/**
 * Characteristic values come back from `catalog/export` in FOUR different shapes,
 * mixed inside a single response — measured on one store's first 100 products:
 *
 *   2000×  {id, value:{ua,ru}}          a single dictionary-backed ref
 *   1890×  []                           an empty list
 *   1100×  {ua,ru}                      an i18n value with no wrapper at all
 *    610×  [{id, value:{ua,ru}}]        a multi-value field
 *
 * Reading them all as `char.value.ua` silently yields "" for a third of them, and
 * the parse does not throw — it just under-reports. That shipped a "0 of 1466
 * products have this field" line into a client report when the real answer was
 * 355. So normalise to ONE shape on the way out: always a list of refs.
 */
const LANG_KEY_RE = /^[a-z]{2,3}$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** True for `{ua:"…", ru:"…"}` — an i18n bag rather than a wrapper object. */
function isI18n(v: unknown): boolean {
  if (!isPlainObject(v)) return false;
  const keys = Object.keys(v);
  return keys.length > 0 && keys.every((k) => LANG_KEY_RE.test(k) && typeof v[k] !== "object");
}

/** Coerce whatever sits in `value` into an i18n bag, mirroring a scalar into ua+ru. */
function toI18n(v: unknown): Record<string, string> {
  if (isI18n(v)) {
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = val == null ? "" : String(val);
    return out;
  }
  const text = v == null ? "" : String(v);
  return { ua: text, ru: text };
}

/** One characteristic entry → the canonical `{…, value:{ua,ru}}` ref. */
function normalizeCharEntry(v: unknown): Record<string, unknown> {
  if (isPlainObject(v) && "value" in v) {
    // {id, value} (and any sibling keys the API adds) — keep them, fix `value`.
    return { ...v, value: toI18n(v.value) };
  }
  if (isPlainObject(v)) return { value: toI18n(v) }; // bare {ua,ru}
  return { value: toI18n(v) }; // scalar
}

/** A characteristic's value in any of the four shapes → always a list of refs. */
export function normalizeCharacteristicValue(v: unknown): Array<Record<string, unknown>> {
  if (v === null || v === undefined || v === "") return [];
  if (Array.isArray(v)) return v.map(normalizeCharEntry);
  return [normalizeCharEntry(v)];
}

// ---------------------------------------------------------------------------
// THE ROUND-TRIP TRAP — catalog_export's shape is NOT catalog_import's shape.
//
// `catalog/import` only reads a characteristic when its value is a PLAIN string
// (or an array of plain strings for a multi-value field): `characteristics:
// {"ves":"380 г"}`. Feed it the shape our own `catalog_export` returns —
// `{"ves":[{value:{ua:"380 г",ru:"380 г"}}]}`, the normalised ref list above —
// and Horoshop answers `status:OK` / «Товар обновлен» and writes NOTHING. No
// warning, no error, no trace. Measured on the test store: the ref-list import left
// the characteristic empty; the identical flat import landed it.
//
// So export→import silently loses the entire characteristics block. On a 500-SKU
// migration that is 500 products stripped of their attributes with a fully green
// log. The fix is here: whatever shape comes in — flat scalar, i18n bag, one ref,
// a list of refs — it is flattened to what the API actually eats BEFORE the POST,
// and anything that cannot be flattened faithfully is a hard error rather than a
// silent drop.
// ---------------------------------------------------------------------------

/** One characteristic entry (any shape) → the single plain string the API eats. */
function charEntryToText(v: unknown, where: string): { text: string } | { error: string } {
  if (v === null || v === undefined) return { text: "" };
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return { text: String(v) };
  if (Array.isArray(v)) return { error: `${where}: nested array inside a characteristic value is not a shape Horoshop accepts.` };
  if (!isPlainObject(v)) return { error: `${where}: unsupported characteristic value of type ${typeof v}.` };

  if ("value" in v) {
    const inner = charEntryToText(v.value, where);
    if ("error" in inner) return inner;
    // {id: 42} with no usable text: Horoshop matches dictionary values BY TEXT on
    // import, so an id alone cannot be resolved here — say so instead of writing "".
    if (inner.text === "" && v.id != null) {
      return {
        error: `${where}: got a dictionary ref {id:${String(v.id)}} with no text. catalog/import matches values by TEXT, not by id — pass the value itself (e.g. "Червоний").`,
      };
    }
    return inner;
  }

  // A ref that carries only its id. Checked BEFORE the i18n branch on purpose:
  // "id" is two lowercase letters, so the language-key test happily reads {id:7}
  // as an Indonesian translation and would write the literal string "7".
  if ("id" in v) {
    return {
      error: `${where}: got a dictionary ref {id:${String(v.id)}} with no text. catalog/import matches values by TEXT, not by id — pass the value itself (e.g. "Червоний"), or read it with horoshop_admin_dictionary_values.`,
    };
  }

  // An i18n bag {ua,ru,en,…}. The import shape carries ONE string that Horoshop
  // mirrors across languages, so per-language values can only be honoured when
  // they agree. If they genuinely differ, refuse — writing one of them and
  // dropping the rest is exactly the kind of quiet loss this fix exists for.
  const keys = Object.keys(v);
  if (keys.length && keys.every((k) => LANG_KEY_RE.test(k))) {
    const distinct = [...new Set(keys.map((k) => (v[k] == null ? "" : String(v[k]))).filter((s) => s !== ""))];
    if (distinct.length === 0) return { text: "" };
    if (distinct.length === 1) return { text: distinct[0] };
    return {
      error: `${where}: the per-language values differ (${distinct.map((s) => JSON.stringify(s)).join(" vs ")}). catalog/import takes ONE value per characteristic and mirrors it across languages — it cannot write a different value per language. Pass a single string, or set the translations via the admin dictionary (horoshop_admin_dictionary_value_set).`,
    };
  }
  return { error: `${where}: unrecognised characteristic value ${JSON.stringify(v).slice(0, 120)}.` };
}

export interface CharNormalizeResult {
  /** The characteristics block in the shape catalog/import actually reads. */
  out: Record<string, string | string[]>;
  /** Fields dropped because every ref in them was empty (an unset export cell). */
  skippedEmpty: string[];
  /** Fields that were reshaped (a ref / ref list / i18n bag came in). */
  reshaped: string[];
  errors: string[];
}

/**
 * Flatten one product's `characteristics` into the import shape.
 *
 * Accepted in: `"текст"`, `["а","б"]`, `{ua,ru}`, `{id,value}`, `[{id,value:{ua,ru}}]`
 * (the export shape). Out: a string, or an array of strings for a multi-value field.
 *
 * An explicit empty scalar (`""` / `null`) is KEPT — that is how a caller clears a
 * characteristic, and dropping it would be a silent failure of its own. An empty
 * REF (`[{value:{ua:"",ru:""}}]`, which is what export returns for a characteristic
 * the product never had) is dropped instead: it carries no instruction, and
 * re-sending it on a round-trip is noise, not a clear.
 */
export function normalizeImportCharacteristics(chars: unknown, article: string): CharNormalizeResult {
  const res: CharNormalizeResult = { out: {}, skippedEmpty: [], reshaped: [], errors: [] };
  if (!isPlainObject(chars)) {
    res.errors.push(`${article}: \`characteristics\` must be an object keyed by the category's API field names, got ${Array.isArray(chars) ? "an array" : typeof chars}.`);
    return res;
  }
  for (const [field, raw] of Object.entries(chars)) {
    const where = `${article} → characteristics.${field}`;
    const isScalar = raw === null || raw === undefined || ["string", "number", "boolean"].includes(typeof raw);
    if (isScalar) {
      // Already the import shape (including an intentional "" clear) — untouched.
      res.out[field] = raw === null || raw === undefined ? "" : String(raw);
      continue;
    }
    const items = Array.isArray(raw) ? raw : [raw];
    const allScalar = items.every((it) => ["string", "number", "boolean"].includes(typeof it));
    const texts: string[] = [];
    for (const it of items) {
      const r = charEntryToText(it, where);
      if ("error" in r) {
        res.errors.push(r.error);
        continue;
      }
      texts.push(r.text);
    }
    if (res.errors.length && !allScalar) continue;
    const kept = texts.filter((t) => t !== "");
    if (kept.length === 0) {
      // Array of plain strings that were all empty is still the caller's own
      // shape — keep it verbatim rather than inventing a drop.
      if (allScalar) res.out[field] = Array.isArray(raw) ? (texts as string[]) : texts[0] ?? "";
      else res.skippedEmpty.push(field);
      continue;
    }
    res.out[field] = kept.length === 1 ? kept[0] : kept;
    if (!allScalar) res.reshaped.push(field);
  }
  return res;
}

/**
 * Rewrite every product's `characteristics` into the import shape, returning a
 * per-article report for the dry run. Products are COPIED (the caller's payload
 * and the dry-run diff both keep seeing the original), and any field whose shape
 * cannot be honoured throws — `status:OK` with nothing written is not an option.
 */
export function normalizeImportPayload(products: Array<Record<string, unknown>>): {
  products: Array<Record<string, unknown>>;
  report: Array<{ article: string; write: Record<string, string | string[]>; reshaped?: string[]; skippedEmpty?: string[] }>;
} {
  const report: Array<{ article: string; write: Record<string, string | string[]>; reshaped?: string[]; skippedEmpty?: string[] }> = [];
  const errors: string[] = [];
  const out = products.map((p) => {
    if (!("characteristics" in p) || p.characteristics === undefined) return p;
    const article = p.article == null ? "(no article)" : String(p.article);
    const r = normalizeImportCharacteristics(p.characteristics, article);
    errors.push(...r.errors);
    report.push({
      article,
      write: r.out,
      ...(r.reshaped.length ? { reshaped: r.reshaped } : {}),
      ...(r.skippedEmpty.length ? { skippedEmpty: r.skippedEmpty } : {}),
    });
    return { ...p, characteristics: r.out };
  });
  if (errors.length) {
    throw new Error(
      `Cannot normalise \`characteristics\` for import — nothing was sent.\n- ${errors.join("\n- ")}\n` +
        `catalog/import reads a characteristic ONLY as a plain value per field: {"color":"Червоний"} (or ["Червоний","Синій"] for a multi-value field). Anything else is answered with status:OK and silently NOT written, which is why this is an error rather than a best-effort guess.`,
    );
  }
  return { products: out, report };
}

/**
 * What the characteristics on THIS response actually looked like — measured, not
 * assumed. See `normalizeExport`.
 */
export interface CharShapeReport {
  /** Products that carried a `characteristics` object at all. */
  products: number;
  /** Individual characteristic values across them. */
  values: number;
  /** …of which carried an `id` (a dictionary-backed ref). */
  valuesWithId: number;
  /** Field → how many products had it present but EMPTY (dropped from the answer). */
  emptyFieldsDropped: Record<string, number>;
}

/**
 * Normalise `characteristics` on every product of a catalog/export response, in
 * place, and REPORT what was really there (D6).
 *
 * Two things the tool used to claim and the data did not support, measured on
 * 400 values across two live stores:
 *
 *  1. `id` was documented as part of every value (`[{id, value:{ua,ru}}]`) and
 *     was absent on 400 of 400. It is a DICTIONARY ref id — present only when
 *     the field is dictionary-backed, which on these stores it never was. Code
 *     that matches characteristics by `id` therefore matches nothing, silently.
 *     The shape report says how many values actually carried one.
 *  2. Every product carried `characteristics.title: []` — a key with an empty
 *     list, which is not a characteristic at all but which makes the documented
 *     read (`v[0].value.ua`) throw on EVERY product. An empty list carries no
 *     value and no instruction, so it is dropped from the answer and counted in
 *     `emptyFieldsDropped` instead of being left as a trap.
 */
function normalizeExport(body: any): { body: any; charShape: CharShapeReport | null } {
  const products = body?.response?.products;
  if (!Array.isArray(products)) return { body, charShape: null };
  const shape: CharShapeReport = { products: 0, values: 0, valuesWithId: 0, emptyFieldsDropped: {} };
  for (const p of products) {
    const chars = p?.characteristics;
    if (!isPlainObject(chars)) continue;
    shape.products++;
    for (const [k, v] of Object.entries(chars)) {
      const norm = normalizeCharacteristicValue(v);
      if (norm.length === 0) {
        // Present but empty: not a characteristic, and the documented read
        // crashes on it. Drop it and count it.
        shape.emptyFieldsDropped[k] = (shape.emptyFieldsDropped[k] ?? 0) + 1;
        delete chars[k];
        continue;
      }
      shape.values += norm.length;
      for (const item of norm) if (item && (item as any).id !== undefined) shape.valuesWithId++;
      chars[k] = norm;
    }
  }
  return { body, charShape: shape.products > 0 ? shape : null };
}

// ---------------------------------------------------------------------------
// catalog_import DRY RUN (P1) — a client-side preview. Horoshop's import has no
// validateOnly, so we export the current values for the payload's articles and
// diff them field-by-field. catalog/export returns values in shapes that DIFFER
// from the import shape (dictionary refs {id,value:X}, i18n bags {ua,ru,…},
// plain scalars), so we unwrap the export value before comparing, and treat the
// fields whose import shape has no faithful export counterpart as "will write"
// rather than inventing a misleading from→to.
// ---------------------------------------------------------------------------

/** Heavy HTML fields that bloat catalog/export (the 4.67 MB / token-overflow
 *  culprits). Dropped by the export `lite` flag, and skipped by the import
 *  dry-run unless the payload actually changes them. */
const HEAVY_EXPORT_FIELDS = ["description", "marketplace_description"];

/**
 * `includedParams` names that are NOT what the API calls the field.
 *
 * `char` is the one that actually bit: the tool's own description illustrates the
 * normalised shape as `"char": [{id, value:{ua,ru}}]`, where `char` stands for one
 * characteristic's key — and it was read as the field name, so a request for
 * ["title","price","presence","brand","parent","char"] came back with no
 * characteristics at all. Horoshop does not reject an unknown includedParam, it
 * simply omits it, so the mistake is invisible: you get a clean answer that is
 * quietly missing a field. The real field is `characteristics` (an object keyed by
 * per-category field names), so the alias is applied and REPORTED, never silently.
 */
const INCLUDED_PARAM_ALIASES: Record<string, string> = {
  char: "characteristics",
  chars: "characteristics",
  characteristic: "characteristics",
};

/**
 * SIZE GATE. This tool grew the mechanism (a 100-product page is ~75 KB scoped
 * to four fields, ~1.26 MB with `lite:true`, ~6.9 MB raw, and 111 KB is what
 * already overflowed one conversation); it now lives in `../sizeGate.js` and
 * every read-only tool shares the same threshold and the same refusal shape.
 * What stays here is the part only this tool knows: how to make a CATALOG
 * answer smaller (lite / includedParams / a fitting `limit`).
 */
const exportSizeLimit = responseSizeLimit;

/** Payload fields whose import representation is structurally unlike the export
 *  one (galleries, sticker/characteristic lists, B2B levels): a value diff would
 *  mislead, so the dry-run surfaces them as "will be written", not as from→to. */
const OPAQUE_IMPORT_FIELDS = new Set([
  "images",
  "gallery_common",
  "gallery_360",
  "gallery",
  "characteristics",
  "icons",
  "residues",
  "price_levels",
  "alt_parent",
  "bind_accessories",
  "bind_accessories_categories",
  "bind_gifts",
  "bind_gifts_categories",
]);

/** A representative scalar for an i18n bag (ua → ru → first present). */
function reprI18n(v: Record<string, unknown>): string {
  const pick = v.ua ?? v.ru ?? Object.values(v).find((x) => x != null);
  return pick == null ? "" : String(pick);
}

/** Unwrap a catalog/export value into something comparable to an import value:
 *  {id,value:X} dictionary refs collapse to X; i18n bags and structural objects
 *  are kept; scalars pass through. */
function unwrapExportValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "string") return v;
  if (Array.isArray(v)) return v;
  if (isPlainObject(v)) {
    const keys = Object.keys(v);
    if ("value" in v && (keys.includes("id") || keys.length <= 2)) return unwrapExportValue(v.value);
    return v; // i18n bag or structural object
  }
  return v;
}

/** Render any leaf value as a comparable string (i18n bag → representative). */
function scalarStr(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (isPlainObject(v)) return isI18n(v) ? reprI18n(v) : JSON.stringify(v);
  if (Array.isArray(v)) return JSON.stringify(v);
  return String(v);
}

function truncate(s: string, n = 120): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

interface FieldChange {
  from: string | null;
  to: string;
  opaque?: true;
  /** FIX #3: this i18n cell targets a language that is OFF on the store, so
   *  Horoshop will silently drop it (it answers OK but persists nothing). */
  inactiveLanguage?: true;
}

/** Diff one payload product against its current exported value. Returns the
 *  changed fields only (identical fields are omitted, like the admin writers). */
function collectChanges(
  currentRaw: Record<string, unknown> | undefined,
  payload: Record<string, unknown>,
): { isNew: boolean; changes: Record<string, FieldChange> } {
  const isNew = !currentRaw;
  const changes: Record<string, FieldChange> = {};
  for (const [key, to] of Object.entries(payload)) {
    if (key === "article") continue;
    const curRaw = currentRaw ? currentRaw[key] : undefined;

    if (OPAQUE_IMPORT_FIELDS.has(key)) {
      changes[key] = {
        from: isNew ? null : "(structural — see current export)",
        to: truncate(scalarStr(to)),
        opaque: true,
      };
      continue;
    }

    const curUnwrapped = unwrapExportValue(curRaw);

    // parent may arrive as {id} — compare the ids.
    if (key === "parent" && isPlainObject(to) && "id" in to) {
      const from = isNew ? null : scalarStr(isPlainObject(curRaw) ? curRaw.id : curRaw);
      const toS = String(to.id);
      if (from !== toS) changes["parent.id"] = { from, to: toS };
      continue;
    }

    // i18n / nested object payload (e.g. title:{ua,ru}) — compare per sub-key.
    if (isPlainObject(to)) {
      for (const [sub, subVal] of Object.entries(to)) {
        const curSub = isPlainObject(curUnwrapped)
          ? (curUnwrapped as Record<string, unknown>)[sub]
          : sub === "ua" || sub === "ru"
            ? curUnwrapped
            : undefined;
        const from = isNew ? null : scalarStr(curSub);
        const toS = scalarStr(subVal);
        if (from !== toS) changes[`${key}.${sub}`] = { from, to: toS };
      }
      continue;
    }

    // scalar payload.
    const from = isNew ? null : scalarStr(curUnwrapped);
    const toS = scalarStr(to);
    if (from !== toS) changes[key] = { from, to: toS };
  }
  return { isNew, changes };
}

/** Fetch current exported products for a set of articles, keyed by article.
 *  Chunked, and skips heavy HTML fields unless the payload changes them. */
/**
 * The schema guard's findings, shaped for the answer. `unverified` is emitted on
 * its own: "I could not check these" is a different statement from "these are
 * fine", and collapsing the two is how a green log gets earned dishonestly.
 */
function schemaGuardFields(r: CharSchemaReport): Record<string, unknown> {
  if (!r.findings.length && !r.unverified.length) return {};
  return {
    ...(r.findings.length
      ? {
          characteristicSchemaWarnings: r.findings,
          characteristicSchemaNote:
            "Each `dropped` name is not defined by the data template of THAT product's own category, so catalog/import ignores it and still answers «Товар обновлен» — measured. Note the name may be perfectly valid elsewhere in the store: templates differ per category, which is why this is checked per product and not against a store-wide list. `templateAccepts` is the full field list that category does take (horoshop_admin_template_schema). Fix the name, move the product, or add the field with horoshop_admin_template_param_add.",
        }
      : {}),
    ...(r.unverified.length
      ? {
          characteristicSchemaUnverified: r.unverified,
          characteristicSchemaUnverifiedNote:
            "These articles carry characteristics that could NOT be checked against a template (no resolvable category, or the admin form/schema was unreachable). Not an error and not a pass — verify with horoshop_catalog_export includedParams:[\"article\",\"characteristics\"] after the import.",
        }
      : {}),
  };
}

/**
 * The storefront-listing gap, stated at RUNTIME instead of only in the tool's
 * description. Trap (6) had long been documented and still shipped a
 * green "no warnings" line on every bulk load — a warning nobody sees during a
 * 500-SKU run is not a warning. Fires only for products that are actually NEW:
 * an edit to an existing product does not move it in or out of a listing, and
 * repeating this on every price update would train the reader to ignore it.
 */
function listingWarning(count: number, planned: boolean): string {
  return (
    `⚠️ ${count} NEW product(s) ${planned ? "will be created" : "were created"} — they may NOT appear in their category's storefront listing right away, even though everything you can check says they are live. ` +
    `Measured: catalog_export gives display_in_showcase:1 and the right parent, the product page returns 200 and the article is in catalog-sitemap.xml, while the category page still reads «Немає товарів» 25+ minutes later. ` +
    `The listing is served by a SEARCH INDEX that an /api/ import does not rebuild, and no tool in this server can see or trigger that rebuild. ` +
    `Verify a new product by its OWN page and by catalog-sitemap.xml — not by the category listing — and if the listing must be populated, ask Horoshop to reindex. New products are also created HIDDEN unless the payload sets display_in_showcase:1 and a presence.`
  );
}

async function fetchCurrentByArticle(
  client: any,
  store: string | undefined,
  articles: string[],
  payloadKeys: Set<string>,
): Promise<Map<string, any>> {
  const map = new Map<string, any>();
  const excluded = HEAVY_EXPORT_FIELDS.filter((f) => !payloadKeys.has(f));
  const CHUNK = 100;
  for (let i = 0; i < articles.length; i += CHUNK) {
    const batch = articles.slice(i, i + CHUNK);
    const body = await client.call(store, "catalog/export", {
      expr: { article: batch },
      ...(excluded.length ? { excludedParams: excluded } : {}),
    });
    const prods = body?.response?.products ?? [];
    for (const p of prods) if (p?.article != null) map.set(String(p.article), p);
  }
  return map;
}

/** Codes/messages that read as a hard failure rather than an informational note. */
function isImportError(code: unknown, message: unknown): boolean {
  const c = String(code ?? "").toLowerCase();
  if (c === "0" || c === "" || c === "ok") return false;
  const m = String(message ?? "").toLowerCase();
  return /error|ошиб|помилк|fail|invalid|not found|не найден|не знайд|reject/.test(m) || /^e/.test(c);
}

/** Collapse a catalog/import response into a summary: {updated, warnings, errors}.
 *  Keeps every non-OK item's detail; drops the per-article "Товар обновлен" noise
 *  that made a 142-SKU response unreadable. */
function summarizeImport(body: any): {
  status: unknown;
  updated: number;
  total: number;
  warnings: Array<{ article: unknown; code: unknown; message: unknown }>;
  errors: Array<{ article: unknown; code: unknown; message: unknown }>;
} {
  const resp = body?.response;
  let items: any[] = [];
  if (Array.isArray(resp)) items = resp;
  else if (Array.isArray(resp?.log)) items = resp.log;
  else if (Array.isArray(resp?.products)) items = resp.products;
  else if (isPlainObject(resp)) {
    // Some responses key the per-article log by article id.
    const vals = Object.values(resp).filter((v) => isPlainObject(v) || Array.isArray(v));
    if (vals.length && vals.every((v) => isPlainObject(v))) items = vals as any[];
  }

  const warnings: Array<{ article: unknown; code: unknown; message: unknown }> = [];
  const errors: Array<{ article: unknown; code: unknown; message: unknown }> = [];
  let updated = 0;
  for (const it of items) {
    const article = (it && (it.article ?? it.id ?? it.parent_article)) ?? "?";
    const rawInfo = it && (it.info ?? it.log ?? it.messages ?? it.message);
    const infos = Array.isArray(rawInfo) ? rawInfo : rawInfo != null ? [rawInfo] : [];
    const bad = infos.filter((m: any) => {
      const code = isPlainObject(m) ? m.code : undefined;
      return isPlainObject(m) ? code != null && String(code) !== "0" : false;
    });
    if (bad.length === 0) {
      updated++;
      continue;
    }
    for (const m of bad) {
      const rec = { article, code: (m as any).code, message: (m as any).message };
      (isImportError((m as any).code, (m as any).message) ? errors : warnings).push(rec);
    }
  }
  return { status: body?.status, updated, total: items.length, warnings, errors };
}

// ---------------------------------------------------------------------------
// FIX #2 — load a large payload from disk. A tool argument cannot carry 142
// products × ~26 KB HTML, so `productsFile` points at a JSON file instead.
// ---------------------------------------------------------------------------

/** Read + validate a products payload from an ABSOLUTE JSON file path. Accepts
 *  either `{products:[…]}` or a bare `[…]`. Throws an actionable error on any
 *  problem (relative path, missing, unreadable, non-JSON, not a product list). */
export function loadProductsFile(filePath: string): Array<Record<string, unknown>> {
  if (!isAbsolute(filePath)) {
    throw new Error(`productsFile must be an ABSOLUTE path (got "${filePath}").`);
  }
  if (!existsSync(filePath)) {
    throw new Error(`productsFile not found: ${filePath}`);
  }
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (e) {
    throw new Error(`Cannot read productsFile ${filePath}: ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`productsFile ${filePath} is not valid JSON: ${(e as Error).message}`);
  }
  const arr = Array.isArray(parsed)
    ? parsed
    : isPlainObject(parsed) && Array.isArray((parsed as Record<string, unknown>).products)
      ? ((parsed as Record<string, unknown>).products as unknown[])
      : null;
  if (!Array.isArray(arr)) {
    throw new Error(
      `productsFile ${filePath} must be a JSON array of products, or an object with a "products" array.`,
    );
  }
  if (arr.length === 0) {
    throw new Error(`productsFile ${filePath} contains an empty product list.`);
  }
  arr.forEach((p, i) => {
    if (!isPlainObject(p)) {
      throw new Error(`productsFile ${filePath}: item ${i} is not a product object.`);
    }
  });
  return arr as Array<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// FIX #3 — writing an i18n cell to a language that is OFF (is_displayed_in_admin
// =0) returns OK but Horoshop SILENTLY DROPS the cell. Scan the payload for i18n
// subfields (title/short_description/description/seo…) that target an inactive
// language and surface a WARNING instead of a silent loss.
// ---------------------------------------------------------------------------

/** Known Horoshop language codes (ru/ua/en/pl/ro), from the shared LANG_INDEX. */
const KNOWN_LANGS = new Set(Object.keys(LANG_INDEX));

/** If `v` is a PURE i18n language bag ({ru:"…",ua:"…"}) return its language
 *  subkeys; otherwise []. Structural objects (parent:{id}, images:{override,
 *  links}) return [] because their keys are not all language codes. */
export function i18nLangKeys(v: unknown): string[] {
  if (!isPlainObject(v)) return [];
  const keys = Object.keys(v);
  if (keys.length === 0) return [];
  const allLangScalars = keys.every((k) => {
    const sub = (v as Record<string, unknown>)[k];
    return KNOWN_LANGS.has(k) && !isPlainObject(sub) && !Array.isArray(sub);
  });
  return allLangScalars ? keys : [];
}

interface InactiveLangFinding {
  article: string;
  field: string;
  lang: string;
}

/** Every payload i18n cell that targets a language explicitly OFF in `states`
 *  (states[lang] === false). Absent/unknown languages are never flagged — only
 *  ones the grid positively reports as disabled. */
export function scanInactiveLangCells(
  products: Array<Record<string, unknown>>,
  states: Record<string, boolean>,
): { findings: InactiveLangFinding[]; langs: string[] } {
  const findings: InactiveLangFinding[] = [];
  const langs = new Set<string>();
  for (const p of products) {
    const article = p.article == null ? "?" : String(p.article);
    for (const [field, val] of Object.entries(p)) {
      for (const lang of i18nLangKeys(val)) {
        if (states[lang] === false) {
          findings.push({ article, field, lang });
          langs.add(lang);
        }
      }
    }
  }
  return { findings, langs: [...langs] };
}

// ---------------------------------------------------------------------------
// FIX #5 — one catalog/import POST with heavy HTML descriptions drops the
// connection (fetch failed, a network abort, NOT an HTTP status) past ~130 KB.
// For REAL writes, auto-chunk the payload by BYTE size, retry the network abort,
// pace the chunks, and aggregate the per-chunk summaries into one. dryRun never
// chunks (it writes nothing).
// ---------------------------------------------------------------------------

/** Practical ceiling for one catalog/import POST body: ~130 KB is stable, ~400
 *  KB drops the connection — keep a margin under that. */
const POST_SIZE_LIMIT = 120_000;
const CHUNK_PAUSE_MS = 400;
const IMPORT_ATTEMPTS = 4;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function byteLen(v: unknown): number {
  return Buffer.byteLength(JSON.stringify(v ?? null), "utf8");
}

/** Split products so each chunk's JSON stays under `limit` bytes. A single
 *  product larger than the limit still ships alone (it cannot be split). */
export function chunkBySize(
  products: Array<Record<string, unknown>>,
  limit: number,
): Array<Array<Record<string, unknown>>> {
  const chunks: Array<Array<Record<string, unknown>>> = [];
  let cur: Array<Record<string, unknown>> = [];
  let curBytes = 2; // "[]"
  for (const p of products) {
    const b = byteLen(p) + 1; // + comma
    if (cur.length > 0 && curBytes + b > limit) {
      chunks.push(cur);
      cur = [];
      curBytes = 2;
    }
    cur.push(p);
    curBytes += b;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/** A dropped connection (not an HTTP/API error) is worth retrying; a Horoshop
 *  ERROR/HTTP_ERROR is deterministic and must NOT be. The client wraps network
 *  failures as "Network error calling …". */
export { isRetryableNetworkError } from "../admin/retry.js";

export async function importChunkWithRetry(
  client: any,
  store: string | undefined,
  chunk: Array<Record<string, unknown>>,
  attempts = IMPORT_ATTEMPTS,
): Promise<any> {
  let lastErr: unknown;
  for (let a = 1; a <= attempts; a++) {
    try {
      return await client.call(store, "catalog/import", { products: chunk }, "POST");
    } catch (e) {
      lastErr = e;
      if (!isRetryableNetworkError(e) || a === attempts) throw e;
      await sleep(300 * a); // linear backoff: 300 / 600 / 900 ms
    }
  }
  throw lastErr;
}

/** OK ⊕ WARNING = WARNING; keeps the noisier status when aggregating chunks. */
function mergeStatuses(a: unknown, b: unknown): unknown {
  if (a == null) return b;
  if (b == null) return a;
  const s = new Set([String(a), String(b)]);
  if (s.has("WARNING")) return "WARNING";
  if (s.has("OK")) return "OK";
  return a;
}

/** Concatenate several raw import bodies' response.log into one, preserving the
 *  {status, response:{log:[…]}} shape verbose consumers (feed-ingest) read. A
 *  single body is returned verbatim (back-compat). */
function mergeVerboseBodies(bodies: any[]): any {
  if (bodies.length === 1) return bodies[0];
  const log: any[] = [];
  let status: unknown;
  for (const b of bodies) {
    const l = b?.response?.log;
    if (Array.isArray(l)) log.push(...l);
    status = mergeStatuses(status, b?.status);
  }
  return { status, response: { log }, chunks: bodies.length };
}

export const catalogTools: ToolSpec[] = [
  {
    name: "horoshop_catalog_export",
    title: "Export catalog products",
    description:
      "Read products from a store's catalog. Filter by category (path or id), article, or showcase visibility, and paginate with offset/limit. " +
      "SIZE FIRST, AND IT IS ENFORCED — this export is HEAVY BY DEFAULT: it returns the full `description` / `marketplace_description` (inline HTML + CSS) on every row, so a 142-SKU catalog at limit:200 is ~4.7 MB / 33k lines and overflows the token limit. Measured per 100 products: ~75 KB scoped to four fields, ~1.3 MB with lite:true, ~6.9 MB raw. The answer is therefore MEASURED before it is returned and a payload over ~100 KB is REFUSED (`error:\"RESPONSE_TOO_LARGE\"`) with its size, the fields it would have contained and the limit that fits — nothing is dumped, so a mis-scoped call costs one short answer instead of the whole conversation. Scope it: `lite:true` (drops description + marketplace_description), `includedParams:[…]` (e.g. [\"article\",\"price\",\"presence\",\"title\"]), `excludedParams:[…]`, or a smaller `limit` + `offset`. `allowLarge:true` forces the full payload; HOROSHOP_EXPORT_MAX_BYTES moves the limit. Working page size is 100. " +
      "WHEN YOU SLICE `includedParams`, CHECK YOUR JOIN KEY CAME BACK. Horoshop normally answers with `article`, `parent_article` and `parent` on every row whatever you ask for — but that is the platform's habit, not something this tool adds, and nothing here re-injects them. If a scoped export ever comes back without `article`, you are holding rows you cannot match to anything; ask for it explicitly rather than assuming. " +
      "PAGINATION: there is no \"give me everything\" call — `limit:0` returns ZERO products, not all of them, and the platform CAPS one call at 500 whatever you ask (measured: limit:523 on a 523-SKU catalog returned exactly 500, with no warning — asking for the whole catalog in one call therefore loses the tail silently). Walk it with offset + limit. " +
      "`quantity` IS NOT STOCK: it reads 0 on every row of stores that do not run warehouse tracking (1725 of 1725 on one store while 714 products were actually in stock), so never compute availability from it — `presence` is the only trustworthy source. " +
      "COLOR ID CAVEAT (do not cross-reference with filter presets): a product's `color` here carries the PRODUCT-colour id (h_colors dictionary, 346-space), e.g. Фіолетовий reads back as color.id=21. That is a DIFFERENT id space from the `color=N` used in filter-preset `params` (the filter-group id, filter_colors 351-space, where Фіолетовий=10). Never decide a preset is empty by matching its `color=N` against this `color.id` — they will not line up (a live `color=10` preset returns products that export under color.id=21). To learn how many products a filter serves, read the storefront listing, not an id match. " +
      "CHARACTERISTICS — THE FIELD IS CALLED `characteristics`. It is one object per product, keyed by the per-category API field names: characteristics: {\"materal\": [{value:{ua,ru}}], \"color\": […]}. To fetch it with includedParams ask for \"characteristics\"; \"char\" is NOT a field (it only ever stood for one characteristic's key in an example) and Horoshop drops an unknown includedParam silently, so asking for it returns products with no characteristics and no error — this tool now rewrites char/chars/characteristic to `characteristics` and says so, and flags any requested field that came back on no product. " +
      "The values are NORMALISED here: the API returns a characteristic in four different shapes in one response ({id,value:{ua,ru}}, a bare {ua,ru}, a list of either, or a scalar), which makes `.value.ua` silently empty for about a third of them. This tool always returns a LIST of refs instead — [{id?, value:{ua,ru}}] — and iterating it while reading `entry.value.ua` is the one correct way to read a characteristic. " +
      "⚠ `id` IS OPTIONAL AND USUALLY ABSENT — do not key on it. It is a dictionary ref that only exists when the field is dictionary-backed: measured on two live stores, 0 of 400 values carried one (an earlier store had 2000 that did). Every answer reports what actually arrived under `characteristicsShape` (`values`, `valuesWithId`), so match characteristics by TEXT. " +
      "⚠ A FIELD CAN BE PRESENT AND EMPTY. Live products carry keys holding an empty list (every product on both stores had `title: []`), on which the documented read `v[0].value.ua` THROWS. Those keys are dropped from the answer and counted in `characteristicsShape.emptyFieldsDropped`, so what you iterate is only real values. " +
      "A language switched off on the store comes back as \"\" (both stores measured: `ru` empty, `ua` filled) — read `value.ua` ?? `value.ru`, never `ru` alone. A scalar value is mirrored into both languages, and any extra keys the API sends alongside `id` are preserved. Characteristic field names differ per category — export one article of the category to learn them.",
    inputSchema: {
      ...storeField,
      expr: z
        .object({
          parent: z
            .string()
            .optional()
            .describe("Category path, e.g. 'Toys \\ Soft toys'."),
          parentId: z
            .union([z.number().int(), z.array(z.number().int())])
            .optional()
            .describe("Category id or ids (sent as expr.parent.id)."),
          article: z
            .union([z.string(), z.array(z.string())])
            .optional()
            .describe("A single article or a list of articles."),
          displayInShowcase: z
            .union([z.literal(0), z.literal(1)])
            .optional()
            .describe("1 = only products shown in the showcase."),
        })
        .optional()
        .describe("Selection filter. Omit to export everything (use limit)."),
      offset: z.number().int().nonnegative().optional(),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Page size; pair with offset to walk large catalogs. 100 is the working size. NOT a max: limit:0 returns zero products, it does not mean \"all\"."),
      includedParams: z
        .array(z.string())
        .optional()
        .describe(
          "Return only these fields. Use the API's own names — characteristics live under `characteristics` (NOT \"char\": that is the placeholder for one characteristic's key inside it). An unknown name is silently ignored by Horoshop, so the answer reports any requested field that came back on no product.",
        ),
      excludedParams: z
        .array(z.string())
        .optional()
        .describe("Drop these fields from the export."),
      allowLarge: z
        .boolean()
        .optional()
        .describe(
          "Default false. The answer is measured before it is returned and a payload over the size limit (default 100 KB, override with HOROSHOP_EXPORT_MAX_BYTES) is REFUSED with the measured size and a concrete suggestion instead of overflowing the conversation. Set true to get it anyway.",
        ),
      lite: z
        .boolean()
        .optional()
        .describe(
          "Default false. When true, drops the heavy HTML fields (description, marketplace_description) to keep the payload small — the usual cause of a token overflow. Ignored if you pass includedParams (you have already scoped the fields). Merges with any excludedParams you also pass.",
        ),
    },
    annotations: { readOnlyHint: true },
    handler: async (client, args) => {
      const expr: Record<string, unknown> = {};
      if (args.expr?.parentId !== undefined) expr.parent = { id: args.expr.parentId };
      else if (args.expr?.parent !== undefined) expr.parent = args.expr.parent;
      if (args.expr?.article !== undefined) expr.article = args.expr.article;
      if (args.expr?.displayInShowcase !== undefined)
        expr.display_in_showcase = args.expr.displayInShowcase;

      const params: Record<string, unknown> = {};
      if (Object.keys(expr).length) params.expr = expr;
      if (args.offset !== undefined) params.offset = args.offset;
      if (args.limit !== undefined) params.limit = args.limit;

      // FIX: `char` is not a field name — map the known near-misses to the real
      // one and SAY SO, because Horoshop answers OK while omitting the field.
      const aliased: Record<string, string> = {};
      let included: string[] | undefined;
      if (args.includedParams) {
        included = [
          ...new Set(
            (args.includedParams as string[]).map((p) => {
              const to = INCLUDED_PARAM_ALIASES[String(p).trim().toLowerCase()];
              if (to && to !== p) {
                aliased[p] = to;
                return to;
              }
              return p;
            }),
          ),
        ];
        params.includedParams = included;
      }
      // `lite` drops the heavy HTML fields. It only makes sense when the caller
      // has NOT already narrowed the field set with includedParams; when they
      // have, respect that and leave it alone.
      let excluded = args.excludedParams ? [...args.excludedParams] : [];
      if (args.lite && !args.includedParams) {
        for (const f of HEAVY_EXPORT_FIELDS) if (!excluded.includes(f)) excluded.push(f);
      }
      if (excluded.length) params.excludedParams = excluded;

      const { body: exported, charShape } = normalizeExport(
        await client.call(args.store, "catalog/export", params),
      );
      // A stale build is invisible until it bites (an early report opened
      // with a rebuilt catalog_import that the running process never loaded), so
      // the catalog tools flag it too — silently when everything is current.
      const stale = staleBuildWarning();
      const products: any[] = (exported as any)?.response?.products ?? [];

      // Which requested fields came back on NO product at all. Horoshop drops an
      // unknown includedParam without a word, so this is the only way a typo
      // becomes visible instead of reading as "the data is empty".
      const notReturned = (included ?? []).filter((p) => !products.some((pr) => pr && Object.prototype.hasOwnProperty.call(pr, p)));
      const paramNotes = {
        ...(Object.keys(aliased).length
          ? {
              includedParamAliases: aliased,
              includedParamAliasNote: `Renamed to the API's own field name(s): ${Object.entries(aliased)
                .map(([from, to]) => `"${from}" → "${to}"`)
                .join(", ")}. Horoshop ignores an unknown includedParam silently, so the original name would have returned nothing.`,
            }
          : {}),
        // What the characteristics on THIS answer really are — the shape the
        // description used to promise was not the shape that arrived (D6).
        ...(charShape
          ? {
              characteristicsShape: charShape,
              characteristicsShapeNote:
                `Every value is normalised to \`[{value:{ua,ru}}]\`. \`id\` is OPTIONAL — it exists only on dictionary-backed values, and here ${charShape.valuesWithId} of ${charShape.values} value(s) carried one, so match by TEXT (\`value.ua\`), never by id.` +
                (Object.keys(charShape.emptyFieldsDropped).length
                  ? ` Dropped as empty (present on the product but holding no value, and \`v[0].value\` on them throws): ${Object.entries(
                      charShape.emptyFieldsDropped,
                    )
                      .map(([k, n]) => `"${k}" ×${n}`)
                      .join(", ")}.`
                  : "") +
                ` A language that is off on this store comes back as "" (read \`value.ua\` ?? \`value.ru\`, do not assume ru).`,
            }
          : {}),
        ...(notReturned.length && products.length
          ? {
              includedParamsNotReturned: notReturned,
              includedParamsNote: `${notReturned.join(", ")} was requested but is present on none of the ${products.length} returned product(s) — either the name is not an API field (characteristics live under "characteristics") or the value is genuinely unset on these products. Fields actually returned: ${[
                ...new Set(products.flatMap((p) => Object.keys(p ?? {}))),
              ].join(", ")}.`,
            }
          : {}),
      };

      const payload =
        exported && typeof exported === "object"
          ? { ...(exported as Record<string, unknown>), ...paramNotes, ...(stale.serverBuild ? stale : {}) }
          : exported;

      // ACTIVE SIZE GATE — refuse to dump a payload that will bury the caller.
      const limit = exportSizeLimit();
      const bytes = answerBytes(payload);
      if (args.allowLarge !== true && bytes > limit) {
        const per = products.length ? Math.round(bytes / products.length) : bytes;
        const fitting = per > 0 ? Math.max(1, Math.floor((limit * 0.9) / per)) : 1;
        const fields = [...new Set(products.flatMap((p) => Object.keys(p ?? {})))];
        return sizeRefusal({
          tool: "horoshop_catalog_export",
          bytes,
          limit,
          hint:
            `Narrow it and call again: scope the fields with includedParams (e.g. ["article","title","price","presence"] ≈ 750 B/product), ` +
            `${args.lite || args.includedParams ? "" : "or drop the HTML with lite:true, "}` +
            `or lower the page size to about limit:${fitting} at the current ${per} B/product (walk the rest with offset).`,
          extra: {
            store: args.store ?? null,
            ...paramNotes,
            products: products.length,
            bytesPerProduct: per,
            fieldsAvailable: fields,
          },
        });
      }
      return payload;
    },
  },
  {
    name: "horoshop_catalog_import",
    title: "Import / update catalog products",
    description:
      "Upsert products into the catalog, matched by `article`. This is the BULK write path for products — the fastest way to move many SKUs — but it is NOT the only one, and reading it as \"the only one\" costs real work: fields that live in the admin product editor and have no import key (per-product SEO, video, the alt text of a single image — 110-234 fields in all) are written with horoshop_admin_record_save entity=products (mind its product-guard: it drops [presence]/[countdown_end_time] unless you name them), stock is written with horoshop_admin_product_stock_set, and products ARE deletable — not through the public /api/, but through horoshop_admin_record_delete entity=products (pass withModifications:true to take the whole modification group). Because it writes in BULK, DRY RUN IS THE DEFAULT — exactly like every admin_* writer. dryRun:true (the default) writes NOTHING: it exports the current values for your payload's articles and returns `willChange` (per-article from→to for the fields you set) plus a `summary` (products, changed, new, fieldChanges). Review it, then pass dryRun:false to actually import. The preview is CLIENT-SIDE (Horoshop has no validateOnly): scalar and i18n fields (price, title{ua,ru}, presence, brand…) show a real from→to; structural fields (images, characteristics, gallery_common, gallery_360, icons, residues, price_levels) are shown as `opaque` \"will write\" entries, not a precise diff, because their import shape is unlike the export shape. An article not found in the catalog is flagged `isNew:true` (all fields new). " +
      "Images are fetched by URL (images.links[] for a modification, gallery_common.links[] for shared galleries). `presence` text can only be set when warehouse stock tracking is OFF. `parent` (or parent.id) is required for NEW products. " +
      "RESPONSE (dryRun:false): summarised by default to `{updated, warnings, errors}` — the per-article \"Товар обновлен\" line for hundreds of SKUs is dropped and only NON-OK items are itemised; pass `verbose:true` for the raw per-article Horoshop response (response.log with a code per article). Status WARNING is normal. " +
      "SIX TRAPS, all of which answer \"Товар обновлен\" while doing the wrong thing: (1) `icons[]` matches stickers BY NAME, not by id — passing ids creates junk stickers literally named \"3\"/\"12\" and hangs them on the product; pass the sticker's title (see horoshop_icons_export). (2) A NEW product is created HIDDEN — set `display_in_showcase:1` and a `presence`, or it appears nowhere on the storefront. (3) A characteristic that the product's category template does not define is dropped by Horoshop with status:OK — and the name may be perfectly real elsewhere in the store, because templates differ per category (measured: `materal` is valid on two of one store's three templates and silently dropped on the third). THIS TOOL NOW CHECKS IT BEFORE WRITING: every payload characteristic name is verified against the data template of that product's OWN category, and any name that would be dropped comes back as `characteristicSchemaWarnings` (with the full list the template does accept) in both the dry run and the real import. Articles whose category could not be resolved are listed separately under `characteristicSchemaUnverified` — not counted as passing. The check needs the admin session; where it is unavailable the import still runs and says so. (4) images.override defaults to true (replaces existing images) and gallery_360.removeAll:true wipes that gallery. (5) `quantity` IS NOT WRITABLE HERE — the field is accepted, the log says «Товар обновлен», and the stock does not move (measured: import quantity:5 → export still 0). Stock lives in the warehouse ledger; use horoshop_admin_product_stock_set (it posts the same income/expense document the admin's «Склад» column does and verifies the new number). This tool now flags a `quantity` in the payload instead of letting it pass silently. (6) THE EXPENSIVE ONE: a product can stay OUT of its category's storefront listing while every source you would check says it is live. Measured on a real store: after the import, catalog_export gives display_in_showcase:1, presence «Є в наявності» and the right parent.id, the admin grid says «Отображать: Да», the product page returns 200 and the article is in catalog-sitemap.xml — and 25+ minutes later the category page still says «Немає товарів». The storefront listing is served by a SEARCH INDEX that an /api/ import does not rebuild, and no tool in this server can see or trigger that rebuild. What it CAN do, and now does, is stop reporting \"updated 500/500, no warnings\" over it: an import that creates NEW articles returns `newProducts` plus a `categoryListingWarning` saying to verify by the product's own page and catalog-sitemap.xml rather than by the category listing. An edit to an existing product does not raise it (it cannot move a product in or out of a listing). If the listing must be populated, the fix is a reindex on Horoshop's side, not another import. " +
      "TIMER: to CLEAR a countdown, pass `countdown_end_time:\"\"` (an empty string) — it is stored as \"0000-00-00 00:00:00\" (the zero date), which reads back as \"no timer\"; it is not null. " +
      "Also: the generated `slug` is unpredictable — take the product URL from the `link` field of an export, never guess it. " +
      "CHARACTERISTICS — SHAPES ACCEPTED: Horoshop itself reads a characteristic ONLY as a plain value per field (`characteristics: {\"color\":\"Червоний\"}`, or an array of plain strings for a multi-value field). Any other shape is answered `status:OK` / «Товар обновлен» and written NOWHERE — which is exactly what an export→import round-trip used to do, because catalog_export returns a normalised REF LIST ([{id?,value:{ua,ru}}]) for reliable reading. This tool now NORMALISES on the way in, so all of these work and mean the same thing: \"380 г\" · [\"а\",\"б\"] · {ua:\"380 г\",ru:\"380 г\"} · {id:7,value:{ua:\"380 г\"}} · [{id:7,value:{ua:\"380 г\",ru:\"380 г\"}}]. The dry run prints the exact block that will be POSTed under `characteristics[].write` (plus `reshaped` / `skippedEmpty`). Two things are still refused OUT LOUD instead of being half-written: a ref whose per-language values DIFFER (import carries one value mirrored across languages — it cannot write ua≠ru; translate via horoshop_admin_dictionary_value_set), and a bare {id:N} with no text (import matches dictionary values by TEXT, not by id). An empty ref from an export ([{value:{ua:\"\",ru:\"\"}}]) is skipped, not sent; an explicit \"\" you pass yourself is still sent as a clear. " +
      "CHARACTERISTICS ARE PER MODIFICATION GROUP, NOT PER SKU: writing one on a single modification writes it for the whole group. Measured — a characteristic set on ZZTEST-CAP-001-B reads back on ZZTEST-CAP-001 too. So there is no way to give the red variant a different material from the blue one through this field, and looping over every SKU of a group just rewrites the same value N times. Anything that genuinely differs per variant belongs in the modification's own fields, not in `characteristics`. " +
      "BULK PAYLOAD (from disk): when the content is too large for a tool argument (142 products × ~26 KB HTML will not fit), pass `productsFile` — an ABSOLUTE path to a JSON file that is `{products:[…]}` or a bare `[…]` — instead of `products`. The two are mutually exclusive. " +
      "INACTIVE LANGUAGE (silent drop): writing an i18n cell (title/short_description/description/seo…) to a language that is OFF on the store (is_displayed_in_admin=0) returns OK but Horoshop SILENTLY DROPS the cell — export will not return it until you enable the language via horoshop_admin_language_set. This tool reads the store's active languages and returns a `languageWarnings` list (and marks those fields in the dry-run) so the loss is visible before you write. " +
      "WHITESPACE: Horoshop normalises whitespace in text nodes on import, so a saved `description` can read back ~1-2% SHORTER than what you sent — that is only collapsed spaces/newlines; tags, inline styles and HTML entities are preserved 1:1. Do not be alarmed by the length delta when verifying. " +
      "POST SIZE / RELIABILITY: a single import POST past ~130 KB of JSON (≈15 heavy-HTML descriptions, ~400 KB drops the connection) can fail as a NETWORK ABORT (not an HTTP error). On a real write (dryRun:false) this tool AUTO-CHUNKS the payload by size (~120 KB per POST), retries a dropped connection, paces the chunks, and aggregates the per-chunk results into one {updated, warnings, errors} summary (`chunks:N` reports how many POSTs it took). Dry-run never chunks.",
    inputSchema: {
      ...storeField,
      products: z
        .array(z.record(z.any()))
        .min(1)
        .optional()
        .describe(
          "Product objects (inline). MUTUALLY EXCLUSIVE with productsFile — pass exactly one. Common keys: article, parent_article, title{ru,ua}, description, short_description, price, price_old, discount, currency, presence, color, brand, mpn, gtin, parent | parent.id, alt_parent[], characteristics{...} (per-category field names), icons[], images{override,links[]}, gallery_common{override,links[]}, residues[], price_levels[] (B2B).",
        ),
      productsFile: z
        .string()
        .optional()
        .describe(
          "Absolute path to a JSON file holding the payload — use this for BULK/HEAVY content that will not fit in a tool argument (e.g. 142 products × ~26 KB HTML). The file is `{\"products\":[…]}` or a bare `[…]`. MUTUALLY EXCLUSIVE with `products`. Honours dryRun (default true) and the auto-chunking below.",
        ),
      dryRun: z
        .boolean()
        .optional()
        .describe(
          "Default TRUE (safety-first, like admin_* writers): preview from→to per article without writing. Set false to actually import.",
        ),
      verbose: z
        .boolean()
        .optional()
        .describe(
          "Default false: on a real import (dryRun:false) return the summarised {updated, warnings, errors}. Set true for the raw per-article Horoshop response (needed if you read response.log per item).",
        ),
    },
    annotations: {
      readOnlyHint: false,
      // destructive: images.override defaults to TRUE (replaces the existing
      // gallery) and gallery_360.removeAll wipes one. The tool's own trap (4)
      // says so; the annotation used to say the opposite.
      destructiveHint: true,
      idempotentHint: true,
    },
    handler: async (client, args) => {
      // FIX #2: resolve the payload from inline `products` OR a `productsFile` on
      // disk (xor). loadProductsFile validates path/JSON/shape and throws clearly.
      const inline = args.products as Array<Record<string, unknown>> | undefined;
      const productsFile = args.productsFile as string | undefined;
      if (inline && productsFile) {
        throw new Error("Pass either `products` (inline) or `productsFile` (path), not both.");
      }
      const rawProducts = productsFile ? loadProductsFile(productsFile) : inline;
      if (!rawProducts || rawProducts.length === 0) {
        throw new Error(
          "No products to import — provide `products` (inline) or `productsFile` (a JSON file path).",
        );
      }

      const dryRun = args.dryRun !== false;

      // CHARACTERISTICS: flatten every accepted shape (incl. the ref list our own
      // catalog_export returns) into the only shape catalog/import reads. Without
      // this an export→import round-trip answers OK and writes nothing. Done
      // BEFORE the language scan so a characteristic's {ua,ru} bag is not counted
      // as an i18n cell — by here it is already one plain value.
      const { products, report: charReport } = normalizeImportPayload(rawProducts);
      const charTouched = charReport.filter((c) => c.reshaped?.length || c.skippedEmpty?.length);

      // THE FIFTH "Товар обновлен" TRAP: `quantity` is accepted and ignored.
      // Measured on the test store: {"article":"STK-HOLO","quantity":5}
      // answered OK / «Товар обновлен», export still read 0. Stock is a warehouse
      // ledger document (lookup.php transfer_inout_save), not a product field, so
      // there is nothing to "fix" in the payload: the only honest thing is to say
      // so out loud instead of letting a silent no-op look like a write.
      const quantityArticles = products
        .filter((p) => p.quantity !== undefined && p.quantity !== null)
        .map((p) => (p.article == null ? "(no article)" : String(p.article)));
      const quantityWarning = quantityArticles.length
        ? `⚠️ \`quantity\` IS NOT WRITTEN by catalog/import — ${quantityArticles.length} product(s) carry it (${quantityArticles.slice(0, 10).join(", ")}${quantityArticles.length > 10 ? ", …" : ""}). Horoshop accepts the field, answers «Товар обновлен», and leaves the stock exactly where it was (measured: import quantity:5 → export still 0). Warehouse stock is a ledger document, not a product field: set it with horoshop_admin_product_stock_set (article or productId + quantity/delta), which posts the same income/expense the admin's «Склад» column does and re-reads the ledger to prove the new number. Every OTHER field in this payload is unaffected and imports normally.`
        : null;

      // FIX #3: only touch the languages grid when the payload actually carries an
      // i18n bag — a price-only import needs no admin call. Then flag any i18n cell
      // aimed at a language that is OFF (Horoshop answers OK but drops it).
      const hasI18n = products.some((p) => Object.values(p).some((v) => i18nLangKeys(v).length > 0));
      const langStates = hasI18n ? await languageStates(client, args.store) : {};
      const inactive = scanInactiveLangCells(products, langStates);
      const languageWarning =
        inactive.langs.length > 0
          ? `⚠️ Inactive language(s) ${inactive.langs.join(", ")}: ${inactive.findings.length} i18n cell(s) target a language that is OFF on this store (is_displayed_in_admin=0). Horoshop returns OK but SILENTLY DROPS these cells — they will not be saved and export will not return them until you enable the language via horoshop_admin_language_set (is_displayed_in_admin:1, enabled:1).`
          : null;

      if (dryRun) {
        const articles = products.map((p) => (p.article == null ? "" : String(p.article)));
        const payloadKeys = new Set<string>();
        for (const p of products) for (const k of Object.keys(p)) payloadKeys.add(k);
        const known = articles.filter((a) => a !== "");
        const current = known.length
          ? await fetchCurrentByArticle(client, args.store, [...new Set(known)], payloadKeys)
          : new Map<string, any>();

        // FIX: the SCHEMA guard, on the same map the diff already paid
        // for: a characteristic name the product's own category template does not
        // define is dropped by Horoshop with status:OK. Preview it here, so it is
        // seen BEFORE the write rather than discovered by re-exporting afterwards.
        const charSchema = await checkCharacteristicNames(client, args.store, products, current);

        const willChange: Array<{ article: string; isNew?: true; changes: Record<string, FieldChange> }> = [];
        const unchangedArticles: string[] = [];
        const noArticle: number[] = [];
        let newProducts = 0;
        let fieldChanges = 0;
        products.forEach((p, i) => {
          const article = articles[i];
          if (article === "") {
            noArticle.push(i);
            return;
          }
          const { isNew, changes } = collectChanges(current.get(article), p);
          if (isNew) newProducts++;
          const n = Object.keys(changes).length;
          if (n === 0 && !isNew) {
            unchangedArticles.push(article);
            return;
          }
          fieldChanges += n;
          willChange.push({ article, ...(isNew ? { isNew: true as const } : {}), changes });
        });

        // FIX #3: mark each will-write cell that lands on a disabled language.
        if (inactive.findings.length) {
          const marked = new Set(inactive.findings.map((f) => `${f.article}\u0000${f.field}.${f.lang}`));
          for (const w of willChange) {
            for (const [ck, cv] of Object.entries(w.changes)) {
              if (marked.has(`${w.article}\u0000${ck}`)) cv.inactiveLanguage = true;
            }
          }
        }

        return {
          store: args.store ?? null,
          action: "catalog_import",
          dryRun: true,
          ...staleBuildWarning(),
          ...(productsFile ? { productsFile } : {}),
          summary: {
            products: products.length,
            changed: willChange.filter((w) => !w.isNew).length,
            newProducts,
            unchanged: unchangedArticles.length,
            fieldChanges,
            ...(noArticle.length ? { payloadItemsMissingArticle: noArticle.length } : {}),
            ...(inactive.findings.length ? { inactiveLanguageCells: inactive.findings.length } : {}),
            ...(charSchema.findings.length ? { characteristicNamesDropped: charSchema.findings.reduce((n, f) => n + f.dropped.length, 0) } : {}),
          },
          ...(languageWarning ? { inactiveLanguages: inactive.langs, languageWarnings: inactive.findings } : {}),
          ...(quantityWarning ? { quantityWarning, quantityIgnoredFor: quantityArticles } : {}),
          ...schemaGuardFields(charSchema),
          ...(newProducts > 0 ? { categoryListingWarning: listingWarning(newProducts, true) } : {}),
          ...(charReport.length
            ? {
                characteristics: charReport,
                characteristicsNote:
                  "`write` is the EXACT characteristics block that will be POSTed — catalog/import only reads a plain value per field, so any ref list / {id,value} / {ua,ru} you passed (the shape catalog_export returns) was flattened to it here. `reshaped` lists the fields that were converted; `skippedEmpty` lists fields whose refs were all empty (an unset export cell) and are therefore not sent. Before this normalisation such a payload was answered status:OK / «Товар обновлен» with NOTHING written.",
              }
            : {}),
          willChange,
          ...(unchangedArticles.length ? { unchangedArticles } : {}),
          note:
            "Preview only — NOTHING was written. Set dryRun:false to import. Diff is client-side (Horoshop has no validateOnly): scalar/i18n fields show from→to; `opaque:true` fields (images, characteristics, gallery, icons, residues, price_levels) are shown as will-write, not a precise diff. isNew:true = article not in catalog; it is created HIDDEN unless display_in_showcase:1 + presence are set." +
            (charSchema.warning ? ` ${charSchema.warning}` : "") +
            (newProducts > 0 ? ` ${listingWarning(newProducts, true)}` : "") +
            (languageWarning ? ` ${languageWarning}` : "") +
            (quantityWarning ? ` ${quantityWarning}` : "") +
            (noArticle.length ? ` WARNING: ${noArticle.length} payload item(s) have no \`article\` — import matches by article and would misbehave.` : ""),
        };
      }

      // PRE-FLIGHT: three scoped fields per article, 100 articles per
      // call, BEFORE anything is written. It answers the two questions the real
      // write used to have no opinion on at all:
      //   • which articles are NEW      → the category-listing warning (FIX 3)
      //   • what category each sits in  → the characteristic-name guard (FIX 1)
      // Both are exactly the checks the dry run does; running them only in the
      // dry run meant the caller who passed dryRun:false — the one actually
      // changing the store — was the one who got no warning.
      const realArticles = [...new Set(products.map((p) => (p.article == null ? "" : String(p.article))).filter((a) => a !== ""))];
      const pre = realArticles.length
        ? await fetchImportPreflight(client, args.store, realArticles)
        : { rows: new Map<string, any>(), ok: true };
      const charSchema = await checkCharacteristicNames(client, args.store, products, pre.rows);
      // Only claim newness when the export actually answered — a failed pre-flight
      // also returns zero rows, and "all 500 of your products are new" would be a
      // fabrication, which is the very class of bug this wave exists to remove.
      const newArticles = pre.ok ? realArticles.filter((a) => !pre.rows.has(a)) : [];

      // REAL write — FIX #5: chunk by size, retry the network abort, pace the
      // chunks, aggregate the per-chunk summaries into one (never lose errors).
      // The POST-size ceiling is overridable via HOROSHOP_IMPORT_POST_LIMIT (bytes)
      // — production defaults to POST_SIZE_LIMIT; only tests lower it to force a split.
      const envLimit = Number(process.env.HOROSHOP_IMPORT_POST_LIMIT);
      const limit = Number.isFinite(envLimit) && envLimit > 0 ? envLimit : POST_SIZE_LIMIT;
      const chunks = chunkBySize(products, limit);
      const bodies: any[] = [];
      for (let i = 0; i < chunks.length; i++) {
        bodies.push(await importChunkWithRetry(client, args.store, chunks[i]));
        if (i < chunks.length - 1) await sleep(CHUNK_PAUSE_MS);
      }

      // "NEW" IS A PRE-FLIGHT GUESS UNTIL THE WRITE ANSWERS. `newArticles` says
      // "the catalog did not have this article before"; it does NOT say the import
      // created it. Horoshop rejects per article (measured: a product with no
      // resolvable category answers `code 7: Категория не найдена` and lands
      // nothing), and the answer then carried `status:WARNING updated:0` next to a
      // note claiming "1 NEW product(s) WERE CREATED" — a past-tense claim about a
      // write that did not happen, sitting one field away from the data that
      // disproves it. So the article set is narrowed by what the platform actually
      // refused, and the refused ones are reported under their own key instead of
      // being quietly counted as created.
      const rejectedArticles = new Set<string>();
      for (const b of bodies) {
        for (const e of summarizeImport(b).errors) {
          if (e?.article != null) rejectedArticles.add(String(e.article));
        }
      }
      const createdArticles = newArticles.filter((a) => !rejectedArticles.has(String(a)));
      const newRejected = newArticles.filter((a) => rejectedArticles.has(String(a)));
      const newProductFields = {
        ...(createdArticles.length
          ? { newProducts: createdArticles, categoryListingWarning: listingWarning(createdArticles.length, false) }
          : {}),
        ...(newRejected.length
          ? {
              newProductsRejected: newRejected,
              newProductsRejectedNote:
                "These articles did not exist before AND were refused by Horoshop, so nothing was created for them — see `errors` for the reason per article. They are deliberately NOT counted in `newProducts`, because a rejected import that reports products as created is the same lie as a silent one.",
            }
          : {}),
      };

      if (args.verbose === true) {
        const merged = mergeVerboseBodies(bodies);
        const stale = staleBuildWarning();
        return languageWarning || stale.serverBuild || charSchema.warning || newArticles.length
          ? {
              ...merged,
              ...stale,
              ...(languageWarning ? { inactiveLanguages: inactive.langs, languageWarnings: inactive.findings } : {}),
              ...(quantityWarning ? { quantityWarning, quantityIgnoredFor: quantityArticles } : {}),
              ...schemaGuardFields(charSchema),
              ...newProductFields,
            }
          : merged;
      }

      const agg = {
        status: undefined as unknown,
        updated: 0,
        total: 0,
        warnings: [] as Array<{ article: unknown; code: unknown; message: unknown }>,
        errors: [] as Array<{ article: unknown; code: unknown; message: unknown }>,
      };
      for (const b of bodies) {
        const s = summarizeImport(b);
        agg.status = mergeStatuses(agg.status, s.status);
        agg.updated += s.updated;
        agg.total += s.total;
        agg.warnings.push(...s.warnings);
        agg.errors.push(...s.errors);
      }
      const chunkNote = chunks.length > 1 ? ` (${chunks.length} chunks)` : "";
      return {
        store: args.store ?? null,
        action: "catalog_import",
        dryRun: false,
        ...staleBuildWarning(),
        ...(productsFile ? { productsFile } : {}),
        status: agg.status,
        updated: agg.updated,
        total: agg.total,
        ...(chunks.length > 1 ? { chunks: chunks.length } : {}),
        ...(agg.warnings.length ? { warnings: agg.warnings } : {}),
        ...(agg.errors.length ? { errors: agg.errors } : {}),
        ...(languageWarning ? { inactiveLanguages: inactive.langs, languageWarnings: inactive.findings } : {}),
        ...(quantityWarning ? { quantityWarning, quantityIgnoredFor: quantityArticles } : {}),
        ...schemaGuardFields(charSchema),
        ...newProductFields,
        ...(charTouched.length
          ? {
              characteristicsNormalised: charTouched,
              characteristicsNote:
                "These characteristics were NOT in the import shape and were flattened to the plain value catalog/import reads (`reshaped`), or were empty refs from an export and therefore not sent (`skippedEmpty`). Sent as-is they would have returned status:OK with nothing written. Verify with horoshop_catalog_export includedParams:[\"article\",\"characteristics\"].",
            }
          : {}),
        note:
          // "no warnings" is a CLAIM about the whole write, not about Horoshop's
          // reply — a payload can come back 1/1 updated while a characteristic was
          // dropped and a product was created outside its category listing. Only
          // say it when this tool has nothing to add either.
          (agg.errors.length || agg.warnings.length
            ? `${agg.updated}/${agg.total} updated${chunkNote}; ${agg.errors.length} error(s), ${agg.warnings.length} warning(s) itemised above. Pass verbose:true for the full per-article log.`
            : charSchema.warning || createdArticles.length
              ? `${agg.updated}/${agg.total} updated${chunkNote} — Horoshop reported no per-article warnings, but this tool has ${[charSchema.warning ? "a characteristic-name" : "", createdArticles.length ? "a new-product listing" : ""].filter(Boolean).join(" and ")} warning below. Pass verbose:true for the full per-article log.`
              : `${agg.updated}/${agg.total} updated${chunkNote}, no warnings. Pass verbose:true for the full per-article log.`) +
          (charSchema.warning ? ` ${charSchema.warning}` : "") +
          // Only for articles the platform actually accepted — see newProductFields.
          (createdArticles.length ? ` ${listingWarning(createdArticles.length, false)}` : "") +
          (languageWarning ? ` ${languageWarning}` : ""),
      };
    },
  },
  {
    name: "horoshop_catalog_process_images",
    title: "Process FTP-uploaded images",
    description:
      "Attach images that were uploaded over FTP to /content/import_images/. File names bind to products by article: `<article>@<n>.jpg` for the main gallery, `<article>@gallery_common@<n>.jpg` or `<article>@gallery_360@<n>.jpg` for the others. Only jpeg/gif/png are accepted. " +
      "DESTRUCTIVE OPTION: `removePrevImages:true` deletes each touched product's existing images before attaching the new ones. There is no dry run and no undo here — the originals are gone from the store and can only be restored by re-uploading them. It defaults to false; leave it false unless you are deliberately replacing galleries wholesale.",
    inputSchema: {
      ...storeField,
      removePrevImages: z
        .boolean()
        .optional()
        .describe(
          "Default false. TRUE deletes a product's previous images before attaching the new ones — irreversible, no dry run, no undo.",
        ),
    },
    annotations: {
      readOnlyHint: false,
      // destructive: removePrevImages:true irreversibly deletes existing galleries.
      destructiveHint: true,
      idempotentHint: false,
    },
    handler: async (client, args) =>
      client.call(args.store, "catalog/processImages", {
        removePrevImages: args.removePrevImages ?? false,
      }),
  },
  {
    name: "horoshop_icons_export",
    title: "Export stickers / icons",
    description:
      "List product stickers/icons (id, title, enabled). Horoshop v4 only. Use the titles when setting `icons` on catalog_import; reference existing stickers rather than inventing names.",
    inputSchema: { ...storeField },
    annotations: { readOnlyHint: true },
    handler: async (client, args) => client.call(args.store, "icons/export"),
  },
];
