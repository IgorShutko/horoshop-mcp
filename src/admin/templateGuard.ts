/**
 * PRE-FLIGHT SCHEMA GUARD for `catalog_import` — the fifth "Товар обновлен, and
 * nothing happened" trap, closed at the source instead of patched.
 *
 * MEASURED FAILURE (test store, 2026-08-01): a payload carrying
 * `characteristics: {materal: "…"}` for a product whose category uses data
 * template 381 is answered `{"status":"OK","updated":1,"note":"1/1 updated, no
 * warnings."}` and writes NOTHING. `materal` is a perfectly real field name — it
 * exists on templates 460 and 461 of the SAME store — it simply is not on 381.
 * Horoshop drops a characteristic its template does not define, silently, and
 * reports success. On a 500-SKU load with the wrong category that loses the whole
 * characteristics block with a green log.
 *
 * That is why this check is PER PRODUCT and not "does the name exist anywhere in
 * this store": the store-wide union would have waved the measured failure through.
 * The chain is product → its category → that category's data template → the
 * template's field list, which is exactly what `admin_template_schema` calls
 * `fieldNames` and what its own description already promises is "THE FIELD LIST
 * catalog_import/export accepts".
 *
 * NON-FATAL BY CONSTRUCTION. `catalog_import` runs over the public `/api/`; this
 * guard needs the ADMIN session (the template schema is not exposed by `/api/`).
 * A store whose admin login is unavailable must still be able to import, so every
 * failure here degrades to an honest "not verified" line and never throws.
 */

import type { EditTarget } from "./session.js";

/** Entity-type id / table of the site-pages tree — the pair `admin_page_get`
 *  opens a category with. Inlined rather than imported so this stays free of a
 *  tools/ → admin/ back-edge. */
const PAGES_HANDLER = 4;
const PAGES_TABLE = "pages";

/** The `<select>` that carries a category's data template on the page form. */
const TEMPLATE_SELECT = "names[handler]";

/**
 * Keys `catalog/export` puts inside `characteristics` that are NOT template
 * params. Measured on the test store: every product's bag carries `title: []` while
 * `admin_template_schema` lists only the real params, so flagging it would cry
 * wolf on every import that round-trips an export.
 */
