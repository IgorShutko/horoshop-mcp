import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { storeField, type ToolSpec } from "../register.js";
import { payloadFileField, withPayloadFile } from "../admin/payloadFile.js";
import {
  chainLength,
  normaliseUri,
  parseRedirectFile,
  resolveTargetByUrl,
  vetRedirects,
  type PlannedRedirect,
  type RedirectRow,
  type RedirectTargetRow,
} from "../admin/redirects.js";

/**
 * URL redirects (301s) are a bespoke widget, not the generic datagrid — a
 * redirect binds an OLD uri to an EXISTING target record (its "new URL" is that
 * record's current canonical URL). These wrap `/_widget/p_url_history/*` plus the
 * admin's own «Генератор редиректов».
 *
 * Everything here refuses duplicates and loops BEFORE writing: the platform
 * accepts both (see admin/redirects.ts for the measurements), and on a live store
 * a contradictory pair of 301s is invisible until traffic disappears.
 */

const HANDLER_DOC =
  "Handler dict, as seen on a live store: **4 = pages AND catalog categories**, **17 = products**, 172 = news, 349 = brands, 364 = filter presets, 425 = external-service files.";

/** Read the whole redirects screen once: every redirect + every possible target. */
async function loadState(
  client: any,
  store: string | undefined,
): Promise<{ rows: RedirectRow[]; targets: RedirectTargetRow[]; truncated: boolean }> {
  const groups = await client.admin.redirectList(store);
  const rows: RedirectRow[] = [];
  const targets: RedirectTargetRow[] = [];
  for (const t of groups as any[]) {
    targets.push({
      handler: t.handler,
      record: t.record,
      title: t.title,
      url: t.currentUrl,
      redirectCount: t.oldUris.length,
    });
    for (const o of t.oldUris) {
      rows.push({ historyId: String(o.id), from: o.uri, handler: t.handler, record: t.record, to: t.currentUrl, title: t.title });
    }
  }
  return { rows, targets, truncated: (groups as any).truncated === true };
}

/** Turn one caller-supplied item into a PlannedRedirect, or explain why it can't be. */
function planOne(
  targets: RedirectTargetRow[],
  item: { from: string; to?: string; handler?: number | string; record?: number | string },
): { plan?: PlannedRedirect; error?: string; note?: string } {
  const norm = normaliseUri(item.from);
  if (item.handler !== undefined && item.record !== undefined) {
    const t = targets.find((x) => String(x.handler) === String(item.handler) && String(x.record) === String(item.record));
    return {
      plan: {
        from: norm.uri,
        handler: String(item.handler),
        record: String(item.record),
        // A target that is not on the screen still works (the screen is paged by
        // record, and a brand-new record may sort anywhere) — we just cannot show
        // its destination, so loop checks fall back to "unknown".
        to: t?.url ?? "",
        title: t?.title,
      },
      note: norm.note,
    };
  }
  if (!item.to) {
    return { error: `"${item.from}": pass either \`to\` (the destination URL) or \`handler\`+\`record\`.` };
  }
  const res = resolveTargetByUrl(targets, item.to);
  if (!res.ok) return { error: `"${item.from}" → ${res.detail}` };
  return {
    plan: { from: norm.uri, handler: res.target.handler, record: res.target.record, to: res.target.url, title: res.target.title },
    note: norm.note,
  };
}

const redirectItem = z.object({
  from: z.string().min(1).describe('Old URI to redirect FROM, e.g. "/old-category" (a full https://… URL is reduced to its path).'),
  to: z.string().optional().describe('Destination URL, e.g. "/new-category/". Must be the CURRENT canonical URL of an existing record — it is resolved to that record. Alternative to handler+record.'),
  handler: z.union([z.number().int(), z.string()]).optional().describe("Target entity type, if you know it (see the handler dict)."),
  record: z.union([z.number().int(), z.string()]).optional().describe("Target record id, if you know it."),
});

