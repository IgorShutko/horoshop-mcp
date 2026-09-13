import { z } from "zod";
import { storeField, type ToolSpec } from "../register.js";
import { fieldValue } from "../admin/form.js";

const CHECKCODE = "yamete_kudasai";

/** Fetch a product-template edit form (its own subsystem, not edit.php/save.php). */
function templateFormUrl(id: string | number): string {
  return `/adminLegacy/forms/handlers.php?edit=${encodeURIComponent(String(id))}&checkcode=${CHECKCODE}`;
}

export const adminTemplateTools: ToolSpec[] = [
  {
    name: "horoshop_admin_product_templates",
    title: "List product templates",
    description:
      "List product/data templates (Шаблоны товаров) — the characteristic schemas categories use (id + name, e.g. \"КАТАЛОГ: Товар\"). Use an id with the get/set tools.",
    inputSchema: { ...storeField },
    annotations: { readOnlyHint: true },
    handler: async (client, args) => {
      const rows = await client.admin.listRecords(args.store, 1);
      // The datagrid row concatenates title + internal name + action-cell text
      // ("Стікери · h_catalog_stkeri · очистить контент"); the title is the first segment.
      const cleanName = (label: string) => (label ?? "").split("·")[0].trim() || label;
      return { count: rows.length, templates: rows.map((r: any) => ({ id: r.id, name: cleanName(r.label) })) };
    },
  },
  {
    name: "horoshop_admin_product_template_get",
    title: "Read a product template",
    description:
      "Read a product template by id: its title and internal name/table. Read-only. Use before horoshop_admin_product_template_set. LIMITATION: this returns only the template's identity (6 meta fields) — the characteristic schema itself (which fields a category's products get) is NOT exposed by this editor, so you cannot see or change a category's characteristic list from here.",
    inputSchema: {
      ...storeField,
      id: z.union([z.number().int(), z.string()]).describe("Template id (from horoshop_admin_product_templates)."),
    },
    annotations: { readOnlyHint: true },
    handler: async (client, args) => {
      const form = await client.admin.getFormFromUrl(args.store, templateFormUrl(args.id));
      return {
        id: String(args.id),
        title: fieldValue(form, "handler[title]"),
        name: fieldValue(form, "handler[name]"),
        table: fieldValue(form, "handler[table]"),
        action: form.action,
        fieldCount: form.fields.length,
        fields: Object.fromEntries(form.fields.map((f) => [f.name, f.value])),
      };
    },
  },
  {
    name: "horoshop_admin_product_template_set",
    title: "Edit a product template",
    description:
      "Edit a product template's fields by id. Pass `set` as a map of exact form field names → values (get them from horoshop_admin_product_template_get) — most commonly {\"handler[title]\":\"New name\"}. Read-modify-write: the rest of the schema is preserved. DRY RUN BY DEFAULT. Editing the characteristic schema (field arrays) is advanced — change what you understand.",
    inputSchema: {
      ...storeField,
      id: z.union([z.number().int(), z.string()]).describe("Template id."),
      set: z.record(z.string()).describe("Map of form field name → new value (e.g. {\"handler[title]\":\"…\"})."),
      dryRun: z.boolean().optional().describe("Default true: preview without saving. Set false to save."),
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
    handler: async (client, args) => {
      const form = await client.admin.getFormFromUrl(args.store, templateFormUrl(args.id));
      const overrides: Record<string, string> = {};
      const planned: Array<{ field: string; from: string; to: string }> = [];
      const unknown: string[] = [];
      for (const [name, value] of Object.entries(args.set as Record<string, string>)) {
        if (!form.fieldNames.has(name)) {
          unknown.push(name);
          continue;
        }
        const from = fieldValue(form, name);
        if (from === value) continue;
        overrides[name] = value;
        planned.push({ field: name, from, to: value });
      }
      if (planned.length === 0) {
        return { id: String(args.id), changes: [], unknownFields: unknown, note: "Nothing to change." };
      }
      const dryRun = args.dryRun !== false;
      if (dryRun) return { id: String(args.id), dryRun: true, willChange: planned, unknownFields: unknown };

      const action = form.action || "/adminLegacy/savers/handlers.php";
      const res = await client.admin.saveViaRoute(args.store, action, form, overrides);
      const after = await client.admin.getFormFromUrl(args.store, templateFormUrl(args.id));
      const changes = planned.map((p) => {
        const now = fieldValue(after, p.field);
        return { ...p, persisted: now === p.to, now };
      });
      const ok = changes.every((c) => c.persisted);
      return {
        id: String(args.id),
        dryRun: false,
        saved: ok,
        httpStatus: res.httpStatus,
        changes,
        unknownFields: unknown,
        note: ok ? "Saved and verified." : "Some fields did not persist — check field names.",
      };
    },
  },
];
