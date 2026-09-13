import { z } from "zod";
import { storeField, type ToolSpec } from "../register.js";
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
import { INDEX_LANG, fieldValue, type GridRow, type ParsedForm } from "../admin/form.js";
import { listEntities, resolveEntity, type AdminEntity } from "../admin/entities.js";
import { gridLabelLanguage } from "../admin/languageState.js";
import type { EditTarget } from "../admin/session.js";
import { resolveBlogNode, resolveNewsRubrics } from "../admin/newsTree.js";
import { answerBytes, fittingCount, responseSizeLimit } from "../sizeGate.js";

const entityArg = z
  .union([z.number().int(), z.string()])
  .describe(
    "Entity to target: a slug (e.g. \"coupons\", \"brands\", \"benefits\") or its numeric handler (e.g. 263). See horoshop_admin_entities.",
  );

/**
 * Resolve the entity AND its handler FOR THIS STORE.
 *
 * The second half is not decoration. A live probe measured an entity whose handler
 * number differs per store (`vchasno_payment`: 458 vs 468) — and the wrong
 * number does not fail, it renders an empty grid and reports success. Every
 * generic reader/writer therefore goes through `entityForStore`, which is a
 * no-op (and makes no request) for the entities whose number is fixed.
 */
async function requireEntity(client: any, store: string | undefined, key: number | string): Promise<AdminEntity> {
  const ent = resolveEntity(key);
  if (!ent) {
    const known = listEntities()
      .map((e) => `${e.slug}(${e.handler})`)
      .join(", ");
    throw new Error(`Unknown admin entity "${key}". Known: ${known}.`);
  }
  return client.admin.entityForStore(store, ent);
}

/**
 * ORDERS ARE NOT A GENERIC RECORD — and reading one generically LITTERS the grid.
 *
 * The orders editor (handler 443) is the one screen that needs `action=edit` in
 * its URL. `edit.php?id=N&handler=443` without it answers 200, renders a blank
 * «Новый заказ» form and materialises an empty 0.00 ROW in the orders grid; the
 * form then posts to `/order/submit/`, not to save.php, so a generic
 * read-modify-write cannot persist it either. The entity is registered for
 * LISTING only (admin_list gives the record ids the order tools address); every
 * generic reader/writer/deleter is sent to the named tools instead.
 */
const ORDER_HANDLER = 443;

function assertNotOrders(ent: AdminEntity, instead: string): void {
  if (ent.handler !== ORDER_HANDLER) return;
  throw new Error(
    `Entity "orders" (handler ${ORDER_HANDLER}) is not reachable through the generic admin tools: its editor needs \`action=edit\` (without it Horoshop renders a blank «Новый заказ» and LEAVES AN EMPTY 0.00 ROW in the orders grid) and it saves through /order/submit/, not save.php. Use ${instead}. Listing is fine: horoshop_admin_list entity="orders" returns the admin record ids these tools take.`,
  );
}

function targetFor(ent: AdminEntity, id: string | number, parent?: number): EditTarget {
  const extra: Record<string, string | number> = {};
  if (parent !== undefined) extra.parent = parent;
  return { id, handler: ent.handler, handlertable: ent.handlertable, extra, flags: ent.flags };
}

/** Read an entity's form — from its utils page if it's a settings singleton, else via edit.php. */
function readForm(
  client: any,
  store: string | undefined,
  ent: AdminEntity,
  id: string | number,
  parent?: number,
): Promise<ParsedForm & { url: string }> {
  return ent.formUrl
    ? client.admin.getFormFromUrl(store, ent.formUrl)
    : client.admin.getEditForm(store, targetFor(ent, id, parent));
}

/**
 * List an entity's records. The pages tree isn't a datagrid, so read it from the
 * documented `pages/export` API (returns every node with id/parent/title);
 * everything else comes from the admin datagrid.
 */
async function listFor(
  client: any,
  store: string | undefined,
  ent: AdminEntity,
  opts: { parent?: number; page?: number; perPage?: number; maxRows?: number } = {},
): Promise<GridRow[]> {
  if (ent.deleteMode !== "tree") {
    return client.admin.listRecords(store, ent.handler, opts);
  }
  const body = await client.call(store, "pages/export", {});
  const arr: any[] = body?.response?.pages ?? (Array.isArray(body?.response) ? body.response : []);
  return arr.map((p) => ({
    id: String(p.id),
    label: p.title?.ua ?? p.title?.ru ?? p.title?.en ?? String(p.id),
    cells: [],
  }));
}

function mapSelects(form: ParsedForm) {
  const out: Record<string, { value: string; options: Array<{ value: string; label: string }> }> = {};
  for (const [name, info] of Object.entries(form.selects)) out[name] = info;
  return out;
}

/**
 * THE h_news MINE — the defect that cost 10 published articles their rubric.
 *
 * Read-modify-write is safe on most entities: the edit form renders the stored
 * values, so replaying them writes back what was already there. `pages`
 * (handler 4) proved that across 18 nodes — the tree `parent` survives untouched.
 *
 * Blog/news articles (`blog_posts`, h_news, handler 172) are the EXCEPTION, and
 * nothing in the generic tools said so. Their form carries `names[parent]` — the
 * rubric the article lists under — as a select that is RE-SEEDED to a default
 * rather than to storage. Replay it and the article silently moves to whatever
 * section the seed points at. That is exactly what happened: a raw
 * getEditForm+save over 10 articles filed them all under «Політика
 * конфіденційності» and they vanished from /blog/.
 *
 * So the generic writer now behaves like the named `blog_post_update`: unless the
 * caller sets `names[parent]` explicitly (a deliberate move), the field is dropped
 * from the replay, which preserves the stored rubric — and the answer says so.
 */
const NEWS_HANDLER = 172;
const NEWS_PARENT_FIELD = "names[parent]";

function isNewsEntity(ent: AdminEntity): boolean {
  return ent.handler === NEWS_HANDLER || ent.slug === "blog_posts";
}

const NEWS_RMW_WARNING =
  `RUBRIC PROTECTED: ${NEWS_PARENT_FIELD} was dropped from this save. On blog_posts (h_news, handler 172) the edit form re-seeds that select to a DEFAULT instead of the stored rubric, so a plain read-modify-write RELOCATES the article (this once moved 10 live posts out of «Блог» and off the /blog/ page). Omitting the field preserves the stored rubric. To move an article on purpose, either set "${NEWS_PARENT_FIELD}" explicitly in \`set\`, or use horoshop_admin_blog_post_update with \`rubric\` — which also verifies the move against the grid.`;

/** Drop one field from a form's replay set (the original stays intact for reads). */
function withoutField<T extends ParsedForm>(form: T, name: string): T {
  const fields = form.fields.filter((f) => f.name !== name);
  return { ...form, fields, fieldNames: new Set(fields.map((f) => f.name)) };
}

/** Drop several fields from a form's replay set. */
function withoutFields<T extends ParsedForm>(form: T, names: Set<string>): T {
  if (names.size === 0) return form;
  const fields = form.fields.filter((f) => !names.has(f.name));
  return { ...form, fields, fieldNames: new Set(fields.map((f) => f.name)) };
}

/**
 * THE PRODUCT EDITOR'S RE-SEEDED FIELDS — the h_news rubric trap, on products.
 *
 * Once the product form parses (it did not until the raw-slice fix), a plain
 * read-modify-write is only safe if these two are held back. Both were measured
 * on the test store by diffing `catalog/export` around one `record_save` that
 * touched a single unrelated field:
 *
 *  - `…[presence]` — the availability select. It carries a real `selected`, so
 *    the `unselected` guard does not catch it, yet it is NOT the stored value:
 *    a product whose presence is a custom status (id 9 «Є в наявності») renders
 *    the select on id 1 «В наявності». Replaying it silently rewrites the
 *    availability line the storefront prints on the card.
 *  - `…[countdown_end_time]` — a hidden the server seeds with `now + ~5 h`
 *    whenever the product has no countdown. Replaying it TURNS THE PROMO
 *    COUNTDOWN ON: after one field-preserving save, a product that had no
 *    countdown at all came back with `countdown_end_time` five hours out.
 *
 * The names are matched by suffix so both editor layouts are covered: the
 * single-modification form calls them `names[presence]`, the table layout
 * `modifications[0][presence]`, `modifications[1][presence]`, …
 *
 * Set either explicitly and it is sent — the guard only protects fields the
 * caller did not ask to change. Presence is better set through
 * `horoshop_catalog_import` (`presence`), which is the documented path.
 */
const PRODUCT_HANDLER = 17;
const PRODUCT_RESEEDED_RE = /\[(presence|countdown_end_time)\]$/;

function isProductEntity(ent: AdminEntity): boolean {
  return ent.handler === PRODUCT_HANDLER || ent.slug === "products";
}