export const adminRedirectTools: ToolSpec[] = [
  {
    name: "horoshop_admin_redirect_list",
    title: "List URL redirects",
    description:
      "List EVERY 301 redirect in the store, with the target record each one points to (`history_id` is the handle update/delete take). Reads the whole redirects grid, not just its first page — the screen renders 20 target rows at a time, and a plain page read used to report 16 of a store's 35 redirects. " +
      "Pass includeTargets:true to also get every record the screen lists WITH ITS CANONICAL URL (including records that have no redirect yet) — that table is what turns \"/old should go to /new\" into the handler+record a redirect actually needs. SEO/link-equity management.",
    inputSchema: {
      ...storeField,
      includeTargets: z
        .boolean()
        .optional()
        .describe("Default false. True: also return every target record (handler, record, title, canonical URL, how many redirects point at it) — the address book for creating new redirects."),
    },
    annotations: { readOnlyHint: true },
    handler: async (client, args) => {
      const { rows, targets, truncated } = await loadState(client, args.store);
      const chains = rows
        .map((r) => chainLength(rows, r.from, r.to))
        .filter((p) => p.length > 2)
        .map((p) => p.join(" → "));
      return {
        count: rows.length,
        targetCount: targets.length,
        ...(truncated ? { truncated: true, truncatedNote: "The grid walk hit its page cap — some redirects are NOT listed." } : {}),
        redirects: rows.map((r) => ({
          history_id: r.historyId,
          from: r.from,
          to: r.to,
          target: { handler: r.handler, record: r.record, title: r.title },
        })),
        ...(chains.length ? { chains, chainsNote: "These redirects land on a URL that redirects again — each extra hop costs link equity and a round trip. Repoint the first hop at the final destination." } : {}),
        ...(args.includeTargets === true
          ? {
              targets: targets.map((t) => ({ handler: t.handler, record: t.record, title: t.title, url: t.url, redirects: t.redirectCount })),
              targetsNote: "A redirect can only point at one of these records; its destination is that record's `url`. Pass that url as `to` and it resolves to handler+record for you.",
            }
          : {}),
      };
    },
  },
  {
    name: "horoshop_admin_redirect_create",
    title: "Create URL redirect",
    description:
      "Create a 301 redirect from an old URI to an existing record. Give it either `to` (the destination URL — resolved to the record that owns it) or `handler`+`record` directly. " +
      HANDLER_DOC +
      " The old URI is matched EXACTLY: a redirect stored as \"/foo\" does not fire for \"/foo/\" — create both if the old links used a trailing slash (or use horoshop_admin_redirect_generate_slashes for a whole section). " +
      "REFUSES DUPLICATES AND LOOPS BEFORE WRITING. Horoshop does not: creating a second redirect from a uri that already redirects answers OK and leaves two contradictory rows live, with no defined winner (measured). A loop closing back on itself is refused too. Pass force:true to override deliberately. DRY RUN BY DEFAULT — pass dryRun:false to create; returns the new history_id.",
    inputSchema: {
      ...storeField,
      uri: z.string().min(1).describe("Old URI to redirect FROM (e.g. \"/old-category\"). A full https://… URL is reduced to its path."),
      to: z.string().optional().describe("Destination URL — must be an existing record's canonical URL (see horoshop_admin_redirect_list includeTargets:true). Alternative to handler+record."),
      handler: z.union([z.number().int(), z.string()]).optional().describe("Target entity type (4=pages/categories, 17=products, 172=news, 349=brands…). Use with `record`."),
      record: z.union([z.number().int(), z.string()]).optional().describe("Target record id the redirect points TO."),
      force: z.boolean().optional().describe("Default false. True: create even if it duplicates an existing redirect or closes a loop (the conflict is still reported)."),
      dryRun: z.boolean().optional().describe("Default true: preview without creating. Set false to create."),
    },
    annotations: { readOnlyHint: false, idempotentHint: false },
    handler: async (client, args) => {
      const dryRun = args.dryRun !== false;
      const { rows, targets } = await loadState(client, args.store);
      const { plan, error, note } = planOne(targets, { from: args.uri, to: args.to, handler: args.handler, record: args.record });
      if (error || !plan) throw new Error(error ?? "Could not resolve the redirect target.");

      const [{ verdict }] = vetRedirects(rows, [plan]);
      const conflict = verdict.ok ? null : { problem: verdict.problem, detail: verdict.detail };

      if (dryRun) {
        return {
          dryRun: true,
          wouldCreate: { from: plan.from, to: plan.to || "(target not on the redirects screen — destination unknown)", targetHandler: plan.handler, targetRecord: plan.record, title: plan.title },
          ...(note ? { normalised: note } : {}),
          ...(conflict ? { blocked: conflict, note: "This will be REFUSED on a live run. Pass force:true to create it anyway." } : {}),
        };
      }
      if (conflict && args.force !== true) {
        throw new Error(`Refused (${conflict.problem}): ${conflict.detail} Pass force:true to create it anyway.`);
      }

      const res = await client.admin.redirectCreate(args.store, { handler: plan.handler, record: plan.record, uri: plan.from });
      const created = res.status === "OK" && res.historyId != null;
      // Verify against the store, not against the widget's own answer.
      const after = created ? await loadState(client, args.store) : null;
      const landed = after?.rows.find((r) => r.historyId === String(res.historyId));
      return {
        dryRun: false,
        created,
        historyId: res.historyId ?? null,
        status: res.status,
        message: res.message,
        ...(note ? { normalised: note } : {}),
        ...(conflict ? { forcedOver: conflict } : {}),
        verified: landed ? { from: landed.from, to: landed.to, target: `${landed.handler}:${landed.record}` } : null,
        note: created
          ? landed
            ? `Created and confirmed by re-reading the store: ${landed.from} → ${landed.to}.`
            : "The widget reported OK but the new row was not found on re-read — check horoshop_admin_redirect_list."
          : `NOT created — Horoshop answered ${res.status}${res.message ? `: ${res.message}` : ""}.`,
      };
    },
  },
  {
    name: "horoshop_admin_redirect_update",
    title: "Update an existing URL redirect",
    description:
      "Edit a redirect that already exists, addressed by its `history_id` (from horoshop_admin_redirect_list). Change the old URI with `from`, and/or the destination with `to` (or `handler`+`record`). " +
      "HOW THE TWO DIFFER, because the platform hides it: changing `from` is a real in-place edit (one widget call, the history_id survives). Changing the DESTINATION is not editable at all — `update` accepts handler/record and silently ignores them (measured: the row stayed on its old target while the call answered OK), so this tool performs the move as delete+create, which mints a NEW history_id and is reported as such. If the re-create fails the original is restored and the answer says so. " +
      "Duplicates and loops are refused before the write, same as create (`force:true` overrides). DRY RUN BY DEFAULT.",
    inputSchema: {
      ...storeField,
      id: z.union([z.number().int(), z.string()]).describe("history_id of the redirect to edit (from horoshop_admin_redirect_list)."),
      from: z.string().optional().describe("New OLD uri for this redirect (what visitors request). Omit to keep it."),
      to: z.string().optional().describe("New destination URL — resolved to the record that owns it. Omit to keep the current target. Triggers a delete+create (new history_id)."),
      handler: z.union([z.number().int(), z.string()]).optional().describe("New target entity type (use with `record`, instead of `to`)."),
      record: z.union([z.number().int(), z.string()]).optional().describe("New target record id (use with `handler`, instead of `to`)."),
      force: z.boolean().optional().describe("Default false. True: apply even if the result duplicates another redirect or closes a loop."),
      dryRun: z.boolean().optional().describe("Default true: preview without writing. Set false to apply."),
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
    handler: async (client, args) => {
      const dryRun = args.dryRun !== false;
      const { rows, targets } = await loadState(client, args.store);
      const current = rows.find((r) => r.historyId === String(args.id));
      if (!current) {
        throw new Error(
          `No redirect with history_id ${args.id}. horoshop_admin_redirect_list shows the ${rows.length} redirect(s) that exist — note that history_id is NOT the target record id.`,
        );
      }
      const retarget = args.to !== undefined || args.handler !== undefined || args.record !== undefined;
      if (args.from === undefined && !retarget) {
        throw new Error("Nothing to change — pass `from` (new old-uri) and/or `to` / `handler`+`record` (new destination).");
      }

      const { plan, error, note } = planOne(
        targets,
        retarget
          ? { from: args.from ?? current.from, to: args.to, handler: args.handler, record: args.record }
          : { from: args.from!, handler: current.handler, record: current.record },
      );
      if (error || !plan) throw new Error(error ?? "Could not resolve the new target.");

      // Vet against every OTHER redirect: the row being edited must not collide
      // with itself.
      const [{ verdict }] = vetRedirects(rows, [plan], { ignoreHistoryId: current.historyId });
      const conflict = verdict.ok ? null : { problem: verdict.problem, detail: verdict.detail };
      const mode = retarget && (plan.handler !== current.handler || plan.record !== current.record) ? "delete+create" : "in-place";

      if (dryRun) {
        return {
          dryRun: true,
          historyId: current.historyId,
          from: { current: current.from, new: plan.from, changed: plan.from !== current.from },
          to: { current: current.to, new: plan.to || "(unknown)", changed: `${plan.handler}:${plan.record}` !== `${current.handler}:${current.record}` },
          target: { current: `${current.handler}:${current.record}`, new: `${plan.handler}:${plan.record}` },
          mode,
          ...(mode === "delete+create"
            ? { modeNote: "Horoshop cannot retarget a redirect in place (update ignores handler/record), so this runs as DELETE + CREATE and the history_id WILL change. The old row is restored if the create fails." }
            : {}),
          ...(note ? { normalised: note } : {}),
          ...(conflict ? { blocked: conflict, note: "This will be REFUSED on a live run. Pass force:true to apply anyway." } : {}),
        };
      }
      if (conflict && args.force !== true) {
        throw new Error(`Refused (${conflict.problem}): ${conflict.detail} Pass force:true to apply anyway.`);
      }

      let newId = current.historyId;
      let restored: string | null = null;
      let failure: string | null = null;
      // WHY a `diag` block exists here. The in-place rename missed
      // roughly once every five runs of a redirect test and the answer could
      // not say WHERE it was lost: `saved:false` covers "the widget refused",
      // "the widget lied" and "the re-read was stale" alike, and all three look
      // identical from outside. Everything below is measurement, in the answer,
      // so ONE run classifies the event instead of a guessing game over thirty.
      const diag: Record<string, unknown> = { mode, before: { rows: rows.length, targets: targets.length } };
      if (mode === "in-place") {
        const res = await client.admin.redirectUpdate(args.store, { id: current.historyId, uri: plan.from });
        diag.write = {
          httpStatus: res.httpStatus,
          status: res.status ?? null,
          message: res.message ?? null,
          oldUri: res.oldUri ?? null,
          attempts: res.attempts ?? 1,
          missed: res.missed ?? 0,
          ...(res.status === "OK" ? {} : { raw: res.raw ?? null, finalUrl: res.finalUrl ?? null, redirected: res.redirected ?? null, contentType: res.contentType ?? null }),
        };
        if (res.status !== "OK") {
          failure =
            (res.missed ?? 0) > 0 && res.status === undefined
              ? `Horoshop answered its STOREFRONT page (HTTP ${res.httpStatus}, text/html) instead of the admin widget, ${res.missed} attempt(s) in a row — the admin route did not resolve, so NOTHING was written and nothing was refused. This is a platform-side flake (measured: 46% of calls during a burst, ~6% otherwise); the redirect is untouched, just call again.`
              : `Horoshop answered ${res.status}${res.message ? `: ${res.message}` : ""}${res.oldUri ? ` (kept "${res.oldUri}")` : ""}`;
        }
      } else {
        await client.admin.redirectDelete(args.store, current.historyId);
        const res = await client.admin.redirectCreate(args.store, { handler: plan.handler, record: plan.record, uri: plan.from });
        if (res.status === "OK" && res.historyId != null) {
          newId = String(res.historyId);
        } else {
          failure = `Re-create failed (${res.status}${res.message ? `: ${res.message}` : ""})`;
          const back = await client.admin.redirectCreate(args.store, { handler: current.handler, record: current.record, uri: current.from });
          restored = back.status === "OK" && back.historyId != null ? String(back.historyId) : null;
        }
      }

      const after = await loadState(client, args.store);
      const now = after.rows.find((r) => r.historyId === String(newId));
      const persisted = !failure && !!now && now.from === plan.from && `${now.handler}:${now.record}` === `${plan.handler}:${plan.record}`;
      diag.read1 = { rows: after.rows.length, targets: after.targets.length, found: !!now, from: now?.from ?? null };

      // Second, INDEPENDENT re-read — only when the first one disagrees, so the
      // happy path pays nothing. It is what separates "the store never took the
      // write" from "the store took it and the grid handed back a stale page".
      if (!persisted && !failure && mode === "in-place") {
        await new Promise((r) => setTimeout(r, 1200));
        const again = await loadState(client, args.store);
        const row2 = again.rows.find((r) => r.historyId === String(newId));
        diag.read2 = { afterMs: 1200, rows: again.rows.length, targets: again.targets.length, found: !!row2, from: row2?.from ?? null, matches: row2?.from === plan.from };
      }
      diag.defect = persisted
        ? null
        : failure
          ? "write-refused" // the widget itself said no — deterministic, not the flake
          : (diag.read2 as any)?.matches === true
            ? "stale-read" // the write landed; the verification read was behind
            : "write-lost"; // the widget answered OK and the value is not there
      return {
        dryRun: false,
        mode,
        diag,
        historyId: { before: current.historyId, after: newId, changed: newId !== current.historyId },
        saved: persisted,
        was: { from: current.from, to: current.to, target: `${current.handler}:${current.record}` },
        now: now ? { from: now.from, to: now.to, target: `${now.handler}:${now.record}` } : null,
        ...(note ? { normalised: note } : {}),
        ...(conflict ? { forcedOver: conflict } : {}),
        ...(failure ? { error: failure, rolledBack: restored ? `original restored as history_id ${restored}` : "ROLLBACK FAILED — the original redirect no longer exists, recreate it with horoshop_admin_redirect_create" } : {}),
        note: persisted
          ? "Applied and verified by re-reading the store."
          : failure ?? "The write was accepted but the re-read does not match — check horoshop_admin_redirect_list.",
      };
    },
  },
  {
    name: "horoshop_admin_redirect_bulk_create",
    title: "Create URL redirects in bulk (list or file)",
    description:
      "Create many 301 redirects in one call — the migration workhorse. Three ways in: `redirects` as a list of {from, to} pairs (or {from, handler, record}); `csvFile`, the path to a CSV/TSV redirect map with one `old,new` pair per line (tab, \";\" or \",\", header row skipped) — the format a client's redirect list actually arrives in; or `payloadFile`, a JSON file holding {\"redirects\":[…]}. The last two are how you import a 300-line map without pasting it into the conversation. " +
      "`to` is resolved to the record that owns that URL, so you can think in URLs; unresolvable destinations are reported per row instead of guessed. " +
      "DRY RUN BY DEFAULT and the dry run is the point: it reports exactly how many would be created, and which rows CONFLICT — a `from` that already redirects somewhere (Horoshop would happily add a contradictory second row), a duplicate inside the batch itself, a redirect onto its own target, or one that closes a loop with existing redirects. On a live run any conflict ABORTS the whole batch before a single write; pass skipConflicts:true to create the clean rows and skip the rest, or force:true to write everything anyway. Created rows are verified by re-reading the store.",
    inputSchema: {
      ...storeField,
      redirects: z.array(redirectItem).min(1).optional().describe("The redirects to create. Each needs `from` plus either `to` or handler+record."),
      csvFile: z
        .string()
        .optional()
        .describe(
          'ABSOLUTE path to a CSV/TSV redirect map: one "old,new" pair per line (delimiter tab, ";" or ","; a header row and #-comments are skipped). Same shape Horoshop\'s own «Импорт редиректов» expects — but routed through the duplicate/loop guards, which the platform\'s importer has none of.',
        ),
      payloadFile: payloadFileField("horoshop_admin_redirect_bulk_create"),
      skipConflicts: z.boolean().optional().describe("Default false (a conflict aborts the batch). True: create the non-conflicting rows and report the skipped ones."),
      force: z.boolean().optional().describe("Default false. True: create every row even where it duplicates an existing redirect or closes a loop."),
      dryRun: z.boolean().optional().describe("Default true: preview and validate without creating. Set false to create."),
    },
    annotations: { readOnlyHint: false, idempotentHint: false },
    handler: async (client, rawArgs) => {
      const schema = {
        ...storeField,
        redirects: z.array(redirectItem).min(1).optional(),
        csvFile: z.string().optional(),
        payloadFile: payloadFileField("horoshop_admin_redirect_bulk_create"),
        skipConflicts: z.boolean().optional(),
        force: z.boolean().optional(),
        dryRun: z.boolean().optional(),
      };
      const args = withPayloadFile(rawArgs, schema, "horoshop_admin_redirect_bulk_create");
      const items = [...((args.redirects ?? []) as Array<z.infer<typeof redirectItem>>)];
      let fileSkipped: string[] = [];
      if (args.csvFile) {
        if (!isAbsolute(args.csvFile)) throw new Error(`csvFile must be an ABSOLUTE path (got "${args.csvFile}").`);
        if (!existsSync(args.csvFile)) throw new Error(`csvFile not found: ${args.csvFile}`);
        const parsed = parseRedirectFile(readFileSync(args.csvFile, "utf8"));
        if (parsed.rows.length === 0) {
          throw new Error(
            `csvFile ${args.csvFile} yielded no usable rows. Expected one "old,new" pair per line.${parsed.skipped.length ? ` Skipped:\n- ${parsed.skipped.slice(0, 10).join("\n- ")}` : ""}`,
          );
        }
        items.push(...parsed.rows);
        fileSkipped = parsed.skipped;
      }
      if (items.length === 0) {
        throw new Error("Nothing to create — pass `redirects` (a list), `csvFile` (a CSV/TSV map) or `payloadFile` (a JSON file holding {\"redirects\":[…]}).");
      }
      const dryRun = args.dryRun !== false;
      const { rows, targets, truncated } = await loadState(client, args.store);
      if (truncated) {
        throw new Error(
          "The redirects grid could not be read in full, so the duplicate check would be blind to part of the store. Refusing to bulk-create. Re-run when the admin responds normally.",
        );
      }

      const plans: PlannedRedirect[] = [];
      const unresolved: string[] = [];
      const notes: string[] = [];
      for (const it of items) {
        const { plan, error, note } = planOne(targets, it);
        if (error || !plan) unresolved.push(error ?? `"${it.from}": could not resolve target.`);
        else plans.push(plan);
        if (note) notes.push(note);
      }

      const vetted = vetRedirects(rows, plans);
      const clean = vetted.filter((v) => v.verdict.ok).map((v) => v.plan);
      const conflicts = vetted
        .filter((v) => !v.verdict.ok)
        .map((v) => ({ from: v.plan.from, to: v.plan.to, problem: (v.verdict as any).problem, detail: (v.verdict as any).detail }));

      if (dryRun) {
        return {
          dryRun: true,
          submitted: items.length,
          wouldCreate: clean.length,
          conflicts: conflicts.length,
          unresolved: unresolved.length,
          ...(notes.length ? { normalised: notes } : {}),
          ...(fileSkipped.length ? { fileLinesSkipped: fileSkipped } : {}),
          plan: clean.map((p) => ({ from: p.from, to: p.to || "(destination unknown)", target: `${p.handler}:${p.record}`, title: p.title })),
          ...(conflicts.length ? { conflictRows: conflicts } : {}),
          ...(unresolved.length ? { unresolvedRows: unresolved } : {}),
          note:
            conflicts.length || unresolved.length
              ? `A live run ABORTS while ${conflicts.length + unresolved.length} row(s) are unusable. Fix them, or pass skipConflicts:true to create the ${clean.length} clean row(s) only.`
              : `All ${clean.length} row(s) are clean — no duplicates, no loops.`,
        };
      }

      if (unresolved.length && args.skipConflicts !== true) {
        throw new Error(`${unresolved.length} row(s) do not resolve to a real target, so nothing was written:\n- ${unresolved.join("\n- ")}\nFix them, or pass skipConflicts:true to create the rest.`);
      }
      const toWrite = args.force === true ? plans : clean;
      if (conflicts.length && args.force !== true && args.skipConflicts !== true) {
        throw new Error(
          `${conflicts.length} row(s) conflict, so NOTHING was written (a half-applied redirect map is worse than none):\n- ${conflicts
            .map((c) => `${c.from} — ${c.problem}: ${c.detail}`)
            .join("\n- ")}\nPass skipConflicts:true to create the ${clean.length} clean row(s), or force:true to write everything.`,
        );
      }
      if (toWrite.length === 0) {
        return { dryRun: false, created: 0, conflicts, unresolved, note: "Every row conflicted — nothing written." };
      }

      const results: Array<Record<string, unknown>> = [];
      for (const p of toWrite) {
        const res = await client.admin.redirectCreate(args.store, { handler: p.handler, record: p.record, uri: p.from });
        results.push({ from: p.from, to: p.to, target: `${p.handler}:${p.record}`, historyId: res.historyId ?? null, status: res.status, ...(res.message ? { message: res.message } : {}) });
      }

      // Verify against the store — the widget's OK is not proof.
      const after = await loadState(client, args.store);
      const byId = new Set(after.rows.map((r) => r.historyId));
      const verified = results.filter((r) => r.historyId != null && byId.has(String(r.historyId)));
      return {
        dryRun: false,
        submitted: items.length,
        created: verified.length,
        failed: results.length - verified.length,
        skipped: args.force === true ? 0 : conflicts.length + unresolved.length,
        ...(notes.length ? { normalised: notes } : {}),
        ...(fileSkipped.length ? { fileLinesSkipped: fileSkipped } : {}),
        results,
        ...(conflicts.length ? { conflictRows: conflicts } : {}),
        ...(unresolved.length ? { unresolvedRows: unresolved } : {}),
        totalAfter: after.rows.length,
        note:
          verified.length === results.length
            ? `Created ${verified.length} redirect(s), all confirmed by re-reading the store (${after.rows.length} redirects now).`
            : `${results.length - verified.length} row(s) did NOT appear on re-read — see \`results\` for the platform's answer.`,
      };
    },
  },
  {
    name: "horoshop_admin_redirect_generate_slashes",
    title: "Mass-generate trailing-slash redirects",
    description:
      "Run the admin's own «Генератор редиректов»: create slash/no-slash 301s for whole sections at once — the standard migration chore when a site changes its URL suffix. `type` 1 = links WITH a trailing slash redirect to links WITHOUT; 2 = links WITHOUT redirect to links WITH (the usual direction on Horoshop, whose canonical URLs carry the suffix). `handlers` picks the sections: 4 = site structure (pages & categories), 17 = catalog, 172 = news, 349 = brands, 364 = filter presets, 425 = external-service files. " +
      "⚠ THE GENERATOR IS NOT ADDITIVE-ONLY, and it tells you nothing — it answers `OK` with an empty body whatever it did. Measured on a live store: one run over handler 4 created 13 rows, of which 6 REPLACED existing redirects (same uri, brand-new history_id) and one had an EMPTY uri. So this tool diffs the full redirect set around the run and reports `added` / `reissued` (same redirect, new id) / `removed`, and refuses to guess. It also deletes the junk empty-uri rows the generator leaves behind unless you pass keepEmpty:true. " +
      "DRY RUN BY DEFAULT: the dry run cannot predict the platform's output, so it reports the current coverage per section (how many records already have a slash-variant redirect) and what the run would touch.",
    inputSchema: {
      ...storeField,
      handlers: z
        .array(z.union([z.number().int(), z.string()]))
        .min(1)
        .describe("Sections to generate for: 4 (pages+categories), 17 (catalog), 172 (news), 349 (brands), 364 (filter presets), 425 (external-service files)."),
      type: z
        .union([z.literal(1), z.literal(2)])
        .describe("1 = with-slash → without-slash. 2 = without-slash → with-slash (the usual direction for Horoshop canonical URLs)."),
      keepEmpty: z.boolean().optional().describe("Default false: empty-uri rows the generator creates are deleted afterwards (they are junk — a blank old-uri is not a redirect). True: leave them."),
      dryRun: z.boolean().optional().describe("Default true: report current coverage without generating. Set false to run the generator."),
    },
    annotations: { readOnlyHint: false, idempotentHint: false },
    handler: async (client, args) => {
      const dryRun = args.dryRun !== false;
      const handlers = (args.handlers as Array<number | string>).map(String);
      const before = await loadState(client, args.store);
      const scope = before.targets.filter((t) => handlers.includes(String(t.handler)));
      const coverage = handlers.map((h) => {
        const inSection = before.targets.filter((t) => String(t.handler) === h);
        const withRedirect = inSection.filter((t) => t.redirectCount > 0).length;
        return { handler: h, records: inSection.length, withRedirects: withRedirect, withoutRedirects: inSection.length - withRedirect };
      });

      if (dryRun) {
        return {
          dryRun: true,
          type: args.type,
          direction: args.type === 1 ? "with slash → without slash" : "without slash → with slash",
          handlers,
          coverage,
          redirectsNow: before.rows.length,
          recordsInScope: scope.length,
          note:
            "The platform's generator returns no report, so what it will create cannot be predicted — this is the CURRENT coverage. Run with dryRun:false and the answer will diff the redirect set around the run (added / reissued / removed). Note that it may REPLACE existing rows with new history_ids; nothing is lost, but saved ids go stale.",
        };
      }

      const res = await client.admin.redirectGenerate(args.store, { handlers, type: args.type as 1 | 2 });
      const after = await loadState(client, args.store);

      const key = (r: RedirectRow) => `${r.handler}:${r.record}|${r.from}`;
      const beforeKeys = new Map(before.rows.map((r) => [key(r), r]));
      const afterKeys = new Map(after.rows.map((r) => [key(r), r]));
      const added = after.rows.filter((r) => !beforeKeys.has(key(r)));
      const removed = before.rows.filter((r) => !afterKeys.has(key(r)));
      // Same redirect, new history_id — the generator's delete+recreate behaviour.
      const reissued = after.rows.filter((r) => {
        const was = beforeKeys.get(key(r));
        return was && was.historyId !== r.historyId;
      });

      // Empty-uri junk: the generator produced one on the test store. A blank old-uri
      // redirects nothing and the widget treats a blank value as "delete", so it
      // is cleaned up unless the caller insists.
      const empties = after.rows.filter((r) => r.from.trim() === "");
      const cleaned: string[] = [];
      if (args.keepEmpty !== true) {
        for (const e of empties) {
          const r = await client.admin.redirectDelete(args.store, e.historyId);
          if (r.status === "OK") cleaned.push(e.historyId);
        }
      }
      const final = cleaned.length ? await loadState(client, args.store) : after;

      return {
        dryRun: false,
        type: args.type,
        direction: args.type === 1 ? "with slash → without slash" : "without slash → with slash",
        handlers,
        platformStatus: res.status,
        redirects: { before: before.rows.length, after: final.rows.length },
        added: added.filter((r) => r.from.trim() !== "").map((r) => ({ history_id: r.historyId, from: r.from, to: r.to, target: `${r.handler}:${r.record}` })),
        reissued: reissued.map((r) => ({ from: r.from, to: r.to, history_id: r.historyId })),
        removed: removed.map((r) => ({ history_id: r.historyId, from: r.from, to: r.to })),
        ...(cleaned.length ? { emptyUriRowsDeleted: cleaned } : {}),
        ...(empties.length && args.keepEmpty === true ? { emptyUriRowsKept: empties.map((e) => e.historyId) } : {}),
        note:
          `Generator ran (${res.status ?? "?"}). ${added.length} row(s) appeared, ${reissued.length} existing redirect(s) were re-created with new history_ids, ${removed.length} disappeared` +
          (cleaned.length ? `, ${cleaned.length} empty-uri junk row(s) deleted` : "") +
          `. Verified by diffing the full redirect set before and after — the platform itself reports nothing.` +
          (reissued.length ? " Any history_id you had saved for those rows is now stale." : ""),
      };
    },
  },
  {
    name: "horoshop_admin_redirect_delete",
    title: "Delete URL redirect",
    description:
      "Delete one or more 301 redirects by history_id (from horoshop_admin_redirect_list). DRY RUN BY DEFAULT — the dry run shows what each id currently redirects, so you can see what you are about to switch off. Pass dryRun:false to delete; deletion is verified by re-reading the store. Ids that are already gone are listed in `notFound` and are not an error; when NONE of them are in the store the answer carries `alreadyGone:true`, so a repeat delete is a no-op success.",
    inputSchema: {
      ...storeField,
      id: z.union([z.number().int(), z.string()]).optional().describe("history_id of the redirect to delete."),
      ids: z.array(z.union([z.number().int(), z.string()])).optional().describe("Several history_ids to delete in one call."),
      dryRun: z.boolean().optional().describe("Default true: preview without deleting. Set false to delete."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    handler: async (client, args) => {
      const wanted = [...(args.id !== undefined ? [String(args.id)] : []), ...((args.ids ?? []) as Array<string | number>).map(String)];
      if (wanted.length === 0) throw new Error("Pass `id` (one history_id) or `ids` (several).");
      const dryRun = args.dryRun !== false;
      const { rows } = await loadState(client, args.store);
      const found = rows.filter((r) => wanted.includes(r.historyId));
      const notFound = wanted.filter((w) => !rows.some((r) => r.historyId === w));

      if (dryRun) {
        return {
          dryRun: true,
          wouldDelete: found.map((r) => ({ history_id: r.historyId, from: r.from, to: r.to, target: `${r.handler}:${r.record}` })),
          notFound,
          note: notFound.length ? "Ids not found are already gone (or are record ids, not history_ids)." : undefined,
        };
      }
      if (found.length === 0) {
        // Same explicit contract as the other delete tools: an id that is no
        // longer in the store is the state a delete was asking for, so it is a
        // success — flagged, not merely implied by an empty `deleted`.
        const after = await loadState(client, args.store);
        return {
          dryRun: false,
          deleted: [],
          failed: [],
          notFound,
          alreadyGone: true,
          totalAfter: after.rows.length,
          note: "None of the given history_ids are in the store — nothing to delete, and nothing was sent. This is the success shape of a repeat delete.",
        };
      }
      const results = [];
      for (const r of found) {
        const res = await client.admin.redirectDelete(args.store, r.historyId);
        results.push({ history_id: r.historyId, from: r.from, status: res.status });
      }
      const after = await loadState(client, args.store);
      const stillThere = found.filter((r) => after.rows.some((x) => x.historyId === r.historyId)).map((r) => r.historyId);
      return {
        dryRun: false,
        deleted: results.filter((r) => !stillThere.includes(r.history_id as string)),
        failed: stillThere,
        notFound,
        alreadyGone: false,
        totalAfter: after.rows.length,
        note: stillThere.length ? "Some redirects survived the delete — see `failed`." : "Deletion verified by re-reading the store.",
      };
    },
  },
];
