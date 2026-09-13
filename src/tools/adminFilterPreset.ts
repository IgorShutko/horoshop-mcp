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
import { fieldValue, type ParsedForm } from "../admin/form.js";
import type { EditTarget } from "../admin/session.js";

/**
 * Filter PRESETS (SEO) — handler 364, table `h_presets` — as named create/update
 * tools. A preset turns one fixed filter condition on a category (e.g. `color=8`
 * on «Постільна білизна») into its own indexable landing at a custom slug, with a
 * full SEO block (title / keywords / description / seo-text / H1) per language.
 * The public REST API does not create these; only the admin layer does.
 *
 * Contract (reverse-engineered live on two stores, from the
 * addnew form and a real sibling preset):
 *   edit.php?id=<id|addnew>&handler=364&handlertable=h_presets → save.php (multipart)
 *   - names[i18n][3][title]   : title, Ukrainian (index 3; ru = index 1). The
 *                               store convention fills ONLY ua and leaves h1_title
 *                               empty (mirrors the store's own presets).
 *   - names[alias][slug]      : the custom slug.
 *   - names[alias][parent]    : the URL-tree node the slug hangs off. NOT a plain
 *                               value — like a category slug it only persists when
 *                               it carries the p_name-row parent, resolved via the
 *                               zteel.params.url widget. A preset's alias lives
 *                               under widget param_id 5537 (categories use 1), so
 *                               resolveUrlParent is tried with 5537 first, then 1,
 *                               and the first non-empty parent wins. An explicit
 *                               `aliasParent` overrides the resolve entirely.
 *   - names[page]             : the page/category id the preset binds to (a
 *                               <select> the addnew form renders UNSELECTED, so it
 *                               is set explicitly — no trap, it is an override).
 *   - names[params]           : the filter condition, a RAW STRING in the same
 *                               shape as the query after `/filter/`, e.g. "color=8"
 *                               or "parent=1021;price=100-289".
 *   - names[enabled]          : 1/0.
 *   - names[i18n][L][seo_title|seo_keywords|seo_description|seo_text|h1_title] :
 *                               per-language SEO. seo_text is RAW HTML — it is put
 *                               into the multipart part verbatim, NEVER
 *                               htmlspecialchars'd (double-encoding it renders
 *                               literal &lt;h3&gt; on the storefront).
 *   - names[sortorder]        : ordering.
 *
 * Everything reads back off an existing record's edit form (slug, page, params,
 * enabled, seo_text), so the create/update verify by re-reading.
 */

const PRESET_HANDLER = 364;
const PRESET_TABLE = "h_presets";
/** The URL-param widget row a preset's alias belongs to (categories use "1"). */
const PRESET_ALIAS_PARAM_ID = "5537";

const LANGS = ["ua", "ru"] as const;
type Lang = (typeof LANGS)[number];
const LANG_IDX: Record<Lang, number> = { ua: 3, ru: 1 };

/** Human key → the raw seo sub-field. */
const SEO_FIELDS = {
  seoTitle: "seo_title",
  seoKeywords: "seo_keywords",
  seoDescription: "seo_description",
  seoText: "seo_text",
  h1: "h1_title",
} as const;
type SeoKey = keyof typeof SEO_FIELDS;
const SEO_KEYS = Object.keys(SEO_FIELDS) as SeoKey[];

function presetTarget(id: string | number): EditTarget {
  return { id, handler: PRESET_HANDLER, handlertable: PRESET_TABLE, extra: {}, flags: [] };
}

/** The page/category options a preset can bind to (names[page]). */
function pageOptions(form: ParsedForm): Array<{ value: string; label: string }> {
  return (form.selects["names[page]"]?.options ?? []).filter((o) => /^\d+$/.test(o.value) && o.value !== "0");
}

const seoBlockShape = z
  .object({
    seoTitle: z.string().optional().describe("SEO <title>."),
    seoKeywords: z.string().optional().describe("SEO keywords."),
    seoDescription: z.string().optional().describe("SEO meta description."),
    seoText: z.string().optional().describe("SEO-text — RAW HTML, sent verbatim (never htmlspecialchars'd)."),
    h1: z.string().optional().describe("H1 heading (h1_title)."),
  })
  .describe("A per-language SEO block.");

