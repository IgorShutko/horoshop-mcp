import { z } from "zod";
import { storeField, type ToolSpec } from "../register.js";
import { INDEX_LANG, LANG_INDEX } from "../admin/form.js";

/**
 * Attribute-value dictionaries ("Справочники" / books, handler 207) — the value
 * lists behind product characteristics (materials, sizes, colours, units…).
 *
 * Two different jobs, two different mechanisms, and conflating them is what made
 * a multilingual store impossible to finish:
 *
 *  - CREATING a value: the documented catalog API does it as a side effect — a
 *    value comes into existence the moment a product uses it as a characteristic.
 *    That is `dictionary_add_value` (which therefore writes to a PRODUCT, not to
 *    the dictionary; see its description).
 *  - TRANSLATING an existing value: needs the dictionary editor itself. It was
 *    written off as "admin-panel only", so a ru storefront kept Ukrainian size and
 *    colour labels («2-х спальний», «Євро», «Білий») with no way out.
 *
 * The second one turned out to be perfectly reachable headless. The editor is an
 * AJAX popup, not a page: `js/lookup.php?load=loadBookValueForm` returns a form of
 * `names[title][<langIndex>]` inputs, and saving is TWO posts — `lookup.php?load=
 * saveBookValue` validates, then `savers/books.php` persists. Doing only the second
 * is what made earlier attempts look blocked. Verified end to end on the test store:
 * ru title changed, re-read, restored.
 */

/** Accept both spellings of the dictionary id: `dictionaries` returns it as `id`,
 *  the older tools called it `book`. Passing the one the other tool printed used
 *  to be a zod error for no reason. */
function bookIdOf(args: { book?: unknown; id?: unknown }): string {
  const raw = args.book ?? args.id;
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    throw new Error("Pass the dictionary id as `book` (or its alias `id`) — see horoshop_admin_dictionaries.");
  }
  return String(raw);
}

const bookField = {
  book: z
    .union([z.number().int(), z.string()])
    .optional()
    .describe("Dictionary (book) id — as returned by horoshop_admin_dictionaries. Alias: `id`."),
  id: z
    .union([z.number().int(), z.string()])
    .optional()
    .describe("Alias of `book` (horoshop_admin_dictionaries returns the field as `id`, so both are accepted)."),
};

const titlesShape = z
  .object({
    ru: z.string().optional(),
    ua: z.string().optional(),
    en: z.string().optional(),
    pl: z.string().optional(),
    ro: z.string().optional(),
  })
  .strict();