const NON_TEMPLATE_CHAR_KEYS = new Set(["title"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * A product's category id out of whatever shape carries it.
 * `catalog/export` returns `parent: {id: 1083, value: "Футболки"}`; a payload may
 * carry a bare id, a numeric string — or a category NAME, which is not resolvable
 * here and is reported as unverified rather than guessed at.
 */
function categoryIdOf(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : null;
  if (typeof v === "string") return /^\d+$/.test(v.trim()) ? v.trim() : null;
  if (isPlainObject(v)) return categoryIdOf(v.id);
  return null;
}

/** Human label for a category, when the export shape carried one. */
function categoryLabelOf(v: unknown): string | null {
  if (isPlainObject(v) && typeof v.value === "string") return v.value;
  return null;
}

export interface CharSchemaFinding {
  article: string;
  /** "1083 (Футболки)" — where the product actually sits. */
  category: string | null;
  /** "461 (Футболки)" — the data template that category renders products with. */
  template: string | null;
  /** Names in THIS payload that the template does not define — silently dropped. */
  dropped: string[];
  /** Names in this payload that the template does define — these land. */
  kept: string[];
  /** Everything the template accepts, so the payload can be fixed in one look. */
  templateAccepts: string[];
}

export interface CharSchemaReport {
  /** Articles with at least one name that will be dropped. */
  findings: CharSchemaFinding[];
  /** Articles whose template could not be resolved — stated, never assumed OK. */
  unverified: Array<{ article: string; reason: string }>;
  /** How many articles carrying characteristics were actually checked. */
  checked: number;
  /** One-line summary for the tool's `note`, or null when everything is clean. */
  warning: string | null;
}

const EMPTY_REPORT: CharSchemaReport = { findings: [], unverified: [], checked: 0, warning: null };

function pageTarget(id: string | number): EditTarget {
  return { id, handler: PAGES_HANDLER, handlertable: PAGES_TABLE, extra: {}, flags: ["showPages"] };
}

/**
 * Verify every payload characteristic name against the data template of the
 * product's own category.
 *
 * @param currentByArticle  article → its current `catalog/export` row. Supplies
 *   both the category (`parent`) and the characteristic keys the platform already
 *   returns for that product — the latter are treated as accepted even when they
 *   are not template params, so a clean export→import round-trip never warns.
 */
export async function checkCharacteristicNames(
  client: any,
  store: string | undefined,
  products: Array<Record<string, unknown>>,
  currentByArticle: Map<string, any>,
): Promise<CharSchemaReport> {
  const withChars = products.filter(
    (p) => isPlainObject(p.characteristics) && Object.keys(p.characteristics as object).length > 0,
  );
  if (withChars.length === 0) return EMPTY_REPORT;

  const findings: CharSchemaFinding[] = [];
  const unverified: Array<{ article: string; reason: string }> = [];
  let checked = 0;

  // Resolved once per call, never across calls: a template's field list changes
  // the moment someone runs admin_template_param_add, and a cached "unknown" would
  // be a false alarm on the very next import.
  const templateOfCategory = new Map<string, { id: string; label: string | null } | null>();
  const fieldsOfTemplate = new Map<string, Set<string> | null>();

  async function templateFor(categoryId: string): Promise<{ id: string; label: string | null } | null> {
    if (templateOfCategory.has(categoryId)) return templateOfCategory.get(categoryId)!;
    let resolved: { id: string; label: string | null } | null = null;
    try {
      const form = await client.admin.getEditForm(store, pageTarget(categoryId));
      const sel = form.selects?.[TEMPLATE_SELECT];
      if (sel?.value) {
        resolved = { id: String(sel.value), label: sel.options?.find((o: any) => o.value === sel.value)?.label ?? null };
      }
    } catch {
      resolved = null; // admin unreachable — reported as unverified, never fatal
    }
    templateOfCategory.set(categoryId, resolved);
    return resolved;
  }

  async function fieldsFor(templateId: string): Promise<Set<string> | null> {
    if (fieldsOfTemplate.has(templateId)) return fieldsOfTemplate.get(templateId)!;
    let names: Set<string> | null = null;
    try {
      const groups = await client.admin.templateSchema(store, templateId);
      names = new Set<string>(
        (groups ?? []).flatMap((g: any) => (g.params ?? []).map((p: any) => p.name)).filter((n: any) => !!n),
      );
    } catch {
      names = null;
    }
    fieldsOfTemplate.set(templateId, names);
    return names;
  }

  for (const p of withChars) {
    const article = p.article == null ? "(no article)" : String(p.article);
    const names = Object.keys(p.characteristics as Record<string, unknown>);
    const current = currentByArticle.get(article);

    const categoryId = categoryIdOf(current?.parent) ?? categoryIdOf(p.parent);
    if (!categoryId) {
      unverified.push({
        article,
        reason: current
          ? "the export returned no numeric `parent` for this article"
          : "article is NEW and the payload carries no numeric `parent` (a category NAME cannot be resolved to a template here)",
      });
      continue;
    }

    const tpl = await templateFor(categoryId);
    if (!tpl) {
      unverified.push({ article, reason: `could not read the data template of category ${categoryId} (admin form unavailable)` });
      continue;
    }
    const fields = await fieldsFor(tpl.id);
    if (!fields) {
      unverified.push({ article, reason: `could not read the characteristic schema of template ${tpl.id}` });
      continue;
    }

    // Anything the platform ALREADY returns for this product is accepted too:
    // built-ins like `title` are in the export bag but on no template, and
    // warning about them would make the guard noise instead of signal.
    const alreadyOnProduct = isPlainObject(current?.characteristics) ? Object.keys(current.characteristics) : [];
    const accepted = new Set<string>([...fields, ...NON_TEMPLATE_CHAR_KEYS, ...alreadyOnProduct]);

    checked++;
    const dropped = names.filter((n) => !accepted.has(n));
    if (dropped.length === 0) continue;

    findings.push({
      article,
      category: `${categoryId}${categoryLabelOf(current?.parent) ? ` (${categoryLabelOf(current?.parent)})` : ""}`,
      template: `${tpl.id}${tpl.label ? ` (${tpl.label})` : ""}`,
      dropped,
      kept: names.filter((n) => accepted.has(n)),
      templateAccepts: [...fields].sort(),
    });
  }

  const droppedTotal = findings.reduce((n, f) => n + f.dropped.length, 0);
  const warning = findings.length
    ? `⚠️ ${droppedTotal} characteristic name(s) on ${findings.length} product(s) are NOT defined by the data template of the product's own category and WILL BE SILENTLY DROPPED: ` +
      findings
        .slice(0, 5)
        .map((f) => `${f.article} → ${f.dropped.join(", ")} (template ${f.template} accepts: ${f.templateAccepts.join(", ") || "(no characteristics at all)"})`)
        .join(" · ") +
      (findings.length > 5 ? ` · …and ${findings.length - 5} more (see characteristicSchemaWarnings)` : "") +
      ". Horoshop answers status:OK / «Товар обновлен» for these and writes nothing — the name is only accepted on the template its category uses (the SAME name can be valid for another category). Fix the name, move the product to the right category, or add the field with horoshop_admin_template_param_add."
    : null;

  return { findings, unverified, checked, warning };
}

/**
 * Scoped `catalog/export` used only as pre-flight: article → {parent,
 * characteristics}. Cheap on purpose (three fields, 100 articles per call) — a
 * real import must not pay for a full catalog read to get a warning right.
 *
 * `ok` is NOT redundant with `rows.size`: an import of nothing but brand-new
 * articles answers with zero rows and is perfectly healthy, while a failed export
 * also answers with zero rows. Telling those apart is the difference between
 * "these products are new" and a fabricated claim that they are.
 */
export async function fetchImportPreflight(
  client: any,
  store: string | undefined,
  articles: string[],
): Promise<{ rows: Map<string, any>; ok: boolean }> {
  const rows = new Map<string, any>();
  let ok = true;
  const CHUNK = 100;
  for (let i = 0; i < articles.length; i += CHUNK) {
    try {
      const body = await client.call(store, "catalog/export", {
        expr: { article: articles.slice(i, i + CHUNK) },
        includedParams: ["article", "parent", "characteristics"],
      });
      for (const p of body?.response?.products ?? []) if (p?.article != null) rows.set(String(p.article), p);
    } catch {
      // Degrade honestly: the caller reports "not verified", it does not fail.
      ok = false;
    }
  }
  return { rows, ok };
}
