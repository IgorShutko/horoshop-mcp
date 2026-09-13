import { z } from "zod";
import { storeField, type ToolSpec } from "../register.js";

/**
 * PRICE-LIST IMPORT — the supplier-feed engine («Импорт» on the products grid).
 *
 * WHERE IT HIDES. It is not a route and not a menu item: it is a Vue app mounted
 * on a button (`#importBtn`) of the products datagrid, talking to
 * `API_ROOT = /priceListImport`. That is why every navigation-based map of the
 * admin missed it. Eleven POST/GET endpoints, all answering the same
 * `{status, response}` envelope as the marketplace feeds.
 *
 * THE FOUR-STEP WIRE PROTOCOL, measured end to end on the test store:
 *   1. `POST /parser/parseRemoteFile {url}` → `{token, rows, availableGroups,
 *      allRowsCount, imageFieldTypes}`. The file is fetched by the STORE (so the
 *      URL must be reachable from the internet, not from your machine), parsed,
 *      and parked against a token. NOTHING in the catalog changes at this step —
 *      it is the read half, and it is where this server does all its thinking.
 *   2. `GET /settings/getAvailableSettings/?token=…` → the four import policies
 *      (new / exist / missed / images) with their allowed values.
 *   3. `POST /process/begin/?token=…&supplier_id=…` with
 *      `{settings:{columnSettings, needImportFirstRow, importConfig}}` → the plan.
 *   4. `GET /process/importProducts/?token=…&supplier_id=…`, repeatedly, until it
 *      stops answering `inProcess` / `metaStatus 4`. THIS is the step that writes.
 *
 * WHY THE SPLIT INTO TWO TOOLS. Steps 1–2 are safe and step 4 rewrites prices in
 * bulk, so they are not allowed to happen in one call. `…_parse` hands back a
 * token plus the mapping it proposes; `…_run` re-states exactly what will be
 * written and refuses to do it without `confirm`.
 *
 * TWO TRAPS WORTH NAMING:
 *  - A session whose first request is a `/priceListImport/*` POST gets the
 *    storefront 404 page instead of JSON — the PHP session has to be promoted by
 *    a legacy page load first. Handled in the transport (`warmLegacy`).
 *  - `columnSettings` is POSITIONAL: one entry per column of the file, in file
 *    order, `"-1"` meaning "do not import this column". A shifted array imports
 *    prices into the article field, and the platform will not notice.
 */

const ROOT = "/priceListImport";
/** The value that marks a column as "not imported" (bundle constant). */
const SKIP = "-1";
/** `metaStatus` the import loop keeps polling on (bundle: STATUS_IMPORT_PENDING). */
const PENDING = 4;

interface Target {
  index: number;
  label: string;
  value: string;
  group: string;
  /** The parsed `{id, language, type}` of a template field, when it is one. */
  type: string | null;
}

/** Flatten `availableGroups` exactly the way the admin's own store does. */
function flattenTargets(groups: any[]): Target[] {
  const out: Target[] = [];
  for (const g of groups ?? []) {
    for (const o of g.options ?? []) {
      let type: string | null = null;
      try {
        type = JSON.parse(o.value)?.type ?? null;
      } catch {
        type = null;
      }
      out.push({ index: out.length, label: String(o.label ?? ""), value: String(o.value ?? ""), group: String(g.name ?? ""), type });
    }
  }
  return out;
}

const norm = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Resolve one caller-supplied column target. Accepts the flat index, the exact
 * label, or the raw `value` string. Label matching is WHOLE-STRING: a substring
 * match would send «Цена» and «Старая цена для Kasta» to the same field, and the
 * import would happily overwrite the wrong one.
 */