/**
 * THE SLUG MINE — a page that reports "created and verified" and 404s.
 *
 * A page/category slug is NOT a plain field: it belongs to the `zteel.params.url`
 * widget, which keeps its own p_name tree. `names[name][slug]` persists ONLY when
 * `names[name][parent]` carries the p_name-row id of the page's parent. Send the
 * slug alone and the server accepts the POST, answers 302, stores NOTHING for the
 * slug — and every later read agrees, because the form has an empty slug and
 * reads back empty. Measured on the test store: record_save id=addnew with
 * names[name][slug]=zz2a-testpage → created:true, slug reads back "", storefront
 * 404 in both languages; the same record re-saved with names[name][parent]="1"
 * → slug persists, storefront 200.
 *
 * So the generic writer now resolves that parent itself (the same widget call the
 * admin's own JS makes) whenever a caller writes a slug without one, and reports
 * what it did. Nothing is guessed: if the widget returns no parent, the answer
 * says the slug will not persist instead of claiming success.
 */
const PAGES_HANDLER = 4;
const SLUG_FIELD = "names[name][slug]";
const SLUG_PARENT_FIELD = "names[name][parent]";

function isPagesEntity(ent: AdminEntity): boolean {
  return ent.handler === PAGES_HANDLER && !ent.singleton;
}

/**
 * Can a buyer actually open this page? Reads the slug the record KEPT and asks
 * the storefront for it, so a create/slug-write reports a real HTTP status
 * instead of inferring reachability from a form field that reads back fine.
 * Never throws — a shop that does not answer reports `null`, not a failure.
 */
async function pageReachability(
  client: any,
  store: string | undefined,
  id: string | number,
  parent?: number,
): Promise<{ slug: string | null; link: string | null; storefrontStatus: number | null; storefrontReachable: boolean | null }> {
  let slug = "";
  try {
    const form = await client.admin.getEditForm(store, {
      id,
      handler: PAGES_HANDLER,
      handlertable: "pages",
      extra: parent !== undefined ? { parent } : {},
      flags: ["showPages"],
    });
    slug = form.fieldNames.has(SLUG_FIELD) ? fieldValue(form, SLUG_FIELD) : "";
  } catch {
    return { slug: null, link: null, storefrontStatus: null, storefrontReachable: null };
  }
  if (!slug) return { slug: null, link: null, storefrontStatus: null, storefrontReachable: false };
  const link = `/${slug}/`;
  try {
    const r = await client.shop.page(store, link);
    const status = typeof r?.httpStatus === "number" ? r.httpStatus : null;
    return { slug, link, storefrontStatus: status, storefrontReachable: status === null ? null : status >= 200 && status < 400 };
  } catch {
    return { slug, link, storefrontStatus: null, storefrontReachable: null };
  }
}

/** The page-tree parent of an existing node, from the documented pages/export. */
async function pageParentOf(client: any, store: string | undefined, id: string | number): Promise<number | null> {
  const body = await client.call(store, "pages/export", {}).catch(() => ({}));
  const arr: any[] = body?.response?.pages ?? (Array.isArray(body?.response) ? body.response : []);
  const row = arr.find((p) => String(p.id) === String(id));
  return row && row.parent != null ? Number(row.parent) : null;
}

const PRODUCT_RMW_WARNING = (dropped: string[]): string =>
  `PRODUCT FIELDS PROTECTED: ${dropped.join(", ")} ${dropped.length === 1 ? "was" : "were"} dropped from this save. On the product editor neither reflects storage — the presence select is re-seeded (a custom status id 9 renders as id 1, so a replay rewrites the availability shown on the card) and countdown_end_time is seeded with "now + ~5h", so a replay switches a promo countdown ON for a product that never had one. Both were caught by diffing catalog/export around a save. Omitting them preserves what is stored. To change availability use horoshop_catalog_import (\`presence\`); to set a countdown deliberately, pass the field in \`set\`.`;

/**
 * THE hidden+checkbox PAIR — a verification trap that fooled two readers.
 *
 * A boolean in this admin is rendered as a hidden input carrying the 0 default
 * IMMEDIATELY followed by the checkbox carrying 1. When the box is checked the
 * browser submits both and PHP keeps the LAST one, so the effective value is the
 * checkbox's. `record_get` used to report `names[enabled]` = "1" under `fields`
 * and, at the same time, = "0" under `hidden` — the same field with two opposite
 * values and nothing saying which is real. One reader hesitated over it; another
 * read the hidden default, concluded a set of live filter presets was "empty /
 * switched off", and reported a defect that did not exist.
 *
 * So the two are no longer mixed: a hidden input that has a checkbox of the SAME
 * name is not a value at all, it is the form's off-default, and it moves out of
 * `hidden` into `hiddenDefaults` with an explicit note.
 */
function splitHidden(form: ParsedForm): {
  hidden: Record<string, string>;
  hiddenDefaults: Record<string, string>;
} {
  const hidden: Record<string, string> = {};
  const hiddenDefaults: Record<string, string> = {};
  for (const [name, value] of Object.entries(form.hidden)) {
    if (form.checkboxNames?.has(name)) hiddenDefaults[name] = value;
    else hidden[name] = value;
  }
  return { hidden, hiddenDefaults };
}

/**
 * PER-RECORD TRANSLATION STATE — the opt-in half of the label-language fix.
 *
 * The grid has no per-language data at all, so this is the only honest way to
 * answer "is this record translated?", and it costs one form read PER RECORD —
 * hence opt-in and capped. The default answer stays one request and simply says
 * which language you are reading.
 */
