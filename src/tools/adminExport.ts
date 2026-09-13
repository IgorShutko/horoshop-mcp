import { z } from "zod";
import { storeField, type ToolSpec } from "../register.js";

/**
 * FILE EXPORTS.
 *
 * Two "generate a file and hand back a link" actions were on the table for this
 * wave. Only ONE of them is here, and the other one's absence is deliberate.
 *
 * ── NOT SHIPPED: the marketplace export (`POST /_widget/file_export/exports/`).
 * The contract is fully measured — `marketConfigs[N][marketId]` +
 * `marketConfigs[N][currencyId]`, urlencoded exactly the way jQuery's `$.param`
 * serialises the admin's own payload, answering `[{title, url, success}]`, with
 * markets 6 Excel · 7 Hotline · 8 YML · 9 XML(Prom) · 10 Google CSV · 11 Excel
 * extended · 12 Prom(ua+ru) and currencies 1 UAH · 2 EUR · 3 USD · 4 PLN · 5 MDL.
 * It produced three real files on the test store. It is still not wrappable:
 *
 *  1. The FIRST call for a market creates a persistent row in entity 261 («Все
 *     варианты экспорта») as a side effect — a tool that "just generates a file"
 *     would quietly litter the store's export registry.
 *  2. Every call AFTER that throws a raw platform TypeError, «Argument 2 passed
 *     to FileExportManager::generateExport() must be of the type string, null
 *     given» (FileExportWidget.php:225) — reproduced with identical parameters,
 *     from a fresh admin session, and after deleting the 261 rows again. So the
 *     endpoint works once per store and then stops.
 *  3. The «Обновить» path the grid offers for an existing variant
 *     (`savers/export_files.php?handler=261&update=1[&id=N]`) answers 302 and
 *     leaves the file names unchanged, so it yields nothing verifiable either.
 *
 * A tool over that would work exactly once and afterwards fail with a PHP stack
 * message, which is the failure mode this server exists to avoid. Note also that
 * the admin's own «Генерировать» button is broken for every non-YML format: only
 * the YML row renders a currency select, so the popup sends `currencyId:null` and
 * gets the same TypeError. That is a platform bug, not ours.
 */

export const adminExportTools: ToolSpec[] = [
  {
    name: "horoshop_admin_export_characteristics",
    title: "Export a product template's characteristics to Excel",
    description:
      "Generate the «Экспорт характеристик» spreadsheet for ONE product template and return its download link — the .xlsx that lists the template's characteristic fields, which is the practical way to see (and hand to a client) what a category's product form actually asks for. " +
      "`templateId` is a PRODUCT TEMPLATE id, not a category id: get them from horoshop_admin_product_templates (on the test store 381 / 460 / 461). The answer is `{link}` to a file named `hid_specifications_<templateId>.<timestamp>.xlsx`, so every call writes a new file rather than replacing the previous one. Reading only — nothing in the catalog or the template changes. " +
      "⚠ THE ENDPOINT DOES NOT CHECK THAT THE TEMPLATE EXISTS — measured: `hid=999999` answers `status:OK` with a link to a real, downloadable 3 KB spreadsheet that describes nothing. A non-existent id therefore looks exactly like a successful export. This tool refuses instead: the id is checked against the store's template list first, and an unknown one is an error naming the ids that do exist. (A non-numeric id is the platform's own 503 TypeError.)",
    inputSchema: {
      ...storeField,
      templateId: z
        .union([z.number().int(), z.string()])
        .describe("Product template id (horoshop_admin_product_templates). NOT a category id."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    handler: async (client, args) => {
      // The endpoint answers OK for ANY numeric id and hands back a 3 KB
      // spreadsheet about nothing (measured on hid=999999), so "it returned a
      // link" is not evidence the template exists. Templates live in handler 1.
      const templates = await client.admin.listRecords(args.store, 1);
      const known = templates.map((t: any) => String(t.id));
      if (!known.includes(String(args.templateId))) {
        throw new Error(
          `No product template ${args.templateId} on this store. The export endpoint would still answer OK with a link to an empty spreadsheet, which is why this is refused here. Existing template ids: ${
            known.join(", ") || "none"
          } (horoshop_admin_product_templates lists their names).`,
        );
      }

      const res = await client.admin.postUrlencoded(
        args.store,
        "/adminLegacy/export/excel-spec.php",
        { hid: String(args.templateId), action: "step-2" },
        { redirect: "follow", accept: "application/json" },
      );
      let body: any = null;
      try {
        body = JSON.parse(res.text);
      } catch {
        body = null;
      }
      const link = body?.response?.link ?? body?.link ?? null;
      if (!link) {
        throw new Error(
          `No export link came back for template ${args.templateId} (HTTP ${res.httpStatus}, status ${
            body?.status ?? "?"
          }): ${body?.response?.message ?? res.text.slice(0, 300)}`,
        );
      }
      return {
        store: args.store ?? null,
        templateId: String(args.templateId),
        link,
        note: "Generated. The filename carries a timestamp, so this is a new file — earlier exports of the same template are still there.",
      };
    },
  },
];