function resolveTarget(spec: unknown, targets: Target[], column: string): string {
  if (spec === null || spec === undefined) return SKIP;
  const raw = String(spec).trim();
  if (raw === "" || raw === SKIP || norm(raw) === "skip") return SKIP;
  if (/^\d+$/.test(raw)) {
    const t = targets[Number(raw)];
    if (!t) throw new Error(`Column «${column}»: target index ${raw} is out of range (0…${targets.length - 1}).`);
    return t.value;
  }
  const byValue = targets.filter((t) => t.value === raw);
  if (byValue.length === 1) return byValue[0].value;
  const byLabel = targets.filter((t) => norm(t.label) === norm(raw));
  if (byLabel.length === 1) return byLabel[0].value;
  if (byLabel.length > 1) {
    throw new Error(
      `Column «${column}»: «${raw}» names ${byLabel.length} different fields (${byLabel
        .map((t) => `${t.index} in ${t.group}`)
        .join(", ")}) — pass the numeric target index instead.`,
    );
  }
  throw new Error(
    `Column «${column}»: no import field is called «${raw}». Use horoshop_admin_price_import_parse with targetSearch to find the exact label, or pass the numeric index.`,
  );
}

/** Best-effort automatic mapping: exact label match only, ambiguity left unmapped. */
function suggest(columns: string[], targets: Target[]) {
  return columns.map((c) => {
    const hits = targets.filter((t) => norm(t.label) === norm(c));
    if (hits.length === 1) return { column: c, targetIndex: hits[0].index, target: hits[0].label, group: hits[0].group, value: hits[0].value };
    if (hits.length > 1) {
      return {
        column: c,
        targetIndex: null,
        target: null,
        ambiguous: hits.map((h) => ({ index: h.index, group: h.group })),
        note: "Several fields carry this exact label — pick one by index.",
      };
    }
    return { column: c, targetIndex: null, target: null, note: "No field carries exactly this label — map it explicitly or leave it out." };
  });
}

async function fetchSettingsSchema(client: any, store: string | undefined, token: string) {
  const res = await client.admin.getJson(store, `${ROOT}/settings/getAvailableSettings/?token=${encodeURIComponent(token)}`, {
    warmLegacy: true,
  });
  if (res.status !== "OK") {
    throw new Error(`getAvailableSettings failed (HTTP ${res.httpStatus}, status ${res.status ?? "non-JSON"}): ${res.response?.message ?? res.text.slice(0, 200)}`);
  }
  return (res.response?.settings ?? []) as any[];
}

async function fetchSuppliers(client: any, store: string | undefined) {
  const res = await client.admin.postJson(store, `${ROOT}/settings/getSuppliersData`, {}, { warmLegacy: true });
  return (res.response?.suppliers ?? []) as any[];
}

/**
 * Fetch + parse the remote price file, normalising the platform's two failure
 * shapes (both HTTP 200) into one readable error.
 *
 * `parser/parseUploadedFile/?token=…` — the obvious way to re-read an earlier
 * parse — does NOT work for a token created by `parseRemoteFile`: it answers
 * `EXCEPTION «Невозможно обработать загруженный файл»`, because it looks for an
 * UPLOADED file under that token. Measured. So both the dry run and the live run
 * parse the URL themselves; that also guarantees the plan shown and the plan
 * executed came from the same read of the same file.
 */
async function parseRemote(client: any, store: string | undefined, url: string) {
  const parsed = await client.admin.postJson(store, `${ROOT}/parser/parseRemoteFile`, { url }, { warmLegacy: true });
  if (parsed.status !== "OK") {
    const why =
      parsed.status === "VALIDATION_ERROR"
        ? "the platform rejected the URL"
        : parsed.status === "EXCEPTION"
          ? "the platform downloaded something it cannot parse as a price list"
          : `unexpected answer (HTTP ${parsed.httpStatus})`;
    throw new Error(
      `Parsing ${url} failed — ${why}: ${parsed.response?.message ?? parsed.text.slice(0, 200)}${
        parsed.response?.reason ? ` [platform detail: ${String(parsed.response.reason).slice(0, 200)}]` : ""
      }`,
    );
  }
  const r = parsed.response ?? {};
  let rows: any[][] = [];
  try {
    rows = typeof r.rows === "string" ? JSON.parse(r.rows) : (r.rows ?? []);
  } catch {
    rows = [];
  }
  return {
    token: String(r.token ?? ""),
    rows,
    header: (rows[0] ?? []).map((c: any) => String(c ?? "")) as string[],
    targets: flattenTargets(r.availableGroups ?? []),
    allRowsCount: Number(r.allRowsCount ?? rows.length),
    imageFieldTypes: r.imageFieldTypes ?? [],
  };
}