/**
 * Resolve the alias (URL-tree) parent for a preset. Tries the preset alias widget
 * row (param_id 5537) first, then the category default "1", and returns the first
 * non-empty parent. Returns "" (unresolved) if neither answers.
 */
async function resolvePresetAlias(
  client: any,
  store: string | undefined,
  page: number | string,
  slug: string,
  recordId: number | string,
): Promise<{ parent: string; via: string }> {
  for (const pid of [PRESET_ALIAS_PARAM_ID, "1"]) {
    const r = await client.admin
      .resolveUrlParent(store, page, slug, recordId, pid)
      .catch(() => ({ parent: "", slug: "" }));
    if (r.parent) return { parent: String(r.parent), via: `paramId ${pid}` };
  }
  return { parent: "", via: "unresolved" };
}

/** Build the scalar + i18n overrides shared by create/update. */
function buildOverrides(args: any): Record<string, string> {
  const ov: Record<string, string> = {};
  if (args.page !== undefined && args.page !== null) ov["names[page]"] = String(args.page);
  if (typeof args.params === "string") ov["names[params]"] = args.params;
  if (typeof args.enabled === "boolean") ov["names[enabled]"] = args.enabled ? "1" : "0";
  if (args.sortorder !== undefined && args.sortorder !== null) ov["names[sortorder]"] = String(args.sortorder);

  const title = (args.title ?? {}) as { ua?: string; ru?: string };
  if (typeof title.ua === "string") ov[`names[i18n][${LANG_IDX.ua}][title]`] = title.ua;
  if (typeof title.ru === "string") ov[`names[i18n][${LANG_IDX.ru}][title]`] = title.ru;

  const seo = (args.seo ?? {}) as Record<Lang, any>;
  for (const lang of LANGS) {
    const block = seo[lang];
    if (!block) continue;
    for (const key of SEO_KEYS) {
      const v = block[key];
      // seo_text is passed RAW — buildMultipart writes the string verbatim, so no
      // encoding happens here. Do NOT htmlspecialchars (double-encode lesson).
      if (typeof v === "string") ov[`names[i18n][${LANG_IDX[lang]}][${SEO_FIELDS[key]}]`] = v;
    }
  }
  return ov;
}

/** Read back the verifiable state of a saved preset (slug/page/params/enabled + seo_text). */
async function readPresetState(
  client: any,
  store: string | undefined,
  id: string | number,
): Promise<{ slug: string; aliasParent: string; page: string; params: string; enabled: string; seoTextUa: string; found: boolean }> {
  const form = await client.admin.getEditForm(store, presetTarget(id));
  const get = (n: string) => (form.fieldNames.has(n) ? fieldValue(form, n) : "");
  return {
    slug: get("names[alias][slug]"),
    aliasParent: get("names[alias][parent]"),
    page: get("names[page]"),
    params: get("names[params]"),
    enabled: get("names[enabled]"),
    seoTextUa: get(`names[i18n][${LANG_IDX.ua}][seo_text]`),
    found: form.fieldNames.has("names[params]"),
  };
}

const createSchema = {
  ...storeField,
  page: z.union([z.number().int(), z.string()]).describe("Page/category id the preset binds to (names[page]). Must be one of the addnew form's page options."),
  params: z.string().min(1).describe("Filter condition, a RAW string in `/filter/` query shape, e.g. \"color=8\" or \"parent=1021;price=100-289\"."),
  slug: z.string().min(1).describe("Custom URL slug (latin), e.g. \"postilna-bilyzna-blakytnoho-koloru\"."),
  title: z
    .object({ ua: z.string().min(1).describe("Title (Ukrainian, index 3) — required."), ru: z.string().optional().describe("Title (Russian, index 1).") })
    .describe("Preset title per language. The store convention fills only `ua`."),
  seo: z
    .object({ ua: seoBlockShape.optional(), ru: seoBlockShape.optional() })
    .optional()
    .describe("Per-language SEO blocks (ua = index 3, ru = index 1). seo_text is RAW HTML sent verbatim."),
  enabled: z.boolean().optional().describe("Whether the preset is active (names[enabled]). Default true."),
  sortorder: z.union([z.number().int(), z.string()]).optional().describe("Sort order (names[sortorder])."),
  aliasParent: z
    .union([z.number().int(), z.string()])
    .optional()
    .describe("Override the URL-tree parent (names[alias][parent]) instead of resolving it. Use when you know the shared node (e.g. 569 for page 1058 on one store)."),
  dryRun: z.boolean().optional().describe("Default true: preview the plan without creating. Set false to create."),
};

