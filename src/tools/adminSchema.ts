import { z } from "zod";
import { storeField, type ToolSpec } from "../register.js";

/**
 * A data template's characteristic schema — which fields a category's products
 * actually have, and what each is called in the catalog API.
 *
 * This is the layer that silently punishes you for guessing: `catalog/import`
 * drops a characteristic the product's category template does not define, and
 * still answers "Товар обновлен". The schema is not exposed by the template
 * editor's <form> (that carries 6 meta inputs); it is a sortable list on the
 * same page, and its writes live in their own `params/ajax.php` subsystem.
 */

const PARAM_TYPES = ["input", "select", "checkbox", "number", "textarea", "htmlarea"] as const;

export const adminSchemaTools: ToolSpec[] = [
  {
    name: "horoshop_admin_template_schema",
    title: "Read a category's characteristic schema",
    description:
      "Read which characteristics a data template defines — grouped as the admin shows them (e.g. \"Модификации\" vs \"Характеристики\"), each with its param id, label, API field name, type, and the dictionary it draws values from. THIS IS THE FIELD LIST catalog_import/export accepts for products in that category: a name that is not here is silently dropped by the API. Get template ids from horoshop_admin_product_templates, or from a category via horoshop_admin_page_get (template.id).",
    inputSchema: {
      ...storeField,
      template: z
        .union([z.number().int(), z.string()])
        .describe("Data template id (e.g. 461). See horoshop_admin_product_templates."),
    },
    annotations: { readOnlyHint: true },
    handler: async (client, args) => {
      const groups = await client.admin.templateSchema(args.store, args.template);
      return {
        template: String(args.template),
        groups,
        fieldNames: groups.flatMap((g) => g.params.map((p) => p.name)).filter(Boolean),
      };
    },
  },
  {
    name: "horoshop_admin_template_param_add",
    title: "Add a characteristic to a category",
    description:
      "Add (or edit) one characteristic on a data template — this is how you make a new field exist for a category's products so catalog_import will accept it. `group` is a group id from horoshop_admin_template_schema. For a dictionary-backed dropdown pass type \"select\" plus `book` — the dictionary id (382) or its `book_382` form; list the choices with horoshop_admin_template_param_books. Passing a bare number as the raw table value binds the field to a TEMPLATE instead of a dictionary and the values then never land, so use `book`. DRY RUN BY DEFAULT. Editing an existing field: pass its `paramId` — but read the next sentence first, because \"edit\" here is not what it sounds like. " +
      "⚠ EDITING IS A FULL OVERWRITE, NOT A READ-MODIFY-WRITE. Unlike its neighbours, this tool does not read the characteristic's current values before saving: it rebuilds the whole param record from your arguments and sends every attribute explicitly, so the server has nothing to merge. Five attributes are always sent as constants — `localize:\"0\"`, `editable:\"1\"`, `inputlength:\"255\"`, `mask:\"\"`, `comment:\"\"`. Change only a `title` or a `book` on an existing paramId and you silently also turn OFF multilingual values (localize 1→0), UNLOCK a field that was protected from editing (editable 0→1) and ERASE a custom validation mask and comment. No error, no warning. Check the current state with horoshop_admin_template_schema before editing, and expect to restore those attributes by hand afterwards. " +
      "NO PER-LANGUAGE TITLE HERE: `title` is a single, language-less string — the admin's own param editor renders exactly one title input and the saveParam contract has no title[lang] variant. So a characteristic whose HEADING must read differently in another language («Розмір постільної білизни» → Russian) is not translated on the template; its label is translated in the interface-translation table with horoshop_admin_interface_translation_set (key = the heading text, one row per language).",
    inputSchema: {
      ...storeField,
      template: z.union([z.number().int(), z.string()]).describe("Data template id to add the field to."),
      group: z.union([z.number().int(), z.string()]).describe("Group id within the template (from horoshop_admin_template_schema)."),
      title: z.string().describe("Human label, e.g. \"Матеріал\"."),
      name: z
        .string()
        .describe("API field name for catalog_import/export, e.g. \"materal\" (latin, digits, underscore)."),
      type: z.enum(PARAM_TYPES).describe("Field type. \"select\" needs `book`."),
      book: z
        .union([z.number().int(), z.string()])
        .optional()
        .describe("Dictionary for a select: id (382) or \"book_382\". See horoshop_admin_template_param_books."),
      multi: z.boolean().optional().describe("Allow several values (select only)."),
      inGrid: z.boolean().optional().describe("Show the field as a column in the admin product grid."),
      paramId: z
        .union([z.number().int(), z.string()])
        .optional()
        .describe("Existing param id to edit; omit to create a new field."),
      dryRun: z.boolean().optional().describe("Default true: preview without writing. Set false to apply."),
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
    handler: async (client, args) => {
      if (args.type === "select" && !args.book) {
        throw new Error(
          'type "select" needs a dictionary: pass book (e.g. 382 or "book_382"). List them with horoshop_admin_template_param_books.',
        );
      }
      // The admin encodes a dictionary binding as `book_<id>`; a bare id means
      // "another template" and the characteristic then silently never applies.
      const table = args.book == null ? undefined : /^book_/.test(String(args.book)) ? String(args.book) : `book_${args.book}`;
      const param: Record<string, string> = {
        id: String(args.paramId ?? 0),
        title: args.title,
        name: args.name,
        group: String(args.group),
        type: args.type,
        localize: "0",
        editable: "1",
        inputlength: "255",
        mask: "",
        comment: "",
        ...(table ? { table } : {}),
        ...(args.multi ? { multi: "1" } : { multi: "0" }),
        ...(args.inGrid ? { in_grid: "1" } : {}),
      };

      if (args.dryRun !== false) {
        return { dryRun: true, template: String(args.template), wouldSend: param, note: "Set dryRun:false to apply." };
      }

      const res = await client.admin.templateParamSave(args.store, args.template, param);
      const groups = await client.admin.templateSchema(args.store, args.template);
      const found = groups.flatMap((g) => g.params).find((p) => p.name === args.name);
      const bound = args.type !== "select" || !!found?.book;
      return {
        dryRun: false,
        template: String(args.template),
        status: res.status,
        message: res.message,
        saved: !!found && bound,
        param: found ?? null,
        note: !found
          ? "The field did not appear in the template after saving — check the group id and the name (latin/digits/underscore)."
          : bound
            ? `Field "${found.name}" is live on this template — catalog_import now accepts it for products in categories using it.`
            : `Field created but NOT bound to a dictionary (type reads "${found.type}"). Re-run with book set, or values will never land.`,
      };
    },
  },
  {
    name: "horoshop_admin_template_param_books",
    title: "List dictionaries a characteristic can use",
    description:
      "List the dictionaries a select-type characteristic can bind to, in the exact `book_<id>` form the admin expects, with their names. Use before horoshop_admin_template_param_add.",
    inputSchema: {
      ...storeField,
      template: z.union([z.number().int(), z.string()]).describe("Data template id (context for the param form)."),
    },
    annotations: { readOnlyHint: true },
    handler: async (client, args) => {
      // The dictionary picker only exists on a param whose type is already
      // "select" — a blank new param renders as a plain string field and has no
      // picker at all. So borrow the context of an existing select on this
      // template; if it has none, any select param anywhere will do, since the
      // dictionary list is store-wide.
      const groups = await client.admin.templateSchema(args.store, args.template);
      const sel = groups.flatMap((g) => g.params).find((p) => p.book);
      let books = await client.admin.templateParamBooks(args.store, args.template, sel ? sel.id : 0);
      if (!books.length && sel) books = await client.admin.templateParamBooks(args.store, args.template, 0);
      return {
        count: books.length,
        books,
        note: books.length
          ? "Pass one of these `value`s (or just its numeric part) as `book` to horoshop_admin_template_param_add."
          : "No dictionary picker was reachable: this template has no select-type field to borrow context from. Add the field as type \"select\" on a template that has one, or create the dictionary via the admin first.",
      };
    },
  },
  {
    name: "horoshop_admin_template_param_delete",
    title: "Delete a characteristic from a category",
    description:
      "Remove a characteristic from a data template by its param id (from horoshop_admin_template_schema). DESTRUCTIVE: products in that category lose the field and its stored values. DRY RUN BY DEFAULT. A param that is not on the template answers `{deleted:false, alreadyGone:true}` rather than erroring — a repeat delete is a no-op success, and `deleted` is always present so it can be read instead of the note.",
    inputSchema: {
      ...storeField,
      template: z.union([z.number().int(), z.string()]).describe("Data template the field belongs to (used to verify)."),
      paramId: z.union([z.number().int(), z.string()]).describe("Param id to delete."),
      dryRun: z.boolean().optional().describe("Default true: preview without deleting. Set false to delete."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
    handler: async (client, args) => {
      const before = await client.admin.templateSchema(args.store, args.template);
      const target = before.flatMap((g) => g.params).find((p) => String(p.id) === String(args.paramId));
      if (!target) {
        // This branch used to be the WORST of the three failure shapes: no error,
        // but also no `deleted` key — so a caller reading `deleted` got undefined
        // and could not tell "removed it" from "there was nothing there" without
        // parsing the note. Same explicit contract as the other delete tools now.
        return {
          template: String(args.template),
          paramId: String(args.paramId),
          dryRun: args.dryRun !== false,
          deleted: false,
          alreadyGone: true,
          note: "No such param on this template — nothing to delete, and nothing was sent. This is the success shape of a repeat delete.",
          params: before,
        };
      }
      if (args.dryRun !== false) {
        return { dryRun: true, wouldDelete: target, note: "Set dryRun:false to delete. Products lose this field's values." };
      }
      const res = await client.admin.templateParamDelete(args.store, args.paramId);
      const after = await client.admin.templateSchema(args.store, args.template);
      const gone = !after.flatMap((g) => g.params).some((p) => String(p.id) === String(args.paramId));
      return {
        dryRun: false,
        httpStatus: res.httpStatus,
        deleted: gone,
        param: target,
        note: gone ? "Deleted and verified by re-reading the schema." : "Still present after the delete — check the param id.",
      };
    },
  },
];