export const adminPriceImportTools: ToolSpec[] = [
  {
    name: "horoshop_admin_price_import_parse",
    title: "Parse a supplier price list from a URL (read-only) and propose a column mapping",
    description:
      "Step one of the price-list import: hand the store a URL, get back what the platform sees in that file — the column headers, the first rows, the total row count — plus an import TOKEN, the list of fields those columns can be mapped onto, and the four import policies with their allowed values. " +
      "The store fetches the URL itself, so it must be reachable from the public internet (a localhost or intranet link fails), and it must be a real price list: xlsx / xls / csv / xml are what the parser accepts. A missing file answers `VALIDATION_ERROR` («Файл не найден: …»), an HTML page answers `EXCEPTION` («Невозможно обработать загруженный файл») — both arrive as HTTP 200, which is why the status is reported here explicitly. " +
      "NOTHING IS WRITTEN by this tool: the file is parsed and parked against the token, and the catalog is untouched until horoshop_admin_price_import_run is called with confirm. The proposed mapping uses WHOLE-LABEL matching only — a column called «Цена» maps, a column called «Название» does not (the store has «Название (UA)», «Название (RU)» …), and nothing is guessed by prefix, because guessing here writes supplier prices into the wrong field. " +
      "`targetSearch` filters the (200+) mappable fields by substring so you can find the exact label to use; without it only the proposal and a per-group count come back.",
    inputSchema: {
      ...storeField,
      url: z.string().describe("Public URL of the price file (xlsx / xls / csv / xml). Fetched BY THE STORE, so it must be reachable from the internet."),
      targetSearch: z.string().optional().describe("Substring filter over the mappable field labels (e.g. \"цена\", \"наличие\") — use it to find the exact label/index for the mapping."),
      sampleRows: z.number().int().min(0).max(20).optional().describe("How many data rows to show. Default 5."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false },
    handler: async (client, args) => {
      const { token, rows, header, targets, allRowsCount } = await parseRemote(client, args.store, String(args.url));
      const settings = await fetchSettingsSchema(client, args.store, token);
      const suppliers = await fetchSuppliers(client, args.store);

      const groupCounts: Record<string, number> = {};
      for (const t of targets) groupCounts[t.group] = (groupCounts[t.group] ?? 0) + 1;

      const found = args.targetSearch
        ? targets
            .filter((t) => norm(t.label).includes(norm(args.targetSearch)))
            .slice(0, 80)
            .map((t) => ({ index: t.index, label: t.label, group: t.group, type: t.type }))
        : undefined;

      const proposal = suggest(header, targets);
      const unmapped = proposal.filter((p) => p.targetIndex === null).map((p) => p.column);
      const hasArticle = proposal.some((p) => p.value === "article");

      return {
        store: args.store ?? null,
        url: String(args.url),
        token,
        columns: header,
        totalRows: allRowsCount,
        dataRows: Math.max(0, allRowsCount - 1),
        sample: rows.slice(1, 1 + (args.sampleRows ?? 5)),
        proposedMapping: proposal,
        unmappedColumns: unmapped,
        mappableFieldCount: targets.length,
        mappableFieldGroups: groupCounts,
        ...(found ? { matchingFields: found } : {}),
        importSettings: settings.map((s: any) => ({
          systemName: s.systemName,
          title: s.title,
          description: s.description,
          defaultValue: s.defaultValue,
          options: (s.options ?? []).map((o: any) => `${o.value} = ${o.title}`),
        })),
        suppliers: suppliers.map((s: any) => ({ id: s.id, title: s.title })),
        warnings: [
          ...(hasArticle ? [] : ["No column maps onto «Артикул» (`article`). That field is REQUIRED — the import cannot match a row to a product without it."]),
          ...(unmapped.length ? [`${unmapped.length} column(s) have no exact-label match and will be skipped unless mapped explicitly: ${unmapped.join(", ")}.`] : []),
        ],
        next:
          "Nothing has been written. Pass the same URL and a column mapping to horoshop_admin_price_import_run (dry run by default) to see exactly which fields and how many rows would be touched.",
        tokenNote:
          "The token is shown for traceability only — it is not an input anywhere. It belongs to THIS parse; the run tool parses the URL again so that the plan it prints and the plan it executes come from one read of one file.",
      };
    },
  },

  {
    name: "horoshop_admin_price_import_run",
    title: "Dry-run or execute a supplier price-list import",
    description:
      "Step two: give the same file URL you inspected with horoshop_admin_price_import_parse, state the column mapping and the four import policies, and either SHOW what would happen (default) or actually import. The file is parsed again here on purpose, so the plan printed and the plan executed come from ONE read of the file (the platform's `parseUploadedFile` cannot re-open a remote parse — measured — and a stale plan against a changed file would shift the positional mapping silently). " +
      "The dry run reports the literal `columnSettings` array that would go on the wire, column by column with the field each one writes into, the number of data rows, the resolved policies, and every risk it can see. Nothing is sent to the platform in dry-run mode — not even `process/begin`. " +
      "THE POLICIES ARE THE DANGEROUS PART, not the mapping. `exist:doNothing` means «update existing products» — that is what overwrites current prices in bulk. `missed` decides what happens to products that are ON THE SITE BUT NOT IN THE FILE, and every value other than `doNothing` (hide them, or force a presence status) rewrites products the file never mentioned: that needs its own `confirmCatalogWide:true` on top of `confirm:true`. `images:imageOverride` replaces galleries rather than adding to them. " +
      "Executing needs `dryRun:false` AND `confirm:true`. There is no undo: the import writes through the platform's own engine, and this server cannot restore the previous prices. The run polls `process/importProducts` until the platform stops reporting work in progress, then returns the per-row log and the link to the platform's own XLSX report.",
    inputSchema: {
      ...storeField,
      url: z.string().describe("Public URL of the price file — the same one horoshop_admin_price_import_parse showed you. Fetched by the store, and parsed again here."),
      columns: z
        .array(z.union([z.string(), z.number().int(), z.null()]))
        .optional()
        .describe(
          "One entry PER COLUMN of the file, in file order: a field label, a field index, or null to skip. Omit to use the parse tool's exact-label proposal (unmatched columns are skipped).",
        ),
      settings: z
        .record(z.string())
        .optional()
        .describe(
          "Import policies by systemName: {new, exist, missed, images}. Omit any to take the platform's default (`doNothing` / `imageOverride`).",
        ),
      supplierId: z.union([z.number().int(), z.string()]).optional().describe("Supplier to attribute the import to. Default: the store's first supplier."),
      includeFirstRow: z.boolean().optional().describe("Treat row 1 as DATA rather than a header. Default false."),
      dryRun: z.boolean().optional().describe("Default true — report the plan without touching the catalog."),
      confirm: z.boolean().optional().describe("Required together with dryRun:false. Prices and product fields are rewritten in bulk and cannot be restored by this server."),
      confirmCatalogWide: z
        .boolean()
        .optional()
        .describe("Additionally required when `missed` is not `doNothing`, i.e. when the run also rewrites products that are NOT in the file."),
      maxSteps: z.number().int().min(1).max(200).optional().describe("Safety cap on import polling iterations. Default 60."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    handler: async (client, args) => {
      const { token, header, targets, allRowsCount } = await parseRemote(client, args.store, String(args.url));
      const byValue = new Map(targets.map((t) => [t.value, t]));

      // ── mapping ───────────────────────────────────────────────────────────
      let columnSettings: string[];
      if (args.columns) {
        if (args.columns.length !== header.length) {
          throw new Error(
            `columns has ${args.columns.length} entries but the file has ${header.length} columns (${header.join(" | ")}). The array is POSITIONAL — one entry per column, null to skip — so a shorter or longer one would write values into the wrong fields.`,
          );
        }
        columnSettings = args.columns.map((c: any, i: number) => resolveTarget(c, targets, header[i] || `#${i + 1}`));
      } else {
        columnSettings = suggest(header, targets).map((p: any) => p.value ?? SKIP);
      }
      const mapped = columnSettings
        .map((v, i) => ({ column: header[i] || `#${i + 1}`, value: v, target: v === SKIP ? null : (byValue.get(v)?.label ?? v), group: v === SKIP ? null : (byValue.get(v)?.group ?? null) }))
        .filter((m) => m.value !== SKIP);
      if (!columnSettings.includes("article")) {
        throw new Error(
          `No column is mapped onto «Артикул» (\`article\`) — the import cannot tell which product a row is about, and the platform would create duplicates or fail every row. Columns in the file: ${header.join(" | ")}.`,
        );
      }
      const dupes = columnSettings.filter((v, i) => v !== SKIP && columnSettings.indexOf(v) !== i);
      if (dupes.length) {
        throw new Error(
          `Two columns are mapped onto the same field (${[...new Set(dupes)].map((d) => byValue.get(d)?.label ?? d).join(", ")}). The platform takes the last one silently — map one of them to null instead.`,
        );
      }

      // ── policies ──────────────────────────────────────────────────────────
      const schema = await fetchSettingsSchema(client, args.store, token);
      const importConfig: Record<string, string> = {};
      const policyReport: any[] = [];
      for (const s of schema) {
        const asked = args.settings?.[s.systemName];
        const allowed = (s.options ?? []).map((o: any) => String(o.value));
        const value = asked != null ? String(asked) : String(s.defaultValue);
        if (!allowed.includes(value)) {
          throw new Error(
            `settings.${s.systemName} = ${JSON.stringify(value)} is not allowed. «${s.title}» accepts: ${(s.options ?? [])
              .map((o: any) => `${o.value} (${o.title})`)
              .join(", ")}.`,
          );
        }
        importConfig[s.systemName] = value;
        policyReport.push({
          systemName: s.systemName,
          title: s.title,
          value,
          means: (s.options ?? []).find((o: any) => String(o.value) === value)?.title ?? value,
          isDefault: value === String(s.defaultValue),
        });
      }
      for (const k of Object.keys(args.settings ?? {})) {
        if (!schema.some((s: any) => s.systemName === k)) {
          throw new Error(`Unknown import setting ${JSON.stringify(k)}. This store offers: ${schema.map((s: any) => s.systemName).join(", ")}.`);
        }
      }

      const suppliers = await fetchSuppliers(client, args.store);
      const supplierId = args.supplierId != null ? String(args.supplierId) : String(suppliers[0]?.id ?? 1);
      if (!suppliers.some((s: any) => String(s.id) === supplierId)) {
        throw new Error(`No supplier ${supplierId} on this store. Known: ${suppliers.map((s: any) => `${s.id} «${s.title}»`).join(", ") || "none"}.`);
      }

      const needImportFirstRow = args.includeFirstRow === true;
      const dataRows = Math.max(0, allRowsCount - (needImportFirstRow ? 0 : 1));

      const risks: string[] = [];
      if (importConfig.exist === "doNothing") risks.push(`Existing products WILL BE UPDATED: every article in the file that already exists gets the mapped fields (${mapped.map((m) => m.target).join(", ")}) overwritten. There is no undo.`);
      if (importConfig.new === "doNothing") {
        risks.push("Articles absent from the site WILL BE CREATED as new products.");
        // Measured on the test store: with «Новые товары: Импортировать» and no
        // «Раздел» column, the import runs to completion, answers OK, produces
        // an XLSX report — and creates NOTHING, logging code 7 «Категория не
        // найдена, либо в категории указан неверный шаблон» on every row. A
        // silent zero-write looks exactly like a success, so it is called out
        // before the run rather than discovered afterwards.
        if (!mapped.some((m) => norm(m.target) === "раздел")) {
          risks.push(
            "NO «Раздел» COLUMN IS MAPPED. A product that does not yet exist cannot be created without a category: the platform will still report the import as finished, still hand back a report, and create nothing — every row fails with «Категория не найдена, либо в категории указан неверный шаблон». Map a column onto «Раздел» (its values are category names as they appear in the catalog tree), or set settings.new = removeFromList if this run is only meant to update existing products.",
          );
        }
      }
      if (importConfig.missed && importConfig.missed !== "doNothing") {
        risks.push(
          `«${policyReport.find((p) => p.systemName === "missed")?.title}» is set to «${
            policyReport.find((p) => p.systemName === "missed")?.means
          }» — this rewrites products that are NOT in the file at all, i.e. potentially the whole catalog.`,
        );
      }
      if (importConfig.images === "imageOverride" && mapped.some((m) => /фото|галере|image|gallery/i.test(m.target ?? ""))) {
        risks.push("Photos are set to «Перезаписать»: existing galleries are replaced, not extended.");
      }

      if (args.dryRun !== false) {
        return {
          store: args.store ?? null,
          dryRun: true,
          token,
          fileColumns: header,
          dataRows,
          needImportFirstRow,
          supplier: suppliers.find((s: any) => String(s.id) === supplierId) ?? { id: supplierId },
          mapping: mapped,
          skippedColumns: header.filter((_, i) => columnSettings[i] === SKIP),
          policies: policyReport,
          wouldSend: {
            begin: `POST ${ROOT}/process/begin/?token=${token}&supplier_id=${supplierId}`,
            body: { settings: { columnSettings, needImportFirstRow, importConfig } },
            then: `GET ${ROOT}/process/importProducts/?token=${token}&supplier_id=${supplierId} (polled until done)`,
          },
          risks,
          note: "Nothing was sent. To execute: same call with dryRun:false and confirm:true" + (importConfig.missed !== "doNothing" ? " and confirmCatalogWide:true" : "") + ".",
        };
      }

      // ── live ──────────────────────────────────────────────────────────────
      if (!args.confirm) {
        throw new Error(
          `Refused: dryRun:false needs confirm:true. This would write ${dataRows} row(s) into the catalog (${risks.join(" ")}) and cannot be undone by this server.`,
        );
      }
      if (importConfig.missed !== "doNothing" && !args.confirmCatalogWide) {
        throw new Error(
          `Refused: settings.missed = «${importConfig.missed}» also rewrites products that are NOT in the file — potentially the entire catalog. Re-send with confirmCatalogWide:true if that is really intended.`,
        );
      }

      const begin = await client.admin.postJson(
        args.store,
        `${ROOT}/process/begin/?token=${encodeURIComponent(token)}&supplier_id=${encodeURIComponent(supplierId)}`,
        { settings: { columnSettings, needImportFirstRow, importConfig } },
        { warmLegacy: true },
      );
      if (begin.status !== "OK") {
        throw new Error(`process/begin refused (HTTP ${begin.httpStatus}, status ${begin.status ?? "non-JSON"}): ${begin.response?.message ?? begin.text.slice(0, 200)}`);
      }

      const maxSteps = args.maxSteps ?? 60;
      const steps: any[] = [];
      let last: any = null;
      for (let i = 0; i < maxSteps; i++) {
        const step = await client.admin.getJson(
          args.store,
          `${ROOT}/process/importProducts/?token=${encodeURIComponent(token)}&supplier_id=${encodeURIComponent(supplierId)}`,
        );
        last = step;
        steps.push({ step: i + 1, status: step.status, inProcess: step.response?.inProcess ?? null, metaStatus: step.response?.metaStatus ?? null });
        if (step.status !== "OK") break;
        const resp = step.response ?? {};
        if (!resp.inProcess && Number(resp.metaStatus) !== PENDING) break;
        await new Promise((res) => setTimeout(res, 1500));
      }
      if (last?.status !== "OK") {
        throw new Error(
          `The import stopped on a platform error after ${steps.length} step(s) (status ${last?.status ?? "?"}): ${
            last?.response?.message ?? String(last?.text ?? "").slice(0, 200)
          }. Some rows may already have been written — check the products grid.`,
        );
      }

      // Per-row outcome, bounded: the platform keeps one log per row index.
      const logs: any[] = [];
      const upTo = Math.min(dataRows, 25);
      for (let i = 0; i < upTo; i++) {
        const lg = await client.admin.postJson(args.store, `${ROOT}/result/getLogByIndex/?token=${encodeURIComponent(token)}`, { index: needImportFirstRow ? i : i + 1 });
        if (lg.status === "OK" && lg.response?.info) logs.push({ row: needImportFirstRow ? i : i + 1, info: lg.response.info });
      }
      let reportLink: string | null = null;
      const rep = await client.admin.postJson(args.store, `${ROOT}/report/exportLogs/?token=${encodeURIComponent(token)}`, {});
      if (rep.status === "OK") reportLink = rep.response?.link ?? null;

      // "The import finished" is NOT "the import wrote something": the platform
      // reports per-row failures only in the log, and answers OK regardless. So
      // the messages are summarised here and a run where every logged row
      // carries a message is called out as a probable zero-write.
      // `code:0` is the platform's SUCCESS line («Товар добавлен» / «Товар
      // обновлён»); anything else is a real per-row failure (7 = the missing
      // category). Counting every log line as a problem would have flagged a
      // perfectly good import.
      const problemsOf = (l: any) => (l.info ?? []).filter((i: any) => Number(i.code) !== 0);
      const failedRows = logs.filter((l) => problemsOf(l).length > 0);
      const distinct = [...new Set(failedRows.flatMap((l) => problemsOf(l).map((i: any) => `${i.code}: ${i.message}`)))];
      const okMessages = [...new Set(logs.flatMap((l) => (l.info ?? []).filter((i: any) => Number(i.code) === 0).map((i: any) => String(i.message))))];
      const allFailed = logs.length > 0 && failedRows.length === logs.length;

      return {
        store: args.store ?? null,
        imported: true,
        token,
        dataRows,
        supplierId,
        mapping: mapped,
        policies: policyReport,
        steps,
        importStatus: last?.response?.importStatus ?? null,
        rowsInspected: logs.length,
        rowsFailed: failedRows.length,
        outcomes: okMessages,
        problems: distinct,
        rowLog: logs,
        rowLogTruncated: dataRows > upTo ? `only the first ${upTo} rows are shown; the XLSX report covers all of them` : undefined,
        reportLink,
        ...(allFailed
          ? {
              warning: `The platform reported a problem on EVERY row it logged (${distinct.join(" | ")}). The import still answered "finished" and still produced a report — that is what a zero-write looks like here. Verify with horoshop_catalog_export before assuming anything changed.`,
            }
          : {}),
        note: "Written through the platform's own import engine. This server cannot restore the previous values — the XLSX report is the record of what changed.",
      };
    },
  },
];