const updateSchema = {
  ...storeField,
  id: z.union([z.number().int(), z.string()]).describe("Preset id to update."),
  page: z.union([z.number().int(), z.string()]).optional().describe("New page/category id (names[page])."),
  params: z.string().optional().describe("New filter condition (raw string)."),
  slug: z.string().optional().describe("New slug — its alias parent is re-resolved (or pass aliasParent)."),
  title: z.object({ ua: z.string().optional(), ru: z.string().optional() }).optional().describe("Title per language."),
  seo: z.object({ ua: seoBlockShape.optional(), ru: seoBlockShape.optional() }).optional().describe("Per-language SEO blocks (raw HTML seo_text) — REPLACES the stored value."),
  append: z
    .object({ ua: seoBlockShape.optional(), ru: seoBlockShape.optional() })
    .optional()
    .describe(
      appendDescription("the same per-language SEO shape as `seo` (e.g. {\"ua\":{\"seoText\":\"<h3>Доставка</h3>…\"}}), glued onto the END of the stored seo_text — the way to add one block across N presets without resending each preset's 4 KB of author HTML"),
    ),
  prepend: z
    .object({ ua: seoBlockShape.optional(), ru: seoBlockShape.optional() })
    .optional()
    .describe(prependDescription("the same per-language SEO shape as `seo`")),
  verbose: verboseField,
  allowPlaceholderLoss: allowPlaceholderLossField,
  enabled: z.boolean().optional().describe("Enable/disable (names[enabled])."),
  sortorder: z.union([z.number().int(), z.string()]).optional().describe("Sort order."),
  aliasParent: z.union([z.number().int(), z.string()]).optional().describe("Override names[alias][parent] instead of resolving it."),
  dryRun: z.boolean().optional().describe("Default true: preview without saving. Set false to persist."),
};

