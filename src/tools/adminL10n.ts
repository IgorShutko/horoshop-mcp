import { z } from "zod";
import { storeField, type ToolSpec } from "../register.js";
import { INDEX_LANG, fieldValue } from "../admin/form.js";
import {
  PLACEHOLDER_GUARD_DOC,
  allowPlaceholderLossField,
  assertPlaceholdersKept,
  placeholderOverrideNote,
  placeholderPreviewNote,
  scanPlaceholderLoss,
} from "../admin/placeholders.js";
import type { EditTarget } from "../admin/session.js";

/**
 * «Перевод интерфейса» — the l10n table (handler 340), the layer that decides what
 * the STOREFRONT says in each language once the catalog itself is translated.
 *
 * Why this exists. After a full ru translation
 * of one store the shop still showed Ukrainian theme strings — «Оцінка 4.0
 * (125 відгуків)», «Ви економите 600 грн» — and the characteristic
 * heading «Розмір постільної білизни». They live here, and here was unreachable:
 * `admin_list entity=interface_translation` answered "Network error … fetch
 * failed" every time, because the grid holds 4000+ rows and the lister walked all
 * of them (and `perPage:20` made it worse — a smaller window is MORE pages, and
 * one dropped connection out of 208 kills the call).
 *
 * The admin never walks it either: each column header carries a server-side
 * substring filter. So these tools search instead of listing, and a lookup costs
 * one request instead of two hundred.
 *
 * The row model, verified live: one record per (key, language) pair —
 * `names[key]` (the source string, the SAME key across all languages),
 * `names[language]` (a select: 1=ru, 3=ua, 4=en, 5=pl, 6=ro) and `names[value]`
 * (the translation). Editing is an ordinary edit.php/save.php form, so the write
 * is a normal read-modify-write with none of the h_news surprises — `names[language]`
 * is a real select that renders its stored option as `selected`.
 *
 * Answered along the way: a characteristic's LABEL is translated here too.
 * On a live store the key «Матеріал» has rows ua→«Матеріал», ru→«Материал»,
 * en→«Material». The template editor (`params/ajax.php action=saveParam`) has a
 * single, language-less `param[0][title]` — there is no per-language title there —
 * so this table, not the template, is where a characteristic heading gets its
 * Russian.
 */

const L10N_HANDLER = 340;
const L10N_TABLE = "l10n";

/** Column positions in the l10n grid: filterable text columns are [key, value]. */
const COL_KEY = "input:0";
const COL_VALUE = "input:1";

const langArg = z
  .enum(["ru", "ua", "en", "pl", "ro"])
  .describe("Language code (ru/ua/en/pl/ro).");

function l10nTarget(id: string | number): EditTarget {
  return { id, handler: L10N_HANDLER, handlertable: L10N_TABLE };
}

/** A grid row of the l10n table → {id, key, lang, value}. */
function shapeRow(r: { id: string; cells: string[] }) {
  return { id: r.id, key: r.cells[0] ?? "", lang: r.cells[1] ?? "", value: r.cells[2] ?? "" };
}