export const adminDictionaryTools: ToolSpec[] = [
  {
    name: "horoshop_admin_dictionaries",
    title: "List attribute dictionaries",
    description:
      "List the store's attribute-value dictionaries (Справочники / books) — id and name (e.g. Матеріал, Единицы измерения, Розмір футболки). Use the id with horoshop_admin_dictionary_values (as `book` or `id`, both accepted).",
    inputSchema: { ...storeField },
    annotations: { readOnlyHint: true },
    handler: async (client, args) => {
      const rows = await client.admin.listRecords(args.store, 207);
      return { count: rows.length, dictionaries: rows.map((r: any) => ({ id: r.id, name: r.label })) };
    },
  },
  {
    name: "horoshop_admin_dictionary_create",
    title: "Create a new attribute dictionary",
    description:
      "Create a NEW attribute dictionary (справочник / book) — the value list a product characteristic points at. This is the container, not its values: fill it afterwards with horoshop_admin_dictionary_value_set / _add_value. " +
      "The name is validated by the admin BEFORE anything is written (empty or colliding names are refused), and the created dictionary is confirmed by re-reading the dictionaries list, not by trusting the answer. " +
      "Reversible: horoshop_admin_dictionary_delete removes it again. DRY RUN BY DEFAULT.",
    inputSchema: {
      ...storeField,
      title: z.string().min(1).describe("Name of the new dictionary, e.g. «Тип тканини». Shown in the admin's Справочники list."),
      dryRun: z.boolean().optional().describe("Default true: validate the name without creating. Set false to create."),
    },
    annotations: { readOnlyHint: false, idempotentHint: false },
    handler: async (client, args) => {
      const before = await client.admin.listRecords(args.store, 207);
      const clash = before.find((r: any) => String(r.label ?? "").includes(args.title));
      if (args.dryRun !== false) {
        return {
          dryRun: true,
          wouldCreate: args.title,
          existing: before.length,
          ...(clash ? { warning: `A dictionary whose name already contains "${args.title}" exists (id ${clash.id}: ${clash.label}). The admin refuses exact duplicates.` } : {}),
          note: "Set dryRun:false to create. The name is validated by the admin first, so a bad name fails before any write.",
        };
      }
      const res = await client.admin.bookCreate(args.store, args.title);
      const after = await client.admin.listRecords(args.store, 207);
      const created = res.bookId ? after.find((r: any) => String(r.id) === res.bookId) : undefined;
      return {
        dryRun: false,
        bookId: res.bookId ?? null,
        saved: !!created,
        name: created?.label ?? null,
        dictionaries: { before: before.length, after: after.length },
        note: created
          ? `Created and confirmed by re-reading the dictionaries list: id ${res.bookId} — ${created.label}.`
          : `The route answered ${res.status ?? `HTTP ${res.httpStatus}`} but the new dictionary is not in the list — check horoshop_admin_dictionaries.`,
      };
    },
  },
  {
    name: "horoshop_admin_dictionary_rename",
    title: "Rename an attribute dictionary",
    description:
      "Rename an existing dictionary (справочник / book). Renames the CONTAINER only — its values keep their own titles (those are horoshop_admin_dictionary_value_set). " +
      "The platform's saver answers with a bare redirect and says nothing, so the new name is confirmed by re-reading the list. DRY RUN BY DEFAULT.",
    inputSchema: {
      ...storeField,
      ...bookField,
      title: z.string().min(1).describe("The new name."),
      dryRun: z.boolean().optional().describe("Default true: preview without writing. Set false to apply."),
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
    handler: async (client, args) => {
      const book = bookIdOf(args);
      const before = await client.admin.listRecords(args.store, 207);
      const row = before.find((r: any) => String(r.id) === book);
      if (!row) {
        throw new Error(`No dictionary with id ${book}. horoshop_admin_dictionaries lists the ${before.length} that exist.`);
      }
      if (args.dryRun !== false) {
        return { dryRun: true, book, current: row.label, new: args.title, note: "Set dryRun:false to apply." };
      }
      const res = await client.admin.bookRename(args.store, book, args.title);
      const after = await client.admin.listRecords(args.store, 207);
      const now = after.find((r: any) => String(r.id) === book);
      const saved = !!now && String(now.label ?? "").includes(args.title);
      return {
        dryRun: false,
        book,
        httpStatus: res.httpStatus,
        saved,
        was: row.label,
        now: now?.label ?? null,
        note: saved ? "Applied and verified by re-reading the dictionaries list." : "The saver accepted the post but the re-read does not show the new name — check horoshop_admin_dictionaries.",
      };
    },
  },
  {
    name: "horoshop_admin_dictionary_delete",
    title: "Delete an attribute dictionary",
    description:
      "Delete a whole dictionary (справочник / book) — the container AND every value in it. " +
      "WHY THIS IS A SEPARATE TOOL AND NOT horoshop_admin_record_delete: the generic deleter refuses handler 207 (it is a hub), yet the grid's own bulk-remove does work on it — measured on the test store after twelve other candidate routes did nothing. " +
      "DANGEROUS ON A LIVE STORE: a dictionary that product characteristics point at takes its values with it. Delete what you created, not what the store runs on. DRY RUN BY DEFAULT and `confirm` is required on top.",
    inputSchema: {
      ...storeField,
      ...bookField,
      confirm: z.boolean().optional().describe("Must be true together with dryRun:false. Deleting a dictionary cannot be undone."),
      dryRun: z.boolean().optional().describe("Default true: show what would go without deleting. Set false to delete."),
    },
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true },
    handler: async (client, args) => {
      const book = bookIdOf(args);
      const before = await client.admin.listRecords(args.store, 207);
      const row = before.find((r: any) => String(r.id) === book);
      if (!row) {
        return { deleted: false, book, note: `No dictionary with id ${book} — nothing to delete (already gone, or wrong id; horoshop_admin_dictionaries lists ${before.length}).` };
      }
      let values: unknown[] = [];
      try {
        values = await client.admin.listBookValues(args.store, book);
      } catch {
        values = [];
      }
      if (args.dryRun !== false) {
        return {
          dryRun: true,
          book,
          name: row.label,
          valuesThatWouldGo: values.length,
          note: "Set dryRun:false AND confirm:true to delete. Values inside the dictionary go with it.",
        };
      }
      if (args.confirm !== true) {
        throw new Error(`Refused: deleting dictionary ${book} ("${row.label}") would also remove its ${values.length} value(s) and cannot be undone. Pass confirm:true to proceed.`);
      }
      const res = await client.admin.deleteRecords(args.store, 207, [book]);
      const after = await client.admin.listRecords(args.store, 207);
      const gone = !after.find((r: any) => String(r.id) === book);
      return {
        dryRun: false,
        book,
        name: row.label,
        httpStatus: res.httpStatus,
        deleted: gone,
        valuesRemoved: gone ? values.length : 0,
        dictionaries: { before: before.length, after: after.length },
        note: gone ? "Deleted and confirmed by re-reading the dictionaries list." : "The grid accepted the call but the dictionary is still listed — check horoshop_admin_dictionaries.",
      };
    },
  },
  {
    name: "horoshop_admin_dictionary_values",
    title: "List dictionary values",
    description:
      "List the values of an attribute dictionary by id (from horoshop_admin_dictionaries) — value id + text. Read-only, headless. The id may be passed as `book` or as `id` (that tool returns it as `id`); both work. " +
      "The text shown here is the ADMIN's display language only. To see or change a value's other languages use horoshop_admin_dictionary_value_set (dryRun) — that is where the ru/ua split of «Євро» or «Білий» lives.",
    inputSchema: {
      ...storeField,
      ...bookField,
    },
    annotations: { readOnlyHint: true },
    handler: async (client, args) => {
      const book = bookIdOf(args);
      const values = await client.admin.listBookValues(args.store, book);
      return {
        book,
        count: values.length,
        values,
        deletableNote:
          "`deletable` is the admin's own answer, read off each row's trash icon: false means products still use that value (the panel renders the control disabled), so it cannot be removed until they stop referencing it. Delete a free one with horoshop_admin_dictionary_value_delete.",
      };
    },
  },
  {
    name: "horoshop_admin_dictionary_value_delete",
    title: "Delete a dictionary value",
    description:
      "Delete ONE value from an attribute dictionary — the tool for clearing a typo or a test value out of Матеріал / Розмір / Колір. Identify it by dictionary (`book`/`id`) + `valueId` from horoshop_admin_dictionary_values. " +
      "IN-USE VALUES ARE REFUSED, not force-deleted: the admin renders no trash icon for a value products still carry (`deletable:false` in the listing), and this tool honours that instead of overriding it — the fix there is to change those products' characteristic first. " +
      "DRY RUN BY DEFAULT — but note the order of checks: the in-use guard runs BEFORE the preview, so a dry run on a value products still carry ERRORS instead of answering \"deletable:false\". Asking \"can I delete this?\" safely means reading `deletable` from horoshop_admin_dictionary_values first. A dry run that returns normally is therefore always deletable:true. Pass dryRun:false to remove it, after which the dictionary is re-read and the answer confirms it is gone. Deletion is permanent. " +
      "A VALUE THAT IS ALREADY GONE IS NOT AN ERROR: it answers `{deleted:false, alreadyGone:true}` and sends nothing, so a repeat run or an idempotent cleanup can call this twice. That is deliberately NOT the same as the in-use refusal above, which still throws — \"nothing left to do\" and \"not allowed to do it\" are opposite outcomes and must never share a shape. " +
      "Mechanism (reverse-engineered): the books screen is not a datagrid — its trash icon is a GET to savers/books.php?id=<value>&delvalue=<book>.",
    inputSchema: {
      ...storeField,
      ...bookField,
      valueId: z
        .union([z.number().int(), z.string()])
        .describe("Value id inside that dictionary (from horoshop_admin_dictionary_values)."),
      dryRun: z.boolean().optional().describe("Default true: preview without deleting. Set false to delete."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    handler: async (client, args) => {
      const book = bookIdOf(args);
      const valueId = String(args.valueId);
      const before = await client.admin.listBookValues(args.store, book);
      const row = before.find((v: any) => String(v.id) === valueId);
      if (!row) {
        // ALREADY GONE IS A SUCCESS. Same contract as horoshop_admin_order_delete
        // and horoshop_admin_record_delete: a delete whose target is missing has
        // reached the state it was asked for. `deleted:false` + `alreadyGone:true`
        // keeps "I removed it" and "there was nothing to remove" apart, which a
        // bare `{ok:true}` would not — and which an exception made impossible to
        // express at all without matching on the message text.
        return {
          book,
          valueId,
          dryRun: args.dryRun !== false,
          deleted: false,
          alreadyGone: true,
          remaining: before.length,
          note:
            `Dictionary ${book} has no value ${valueId} — nothing to delete, and nothing was sent. ` +
            `This is the success shape of a repeat delete. Existing values: ${before.map((v: any) => `${v.id}=${v.value}`).join(", ") || "(none)"}.`,
        };
      }
      if (!row.deletable) {
        throw new Error(
          `Value ${valueId} «${row.value}» is IN USE: the admin renders its delete control disabled because products still carry it, so it cannot be removed. Re-assign those products' characteristic first (horoshop_catalog_import), then delete it.`,
        );
      }
      if (args.dryRun !== false) {
        return {
          book,
          valueId,
          value: row.value,
          deletable: true,
          dryRun: true,
          note: "Set dryRun:false to delete. Deletion is permanent — a value in use would have been refused above.",
        };
      }
      const res = await client.admin.deleteBookValue(args.store, book, valueId);
      const after = await client.admin.listBookValues(args.store, book);
      const gone = !after.some((v: any) => String(v.id) === valueId);
      return {
        book,
        valueId,
        value: row.value,
        dryRun: false,
        httpStatus: res.httpStatus,
        deleted: gone,
        remaining: after.length,
        note: gone
          ? `Deleted «${row.value}» — the dictionary now holds ${after.length} value(s), verified by re-reading.`
          : `The delete was submitted (HTTP ${res.httpStatus}) but «${row.value}» is still in the dictionary — it was not removed.`,
      };
    },
  },
  {
    name: "horoshop_admin_dictionary_value_set",
    title: "Translate / rename a dictionary value",
    description:
      "Set an existing dictionary value's text PER LANGUAGE — the tool that finishes a multilingual storefront. Size and colour labels («2-х спальний», «Євро», «Сімейний», «Білий»…) come from these dictionaries, so until they are translated a ru version keeps showing the first language's words no matter how well the catalog itself is translated. " +
      "Identify the value by dictionary (`book`/`id`) + `valueId` (from horoshop_admin_dictionary_values), and pass `titles` as {ru, ua, en, pl, ro} — only the languages you list change, the rest are re-sent exactly as stored (every language must stay non-empty, which the admin enforces). " +
      "A LANGUAGE THIS STORE'S EDITOR DOES NOT RENDER IS SKIPPED, NOT WRITTEN — and the call still succeeds. It shows up in `skipped`, and if every language you asked for was skipped the answer is the \"nothing to change\" shape with NO `saved` key, whose note covers two opposite cases at once (\"already match, or none of them apply\"). Judge the result by `changes[].persisted` and `skipped`, never by the absence of an error. " +
      "DRY RUN BY DEFAULT: it reads the value's current per-language titles and shows the before/after — the only way to see the per-language text of ANY value, including ones no product uses. (For a value products already carry, horoshop_catalog_export shows the same {ua,ru} split inside its characteristic refs.) After a real save it re-reads and verifies. " +
      "Mechanism (reverse-engineered, not documented): the admin's own popup editor — lookup.php loadBookValueForm to read, then saveBookValue to validate and savers/books.php to persist. Renaming is not admin-panel-only, contrary to what horoshop_admin_dictionary_add_value used to claim.",
    inputSchema: {
      ...storeField,
      ...bookField,
      valueId: z
        .union([z.number().int(), z.string()])
        .describe("Value id inside that dictionary (from horoshop_admin_dictionary_values)."),
      titles: titlesShape.describe(
        "New text per language, e.g. {\"ru\":\"Евро\",\"ua\":\"Євро\"}. Languages you omit keep their stored text.",
      ),
      dryRun: z
        .boolean()
        .optional()
        .describe("Default true: show the value's current per-language titles and the planned change without saving. Set false to persist."),
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
    handler: async (client, args) => {
      const book = bookIdOf(args);
      const valueId = String(args.valueId);
      const dryRun = args.dryRun !== false;

      const before = await client.admin.bookValueGet(args.store, book, valueId);
      if (!before.found) {
        throw new Error(
          `Dictionary value ${valueId} was not found in book ${book} (the admin's editor returned no title fields). Check both ids with horoshop_admin_dictionaries / horoshop_admin_dictionary_values.`,
        );
      }
      // The form only renders the languages this store actually has; asking for a
      // language it does not render would be written nowhere and reported as saved.
      const renderedIdx = Object.keys(before.titles);
      const readable = (m: Record<string, string>) =>
        Object.fromEntries(Object.entries(m).map(([idx, v]) => [INDEX_LANG[Number(idx)] ?? idx, v]));

      const merged: Record<string, string> = { ...before.titles };
      const planned: Array<{ lang: string; from: string; to: string }> = [];
      const skipped: Array<{ lang: string; reason: string }> = [];
      for (const [code, text] of Object.entries(args.titles as Record<string, string>)) {
        const idx = String(LANG_INDEX[code] ?? "");
        if (!idx || !renderedIdx.includes(idx)) {
          skipped.push({
            lang: code,
            reason: `this store's dictionary editor does not render ${code} (it renders ${renderedIdx
              .map((i) => INDEX_LANG[Number(i)] ?? i)
              .join(", ")}) — the text would go nowhere`,
          });
          continue;
        }
        if (before.titles[idx] === text) continue;
        merged[idx] = text;
        planned.push({ lang: code, from: before.titles[idx], to: text });
      }

      if (planned.length === 0) {
        return {
          store: args.store ?? null,
          book,
          valueId,
          dryRun,
          current: readable(before.titles),
          changes: [],
          skipped,
          note: "Nothing to change (the given titles already match, or none of them apply to this store's languages).",
        };
      }
      if (dryRun) {
        return {
          store: args.store ?? null,
          book,
          valueId,
          dryRun: true,
          current: readable(before.titles),
          willChange: planned,
          skipped,
          note: "Set dryRun:false to persist. Every language is re-sent, so untouched ones keep their stored text.",
        };
      }

      const res = await client.admin.bookValueSave(args.store, book, valueId, merged);
      const after = await client.admin.bookValueGet(args.store, book, valueId);
      const changes = planned.map((p) => {
        const now = after.titles[String(LANG_INDEX[p.lang])] ?? "";
        return { ...p, now, persisted: now === p.to };
      });
      const ok = changes.every((c) => c.persisted);
      return {
        store: args.store ?? null,
        book,
        valueId,
        dryRun: false,
        saved: ok,
        validated: res.validated,
        httpStatus: res.httpStatus,
        before: readable(before.titles),
        after: readable(after.titles),
        changes,
        skipped,
        note: ok
          ? "Saved and verified by re-reading the value's editor. Storefront labels are cached — allow a cache cycle before checking the live page."
          : "Some languages did NOT persist — re-read with dryRun and check the admin's validation.",
      };
    },
  },
  {
    name: "horoshop_admin_dictionary_add_value",
    title: "Create a dictionary value (via a product's characteristic)",
    description:
      "CREATE a new value in an attribute dictionary. Read the mechanism before using it: this tool writes to a PRODUCT, not to the dictionary. Horoshop auto-creates a dictionary value the moment a product carries it as a characteristic, and that is the reliable headless way to add one — so `article` is a product that will actually receive the value, and the value then exists in the shared dictionary for every other product to reuse. " +
      "It does NOT edit a dictionary: it cannot rename, translate or delete an existing value. For translating/renaming use horoshop_admin_dictionary_value_set. " +
      "A TYPO IS NOT A ONE-STEP UNDO. Because the value is created BY PUTTING IT ON A PRODUCT, it is in use from the moment it exists — and horoshop_admin_dictionary_value_delete refuses in-use values, exactly like the admin does. Cleaning up a mistyped value is therefore two steps: first change that product's characteristic (horoshop_catalog_import) so nothing carries the value, then delete it. Until you do, the typo sits in a dictionary every other product in the store picks from. Check the spelling in the dry run. " +
      "`characteristic` is the characteristic's API field name (from horoshop_catalog_export, e.g. \"materal\"); `value` is the new text. IMPORTANT: the characteristic must exist in THAT product's category template — Horoshop silently drops an unknown characteristic and still answers \"Товар обновлен\", so pick an article whose export already lists the field. This tool re-reads the product afterwards and reports saved:false if the value did not land. DRY RUN BY DEFAULT.",
    inputSchema: {
      ...storeField,
      characteristic: z.string().describe("Characteristic API field name (e.g. \"materal\") — see horoshop_catalog_export."),
      value: z.string().describe("New dictionary value text to add."),
      article: z.string().describe("Article of a product that will carry the characteristic (the value is created in the shared dictionary as a side effect)."),
      dryRun: z.boolean().optional().describe("Default true: preview without importing. Set false to apply."),
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
    handler: async (client, args) => {
      const dryRun = args.dryRun !== false;
      const product = { article: args.article, characteristics: { [args.characteristic]: args.value } };
      if (dryRun) {
        return {
          dryRun: true,
          wouldImport: product,
          note: `Set dryRun:false to create the value via catalog import. This WRITES the characteristic onto product ${args.article} — that is the mechanism, not a side effect to ignore.`,
        };
      }
      const body: any = await client.call(args.store, "catalog/import", { products: [product] }, "POST");
      const log = body?.response?.log ?? body?.response ?? body;

      // "Товар обновлен" is NOT proof: Horoshop drops a characteristic that the
      // product's category template does not define, and still reports success.
      // Re-read the product and check the value actually landed.
      const after: any = await client.call(
        args.store,
        "catalog/export",
        { expr: { article: args.article }, includedParams: ["article", "characteristics", args.characteristic] },
        "POST",
      );
      const p = after?.response?.products?.[0];
      const slot = p?.characteristics?.[args.characteristic] ?? p?.[args.characteristic];
      // A characteristic reads back in three shapes: a plain string, a single
      // {id,value:{ua,…}} ref, or an ARRAY of refs when the field allows several
      // values. Only handling the middle one made this tool under-report a write
      // that had in fact landed.
      const texts = (Array.isArray(slot) ? slot : [slot])
        .map((s: any) => (s && typeof s === "object" ? (s.value?.ua ?? s.value) : s))
        .filter((s: any) => typeof s === "string");
      const text = texts.length === 1 ? texts[0] : texts.length ? texts.join(" | ") : null;
      const applied = texts.some((s: string) => s.trim() === args.value.trim());

      return {
        dryRun: false,
        saved: applied,
        imported: body?.status ?? "?",
        log,
        characteristicNow: text ?? null,
        note: applied
          ? "Value created and verified on the product — it now exists in the shared dictionary for reuse. To give it text in other languages use horoshop_admin_dictionary_value_set."
          : `Not written. The API reported success but "${args.characteristic}" did not land on ${args.article} — that characteristic is almost certainly not part of this product's category template (Horoshop drops unknown characteristics silently). Export the article first and use a field name it already returns.`,
      };
    },
  },
];