export const adminFilterPresetTools: ToolSpec[] = [
  {
    name: "horoshop_admin_filter_preset_create",
    title: "Create an SEO filter preset (custom slug + SEO block) in one call",
    description:
      "Create a filter PRESET (handler 364, h_presets) — a fixed filter condition on one category turned into an indexable landing at a custom slug, the thing the public REST API cannot create. `page` = the category/page id it binds to; `params` = the RAW filter condition string in `/filter/` shape (e.g. \"color=8\"); `slug` = the custom URL slug; `title.ua` (required) + optional `title.ru`; a per-language `seo` block (seoTitle/seoKeywords/seoDescription/seoText/h1). seo_text is written as RAW HTML verbatim (never double-encoded, so <h3>/<ul> render as markup, not literal &lt;h3&gt;). " +
      "⚠️ COLOR ID SPACE — the `color=N` in `params` is the FILTER-GROUP id (filter_colors, 351-space), NOT the product `color.id` from catalog_export (h_colors, 346-space): the two DO NOT line up, so never judge a preset \"empty\" by matching its color=N against exported product color.ids (a live color=10 preset returns products that export under color.id=21 — that mismatch nearly got a working colour landing disabled). To check how many products a preset actually serves, read the storefront listing, not an id match. Filter-group ids (params color=N → name): Чорний=1, Білий=2, Сірий=3, Червоний=4, Жовтий=6, Зелений=7, Блакитний=8, Синій=9, Фіолетовий=10, Коричневий=11, Рожевий=12. " +
      "The slug PERSISTS only with its URL-tree parent, resolved via the preset's alias widget (param_id 5537, then the category default) — or pass `aliasParent` to set the known shared node explicitly. `enabled` defaults true. DRY RUN BY DEFAULT — pass dryRun:false to create. Remove a test preset with horoshop_admin_record_delete entity=filter_presets. " +
      "HOW THE VERIFY IS GATED — READ `persisted`, NOT THE NOTE. All six fields are re-read and reported in `persisted` (slug, page, params, enabled, seoText, aliasParent), but the cheerful note is gated on FOUR of them: slug, page, params, enabled. A preset whose `seo_text` did not land therefore still reports as created and fine — and an SEO landing with no text on it is the whole point missed. Check `persisted.seoText` explicitly (and `persisted.aliasParent`, which the note only mentions when it is false).",
    inputSchema: createSchema,
    annotations: { readOnlyHint: false, idempotentHint: false },
    handler: async (client, args) => {
      const form = await client.admin.getEditForm(args.store, presetTarget("addnew"));
      for (const need of ["names[params]", "names[alias][slug]", "names[alias][parent]", "names[page]"]) {
        if (!form.fieldNames.has(need)) {
          throw new Error(`The preset create form is missing ${need} — the admin markup changed or the session is invalid.`);
        }
      }
      const pages = pageOptions(form);
      const page = String(args.page);
      if (!new Set(pages.map((o) => o.value)).has(page)) {
        throw new Error(`page ${page} is not a valid preset target. Valid pages: ${pages.map((o) => `${o.value}=${o.label}`).join(", ")}.`);
      }

      const slug = String(args.slug);
      // Resolve (or accept) the alias parent so the slug persists.
      let aliasParent = args.aliasParent !== undefined && args.aliasParent !== null ? String(args.aliasParent) : "";
      let aliasVia = aliasParent ? "explicit" : "";
      if (!aliasParent) {
        const r = await resolvePresetAlias(client, args.store, page, slug, 0);
        aliasParent = r.parent;
        aliasVia = r.via;
      }

      const overrides = buildOverrides({ ...args, params: args.params, enabled: args.enabled !== false });
      overrides["names[alias][slug]"] = slug;
      if (aliasParent) overrides["names[alias][parent]"] = aliasParent;

      if (args.dryRun !== false) {
        return {
          store: args.store ?? null,
          action: "filter_preset_create",
          dryRun: true,
          page: `${page}${pages.find((p) => p.value === page) ? ` (${pages.find((p) => p.value === page)!.label})` : ""}`,
          params: args.params,
          slug,
          aliasParent: aliasParent || "UNRESOLVED (slug may not persist — pass aliasParent)",
          aliasVia,
          fields: Object.keys(overrides),
          enabled: args.enabled !== false,
          note: "Set dryRun:false to create. seo_text is sent as raw HTML verbatim.",
        };
      }

      const idsBefore = new Set(
        (await client.admin.listRecords(args.store, PRESET_HANDLER, { perPage: 160 }).catch(() => [])).map((r: any) => String(r.id)),
      );
      const res = await client.admin.save(args.store, form, overrides);
      const after = await client.admin.listRecords(args.store, PRESET_HANDLER, { perPage: 160 }).catch(() => [] as any[]);
      const fresh = after.filter((r: any) => !idsBefore.has(String(r.id)));
      const newId = fresh.length === 1 ? String(fresh[0].id) : null;
      if (!newId) {
        return {
          store: args.store ?? null,
          action: "filter_preset_create",
          dryRun: false,
          created: fresh.length > 0,
          httpStatus: res.httpStatus,
          note:
            fresh.length > 1
              ? `Created but ${fresh.length} rows appeared at once (ambiguous): ${fresh.map((r: any) => r.id).join(", ")}.`
              : `Submitted (HTTP ${res.httpStatus}) but no new preset appeared — the save was likely rejected. Check horoshop_admin_list entity=filter_presets.`,
        };
      }

      const state = await readPresetState(client, args.store, newId);
      const seoTextUa = (args.seo?.ua?.seoText ?? "") as string;
      const persisted = {
        // Horoshop normalises the slug (lower-cases, transliterates) on save, so a
        // slug submitted with any upper-case reads back lower-cased. Compare
        // case-insensitively — otherwise a perfectly-persisted "Foo-Bar" is
        // falsely reported as not persisted, which is exactly the "did not
        // persist" cry-wolf that masked a working create.
        slug: state.slug.toLowerCase() === slug.toLowerCase(),
        page: state.page === page,
        params: state.params === String(args.params),
        enabled: state.enabled === (args.enabled === false ? "0" : "1"),
        seoText: seoTextUa ? state.seoTextUa === seoTextUa : null,
        aliasParent: aliasParent ? state.aliasParent === aliasParent : null,
      };
      const ok = persisted.slug && persisted.page && persisted.params && persisted.enabled;
      return {
        store: args.store ?? null,
        action: "filter_preset_create",
        dryRun: false,
        created: true,
        newId,
        httpStatus: res.httpStatus,
        slug: state.slug || null,
        aliasParent: { requested: aliasParent || null, readBack: state.aliasParent || null, via: aliasVia },
        link: state.slug ? `/${state.slug}/` : null,
        persisted,
        note: ok
          ? `Preset ${newId} created at /${state.slug}/ (page ${state.page}, ${state.params})${persisted.aliasParent === false ? " — WARNING: alias parent read back differently" : ""}.`
          : `Preset ${newId} created but some fields did not persist — verify: ${JSON.stringify(persisted)}.`,
      };
    },
  },
  {
    name: "horoshop_admin_filter_preset_update",
    title: "Update an SEO filter preset (page, params, slug, SEO block)",
    description:
      "Update an existing filter preset (handler 364) by id. Read-modify-write: only the fields you pass change. Sets page / params / title / per-language SEO (raw-HTML seo_text) / enabled / sortorder. To change the slug pass `slug` (its alias parent is re-resolved via the preset widget, or pass `aliasParent`). Verifies by re-reading (slug, page, params, enabled, seo_text). " +
      "ADD A BLOCK WITHOUT RESENDING THE TEXT: `append` / `prepend` take the same per-language SEO shape as `seo` but splice onto the STORED seo_text instead of replacing it. That is the bulk case — one extra block across 15 presets costs 15 short deltas instead of 15 × 4 KB of re-typed Ukrainian HTML, and the existing copy is never re-encoded (so it cannot be corrupted). The same cell in `seo` AND `append`/`prepend` is an error, never a silent winner. " +
      "ANSWER SIZE: a persisted seo_text comes back as {length, tail, sha256}, not echoed as from+to+now (which is what made a 15-preset rollout unreadable); a field that did NOT persist still reports expected/actual previews plus the first differing offset. verbose:true restores the full diff. " +
      "⚠️ COLOR ID SPACE — the `color=N` in `params` is the FILTER-GROUP id (filter_colors, 351-space), NOT the product `color.id` from catalog_export (h_colors, 346-space); they do not line up. Never disable a preset because its color=N does not match exported product color.ids (a live color=10 preset serves products that export under color.id=21). Judge coverage from the storefront listing, not an id match. Filter-group ids (color=N → name): Чорний=1, Білий=2, Сірий=3, Червоний=4, Жовтий=6, Зелений=7, Блакитний=8, Синій=9, Фіолетовий=10, Коричневий=11, Рожевий=12. " +
      "NOT IDEMPOTENT WHEN YOU SPLICE: `set`-style fields can be re-sent safely, but `append`/`prepend` concatenate unconditionally. If a call times out and you retry it blind, the block lands TWICE in the live seo_text. Re-read the record before repeating a splice. " +
      "DRY RUN BY DEFAULT — pass dryRun:false to persist. " +
      PLACEHOLDER_GUARD_DOC,
    inputSchema: updateSchema,
    // NOT idempotent: append/prepend splice unconditionally, so a blind retry
    // duplicates the SEO block on a live store.
    annotations: { readOnlyHint: false, idempotentHint: false },
    handler: async (client, args) => {
      const form = await client.admin.getEditForm(args.store, presetTarget(args.id));
      if (!form.fieldNames.has("names[params]")) {
        throw new Error(`Preset ${args.id} not found — its edit form has no names[params]. Check the id with horoshop_admin_list entity=filter_presets.`);
      }

      const overrides = buildOverrides(args);

      // APPEND / PREPEND onto the stored SEO text. This is the case the tool was
      // missing: adding one block to 15 presets used to mean sending 15 × 4 KB of
      // someone else's Ukrainian HTML back inline, character-perfect, on a live
      // client store. The RMW already holds the current value — splice onto it.
      const seoCellKeys = (m: any): string[] =>
        m ? LANGS.flatMap((l) => SEO_KEYS.filter((k) => typeof m[l]?.[k] === "string").map((k) => `${l}.${k}`)) : [];
      assertNoSpliceConflict(seoCellKeys(args.seo), [...seoCellKeys(args.append), ...seoCellKeys(args.prepend)], "seo");
      const spliced: Record<string, { mode: string; delta: string; from: string; to: string }> = {};
      for (const lang of LANGS) {
        for (const key of SEO_KEYS) {
          const pre = args.prepend?.[lang]?.[key];
          const app = args.append?.[lang]?.[key];
          if (typeof pre !== "string" && typeof app !== "string") continue;
          const field = `names[i18n][${LANG_IDX[lang]}][${SEO_FIELDS[key]}]`;
          if (!form.fieldNames.has(field)) {
            throw new Error(
              `append/prepend target ${lang}.${key} (${field}) is not on preset ${args.id}'s form — nothing to splice onto. Check the preset id, or write the field with \`seo\`.`,
            );
          }
          const from = fieldValue(form, field);
          const to = splice({ current: from, append: app, prepend: pre });
          if (from === to) continue;
          overrides[field] = to;
          spliced[field] = {
            mode: [typeof pre === "string" ? "prepend" : "", typeof app === "string" ? "append" : ""].filter(Boolean).join("+"),
            delta: `${pre ?? ""}${app ?? ""}`,
            from,
            to,
          };
        }
      }

      let aliasParent = "";
      let aliasVia: string | null = null;
      if (typeof args.slug === "string" && args.slug.length) {
        overrides["names[alias][slug]"] = args.slug;
        if (args.aliasParent !== undefined && args.aliasParent !== null) {
          aliasParent = String(args.aliasParent);
          aliasVia = "explicit";
        } else {
          const pageForResolve = args.page ?? fieldValue(form, "names[page]");
          const r = await resolvePresetAlias(client, args.store, pageForResolve, args.slug, args.id);
          aliasParent = r.parent;
          aliasVia = r.via;
        }
        if (aliasParent) overrides["names[alias][parent]"] = aliasParent;
      } else if (args.aliasParent !== undefined && args.aliasParent !== null) {
        aliasParent = String(args.aliasParent);
        aliasVia = "explicit";
        overrides["names[alias][parent]"] = aliasParent;
      }

      if (Object.keys(overrides).length === 0) {
        throw new Error("Nothing to update — pass at least one of page / params / slug / title / seo / append / prepend / enabled / sortorder.");
      }
      const verbose = args.verbose === true;

      const planned: Array<Record<string, any>> = Object.entries(overrides).map(([field, to]) => {
        const s = spliced[field];
        const from = fieldValue(form, field);
        return s
          ? {
              field,
              mode: s.mode,
              from,
              to,
              delta: s.delta,
              length: { before: from.length, delta: s.delta.length, after: String(to).length },
            }
          : { field, from, to };
      });

      // TEMPLATE TOKENS — a preset's SEO block is exactly where {title}/{site}
      // style variables live (see admin/placeholders.ts).
      const placeholderWarnings = scanPlaceholderLoss(planned);

      if (args.dryRun !== false) {
        return {
          store: args.store ?? null,
          action: "filter_preset_update",
          id: String(args.id),
          dryRun: true,
          aliasParent: aliasParent || null,
          aliasVia,
          ...(placeholderWarnings.length
            ? { placeholderWarnings, placeholderNote: placeholderPreviewNote(placeholderWarnings) }
            : {}),
          willChange: planned.map((p) => compactPreview(p, verbose)),
        };
      }
      assertPlaceholdersKept(placeholderWarnings, args.allowPlaceholderLoss === true);

      const res = await client.admin.save(args.store, form, overrides);
      const verify = await client.admin.getEditForm(args.store, presetTarget(args.id));
      const changes = planned.map((p) => {
        const now = fieldValue(verify, p.field as string);
        // The slug is normalised (lower-cased/transliterated) server-side, so
        // verify it case-insensitively rather than crying "did not persist".
        const persisted =
          p.field === "names[alias][slug]" ? now.toLowerCase() === String(p.to).toLowerCase() : now === p.to;
        return { ...p, now, persisted };
      });
      const ok = changes.every((c) => c.persisted);
      const reported = changes.map((c) => compactVerified(c, verbose));
      const compacted = wasCompacted(reported);
      return {
        store: args.store ?? null,
        action: "filter_preset_update",
        id: String(args.id),
        dryRun: false,
        saved: ok,
        httpStatus: res.httpStatus,
        aliasParent: aliasParent ? { readBack: fieldValue(verify, "names[alias][parent]"), via: aliasVia } : null,
        ...(placeholderWarnings.length
          ? { placeholderLossAllowed: placeholderWarnings, placeholderNote: placeholderOverrideNote(placeholderWarnings) }
          : {}),
        changes: reported,
        note:
          (ok ? "Saved and verified by re-reading the preset." : "Some fields did not persist — check field names / admin validation.") +
          (compacted ? ` ${COMPACT_NOTE}` : ""),
      };
    },
  },
];