const LANG_STATUS_MAX = 30;
const I18N_FIELD_RE = /\[i18n\]\[(\d+)\]\[/;
/** The pages tree is labelled from pages/export, which `listFor` reads ua-first. */
const TREE_LABEL_LANG = "ua";

/** Languages that have any non-empty i18n field on a record's form. */
function langFill(form: ParsedForm): { filled: string[]; empty: string[] } | null {
  const seen = new Map<string, boolean>();
  for (const f of form.fields) {
    const m = I18N_FIELD_RE.exec(f.name);
    if (!m) continue;
    const code = INDEX_LANG[Number(m[1])];
    if (!code) continue;
    const has = typeof f.value === "string" && f.value.trim() !== "";
    seen.set(code, (seen.get(code) ?? false) || has);
  }
  if (seen.size === 0) return null; // record has no per-language fields at all
  const filled: string[] = [];
  const empty: string[] = [];
  for (const [code, has] of seen) (has ? filled : empty).push(code);
  return { filled, empty };
}

async function attachLangStatus(
  client: any,
  store: string | undefined,
  ent: AdminEntity,
  records: Array<{ id: string; label: string }>,
  parent?: number,
): Promise<{ records: Array<Record<string, any>>; status: Record<string, any> }> {
  if (ent.special === "heavy" || ent.special === "no-form") {
    throw new Error(
      `langStatus is not available for "${ent.slug}": it is a ${ent.special} editor whose records do not open as a plain form. Read a single record with horoshop_admin_record_get instead.`,
    );
  }
  const slice = records.slice(0, LANG_STATUS_MAX);
  const out: Array<Record<string, any>> = [];
  let noI18n = 0;
  for (const r of records) {
    if (!slice.includes(r)) {
      out.push(r);
      continue;
    }
    try {
      const form = await readForm(client, store, ent, r.id, parent);
      const fill = langFill(form);
      if (!fill) {
        noI18n++;
        out.push({ ...r, langsFilled: null });
      } else {
        out.push({ ...r, langsFilled: fill.filled, langsEmpty: fill.empty });
      }
    } catch (e) {
      out.push({ ...r, langStatusError: e instanceof Error ? e.message : String(e) });
    }
  }
  return {
    records: out,
    status: {
      checked: slice.length,
      of: records.length,
      ...(records.length > LANG_STATUS_MAX ? { truncated: true, cap: LANG_STATUS_MAX } : {}),
      ...(noI18n ? { withoutI18nFields: noI18n } : {}),
      cost: `${slice.length} extra form read(s)`,
    },
  };
}

/**
 * ONE array under ONE name — and a GUARD where the wrong name used to be.
 *
 * Two measurements, one design.
 *
 * (1) A cleanup script read `admin_list(...).rows`, got `undefined` next
 *     to `count:25`, concluded the grid was empty and would have left a live test
 *     product in the catalog had a second read not caught it. `undefined` is the
 *     dangerous answer here, because it reads exactly like "nothing to do".
 * (2) The fix for (1) — publishing the SAME array under both names —
 *     made JSON write every row twice. Measured on the test store: 174 KB of a
 *     349 KB listing was the duplicate, i.e. half of every answer, on a server
 *     whose whole size gate exists to keep answers under 100 KB.
 *
 * So `rows` no longer holds a copy. It holds a small, fixed-size object that
 * says where the list is. That keeps the property (1) was bought for — reading
 * `rows` never looks like an empty grid — while costing O(1) instead of O(n):
 *   • truthy, so `if (!rows)` does not fire;
 *   • no `.length`, so `rows.length === 0` is false, not "empty";
 *   • NOT iterable and NOT mappable, so `for (const r of rows)` / `rows.map()`
 *     throw LOUDLY instead of quietly yielding nothing.
 * An answer that lies quietly is the failure mode this server is built against;
 * an answer that throws is not.
 */
interface RowsGuard {
  NOT_THE_LIST: string;
  readInstead: "records";
  count: number;
}

function rowsGuard(count: number): RowsGuard {
  return {
    NOT_THE_LIST:
      `The rows are in \`records\` (${count} here). \`rows\` used to be a second copy of the same array and ` +
      `doubled the size of every listing, so it now holds this note. It is deliberately NOT an array: ` +
      `reading it as one throws, instead of looking like an empty grid.`,
    readInstead: "records",
    count,
  };
}

function listAliases<T>(records: T[]): { records: T[]; rows: RowsGuard } {
  return { records, rows: rowsGuard(records.length) };
}

/**
 * Explain what `label` is — and, more importantly, what it is NOT.
 *
 * The grid renders its i18n columns in ONE language, so a fully translated
 * record is indistinguishable from an untranslated one here. Two records were
 * overwritten on a live store for exactly that reason (one of them holding the
 * `−{DISCOUNT_PERCENT}%` template), so the language now travels with the answer.
 */
function labelLangBlock(lang: { code: string | null; raw: string | null; firstLanguage: string | null }) {
  if (lang.code === TREE_LABEL_LANG) {
    // The pages tree is not a datagrid: its labels come from pages/export, which
    // hands back a title per language and is read ua-first here.
    return {
      labelLang: TREE_LABEL_LANG,
      labelLangNote:
        "`label` for the pages tree comes from pages/export and is read ua-first (falling back to ru/en only when ua is empty) — it is NOT a translation indicator, and it is not the same language the datagrid entities label with. Read the node with horoshop_admin_page_get to see every language.",
    };
  }
  if (!lang.code) return {};
  const first =
    lang.firstLanguage && lang.firstLanguage !== lang.code
      ? ` (the admin panel's own UI language — the store's FIRST language is ${lang.firstLanguage}, so these labels are not the primary-language text either)`
      : " (the admin panel's own UI language)";
  return {
    labelLang: lang.code,
    labelLangNote:
      `\`label\` is the datagrid's text and the grid renders every multilingual column in ${lang.code} only${first}. ` +
      `IT IS NOT A TRANSLATION INDICATOR: a record whose other languages are already written looks exactly like one where they are empty — that is how a correctly translated sticker, and one holding the template "−{DISCOUNT_PERCENT}%", were both overwritten as if untranslated. ` +
      `To see per-language content: pass langStatus:true (one extra form read per record, capped at ${LANG_STATUS_MAX}) or read the record with horoshop_admin_record_get.`,
  };
}

export const adminGenericTools: ToolSpec[] = [
  {
    name: "horoshop_admin_entities",
    title: "List admin entity types",
    description:
      "List the reverse-engineered admin entity types the generic admin tools can reach (slug, handler id, title, and whether it needs special handling). Use to discover what horoshop_admin_record_get / _save / _list / _delete can target.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
    handler: async () => listEntities(),
  },
  {
    name: "horoshop_admin_record_get",
    title: "Read any admin record",
    description:
      "Read ANY admin record (any entity type) into its complete field set: every input/textarea value, every dropdown with its options (dictionaries), and the hidden service fields. This is the universal reader behind the admin panel — pass an entity slug/handler and a record id. For create-form inspection use id \"addnew\". Note: a few entities (products, client cards) are heavy special editors and may not open with a blank id. " +
      "SIZE: some forms are enormous — site_settings measures 364–374 fields / 100–211 KB on live stores. The record's own values are never what gets dropped: when the answer is over the response size limit the DROPDOWN OPTION lists are cut first (`selectsOptionsTruncated:true`, each select keeping `optionsTotal`), because 47 KB of that payload is option lists — one timezone select alone carries 412. Only if the FIELDS themselves still overflow is the answer refused, and then `fields:[\"seo\",\"delivery\"]` returns just the ones whose name matches (reported as `fieldsFilter` / `fieldsReturned`, so a partial read is never mistaken for a whole one). " +
      "WHERE THE VALUE IS: `fields` is the authority for every field. A boolean (names[enabled], names[act]…) is rendered as a hidden 0-default PLUS a checkbox, and the checkbox wins — those hidden defaults are therefore reported separately under `hiddenDefaults` (with the checkbox names listed in `checkboxFields`), NOT mixed into `hidden`, because seeing the same name as \"1\" in fields and \"0\" in hidden once led a reader to declare a set of live, enabled records switched off. `hidden` now holds only genuine hidden service values. " +
      "\u26a0 NOT EVERY FORM FIELD REFLECTS STORAGE. For blog_posts (h_news, handler 172) the `names[parent]` select — the article's rubric — is re-seeded to a DEFAULT, not to the stored value: do not trust it, and never feed it back through a raw read-modify-write (that is what once moved 10 published articles into a foreign rubric). Asymmetry worth remembering: on pages (handler 4) raw RMW is safe and the tree parent survives; on h_news it is not. Use horoshop_admin_blog_post_update for articles — it preserves or moves the rubric deliberately and verifies the result against the grid.",
    inputSchema: {
      ...storeField,
      entity: entityArg,
      id: z
        .union([z.number().int(), z.string()])
        .describe("Record id, or \"addnew\" to inspect a blank create form."),
      parent: z.number().int().optional().describe("Parent id (context for tree entities like pages)."),
      fields: z
        .array(z.string())
        .optional()
        .describe(
          "Return only the fields whose NAME contains one of these substrings (case-insensitive) — how to read ONE section of a giant form instead of all of it (site_settings is 339 fields / 187 KB). Applies to `fields`, `selects`, `hidden` and `hiddenDefaults` alike. `fieldCount` still reports the form's true size and `fieldsFilter` reports what was applied, so a filtered read can never be mistaken for the whole record.",
        ),
    },
    annotations: { readOnlyHint: true },
    narrowHint:
      "Narrow it and call again: `fields:[\"…\"]` returns only the fields whose name matches (site_settings holds 339 fields — `fields:[\"seo\"]` or `fields:[\"delivery\"]` is what you actually want). Or read the same values through a purpose-built getter: horoshop_admin_settings_get / _brand / _catalog / _checkout / _tracking, horoshop_admin_seo_settings_get, horoshop_admin_store_contacts.",
    handler: async (client, args) => {
      const ent = await requireEntity(client, args.store, args.entity);
      assertNotOrders(ent, "horoshop_admin_order_get");
      const form = await readForm(client, args.store, ent, args.id, args.parent);
      // Field filter (the narrowing lever the size gate points at). Substring, not
      // exact: the caller knows "seo" or "delivery", not `names[extra][seo_…]`.
      const wanted: string[] = Array.isArray(args.fields)
        ? args.fields.map((s: string) => String(s).toLowerCase()).filter((s: string) => s !== "")
        : [];
      const keep = (name: string): boolean =>
        wanted.length === 0 || wanted.some((w) => name.toLowerCase().includes(w));
      const pick = <T>(o: Record<string, T>): Record<string, T> =>
        wanted.length === 0 ? o : Object.fromEntries(Object.entries(o).filter(([k]) => keep(k)));
      // Surface the h_news trap at the exact moment someone reads the form they
      // are about to replay — a description alone did not stop the incident.
      const newsNote = isNewsEntity(ent) && form.fieldNames.has(NEWS_PARENT_FIELD)
        ? {
            warning:
              `"${NEWS_PARENT_FIELD}" on this form is the article's RUBRIC and is re-seeded to a default — it does NOT reflect what is stored. Writing this form back field-for-field (raw read-modify-write) will MOVE the article; that is how 10 live posts once left «Блог». horoshop_admin_record_save already drops the field for you unless you set it explicitly; for articles prefer horoshop_admin_blog_post_update (rubric preserved or moved on purpose, verified against the grid).`,
          }
        : {};
      // Same trap on products, found by diffing catalog/export around a save.
      const reseeded = isProductEntity(ent) ? [...form.fieldNames].filter((n) => PRODUCT_RESEEDED_RE.test(n)) : [];
      const productNote = reseeded.length
        ? {
            reseededFields: reseeded,
            reseededWarning:
              `These fields do NOT reflect storage: the presence select is re-seeded (a custom status id 9 «Є в наявності» renders as id 1 «В наявності») and countdown_end_time is seeded with "now + ~5h" when the product has no countdown. A raw read-modify-write therefore rewrites availability and switches a promo countdown on — measured by diffing catalog/export around one save. horoshop_admin_record_save drops them from the POST unless you set them explicitly; the authority for availability is horoshop_catalog_export (\`presence\`).`,
          }
        : {};
      // SQUEEZE BEFORE REFUSING — measured the hard way. `site_settings` on the
      // test store is 100 KB, i.e. one kilobyte over the response gate, and of that
      // 47 KB is dropdown OPTIONS (the timezone select alone carries 412 of
      // them). Refusing the whole record over reference data is the wrong trade:
      // it broke a pristine-state check, which reads `fields` and
      // reported the store's logo as missing when the real logo was untouched.
      // So when the answer is too big, the OPTION LISTS give way first and the
      // record's own values never do.
      const squeezeSelects = (sel: ReturnType<typeof mapSelects>, keepOptions: number) =>
        Object.fromEntries(
          Object.entries(sel).map(([k, v]) => {
            const opts = v?.options ?? [];
            return opts.length > keepOptions
              ? [k, { ...v, options: opts.slice(0, keepOptions), optionsTotal: opts.length, optionsTruncated: true }]
              : [k, v];
          }),
        );
      const { hidden: allHidden, hiddenDefaults: allDefaults } = splitHidden(form);
      const hidden = pick(allHidden);
      const hiddenDefaults = pick(allDefaults);
      const defaultNames = Object.keys(hiddenDefaults);
      const shownFields = form.fields.filter((f) => keep(f.name));
      const build = (selects: Record<string, unknown>, squeezed: number | null) => ({
        entity: ent.slug,
        ...newsNote,
        ...productNote,
        handler: ent.handler,
        handlertable: ent.handlertable,
        id: ent.singleton ? "1 (singleton)" : String(args.id),
        special: ent.special ?? null,
        action: form.action,
        fieldCount: form.fields.length,
        // A filtered read must never look like a complete one.
        ...(wanted.length
          ? {
              fieldsFilter: args.fields,
              fieldsReturned: shownFields.length,
              fieldsFilterNote: `PARTIAL READ: ${shownFields.length} of ${form.fields.length} fields matched ${JSON.stringify(args.fields)}. The record itself is unchanged and complete — drop \`fields\` (or widen it) to see the rest.`,
            }
          : {}),
        fields: Object.fromEntries(shownFields.map((f) => [f.name, f.value])),
        checkboxFields: [...(form.checkboxNames ?? [])].filter((n) => keep(n)),
        // File inputs are not values (nothing to read back), but their NAMES are
        // the addresses horoshop_admin_upload_image writes to — a product's image
        // slots in particular are per-record and can only be discovered here.
        ...(form.fileFields?.length
          ? {
              fileFields: form.fileFields.filter((f: any) => keep(typeof f === "string" ? f : String(f?.name ?? ""))),
              fileFieldsNote:
                "Upload into any of these with horoshop_admin_upload_image (entity + id + field). They carry no readable value — a file input is write-only.",
            }
          : {}),
        selects,
        ...(squeezed != null
          ? {
              selectsOptionsTruncated: true,
              selectsOptionsNote: `The answer was over the response size limit, so the dropdown OPTION lists were cut to ${squeezed} per select (\`optionsTotal\` on each says how many there really are) — the record's own \`fields\` are complete and untouched. Pass allowLarge:true for every option, or read the dictionary directly with horoshop_admin_dictionary_values.`,
            }
          : {}),
        hidden,
        ...(defaultNames.length
          ? {
              hiddenDefaults,
              hiddenDefaultsNote:
                `NOT VALUES — these are the OFF defaults of checkbox fields (${defaultNames.join(", ")}). Each is a hidden input that shares its name with a checkbox, so the browser submits both and the LAST one wins: the ACTUAL value is the one in \`fields\` (and the name is listed in \`checkboxFields\`). They used to sit inside \`hidden\` alongside real values, where "0" here vs "1" in \`fields\` read as a contradiction — that is how a set of live, enabled records was once reported as switched off.`,
            }
          : {}),
      });

      const full = build(pick(mapSelects(form)), null);
      if (args.allowLarge === true) return full;
      const limit = responseSizeLimit();
      if (answerBytes(full) <= limit) return full;
      // Over the limit: give up the option lists, in two steps, before the gate
      // gives up the whole record.
      for (const keepOptions of [12, 0]) {
        const squeezed = build(pick(squeezeSelects(mapSelects(form), keepOptions)), keepOptions);
        if (answerBytes(squeezed) <= limit) return squeezed;
      }
      // Still too big: the FIELDS themselves are the weight. The gate in
      // registerTools refuses it and tells the caller to use `fields:[…]`.
      return full;
    },
  },
  {
    name: "horoshop_admin_list",
    title: "List admin records",
    description:
      "List the records of an admin entity (id + a human label from the grid cells). By default returns ALL records across every grid page (the admin datagrid caps a page at 20/40/…/160, so a single fetch is not the whole list). Use to discover record ids for horoshop_admin_record_get / _save / _delete. For tree entities like pages pass a parent id to list under it. `count` is what was returned; `total` is the grid's declared grand total. " +
      "WHEN `count` < `total` THE LIST IS NOT EVERYTHING, and the answer always says so: `truncated:true` plus `incomplete` (with `missing`, and the same text repeated as `warning`). Two causes, both reported: the safety cap (`maxRows`), or GRID DRIFT — big grids page on a sort column with duplicates and no stable tiebreaker, so rows move across page boundaries between renders and a few end up served on no page at all (measured on a 523-product grid: 1 row lost at perPage 160, 8 at perPage 20). A repair pass re-reads the pages and normally recovers them; if it cannot, the shortfall is stated instead of hidden. Never count, diff or conclude \"not there\" from a list carrying `incomplete`. A SMALLER perPage makes drift WORSE (more boundaries) — prefer `search`, or the entity's own API export (products: horoshop_catalog_export). " +
      "THE LIST IS IN `records`, AND ONLY THERE — an array of {id, label} (plus `code`, the grid's own key column, where the grid has one: on products that is the ARTICLE). `rows` is NOT the list and is not an array: it is a one-line guard object naming `records`, kept because reading the answer as `rows` and getting `undefined` reads exactly like \"this entity is empty\" (a cleanup script did that here, saw nothing to clean at count:25, and nearly left a live product in the catalog). It used to be a full second COPY of the array, which doubled every listing — measured on a 349 KB answer, 174 KB of it was the duplicate — so the copy is gone and the guard stays: iterating or mapping `rows` now throws instead of quietly yielding nothing. `count` is the number to trust; count>0 with no rows in hand means you read the wrong key, not that the grid is empty. " +
      "⚠ `label` IS ONE LANGUAGE, NOT A TRANSLATION STATUS. The grid renders every multilingual column in a single language (the admin panel's UI language, reported as `labelLang`, which is NOT necessarily the store's first language), so a record whose other languages are already written looks exactly like an untranslated one. Two live records were overwritten on that assumption — one of them holding the storefront template «−{DISCOUNT_PERCENT}%». Pass langStatus:true for per-record `langsFilled`/`langsEmpty` (one extra form read per record, capped), or read the record with horoshop_admin_record_get. " +
      "HUGE GRIDS — USE `search`, NOT A FULL WALK. interface_translation (l10n, handler 340) holds 4000+ rows; listing it whole means dozens of round-trips and used to die outright with \"Network error … fetch failed\" (lowering `perPage` makes it WORSE — a smaller window means more pages). `search` applies the admin's own server-side column filter (a substring match) and returns only the matching rows, so finding one theme string costs a single request. `searchColumn` picks the column by label or id (default: the first text-filterable one) — e.g. searchColumn:\"Ключ\" to match the translation key, \"Значение\" to match the translated text. The filter is cleared afterwards, so later listings are unaffected. For the interface-translation layer specifically prefer horoshop_admin_interface_translation_get / _set, which wrap this and know the key/lang/value shape.",
    inputSchema: {
      ...storeField,
      entity: entityArg,
      parent: z.number().int().optional().describe("Parent id (for tree entities like pages)."),
      search: z
        .string()
        .optional()
        .describe(
          "Server-side substring filter — returns only matching rows instead of walking the whole grid. Essential for 4000-row grids like interface_translation.",
        ),
      searchColumn: z
        .union([z.number().int(), z.string()])
        .optional()
        .describe(
          "Which column `search` filters on: a header label (\"Ключ\", \"Значение\") or its numeric column id. Omit for the first text-filterable column. The answer lists the available columns.",
        ),
      page: z.number().int().optional().describe("Fetch only this one grid page instead of all pages."),
      perPage: z.number().int().optional().describe("Grid window size (max 160). Omit to page at the native size; setting it widens the window so most entities return in a single fetch. NOTE: this does NOT cap how many rows are fetched — a smaller window just means more pages. To bound a huge grid use `search` or `maxRows`."),
      maxRows: z.number().int().optional().describe("Safety cap on how many rows the walk collects (default 5000, or 500 with `search`). `truncated:true` says the cap was hit."),
      langStatus: z
        .boolean()
        .optional()
        .describe(
          `Default false. True: also report, per record, which languages actually hold text (\`langsFilled\` / \`langsEmpty\`) — the answer \`label\` alone cannot give, since the grid shows ONE language. Costs one extra form read PER RECORD (capped at ${LANG_STATUS_MAX}), so narrow the list with \`search\`/\`page\` first on big grids.`,
        ),
    },
    annotations: { readOnlyHint: true },
    // Measured on a live store: entity=interface_translation returns 1 293 KB and
    // entity=orders 1 090 KB with NO argument at all. The gate refuses those; this
    // is what it tells the caller to do instead, with a row budget computed from
    // the answer that was actually measured.
    narrowHint: ({ payload, bytes, limit }) => {
      const n = Number((payload as any)?.count) || 0;
      const fits = n > 0 ? fittingCount(n, bytes, limit) : 0;
      // The walk pages at the grid's own steps (20…160) and ROUNDS UP to whole
      // pages, so a bare row budget can still overshoot — suggest a page size the
      // grid actually serves, which makes `perPage:P, page:N` land exactly on P rows.
      const steps = [160, 140, 120, 100, 80, 60, 40, 20];
      const per = steps.find((s) => s <= fits) ?? 20;
      const pages = n > 0 ? Math.ceil(((payload as any)?.total ?? n) / per) : 0;
      return (
        `Narrow it and call again: \`search:"…"\` returns only matching rows in ONE request (the right shape for l10n and other 4000-row grids). ` +
        (n > 0
          ? `To page through it instead: \`perPage:${per}, page:1\` returns ${per} rows (~${Math.max(1, Math.round((bytes / n) * per / 1024))} KB) — this answer held ${n} rows, so that is ${pages} page(s), and every page carries \`total\`. `
          : `\`page:N\` fetches a single grid page and \`maxRows:N\` caps the walk. `) +
        `\`parent\` scopes a tree entity; \`langStatus:true\` multiplies the answer — drop it. ` +
        `For products prefer horoshop_catalog_export with includedParams; for orders horoshop_orders_get with a date range and \`limit\`.`
      );
    },
    handler: async (client, args) => {
      const ent = await requireEntity(client, args.store, args.entity);
      // Which language the grid writes its labels in — one cached read per store,
      // never per record. See gridLabelLanguage.
      const labelLang =
        ent.deleteMode === "tree"
          ? { code: TREE_LABEL_LANG, raw: null, firstLanguage: null }
          : await gridLabelLanguage(client, args.store, ent.handler);
      const langBlock = labelLangBlock(labelLang);
      const wantLangStatus = args.langStatus === true;

      if (typeof args.search === "string" && args.search.trim() !== "") {
        if (ent.deleteMode === "tree") {
          throw new Error(
            `Entity "${ent.slug}" is the page TREE, not a datagrid — it has no column filter. List it without \`search\` and filter the returned labels.`,
          );
        }
        const res = await client.admin.searchRecords(args.store, ent.handler, {
          query: args.search,
          column: args.searchColumn,
          parent: args.parent,
          maxRows: args.maxRows,
        });
        const found = res.rows.map((r) => ({ id: r.id, label: r.label, cells: r.cells }));
        const withLangs = wantLangStatus ? await attachLangStatus(client, args.store, ent, found, args.parent) : null;
        return {
          entity: ent.slug,
          handler: ent.handler,
          search: args.search,
          searchedColumn: res.column ? { param: res.column.param, label: res.column.label } : null,
          availableColumns: res.columns.map((c) => ({ param: c.param, label: c.label, type: c.type })),
          count: res.rows.length,
          total: res.total,
          ...(res.truncated ? { truncated: true } : {}),
          ...((res as any).incomplete ? { incomplete: (res as any).incomplete, warning: (res as any).incomplete.note } : {}),
          ...langBlock,
          ...(withLangs ? { langStatus: withLangs.status } : {}),
          // `records` is the list; `rows` is the O(1) guard for the name callers
          // keep reaching for — see listAliases.
          ...listAliases(withLangs ? withLangs.records : found),
        };
      }

      const rows = await listFor(client, args.store, ent, {
        parent: args.parent,
        page: args.page,
        perPage: args.perPage,
        maxRows: args.maxRows,
      });
      const total = (rows as any).total ?? rows.length;
      // `code` is the grid's own key column (on products: the ARTICLE) — the cell
      // that physically holds the row's id input, so it is exact and survives a
      // reordered column set. It is what maps a human's SKU to the internal id
      // every bulk endpoint insists on, so it is worth its bytes here.
      const listed = rows.map((r) => ({ id: r.id, ...(r.code ? { code: r.code } : {}), label: r.label }));
      const withLangs = wantLangStatus ? await attachLangStatus(client, args.store, ent, listed, args.parent) : null;
      const incomplete = (rows as any).incomplete;
      const driftRepair = (rows as any).driftRepair;
      return {
        entity: ent.slug,
        handler: ent.handler,
        count: rows.length,
        total,
        ...((rows as any).truncated ? { truncated: true } : {}),
        // Only present when the grid actually drifted (D1): `lostOnFirstWalk` is
        // how many rows a plain walk would have dropped without a word.
        ...(driftRepair ? { driftRepair } : {}),
        // The undercount has to be impossible to miss: it is repeated as a
        // top-level `warning` because a nested flag is exactly what four waves
        // of readers walked past (D1).
        ...(incomplete ? { incomplete, warning: incomplete.note } : {}),
        ...langBlock,
        ...(withLangs ? { langStatus: withLangs.status } : {}),
        ...listAliases(withLangs ? withLangs.records : listed),
      };
    },
  },
  {
    name: "horoshop_admin_record_delete",
    title: "Delete admin records",
    description:
      "Delete one or more records of an admin entity by id. Covers flat-grid entities (coupons, banners, brands, stickers, benefits, reviews…), PRODUCTS, the pages/categories tree, and order statuses — each uses its own delete route, picked automatically. For tree-parented grids (blog/news articles) a row is only visible under its own rubric, so if you don't pass `parent` the delete auto-resolves each id's rubric from the page tree instead of failing to find it. DRY RUN BY DEFAULT: previews which ids exist and would be removed (with the resolved parent). Pass dryRun:false to delete; it then re-checks to confirm they are gone. Special editors that have no delete route report an explanation instead. " +
      "IDS THAT ARE ALREADY GONE ARE NOT AN ERROR — they come back in `notFound`, and when NONE of the given ids exist the answer carries `alreadyGone:true`. A delete whose target is missing has reached the state it was asked for, so a repeat run is a no-op success; `deleted` (what THIS call removed) stays separate from `notFound` (what was never there), so the two can never be confused. The same `deleted` / `notFound` / `alreadyGone` contract holds across horoshop_admin_order_delete, horoshop_admin_redirect_delete, horoshop_admin_dictionary_value_delete and horoshop_admin_template_param_delete. " +
      "⚠ PRODUCTS (entity=products) — deletion is PERMANENT and there is no undo, so treat the dry run as the safety step and delete by id, never by a guessed range. A product and its modifications are separate grid rows: by default only the rows you list are deleted, so removing a parent SKU leaves its modifications behind as orphans (measured live). Pass `withModifications:true` to delete each listed product WITH its modifications — the admin's own «delete selected goods with modifications». Existence is verified by opening each product's editor (a deleted/unknown product answers 503), not by walking the catalog grid, so this costs one request per id instead of one per 20 SKUs of the whole catalog.",
    inputSchema: {
      ...storeField,
      entity: entityArg,
      ids: z
        .array(z.union([z.number().int(), z.string()]))
        .min(1)
        .describe("Record ids to delete (from horoshop_admin_list)."),
      parent: z.number().int().optional().describe("Parent id (context for tree entities). For blog/news it auto-resolves if omitted."),
      withModifications: z
        .boolean()
        .optional()
        .describe("Products only: also delete each listed product's modifications (removeSelectedGridsAndMods). Default false — only the listed rows go."),
      dryRun: z.boolean().optional().describe("Default true: preview without deleting. Set false to delete."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    handler: async (client, args) => {
      const ent = await requireEntity(client, args.store, args.entity);
      assertNotOrders(ent, "horoshop_admin_order_delete (it runs BOTH delete routes: the one that returns stock and the one that removes the row)");
      const mode = ent.deleteMode ?? "grid";
      if (mode === "none") {
        throw new Error(`Entity "${ent.slug}" is a special editor with no deletable records.`);
      }
      const dryRun = args.dryRun !== false;
      const wanted = (args.ids as Array<string | number>).map(String);

      // Which records exist, and under which parent each should be deleted. For a
      // tree-parented grid (blog/news) with no explicit parent, resolve each id's
      // rubric from the page tree — the row is only visible/deletable under it, so
      // the old code (a single parent-less list) reported it "not found".
      const parentOf = new Map<string, number | undefined>();
      let toDelete: Array<{ id: string; label: string }>;
      let notFound: string[];
      const autoResolve = ent.parentTree === true && mode === "grid" && args.parent == null;
      // Products: probe each id's editor instead of listing the catalog. Walking
      // the grid to answer "does 536 exist" costs one request per 20 SKUs of the
      // ENTIRE catalog — fine for 25 products on a test store, absurd on a real one.
      const probeExistence = isProductEntity(ent);
      if (probeExistence) {
        const found: Array<{ id: string; label: string }> = [];
        notFound = [];
        for (const id of wanted) {
          const exists = await client.admin.recordExists(args.store, targetFor(ent, id, args.parent));
          if (exists) found.push({ id, label: `${ent.slug} ${id}` });
          else notFound.push(id);
          parentOf.set(id, args.parent);
        }
        toDelete = found;
      } else if (autoResolve) {
        const blogNode = await resolveBlogNode(client, args.store, 0).catch(() => 0);
        const resolved = await resolveNewsRubrics(
          client,
          args.store,
          ent.handler,
          wanted,
          blogNode ? [blogNode] : [],
        );
        toDelete = wanted.filter((id) => resolved.has(id)).map((id) => ({ id, label: resolved.get(id)!.label }));
        for (const [id, info] of resolved) parentOf.set(id, info.parent);
        notFound = wanted.filter((id) => !resolved.has(id));
      } else {
        const before = await listFor(client, args.store, ent, { parent: args.parent });
        const existing = new Set(before.map((r) => r.id));
        toDelete = before.filter((r) => wanted.includes(r.id)).map((r) => ({ id: r.id, label: r.label }));
        for (const r of toDelete) parentOf.set(r.id, args.parent);
        notFound = wanted.filter((id) => !existing.has(id));
      }

      const withMods = probeExistence && args.withModifications === true;
      if (dryRun) {
        return {
          entity: ent.slug,
          dryRun: true,
          wouldDelete: toDelete.map((r) => ({ id: r.id, label: r.label, ...(autoResolve ? { parent: parentOf.get(r.id) } : {}) })),
          notFound,
          ...(probeExistence
            ? {
                withModifications: withMods,
                warning: withMods
                  ? "PERMANENT: each listed product will be deleted together with its modifications. There is no undo."
                  : "PERMANENT: only the listed rows are deleted — a parent SKU's modifications stay behind as orphans. Pass withModifications:true to remove them too. There is no undo.",
              }
            : {}),
        };
      }
      if (toDelete.length === 0) {
        // Already the right shape (an empty `deleted` next to a populated
        // `notFound` cannot be misread as a deletion), plus the same explicit
        // `alreadyGone` flag the other delete tools now carry, so an idempotent
        // cleanup can test ONE field across all of them instead of a per-tool
        // string match.
        return {
          entity: ent.slug,
          dryRun: false,
          deleted: [],
          notFound,
          alreadyGone: true,
          note: "None of the given ids exist — nothing to delete, and nothing was sent. This is the success shape of a repeat delete.",
        };
      }

      let httpStatus = 0;
      const notes: string[] = [];
      if (mode === "tree") {
        for (const r of toDelete) {
          const res = await client.admin.deletePageNode(args.store, r.id);
          httpStatus = res.httpStatus;
        }
      } else if (mode === "custom") {
        for (const r of toDelete) {
          const res = await client.admin.deleteOrderStatus(args.store, r.id);
          httpStatus = res.httpStatus;
          if (res.note) notes.push(`id ${r.id}: ${res.note}`);
        }
      } else {
        // Grid delete, grouped by the resolved parent so removeSelectedGrids targets
        // the right rubric. Prime the parent-scoped grid before each group — the op
        // acts on the session's current grid context.
        const groups = new Map<string, { parent: number | undefined; ids: string[] }>();
        for (const r of toDelete) {
          const p = parentOf.get(r.id);
          const key = p == null ? "" : String(p);
          if (!groups.has(key)) groups.set(key, { parent: p, ids: [] });
          groups.get(key)!.ids.push(r.id);
        }
        for (const { parent, ids } of groups.values()) {
          if (parent != null) await client.admin.listRecords(args.store, ent.handler, { parent }).catch(() => {});
          const res = await client.admin.deleteRecords(args.store, ent.handler, ids, {
            parent: parent ?? undefined,
            withModifications: withMods,
          });
          httpStatus = res.httpStatus;
        }
      }

      // Re-list to confirm deletion — per resolved parent for tree-parented grids,
      // otherwise the flat/explicit-parent list. Products are re-PROBED instead,
      // for the same reason the pre-check was a probe.
      const stillThere = new Set<string>();
      if (probeExistence) {
        for (const r of toDelete) {
          if (await client.admin.recordExists(args.store, targetFor(ent, r.id, args.parent))) stillThere.add(r.id);
        }
      } else if (autoResolve) {
        const parents = [...new Set([...parentOf.values()].filter((p): p is number => p != null))];
        for (const p of parents) {
          const rows = await client.admin.listRecords(args.store, ent.handler, { parent: p }).catch(() => [] as GridRow[]);
          for (const r of rows) stillThere.add(r.id);
        }
      } else {
        const after = await listFor(client, args.store, ent, { parent: args.parent });
        for (const r of after) stillThere.add(r.id);
      }
      const deleted = toDelete.filter((r) => !stillThere.has(r.id)).map((r) => ({ id: r.id, label: r.label }));
      const failed = toDelete.filter((r) => stillThere.has(r.id)).map((r) => r.id);
      return {
        entity: ent.slug,
        dryRun: false,
        httpStatus,
        deleted,
        failed,
        notFound,
        alreadyGone: false,
        ...(probeExistence ? { withModifications: withMods } : {}),
        ...(notes.length ? { warnings: notes } : {}),
        note: failed.length
          ? "Some ids did NOT delete — check delete mode/permissions."
          : probeExistence
            ? `Deletion verified: ${deleted.length} product editor(s) no longer resolve.${withMods ? "" : " Modifications of a deleted parent SKU, if any, were NOT removed — re-run with withModifications:true if you meant to."}`
            : "Deletion verified by re-listing.",
      };
    },
  },
  {
    name: "horoshop_admin_record_save",
    title: "Write any admin record",
    description:
      "Set ANY field(s) on ANY admin record — the universal writer. Pass `set` as a map of exact form field names (get them from horoshop_admin_record_get) to new string values. Read-modify-write: every field you don't list is preserved. DRY RUN BY DEFAULT — pass dryRun:false to persist; after saving it re-reads the record and reports which fields verified. To CREATE a record, use id \"addnew\" and set the required fields — the new id is returned as `newId`. Field names not present on the form are rejected as typos unless you pass allowNewFields:true (needed for rows the admin builds in JS, e.g. the contacts table in site_settings). " +
      "EVERY FIELD YOU SET IS ACCOUNTED FOR, INCLUDING THE ONES THAT NEEDED NOTHING: `setFields` are the ones actually rewritten, `unknownFields` the ones not on the form, and `unchangedFields` the ones that ALREADY held the exact value you asked for. That last list exists because it used to be no list at all — a field that matched the form default simply disappeared from the answer, which reads as \"silently dropped\" (measured on a coupon's names[type], whose blank create form already carries \"1\"). It is still submitted; the save replays the whole form. If a name you passed is in none of the three, that IS a bug — say so. " +
      "ADD TEXT WITHOUT RESENDING IT: `append` / `prepend` take the same field→text map but splice your delta onto the STORED value instead of replacing it — the way to add one block to a 4 KB seo_text without retyping the 4 KB (and without risking a mangled copy of someone else's content on a live store). The same field in `set` AND `append`/`prepend` is an error, never a silent winner. " +
      "ANSWER SIZE: on success a long field is reported as {length, tail, sha256} rather than echoed three times as from+to+now (that triple echo was ~12 KB per 4 KB field, ~400 KB across a 15-record rollout); a field that did NOT persist still reports expected vs actual previews and the first differing offset. Pass verbose:true for the full diff. " +
      PLACEHOLDER_GUARD_DOC +
      " " +
      "\u26a0 \"EVERY FIELD YOU DON'T LIST IS PRESERVED\" HAS EXCEPTIONS, AND THEY DIFFER PER ENTITY. Some admin forms re-render a field as a DEFAULT instead of as storage, so sending the form back field-for-field overwrites a value nobody meant to touch. Three entities behave differently — do not generalise from one to another. " +
      "• blog_posts (h_news, handler 172) RUBRIC TRAP: that entity's form re-seeds `names[parent]` — the rubric the article lists under — to a DEFAULT rather than to storage, so a field-for-field read-modify-write silently RELOCATES the article (this moved 10 published posts out of «Блог» once). This tool therefore DROPS `names[parent]` from the save unless you list it in `set` yourself, and says so in the answer; pass it explicitly to move an article on purpose. For articles prefer horoshop_admin_blog_post_update, which preserves or moves the rubric deliberately and verifies the move against the grid. " +
      "• products (h_products, handler 17) PRESENCE / COUNTDOWN TRAP — the same class of mine, on the entity you are most likely to touch: the product form re-seeds `…[presence]` (a custom status id 9 «Є в наявності» renders as id 1 «В наявності») and `…[countdown_end_time]` (seeded \"now + ~5h\" on a product that has no timer at all). Measured: saving one unrelated field (`mpn`) rewrote availability AND switched a promo countdown on for real shoppers. This tool DROPS both from the POST unless you list them yourself, and reports `productGuard` when it does. Set them explicitly and the write IS sent — but verification then comes back `persisted:null, unverifiable:true`, because the form re-reads its own seed rather than storage and this tool will not claim a result it cannot see. Availability is authoritatively read with horoshop_catalog_export (`presence`) and set with horoshop_catalog_import. " +
      "• pages (handler 4): raw RMW is safe and the tree parent survives — with one exception, the slug. `names[name][slug]` persists only when `names[name][parent]` carries the URL-node id of the parent; sent alone it is accepted, stored nowhere, and the page 404s while every later read agrees it saved. This tool resolves that parent for you, and refuses the save outright if it cannot, rather than storing a slug that does not exist.",
    inputSchema: {
      ...storeField,
      entity: entityArg,
      id: z
        .union([z.number().int(), z.string()])
        .describe("Record id to edit, or \"addnew\" to create."),
      set: z
        .record(z.string())
        .optional()
        .describe("Map of exact form field name → new value (REPLACES it), e.g. {\"names[i18n][3][seo_title]\":\"…\"}. Optional when you pass `append`/`prepend`."),
      append: z
        .record(z.string())
        .optional()
        .describe(
          appendDescription("a map of exact form field name → the text to glue onto the END of its stored value, e.g. {\"names[i18n][3][seo_text]\":\"<h3>Доставка</h3>…\"}"),
        ),
      prepend: z
        .record(z.string())
        .optional()
        .describe(
          prependDescription("a map of exact form field name → the text to glue onto the START of its stored value"),
        ),
      verbose: verboseField,
      allowPlaceholderLoss: allowPlaceholderLossField,
      parent: z.number().int().optional().describe("Parent id (context for tree entities)."),
      allowNewFields: z
        .boolean()
        .optional()
        .describe(
          "Default false: names that aren't on the form are refused as typos. Set true to send them anyway — required for JS-generated rows such as extra[contacts_data][common][0][value] in site_settings.",
        ),
      dryRun: z
        .boolean()
        .optional()
        .describe("Default true: preview the field changes without saving. Set false to persist."),
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
    handler: async (client, args) => {
      const ent = await requireEntity(client, args.store, args.entity);
      assertNotOrders(ent, "horoshop_admin_order_status_change / horoshop_admin_order_delete");
      const dryRun = args.dryRun !== false;
      const verbose = args.verbose === true;
      // Copied, not aliased: the slug guard below ADDS a field to it.
      const setMap = { ...((args.set ?? {}) as Record<string, string>) };
      const appendMap = (args.append ?? {}) as Record<string, string>;
      const prependMap = (args.prepend ?? {}) as Record<string, string>;
      const spliceNames = [...new Set([...Object.keys(appendMap), ...Object.keys(prependMap)])];
      if (Object.keys(setMap).length === 0 && spliceNames.length === 0) {
        throw new Error("Nothing to write — pass `set` (replace), `append` and/or `prepend` (splice onto the stored value).");
      }
      assertNoSpliceConflict(Object.keys(setMap), spliceNames);

      const form = await readForm(client, args.store, ent, args.id, args.parent);

      // SLUG MINE (see the note above SLUG_FIELD): writing a page slug without
      // the resolved URL-tree parent stores nothing and 404s the page, while
      // every report says "verified". Resolve it here, exactly as the admin's own
      // JS does, and say so in the answer.
      let urlNode: Record<string, unknown> | null = null;
      if (
        isPagesEntity(ent) &&
        typeof setMap[SLUG_FIELD] === "string" &&
        setMap[SLUG_FIELD].length > 0 &&
        !Object.prototype.hasOwnProperty.call(setMap, SLUG_PARENT_FIELD)
      ) {
        const isCreateHere = ["addnew", "0", ""].includes(String(args.id));
        const treeParent =
          setMap["names[parent]"] != null && String(setMap["names[parent]"]).length
            ? Number(setMap["names[parent]"])
            : args.parent != null
              ? Number(args.parent)
              : isCreateHere
                ? null
                : await pageParentOf(client, args.store, args.id);
        if (treeParent == null) {
          throw new Error(
            `Writing ${SLUG_FIELD} on a page needs the page's tree parent so the URL node can be resolved — without it the slug is silently dropped and the page 404s. Pass "names[parent]" in \`set\` (or \`parent\`), or use horoshop_admin_page_create / horoshop_admin_category_create, which do this for you.`,
          );
        }
        const r = await client.admin
          .resolveUrlParent(args.store, treeParent, setMap[SLUG_FIELD], isCreateHere ? 0 : args.id)
          .catch(() => ({ parent: "", slug: "" }));
        if (r.parent) setMap[SLUG_PARENT_FIELD] = r.parent;
        urlNode = {
          treeParent,
          resolvedParent: r.parent || null,
          normalisedSlug: r.slug || null,
          note: r.parent
            ? `${SLUG_PARENT_FIELD} was resolved to ${r.parent} and added to this save — without it the slug does not persist and the page 404s.`
            : `The URL widget returned NO parent for tree parent ${treeParent}: the slug will NOT persist and the page will 404. Check that the parent id is a real page.`,
        };
      }

      // APPEND/PREPEND: the read half of the read-modify-write is already done, so
      // the delta is spliced onto the STORED value here. This is the whole point —
      // adding one block to a 4 KB seo_text no longer means resending the 4 KB.
      const spliced: Record<string, { from: string; to: string; mode: string; delta: string }> = {};
      for (const name of spliceNames) {
        if (!form.fieldNames.has(name)) {
          throw new Error(
            `append/prepend target "${name}" is not on this record's form, so there is no stored value to splice onto. Read the record with horoshop_admin_record_get and use an exact field name (allowNewFields does NOT apply to append/prepend).`,
          );
        }
        if (form.selects[name]?.unselected) {
          throw new Error(
            `append/prepend target "${name}" is a <select> the admin renders with no selected option — its stored value is UNKNOWN here, so splicing onto it would overwrite real data with a guess. Set it explicitly with \`set\` if you truly mean to change it.`,
          );
        }
        const from = fieldValue(form, name);
        const to = splice({ current: from, append: appendMap[name], prepend: prependMap[name] });
        const mode = [prependMap[name] ? "prepend" : "", appendMap[name] ? "append" : ""].filter(Boolean).join("+");
        spliced[name] = { from, to, mode, delta: `${prependMap[name] ?? ""}${appendMap[name] ?? ""}` };
      }

      const overrides: Record<string, string> = {};
      const planned: Array<Record<string, any>> = [];
      const unknown: string[] = [];
      // A field you asked for that is ALREADY at that value is a no-op and never
      // reaches `planned`. Until now it reached nothing else either: it was in
      // neither `setFields` nor `unknownFields`, so from the answer alone it had
      // simply vanished — which is exactly how it was read (`names[type]`
      // on a coupon, whose blank create form already carries "1"). The value is
      // still submitted, because the save replays the whole form; what was
      // missing was the sentence saying so. Naming them ends the ambiguity for
      // every entity, not just that one.
      const unchanged: string[] = [];
      const allowNew = args.allowNewFields === true;
      for (const [name, value] of Object.entries(setMap)) {
        if (!form.fieldNames.has(name)) {
          // Not on the form: usually a typo, but some rows only exist once the
          // admin's JS builds them (the contacts table in site_settings), so an
          // explicit opt-in can send them anyway.
          if (!allowNew) {
            unknown.push(name);
            continue;
          }
          overrides[name] = value;
          planned.push({ field: name, from: "(not on form)", to: value });
          continue;
        }
        const from = fieldValue(form, name);
        if (from === value) {
          unchanged.push(name);
          continue;
        }
        overrides[name] = value;
        planned.push({ field: name, from, to: value });
      }
      for (const [name, s] of Object.entries(spliced)) {
        if (s.from === s.to) continue; // empty delta — nothing to write
        overrides[name] = s.to;
        planned.push({
          field: name,
          mode: s.mode,
          from: s.from,
          to: s.to,
          delta: s.delta,
          length: { before: s.from.length, delta: s.delta.length, after: s.to.length },
        });
      }

      // h_news rubric guard: unless the caller asked for a move, the re-seeded
      // names[parent] must not ride along in the replay (see NEWS_RMW_WARNING).
      const guardNews =
        isNewsEntity(ent) &&
        form.fieldNames.has(NEWS_PARENT_FIELD) &&
        !Object.prototype.hasOwnProperty.call(setMap, NEWS_PARENT_FIELD) &&
        !spliceNames.includes(NEWS_PARENT_FIELD);
      const rubricNote = guardNews
        ? { rubricGuard: NEWS_RMW_WARNING }
        : isNewsEntity(ent) && form.fieldNames.has(NEWS_PARENT_FIELD)
          ? { rubricGuard: `You set ${NEWS_PARENT_FIELD} explicitly — the article WILL be moved to that rubric. Verify with horoshop_admin_list entity=blog_posts parent=<rubric>, or use horoshop_admin_blog_post_update which verifies the move for you.` }
          : {};
      // Product guard: the re-seeded presence / countdown_end_time must not ride
      // along either (see PRODUCT_RESEEDED_RE).
      const productDropped = isProductEntity(ent)
        ? new Set(
            [...form.fieldNames].filter(
              (n) =>
                PRODUCT_RESEEDED_RE.test(n) &&
                !Object.prototype.hasOwnProperty.call(setMap, n) &&
                !spliceNames.includes(n),
            ),
          )
        : new Set<string>();
      const productNote = productDropped.size ? { productGuard: PRODUCT_RMW_WARNING([...productDropped]) } : {};
      const spliceNote = spliceNames.length
        ? { splice: Object.fromEntries(Object.entries(spliced).map(([f, s]) => [f, `${s.mode}: ${s.from.length} + ${s.delta.length} → ${s.to.length} chars`])) }
        : {};
      // TEMPLATE TOKENS (see admin/placeholders.ts): a value that HAD
      // {DISCOUNT_PERCENT} and no longer does is a storefront substitution being
      // frozen into text — refuse it unless the caller says it is meant.
      const placeholderWarnings = scanPlaceholderLoss(planned);
      const allowLoss = args.allowPlaceholderLoss === true;

      if (unknown.length && planned.length === 0) {
        throw new Error(
          `None of the given fields exist on this record's form. Unknown: ${unknown.join(", ")}. Read the record first with horoshop_admin_record_get — or pass allowNewFields:true if these are JS-generated rows.`,
        );
      }
      const urlNote = urlNode ? { urlNode } : {};
      if (planned.length === 0) {
        return { entity: ent.slug, id: String(args.id), dryRun, ...rubricNote, ...productNote, ...urlNote, ...spliceNote, changes: [], unknownFields: unknown, ...(unchanged.length ? { unchangedFields: unchanged } : {}), note: "Nothing to change." + (unchanged.length ? ` The field(s) you set (${unchanged.join(", ")}) already hold that exact value — they are listed under unchangedFields, not lost.` : "") };
      }
      if (dryRun) {
        // Long bodies are windowed (head/tail), never echoed whole — a 4 KB
        // seo_text preview must not cost 4 KB of conversation per field.
        const preview = planned.map((p) => compactPreview(p, verbose));
        return {
          entity: ent.slug,
          id: String(args.id),
          dryRun: true,
          ...rubricNote, ...productNote, ...urlNote,
          ...spliceNote,
          ...(placeholderWarnings.length
            ? { placeholderWarnings, placeholderNote: placeholderPreviewNote(placeholderWarnings) }
            : {}),
          willChange: preview,
          unknownFields: unknown,
          ...(unchanged.length ? { unchangedFields: unchanged } : {}),
        };
      }
      assertPlaceholdersKept(placeholderWarnings, allowLoss);

      // Creating: re-reading the create sentinel returns a fresh blank form, not
      // the new record, and the id is assigned server-side. So snapshot the grid
      // ids around the save and report the one that appeared — "submitted" is not
      // the same as "created", and the caller should not have to go looking.
      const isCreate = !ent.singleton && ["addnew", "0", ""].includes(String(args.id));
      // Must go through listFor, not the raw datagrid: the pages tree has no
      // grid rows at all, so reading it directly reports every created page as
      // "not created" — a false negative in the opposite direction of the bug
      // this verification exists to catch.
      const idsBefore = isCreate
        ? new Set(
            (await listFor(client, args.store, ent, { parent: args.parent, perPage: 160 }).catch(() => [])).map(
              (r: any) => String(r.id),
            ),
          )
        : null;

      // The guarded fields are stripped from the POST, not from the read: `form`
      // stays intact for the verification below.
      const saveForm = withoutFields(guardNews ? withoutField(form, NEWS_PARENT_FIELD) : form, productDropped);
      const result = await client.admin.save(args.store, saveForm, overrides);

      if (isCreate) {
        const after = await listFor(client, args.store, ent, { parent: args.parent, perPage: 160 }).catch(
          () => [] as any[],
        );
        const fresh = after.filter((r: any) => !idsBefore!.has(String(r.id)));
        const newId = fresh.length === 1 ? String(fresh[0].id) : null;
        // A created PAGE is only "created" for a buyer if it has a URL. Read the
        // slug the record actually kept and ask the storefront — "confirmed in
        // the list" is exactly the report that hid a 404 page behind a green tick.
        const front = isPagesEntity(ent) && newId ? await pageReachability(client, args.store, newId, args.parent) : null;
        return {
          entity: ent.slug,
          created: fresh.length > 0,
          dryRun: false,
          ...rubricNote, ...productNote, ...urlNote,
          httpStatus: result.httpStatus,
          newId,
          newRecord: fresh.length === 1 ? fresh[0] : undefined,
          ...(front ?? {}),
          setFields: planned.map((p) => p.field as string),
          unknownFields: unknown,
          ...(unchanged.length ? { unchangedFields: unchanged } : {}),
          note:
            fresh.length === 1
              ? front && front.storefrontReachable === false
                ? front.slug
                  ? `Created id ${newId} at ${front.link}, but the storefront answered HTTP ${front.storefrontStatus} — a buyer CANNOT open it yet.`
                  : `Created id ${newId}, but it kept NO slug, so it has no URL and 404s. A page slug needs the resolved ${SLUG_PARENT_FIELD} — use horoshop_admin_page_create (info page) or horoshop_admin_category_create (category), which resolve it.`
                : front && front.storefrontReachable === true
                  ? `Created and confirmed: id ${newId}, storefront ${front.link} → HTTP ${front.storefrontStatus}.`
                  : `Created and confirmed in the list: id ${newId}.`
              : fresh.length > 1
                ? `Created, but ${fresh.length} new rows appeared at once — ambiguous. Candidates: ${fresh.map((r: any) => r.id).join(", ")}.`
                : ent.slug === "coupons"
                  ? `Submitted (HTTP ${result.httpStatus}) but no new coupon appeared. THIS IS EXPECTED AND THERE IS ANOTHER WAY: Horoshop's own «add coupon» form answers 5xx on this route (reproduced across several sessions), while its «Сгенерировать сертификаты» button works. Create the code with horoshop_admin_coupons_generate (kind "coupon" = percent, kind "certificate" = fixed amount) — the platform picks the 10-character code itself, which is the one thing this route could have given you. Editing and deleting an existing coupon through record_save / record_delete are unaffected.`
                  : `Submitted (HTTP ${result.httpStatus}) but no new row appeared in the list — the save was likely rejected by validation, or this entity's grid needs a parent. Check horoshop_admin_list.`,
        };
      }

      const after = await readForm(client, args.store, ent, args.id, args.parent);
      const changes: Array<Record<string, any>> = planned.map((p) => {
        const field = p.field as string;
        const now = fieldValue(after, field);
        // A select the server renders without a `selected` option reads back as
        // unknown, not as empty — we cannot confirm or deny it. Saying "did not
        // persist" there would be the same lie in the opposite direction as the
        // one that used to claim a wiped parent was "verified".
        if (after.selects[field]?.unselected) {
          return { ...p, persisted: null as boolean | null, now: null, unverifiable: true };
        }
        // Same for the product editor's re-seeded fields: the form reads back its
        // SEED, not storage, so a presence that really was written to 9 re-reads
        // as 1 and would be reported "did not persist" — a false failure.
        // Verified live: the explicit write landed (catalog/export showed id 9)
        // while this re-read still said 1.
        if (isProductEntity(ent) && PRODUCT_RESEEDED_RE.test(field)) {
          return {
            ...p,
            persisted: null as boolean | null,
            now,
            unverifiable: true,
            note: "This field re-reads as the form's seed, not as storage — confirm with horoshop_catalog_export (presence / countdown_end_time).",
          };
        }
        // "NEW" is the create sentinel on JS-built rows: the server swaps it for
        // a real id, so reading back something else is success, not failure.
        const sentinel = p.to === "NEW";
        return {
          ...p,
          persisted: sentinel ? now !== "" && now !== "NEW" : now === p.to,
          now,
          ...(sentinel ? { sentinel: true } : {}),
        };
      });
      const failed = changes.filter((c) => c.persisted === false);
      const unverifiable = changes.filter((c) => (c as any).unverifiable);
      const ok = failed.length === 0;
      // A slug write on a page is only real if the storefront serves the URL.
      const slugFront =
        isPagesEntity(ent) && Object.prototype.hasOwnProperty.call(setMap, SLUG_FIELD)
          ? await pageReachability(client, args.store, args.id, args.parent)
          : null;
      // THE TRIPLE ECHO (see admin/changes.ts): a persisted 4 KB seo_text used to
      // come back as from+to+now — ~12 KB per field, ~400 KB across a 15-record
      // rollout. Success collapses to length+tail+sha256; a FAILURE keeps the
      // expected/actual previews and the first differing offset.
      const reported = changes.map((c) => compactVerified(c, verbose));
      const compacted = wasCompacted(reported);
      return {
        entity: ent.slug,
        id: String(args.id),
        dryRun: false,
        saved: ok,
        httpStatus: result.httpStatus,
        ...rubricNote, ...productNote, ...urlNote,
        ...(slugFront ?? {}),
        ...spliceNote,
        ...(placeholderWarnings.length
          ? { placeholderLossAllowed: placeholderWarnings, placeholderNote: placeholderOverrideNote(placeholderWarnings) }
          : {}),
        changes: reported,
        unknownFields: unknown,
        ...(unchanged.length ? { unchangedFields: unchanged } : {}),
        note:
          (slugFront && slugFront.storefrontReachable === false
            ? `The slug write did NOT make this page reachable${slugFront.link ? ` (${slugFront.link} → HTTP ${slugFront.storefrontStatus})` : " — the record kept no slug"}. ${SLUG_PARENT_FIELD} must carry the resolved URL-node id; use horoshop_admin_page_create / horoshop_admin_category_create. `
            : "") +
          (!ok
            ? `${failed.length} field(s) did NOT persist — check field names or admin validation.`
            : unverifiable.length
              ? `Saved. ${unverifiable.length} field(s) could not be verified: the admin renders those selects with no selected option, so their stored value is not readable back (${unverifiable.map((c) => c.field).join(", ")}).`
              : "All changes verified by re-reading the record.") + (compacted ? ` ${COMPACT_NOTE}` : ""),
      };
    },
  },
];
