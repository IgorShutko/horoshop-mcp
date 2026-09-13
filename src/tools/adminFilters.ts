import { z } from "zod";
import { storeField, type ToolSpec } from "../register.js";
import { fieldValue, type ParsedForm } from "../admin/form.js";
import type { EditTarget } from "../admin/session.js";

/**
 * Indexed (SEO) filters — handler 422, table `h_indexed_filters` — as named
 * create/update tools. An indexed filter turns a chosen COMBINATION of filter
 * characteristics on one category into an indexable landing (e.g. «Футболки» +
 * Бренд + Ціна), so the filtered URL gets its own crawlable page.
 *
 * Contract (reverse-engineered live on a test store):
 *   edit.php?id=<id|addnew>&handler=422&handlertable=h_indexed_filters → save.php
 *   - names[title]      : the filter's admin name
 *   - names[page]       : the page/category id it binds to (a <select>, rendered
 *                         with NO selected option, so pass it as an override)
 *   - names[enabled]    : 1/0
 *   - names[filters][]  : a MULTI-value field — one entry per condition. The
 *                         admin renders one «Фильтр N» <select> per condition and
 *                         submits several REPEATED `names[filters][]` parts. A
 *                         plain JSON patch cannot express a repeated key, which is
 *                         why generic record_save can only ever save ONE filter.
 *                         The option values are the store's filter-characteristic
 *                         ids (e.g. 5382=Бренд, 4508=Ціна, 5669=Иконки),
 *                         listed per page by the widget.
 *
 * Multiple conditions are written by passing `filters` as an ARRAY; the tool
 * submits them via AdminClient.saveMulti, whose additive array support in
 * buildMultipart emits the repeated `names[filters][]` parts. Verified live: a
 * two-condition create renders both «Фильтр» rows back on the edit page.
 */

const FILTER_HANDLER = 422;
const FILTER_TABLE = "h_indexed_filters";

function filterTarget(id: string | number): EditTarget {
  return { id, handler: FILTER_HANDLER, handlertable: FILTER_TABLE, extra: {}, flags: [] };
}

/** The filter-characteristic options a filter can combine (from names[filters][]). */
function filterOptions(form: ParsedForm): Array<{ value: string; label: string }> {
  return (form.selects["names[filters][]"]?.options ?? []).filter((o) => /^\d+$/.test(o.value));
}

/** The page/category options the filter can bind to (names[page]). */
function pageOptions(form: ParsedForm): Array<{ value: string; label: string }> {
  return (form.selects["names[page]"]?.options ?? []).filter((o) => /^\d+$/.test(o.value));
}

/**
 * Read back what the admin actually exposes for a saved indexed filter.
 *
 * IMPORTANT verification caveat (established live): the legacy edit view does NOT
 * render the stored filter CONDITIONS — it always draws a fixed pair of empty
 * «Фильтр» selects (a template), identical for a one- or a two-condition record,
 * and no `<option>` is marked selected. The datagrid, projectAjax
 * (loadAvailableFiltersByPageId returns only what is AVAILABLE, not what is
 * chosen) and the core-api expose them no better. So the count of saved
 * conditions is NOT readable through this server. What IS readable and verifiable
 * is `names[page]` (the bound category renders as the selected option) and
 * `names[enabled]`. The conditions themselves are proven only at the wire level:
 * the tool submits them as repeated `names[filters][]` parts (which a single JSON
 * key cannot express) and the save is accepted. This function returns the
 * readable state; it deliberately does not pretend to count stored conditions.
 */
async function readFilterState(
  client: any,
  store: string | undefined,
  id: string | number,
): Promise<{ page: string; enabled: string; found: boolean }> {
  const form = await client.admin.getEditForm(store, filterTarget(id));
  return {
    page: form.fieldNames.has("names[page]") ? fieldValue(form, "names[page]") : "",
    enabled: form.fieldNames.has("names[enabled]") ? fieldValue(form, "names[enabled]") : "",
    found: form.fieldNames.has("names[filters][]"),
  };
}

const filtersArg = z
  .array(z.union([z.number().int(), z.string()]))
  .min(1)
  .describe("Filter-characteristic ids to combine (one per condition). From horoshop_admin_record_get entity=indexed_filters id=addnew, the names[filters][] options (e.g. Бренд, Ціна).");

const createSchema = {
  ...storeField,
  title: z.string().min(1).describe("Filter name (admin label), e.g. «Футболки: бренд + ціна»."),
  page: z.union([z.number().int(), z.string()]).describe("Page/category id the filter binds to (names[page])."),
  filters: filtersArg,
  enabled: z.boolean().optional().describe("Whether the indexed filter is active (names[enabled]). Default true."),
  dryRun: z.boolean().optional().describe("Default true: preview the plan without creating. Set false to create."),
};

const updateSchema = {
  ...storeField,
  id: z.union([z.number().int(), z.string()]).describe("Indexed-filter id to update."),
  title: z.string().optional().describe("New filter name."),
  page: z.union([z.number().int(), z.string()]).optional().describe("New page/category id (names[page])."),
  filters: z
    .array(z.union([z.number().int(), z.string()]))
    .min(1)
    .optional()
    .describe("Replace the condition set (one id per condition). Omit to keep the current conditions."),
  enabled: z.boolean().optional().describe("Enable/disable the filter (names[enabled])."),
  dryRun: z.boolean().optional().describe("Default true: preview without saving. Set false to persist."),
};