export const adminL10nTools: ToolSpec[] = [
  {
    name: "horoshop_admin_interface_translation_get",
    title: "Find interface translation strings",
    description:
      "Search the store's «Перевод интерфейса» table (l10n, handler 340) — the THEME strings the storefront renders around your content: «Чесна ціна», «Ви економите», «Оцінка», «відгуків», button and label text, and the headings of product characteristics. This is where a shop that is fully translated in the catalog still shows the first language. " +
      "One record per (key, language) pair: `key` is the source string and is the same across languages, `value` is that language's text. Search by key (default) or by value; results come back with the record id you feed to horoshop_admin_interface_translation_set. " +
      "SEARCHING THE WRONG COLUMN LOOKS LIKE \"THE STRING DOES NOT EXIST\". `searchIn` defaults to `key`, and the key is always the BASE language's wording — so hunting for the Ukrainian text on a store whose base language is Russian (or the reverse) returns zero rows for a string that is right there in the table. Nothing is broken; you searched the wrong column. If a search comes back empty, run it again with searchIn:\"value\". " +
      "Server-side substring search — do NOT try to list this table, it has thousands of rows and walking it is what used to fail with \"Network error … fetch failed\". Searching an empty query is refused for the same reason. COST: a narrow match is 3 grid requests (reload, filter, clear); a broad substring pages through the matches up to `maxRows` (default 500) and can be dozens. Still far cheaper than listing the table — just keep the substring specific.",
    inputSchema: {
      ...storeField,
      search: z
        .string()
        .min(1)
        .describe("Substring to look for, e.g. \"Чесна ціна\" or \"Матеріал\". Case-insensitive substring match, server-side."),
      searchIn: z
        .enum(["key", "value"])
        .optional()
        .describe("Which column to match: \"key\" (the source string, default) or \"value\" (the translated text)."),
      lang: langArg.optional().describe("Return only this language's rows. Omit for every language of each match."),
      maxRows: z.number().int().optional().describe("Cap on rows collected (default 500)."),
    },
    annotations: { readOnlyHint: true },
    handler: async (client, args) => {
      const res = await client.admin.searchRecords(args.store, L10N_HANDLER, {
        query: args.search,
        column: args.searchIn === "value" ? COL_VALUE : COL_KEY,
        maxRows: args.maxRows,
      });
      let rows = res.rows.map(shapeRow);
      if (args.lang) rows = rows.filter((r) => r.lang === args.lang);
      return {
        store: args.store ?? null,
        search: args.search,
        searchedIn: args.searchIn ?? "key",
        searchedColumn: res.column ? { param: res.column.param, label: res.column.label } : null,
        count: rows.length,
        totalMatches: res.total,
        ...(res.truncated ? { truncated: true } : {}),
        rows,
        note: rows.length
          ? "Pass a row's `id` to horoshop_admin_interface_translation_set to change its text."
          : "No match. The key is the SOURCE string exactly as the theme defines it (usually in the store's first language) — try a shorter substring, or searchIn:\"value\".",
      };
    },
  },
  {
    name: "horoshop_admin_interface_translation_set",
    title: "Set an interface translation string",
    description:
      "Set one interface-translation string (l10n, handler 340) — the storefront theme text for a given key and language. Target it either by `id` (from horoshop_admin_interface_translation_get) or by `key` + `lang`, which is resolved by exact-key search and refuses to guess if it is ambiguous. " +
      "Read-modify-write on the record's own edit form: only `names[value]` changes, the key and language are left as stored. Verifies by re-reading the record. DRY RUN BY DEFAULT — pass dryRun:false to persist. " +
      "This is also how a CHARACTERISTIC HEADING gets translated (e.g. «Розмір постільної білизни» → Russian): the template editor has no per-language title field, the label is translated here. " +
      PLACEHOLDER_GUARD_DOC,
    inputSchema: {
      ...storeField,
      id: z
        .union([z.number().int(), z.string()])
        .optional()
        .describe("Record id from horoshop_admin_interface_translation_get. Either this, or key+lang."),
      key: z.string().optional().describe("Source string (exact key) — used with `lang` when you have no id."),
      lang: langArg.optional().describe("Language of the row to change — required with `key`."),
      value: z.string().describe("New translated text for that key + language."),
      allowPlaceholderLoss: allowPlaceholderLossField,
      dryRun: z.boolean().optional().describe("Default true: preview the change without saving. Set false to persist."),
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
    handler: async (client, args) => {
      const dryRun = args.dryRun !== false;

      // Resolve the target row.
      let id = args.id != null ? String(args.id) : null;
      let resolvedFrom: unknown = null;
      if (!id) {
        if (!args.key || !args.lang) {
          throw new Error("Pass `id`, or both `key` and `lang`, to identify which translation row to change.");
        }
        const res = await client.admin.searchRecords(args.store, L10N_HANDLER, {
          query: args.key,
          column: COL_KEY,
        });
        const rows = res.rows.map(shapeRow);
        const exact = rows.filter((r) => r.key === args.key && r.lang === args.lang);
        if (exact.length === 0) {
          const keys = [...new Set(rows.map((r) => r.key))].slice(0, 10);
          throw new Error(
            `No l10n row with key "${args.key}" in ${args.lang}. ${
              keys.length
                ? `Substring matches on other keys: ${keys.join(", ")}. The key is the SOURCE string exactly as the theme defines it.`
                : "Nothing matched that substring at all."
            }`,
          );
        }
        if (exact.length > 1) {
          throw new Error(
            `Ambiguous: ${exact.length} rows carry key "${args.key}" in ${args.lang} (ids ${exact
              .map((r) => r.id)
              .join(", ")}). Pass the id you mean.`,
          );
        }
        id = exact[0].id;
        resolvedFrom = { key: args.key, lang: args.lang, matchedId: id };
      }

      const form = await client.admin.getEditForm(args.store, l10nTarget(id));
      if (!form.fieldNames.has("names[value]") || !form.fieldNames.has("names[key]")) {
        throw new Error(
          `Record ${id} is not an interface-translation row (its form has no names[key]/names[value]). Check the id with horoshop_admin_interface_translation_get.`,
        );
      }
      const key = fieldValue(form, "names[key]");
      const langIdx = form.selects["names[language]"]?.value ?? "";
      const lang = INDEX_LANG[Number(langIdx)] ?? langIdx;
      const from = fieldValue(form, "names[value]");

      if (args.lang && lang && lang !== args.lang) {
        throw new Error(
          `Record ${id} is the ${lang} row of key "${key}", not ${args.lang}. Re-resolve with horoshop_admin_interface_translation_get.`,
        );
      }
      if (from === args.value) {
        return { store: args.store ?? null, id, key, lang, dryRun, changed: false, value: from, note: "Already this value — nothing to write." };
      }
      // TEMPLATE TOKENS: a theme string is the densest place for them («Ви
      // економите {PRICE}») — replacing one with a constant freezes the number on
      // every page that renders it. See admin/placeholders.ts.
      const placeholderWarnings = scanPlaceholderLoss([{ field: "names[value]", from, to: args.value }]);
      if (dryRun) {
        return {
          store: args.store ?? null,
          id,
          key,
          lang,
          dryRun: true,
          ...(resolvedFrom ? { resolvedFrom } : {}),
          ...(placeholderWarnings.length
            ? { placeholderWarnings, placeholderNote: placeholderPreviewNote(placeholderWarnings) }
            : {}),
          willChange: { field: "names[value]", from, to: args.value },
          note: "Set dryRun:false to persist. Only names[value] is written; key and language stay as stored.",
        };
      }
      assertPlaceholdersKept(placeholderWarnings, args.allowPlaceholderLoss === true);

      const res = await client.admin.save(args.store, form, { "names[value]": args.value });
      const after = await client.admin.getEditForm(args.store, l10nTarget(id));
      const now = fieldValue(after, "names[value]");
      const langAfter = INDEX_LANG[Number(after.selects["names[language]"]?.value ?? "")] ?? lang;
      return {
        store: args.store ?? null,
        id,
        key,
        lang,
        dryRun: false,
        saved: now === args.value,
        httpStatus: res.httpStatus,
        ...(resolvedFrom ? { resolvedFrom } : {}),
        ...(placeholderWarnings.length
          ? { placeholderLossAllowed: placeholderWarnings, placeholderNote: placeholderOverrideNote(placeholderWarnings) }
          : {}),
        change: { field: "names[value]", from, to: args.value, now },
        languagePreserved: langAfter === lang,
        note:
          now === args.value
            ? "Saved and verified by re-reading the record. Storefront text is cached — allow a few minutes / a cache reset before checking the live page."
            : "The value did NOT persist — re-read the record and check for admin validation.",
      };
    },
  },
];
