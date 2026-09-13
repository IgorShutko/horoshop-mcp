import { z } from "zod";
import { storeField, type ToolSpec } from "../register.js";
import { INDEX_LANG, LANG_INDEX, fieldValue, type ParsedForm } from "../admin/form.js";
import { languageStates } from "../admin/languageState.js";
import { payloadFileField, withPayloadFile } from "../admin/payloadFile.js";
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
import type { EditTarget } from "../admin/session.js";

/** handler/handlertable for the site-pages tree (pages, categories, blog, reviews). */
const PAGES_HANDLER = 4;
const PAGES_TABLE = "pages";

/** Logical SEO field → the form field name template, per language index. */
const SEO_FIELD_TEMPLATES: Record<string, (l: number) => string> = {
  title: (l) => `names[i18n][${l}][title]`,
  seo_title: (l) => `names[i18n][${l}][seo_title]`,
  seo_keywords: (l) => `names[i18n][${l}][seo_keywords]`,
  seo_description: (l) => `names[i18n][${l}][seo_description]`,
  h1: (l) => `names[i18n][${l}][h1_title]`,
};

/**
 * The page body lives in a different field on a plain page vs a catalog
 * category vs a category with a custom template — resolve by which one the form
 * actually rendered rather than guessing from the entity type.
 */
function textFieldName(form: ParsedForm, l: number): string | null {
  for (const candidate of [
    `extra[i18n][${l}][text]`,
    `extra[i18n][${l}][seo_text]`,
    `extra_parent[i18n][${l}][seo_text]`,
  ]) {
    if (form.fieldNames.has(candidate)) return candidate;
  }
  return null;
}

function resolveFieldName(form: ParsedForm, logical: string, l: number): string | null {
  if (logical === "text") return textFieldName(form, l);
  const tpl = SEO_FIELD_TEMPLATES[logical];
  const name = tpl ? tpl(l) : null;
  return name && form.fieldNames.has(name) ? name : null;
}

function pageTarget(id: string | number, parent?: number): EditTarget {
  const extra: Record<string, string | number> = {};
  if (parent !== undefined) extra.parent = parent;
  return { id, handler: PAGES_HANDLER, handlertable: PAGES_TABLE, extra, flags: ["showPages"] };
}

/** Shape a parsed page/category form into a readable per-language view. */
function describePage(form: ParsedForm & { url: string }) {
  const langs: Record<string, Record<string, string>> = {};
  for (const [idxStr, code] of Object.entries(INDEX_LANG)) {
    const l = Number(idxStr);
    const entry: Record<string, string> = {};
    for (const logical of Object.keys(SEO_FIELD_TEMPLATES)) {
      const name = resolveFieldName(form, logical, l);
      if (name) entry[logical] = fieldValue(form, name);
    }
    const tn = textFieldName(form, l);
    if (tn) entry.text = fieldValue(form, tn);
    if (Object.keys(entry).length) langs[code] = entry;
  }
  const template = form.selects["names[handler]"];
  return {
    id: form.hidden.id ?? null,
    extra_handler: form.hidden.extra_handler ?? null,
    kind: textFieldName(form, LANG_INDEX.ua)?.includes("seo_text") ? "category" : "page",
    slug: fieldValue(form, "names[name][slug]"),
    parent: form.selects["names[parent]"]?.value ?? null,
    template: template ? { id: template.value, label: template.options.find((o) => o.value === template.value)?.label ?? null } : null,
    languages: langs,
    templateOptions: template?.options ?? [],
  };
}

const seoPatchSchema = z
  .object({
    title: z.string().optional(),
    seo_title: z.string().optional(),
    seo_keywords: z.string().optional(),
    seo_description: z.string().optional(),
    h1: z.string().optional(),
    text: z.string().optional(),
  })
  .strict();

const langsSchema = z
  .object({
    ua: seoPatchSchema.optional(),
    ru: seoPatchSchema.optional(),
    en: seoPatchSchema.optional(),
    pl: seoPatchSchema.optional(),
    ro: seoPatchSchema.optional(),
  })
  .strict();

/** Declared once so `withPayloadFile` can re-validate a file-borne payload
 *  against the very same shape the inline arguments are checked with. */
const pageSeoSchema = {
  ...storeField,
  id: z
    .union([z.number().int(), z.string()])
    .describe("Page/category id to edit (e.g. 927)."),
  parent: z.number().int().optional().describe("Parent id (context; usually optional for edits)."),
  langs: langsSchema
    .optional()
    .describe(
      "Per-language patch that REPLACES the value. Each language (ua/ru/en/pl/ro) may set any of: title, h1, seo_title, seo_keywords, seo_description, text. Omitted fields are left unchanged. Required unless `append`/`prepend` or `payloadFile` carries the content.",
    ),
  append: langsSchema
    .optional()
    .describe(
      appendDescription("the same per-language shape as `langs` (e.g. {\"ua\":{\"text\":\"<h3>Доставка</h3>…\"}}), whose values are glued onto the END of the stored text"),
    ),
  prepend: langsSchema
    .optional()
    .describe(prependDescription("the same per-language shape as `langs`")),
  verbose: verboseField,
  allowPlaceholderLoss: allowPlaceholderLossField,
  payloadFile: payloadFileField("horoshop_admin_page_seo_set"),
  dryRun: z
    .boolean()
    .optional()
    .describe("Default true: preview the exact field changes without saving. Set false to persist."),
};