export const adminFilterTools: ToolSpec[] = [
  {
    name: "horoshop_admin_indexed_filter_create",
    title: "Create an indexed (SEO) filter with several conditions",
    description:
      "Create an indexed/SEO filter (handler 422) that binds a COMBINATION of filter characteristics to one category so the filtered URL becomes an indexable landing. `page` = the category/page id; `filters` = an ARRAY of filter-characteristic ids (one per condition, e.g. Бренд + Ціна). Unlike generic record_save — which can only ever set ONE filter because a JSON patch cannot repeat a key — this submits every condition as a repeated names[filters][] part, so all of them persist. Discover the valid ids with horoshop_admin_record_get entity=indexed_filters id=addnew (the names[filters][] and names[page] options); the tool also lists them in a dry run and rejects ids not offered. " +
      "WHAT RE-READING CAN AND CANNOT PROVE: only `page` and `enabled` are verifiable. The stored CONDITIONS are not readable back through any interface this server has — the legacy edit view always draws the same fixed pair of empty «Фильтр» selects whether the record holds one condition or five, and neither the datagrid nor projectAjax exposes the saved set (loadAvailableFiltersByPageId returns what is AVAILABLE, not what is chosen). The answer says so in `conditionReadBack` instead of inventing a count. The conditions are proven only at the wire level (they are POSTed as repeated names[filters][] parts and the save is accepted) — to confirm the result for real, open the filtered category URL on the storefront and see whether it lists the products you expect. " +
      "TWO ID SPACES, ONE NUMBER: the ids in `filters` come from this form's own registry (the filter groups, e.g. filter_colors 351) and are NOT the dictionary value ids a product carries in horoshop_catalog_export (`color.id`, h_colors 346). They overlap numerically and mean different things, so do not judge an \"empty\" filter by matching ids across the two — judge it by the storefront listing. Ids not offered by the form are refused here rather than saved as junk. " +
      "`enabled` defaults true. DRY RUN BY DEFAULT — pass dryRun:false to create. Remove a test filter with horoshop_admin_record_delete entity=indexed_filters.",
    inputSchema: createSchema,
    annotations: { readOnlyHint: false, idempotentHint: false },
    handler: async (client, args) => {
      const form = await client.admin.getEditForm(args.store, filterTarget("addnew"));
      if (!form.fieldNames.has("names[filters][]") || !form.fieldNames.has("names[page]")) {
        throw new Error("The indexed-filter create form is missing names[filters][]/names[page] — the admin markup changed or the session is invalid.");
      }
      const opts = filterOptions(form);
      const pages = pageOptions(form);
      const validFilter = new Set(opts.map((o) => o.value));
      const validPage = new Set(pages.map((o) => o.value));

      const filters = (args.filters as Array<string | number>).map(String);
      const page = String(args.page);
      const unknownFilters = filters.filter((f) => !validFilter.has(f));
      if (unknownFilters.length) {
        throw new Error(
          `Filter id(s) not available: ${unknownFilters.join(", ")}. Valid options: ${opts.map((o) => `${o.value}=${o.label}`).join(", ") || "(none — pick a page first)"}.`,
        );
      }
      if (!validPage.has(page)) {
        throw new Error(
          `page ${page} is not a valid target. Valid pages: ${pages.map((o) => `${o.value}=${o.label}`).join(", ")}.`,
        );
      }

      const overrides: Record<string, string | string[]> = {
        "names[title]": String(args.title),
        "names[page]": page,
        "names[enabled]": args.enabled === false ? "0" : "1",
        "names[filters][]": filters,
      };

      if (args.dryRun !== false) {
        return {
          store: args.store ?? null,
          action: "indexed_filter_create",
          dryRun: true,
          page: `${page}${pages.find((p) => p.value === page) ? ` (${pages.find((p) => p.value === page)!.label})` : ""}`,
          conditions: filters.map((f) => `${f}${opts.find((o) => o.value === f) ? ` (${opts.find((o) => o.value === f)!.label})` : ""}`),
          enabled: args.enabled !== false,
          availableFilters: opts,
          note: "Set dryRun:false to create. All conditions are submitted as repeated names[filters][] parts.",
        };
      }

      const idsBefore = new Set(
        (await client.admin.listRecords(args.store, FILTER_HANDLER).catch(() => [])).map((r: any) => String(r.id)),
      );
      const res = await client.admin.saveMulti(args.store, form, overrides);
      const after = await client.admin.listRecords(args.store, FILTER_HANDLER).catch(() => [] as any[]);
      const fresh = after.filter((r: any) => !idsBefore.has(String(r.id)));
      const newId = fresh.length === 1 ? String(fresh[0].id) : null;
      if (!newId) {
        return {
          store: args.store ?? null,
          action: "indexed_filter_create",
          dryRun: false,
          created: fresh.length > 0,
          httpStatus: res.httpStatus,
          note:
            fresh.length > 1
              ? `Created but ${fresh.length} rows appeared at once (ambiguous): ${fresh.map((r: any) => r.id).join(", ")}.`
              : `Submitted (HTTP ${res.httpStatus}) but no new filter appeared — the save was likely rejected. Check horoshop_admin_list entity=indexed_filters.`,
        };
      }

      const state = await readFilterState(client, args.store, newId);
      const pagePersisted = state.page === page;
      return {
        store: args.store ?? null,
        action: "indexed_filter_create",
        dryRun: false,
        created: true,
        newId,
        httpStatus: res.httpStatus,
        transmittedConditions: filters,
        page: { requested: page, readBack: state.page, persisted: pagePersisted },
        enabled: state.enabled,
        conditionReadBack:
          "n/a — the legacy admin does not render stored filter conditions back (fixed 2-row template, no selected options; datagrid/projectAjax/core-api expose none). All requested conditions were transmitted as repeated names[filters][] parts and the save was accepted.",
        note: pagePersisted
          ? `Indexed filter ${newId} created on page ${page} with ${filters.length} condition(s) (${filters.join(", ")}) submitted as repeated names[filters][] parts.`
          : `Filter ${newId} created but names[page] read back as "${state.page}" (requested ${page}) — verify in the admin.`,
      };
    },
  },
  {
    name: "horoshop_admin_indexed_filter_update",
    title: "Update an indexed (SEO) filter (title, page, conditions)",
    description:
      "Update an existing indexed/SEO filter (handler 422) by id. Read-modify-write for the scalar fields (title/page/enabled); pass `filters` (an array of characteristic ids) to REPLACE the whole condition set — again submitted as repeated names[filters][] parts so all conditions persist, not just one. Omit `filters` to leave the conditions unchanged. " +
      "WHAT IS VERIFIED: `page` and `enabled` only — those re-read from the record. The condition set does NOT read back: the legacy edit view renders a fixed empty «Фильтр» template regardless of what is stored, so replacing five conditions with one looks identical on a re-read. The answer reports `conditionReadBack: \"n/a\"` rather than claiming a count. Confirm a condition change by opening the filtered category URL on the storefront. Note also that a `filters` id belongs to the admin's filter-group registry (filter_colors 351 and kin), not to the product-side dictionary ids in horoshop_catalog_export (`color.id`, h_colors 346) — the numbers overlap and mean different things. " +
      "DRY RUN BY DEFAULT — pass dryRun:false to persist.",
    inputSchema: updateSchema,
    annotations: { readOnlyHint: false, idempotentHint: true },
    handler: async (client, args) => {
      const form = await client.admin.getEditForm(args.store, filterTarget(args.id));
      if (!form.fieldNames.has("names[filters][]")) {
        throw new Error(`Indexed filter ${args.id} not found — its edit form has no names[filters][]. Check the id with horoshop_admin_list entity=indexed_filters.`);
      }
      const opts = filterOptions(form);
      const validFilter = new Set(opts.map((o) => o.value));

      const overrides: Record<string, string | string[]> = {};
      if (typeof args.title === "string") overrides["names[title]"] = args.title;
      if (args.page !== undefined) overrides["names[page]"] = String(args.page);
      if (typeof args.enabled === "boolean") overrides["names[enabled]"] = args.enabled ? "1" : "0";
      let filters: string[] | null = null;
      if (args.filters) {
        filters = (args.filters as Array<string | number>).map(String);
        const unknown = filters.filter((f) => !validFilter.has(f));
        if (unknown.length) {
          throw new Error(`Filter id(s) not available: ${unknown.join(", ")}. Valid: ${opts.map((o) => `${o.value}=${o.label}`).join(", ")}.`);
        }
        overrides["names[filters][]"] = filters;
      }
      if (Object.keys(overrides).length === 0) {
        throw new Error("Nothing to update — pass at least one of title / page / enabled / filters.");
      }

      if (args.dryRun !== false) {
        return {
          store: args.store ?? null,
          action: "indexed_filter_update",
          id: String(args.id),
          dryRun: true,
          willSet: Object.fromEntries(Object.entries(overrides).map(([k, v]) => [k, v])),
        };
      }

      const res = await client.admin.saveMulti(args.store, form, overrides);
      const state = await readFilterState(client, args.store, args.id);
      const pagePersisted = args.page === undefined || state.page === String(args.page);
      return {
        store: args.store ?? null,
        action: "indexed_filter_update",
        id: String(args.id),
        dryRun: false,
        httpStatus: res.httpStatus,
        page: { readBack: state.page, persisted: pagePersisted },
        enabled: state.enabled,
        transmittedConditions: filters,
        conditionReadBack: filters
          ? "n/a — the legacy admin does not render stored filter conditions back; the replacement set was transmitted as repeated names[filters][] parts and the save was accepted."
          : "unchanged (conditions not touched)",
        note: pagePersisted ? "Saved." : `names[page] read back as "${state.page}" (requested ${args.page}) — verify in the admin.`,
      };
    },
  },
];
