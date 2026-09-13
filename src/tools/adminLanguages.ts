import { z } from "zod";
import { storeField, type ToolSpec } from "../register.js";
import { fieldValue } from "../admin/form.js";

/** Logical language setting → its form field name. */
const LANG_FIELDS: Record<string, string> = {
  site_title: "site_title",
  enabled: "enabled",
  currency: "currency",
  noindex: "noindex",
  is_displayed_in_admin: "is_displayed_in_admin",
};

export const adminLanguageTools: ToolSpec[] = [
  {
    name: "horoshop_admin_languages",
    title: "List store languages",
    description:
      "List the store's languages (id + label) from the languages grid. Use an id with horoshop_admin_language_set.",
    inputSchema: { ...storeField },
    annotations: { readOnlyHint: true },
    handler: async (client, args) => {
      const rows = await client.admin.listRecords(args.store, 339);
      return { count: rows.length, languages: rows.map((r: any) => ({ id: r.id, label: r.label })) };
    },
  },
  {
    name: "horoshop_admin_language_set",
    title: "Edit a store language",
    description:
      "Edit a language's settings by id: site_title (its name), enabled (0/1), is_displayed_in_admin (0/1), currency (currency id — see the language editor), noindex (0/1). Read-modify-write; posts to the languages route. DRY RUN BY DEFAULT. (Adding/removing languages changes the whole storefront and is left to the admin UI.)",
    inputSchema: {
      ...storeField,
      id: z.union([z.number().int(), z.string()]).describe("Language id (from horoshop_admin_languages)."),
      site_title: z.string().optional().describe("Language display name."),
      enabled: z.enum(["0", "1"]).optional().describe("Enabled on the storefront."),
      is_displayed_in_admin: z.enum(["0", "1"]).optional().describe("Shown in the admin language switcher."),
      currency: z.string().optional().describe("Currency id for this language."),
      noindex: z.enum(["0", "1"]).optional().describe("noindex this language's pages."),
      dryRun: z.boolean().optional().describe("Default true: preview changes without saving. Set false to save."),
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
    handler: async (client, args) => {
      const target = { id: args.id, handler: 339 };
      const form = await client.admin.getEditForm(args.store, target);
      const overrides: Record<string, string> = {};
      const planned: Array<{ field: string; from: string; to: string }> = [];
      for (const [logical, formField] of Object.entries(LANG_FIELDS)) {
        const val = (args as Record<string, unknown>)[logical];
        if (val === undefined || !form.fieldNames.has(formField)) continue;
        const to = String(val);
        const from = fieldValue(form, formField);
        if (from === to) continue;
        overrides[formField] = to;
        planned.push({ field: logical, from, to });
      }
      if (planned.length === 0) {
        return { id: String(args.id), dryRun: args.dryRun !== false, changes: [], note: "Nothing to change." };
      }
      const dryRun = args.dryRun !== false;
      if (dryRun) return { id: String(args.id), dryRun: true, willChange: planned };

      const action = form.action || "/languages/save/";
      const res = await client.admin.saveViaRoute(args.store, action, form, overrides);
      const after = await client.admin.getEditForm(args.store, target);
      const changes = planned.map((p) => {
        const now = fieldValue(after, LANG_FIELDS[p.field]);
        return { ...p, persisted: now === p.to, now };
      });
      const ok = res.status === "OK" && changes.every((c) => c.persisted);
      return {
        id: String(args.id),
        dryRun: false,
        saved: ok,
        status: res.status,
        changes,
        note: ok ? "Saved and verified." : "Some fields did not persist — check values (currency id, etc.).",
      };
    },
  },
];