export const adminTools: ToolSpec[] = [
  {
    name: "horoshop_admin_login_check",
    title: "Check admin session",
    description:
      "Verify the admin-panel session for a store (separate from the /api/ token — this logs into the control panel with the store credentials). Returns who is authenticated. Use before admin write tools to confirm access.",
    inputSchema: { ...storeField },
    annotations: { readOnlyHint: true },
    handler: async (client, args) => client.admin.whoAmI(args.store),
  },
  {
    name: "horoshop_admin_page_get",
    title: "Read page/category (admin)",
    description:
      "Read a site page or catalog category from the admin panel into structured JSON: slug, template, per-language title/H1/SEO title/keywords/description and body text. Covers fields the public /api/ exposes as read-only or not at all. `id` is the page/category id (from horoshop_pages_export or the admin URL). This is the read half of horoshop_admin_page_seo_set. " +
      "DISABLED-LANGUAGE FLAG: `languageStatus` reports each language's on/off state and `disabledLanguages` lists the OFF ones. A disabled language's title/text is usually Horoshop platform DEMO content (\"This is demo store\", \"Clothing and Shoes\"), not real content — when a disabled language still carries text, a `note` warns you so you do not mistake the demo default for working data.",
    inputSchema: {
      ...storeField,
      id: z
        .union([z.number().int(), z.string()])
        .describe("Page/category id to read (e.g. 927). Use \"addnew\" for a blank create form."),
      parent: z.number().int().optional().describe("Parent id (needed only for create/context)."),
    },
    annotations: { readOnlyHint: true },
    handler: async (client, args) => {
      const form = await client.admin.getEditForm(args.store, pageTarget(args.id, args.parent));
      const page = describePage(form);
      const states = await languageStates(client, args.store);
      const disabledLanguages = Object.keys(page.languages).filter((code) => states[code] === false);
      const disabledWithContent = disabledLanguages.filter((code) => {
        const entry = page.languages[code];
        return entry && Object.values(entry).some((v) => typeof v === "string" && v.trim() !== "");
      });
      return {
        ...page,
        ...(Object.keys(states).length ? { languageStatus: states } : {}),
        ...(disabledLanguages.length ? { disabledLanguages } : {}),
        ...(disabledWithContent.length
          ? {
              note: `Language(s) ${disabledWithContent.join(", ")} are DISABLED on this store but still carry title/text here — this is usually Horoshop platform demo content ("This is demo store" / "Clothing and Shoes"), not real content. Do not treat it as working data.`,
            }
          : {}),
      };
    },
  },
  {
    name: "horoshop_admin_page_seo_set",
    title: "Set page/category SEO (admin)",
    description:
      "Set SEO and content fields on a site page or catalog category via the admin panel — the multilingual title, H1, SEO title, meta keywords, meta description, and body text that the public /api/ cannot write. Read-modify-write: untouched fields are preserved. Languages: ua, ru, en, pl, ro. DRY RUN BY DEFAULT — pass dryRun:false to actually save; after saving it re-reads the record and reports the verified values. " +
      "WHAT \"VERIFIED\" MEANS HERE: the field was read back out of the ADMIN FORM. That is proof the value is stored — it is NOT proof the page exists for a shopper. A page created with record_save entity=pages can answer 404 on the storefront in every language while this tool reports saved:true and persisted:true on every field (seen live). If the page is new, fetch its URL yourself, or create it with horoshop_admin_page_create / horoshop_admin_category_create, which resolve the URL node so the address actually exists. " +
      "ADD TEXT WITHOUT RESENDING IT: `append` / `prepend` take the same per-language shape as `langs` but splice onto the STORED text instead of replacing it — the way to add one block to a 20 KB body without sending the 20 KB back (and without risking a mangled copy of live content). Same cell in `langs` AND `append`/`prepend` is an error, not a silent winner. " +
      "ANSWER SIZE: a persisted long value comes back as {length, tail, sha256}, not echoed as from+to+now; a field that did NOT persist still reports expected/actual previews and the first differing offset. verbose:true restores the full diff. " +
      PLACEHOLDER_GUARD_DOC +
      " " +
      "BULK PAYLOAD FROM DISK: a page body is routinely 20+ KB and will not fit in a tool argument. Do NOT fall back to a hand-rolled getEditForm+save for that — pass `payloadFile`, an ABSOLUTE path to a JSON file holding the same arguments (e.g. {\"langs\":{\"ru\":{\"text\":\"<22 KB of HTML>\"}}}). It is mutually exclusive with the inline `langs` and behaves identically, dryRun included.",
    inputSchema: pageSeoSchema,
    annotations: { readOnlyHint: false, idempotentHint: true },
    handler: async (client, rawArgs) => {
      const args = withPayloadFile(rawArgs, pageSeoSchema, "horoshop_admin_page_seo_set");
      const langs = (args.langs ?? {}) as Record<string, Record<string, string>>;
      const appendLangs = (args.append ?? {}) as Record<string, Record<string, string>>;
      const prependLangs = (args.prepend ?? {}) as Record<string, Record<string, string>>;
      const cellKeys = (m: Record<string, Record<string, string>>): string[] =>
        Object.entries(m).flatMap(([code, patch]) => Object.keys(patch).map((f) => `${code}.${f}`));
      const spliceKeys = [...new Set([...cellKeys(appendLangs), ...cellKeys(prependLangs)])];
      if (Object.keys(langs).length === 0 && spliceKeys.length === 0) {
        throw new Error(
          "Nothing to write: pass `langs` (replace) and/or `append`/`prepend` (splice onto the stored text) inline, or a `payloadFile` whose JSON contains them.",
        );
      }
      assertNoSpliceConflict(cellKeys(langs), spliceKeys, "langs");
      const verbose = args.verbose === true;
      const dryRun = args.dryRun !== false;
      const form = await client.admin.getEditForm(args.store, pageTarget(args.id, args.parent));

      const overrides: Record<string, string> = {};
      const planned: Array<Record<string, any>> = [];
      const skipped: Array<{ lang: string; field: string; reason: string }> = [];

      for (const [code, patch] of Object.entries(langs)) {
        const l = LANG_INDEX[code];
        for (const [logical, value] of Object.entries(patch)) {
          const formField = resolveFieldName(form, logical, l);
          if (!formField) {
            skipped.push({ lang: code, field: logical, reason: "field not present on this record's form" });
            continue;
          }
          const from = fieldValue(form, formField);
          if (from === value) continue; // no-op, don't churn
          overrides[formField] = value;
          planned.push({ lang: code, field: logical, formField, from, to: value });
        }
      }

      // APPEND/PREPEND — splice onto the stored text (the read half of the RMW is
      // already done), so a 22 KB body never has to travel back inline to gain a
      // paragraph.
      for (const key of spliceKeys) {
        const [code, logical] = key.split(".");
        const l = LANG_INDEX[code];
        const formField = resolveFieldName(form, logical, l);
        if (!formField) {
          skipped.push({ lang: code, field: logical, reason: "field not present on this record's form" });
          continue;
        }
        const pre = prependLangs[code]?.[logical];
        const app = appendLangs[code]?.[logical];
        const from = fieldValue(form, formField);
        const to = splice({ current: from, append: app, prepend: pre });
        if (from === to) continue;
        overrides[formField] = to;
        planned.push({
          lang: code,
          field: logical,
          formField,
          mode: [pre ? "prepend" : "", app ? "append" : ""].filter(Boolean).join("+"),
          from,
          to,
          delta: `${pre ?? ""}${app ?? ""}`,
          length: { before: from.length, delta: (pre ?? "").length + (app ?? "").length, after: to.length },
        });
      }

      const src = args.payloadFileUsed ? { payloadFile: args.payloadFileUsed } : {};
      if (planned.length === 0) {
        return { store: args.store ?? null, id: String(args.id), dryRun, ...src, changes: [], skipped, note: "Nothing to change (values already match or no mappable fields)." };
      }
      // TEMPLATE TOKENS: an SEO title stored as "{title} — {site}" replaced by a
      // constant loses the substitution on every page it templates (see
      // admin/placeholders.ts).
      const placeholderWarnings = scanPlaceholderLoss(planned, (p) => `${p.lang}.${p.field}`);
      if (dryRun) {
        // Long bodies are windowed, not echoed — see compactPreview.
        return {
          store: args.store ?? null,
          id: String(args.id),
          dryRun: true,
          ...src,
          ...(placeholderWarnings.length
            ? { placeholderWarnings, placeholderNote: placeholderPreviewNote(placeholderWarnings) }
            : {}),
          willChange: planned.map((p) => compactPreview(p, verbose)),
          skipped,
        };
      }
      assertPlaceholdersKept(placeholderWarnings, args.allowPlaceholderLoss === true);

      const result = await client.admin.save(args.store, form, overrides);
      // Verify by re-reading and comparing the fields we changed.
      const after = await client.admin.getEditForm(args.store, pageTarget(args.id, args.parent));
      const changes = planned.map((p) => {
        const now = fieldValue(after, p.formField as string);
        return { ...p, persisted: now === p.to, now };
      });
      const ok = changes.every((c) => c.persisted);
      const reported = changes.map((c) => compactVerified(c, verbose));
      const compacted = wasCompacted(reported);
      return {
        store: args.store ?? null,
        id: String(args.id),
        dryRun: false,
        saved: ok,
        httpStatus: result.httpStatus,
        ...src,
        ...(placeholderWarnings.length
          ? { placeholderLossAllowed: placeholderWarnings, placeholderNote: placeholderOverrideNote(placeholderWarnings) }
          : {}),
        changes: reported,
        skipped,
        note:
          (ok
            ? "All changes verified by re-reading the record."
            : "Some fields did NOT persist — check the field mapping or admin validation.") +
          (compacted ? ` ${COMPACT_NOTE}` : ""),
      };
    },
  },
];
