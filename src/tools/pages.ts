import { z } from "zod";
import { storeField, type ToolSpec } from "../register.js";

export const pageTools: ToolSpec[] = [
  {
    name: "horoshop_pages_export",
    title: "Export categories",
    description:
      "List catalog categories/pages under a parent (id, parent, multilingual title, discount). Use the returned ids as parent.id when importing products. " +
      "READ-ONLY HERE ONLY: categories cannot be written through the PUBLIC /api/ layer — but they are fully writable through the admin layer this server also speaks. Use horoshop_admin_category_update (title, SEO meta, seo_text, cover, flags), horoshop_admin_category_create, or horoshop_admin_page_seo_set. Do not conclude from this endpoint that categories are immutable.",
    inputSchema: {
      ...storeField,
      parent: z
        .number()
        .int()
        .optional()
        .describe("Parent category id to list under. Default 0 (root)."),
    },
    annotations: { readOnlyHint: true },
    handler: async (client, args) => {
      const params: Record<string, unknown> = {};
      if (args.parent !== undefined) params.parent = args.parent;
      return client.call(args.store, "pages/export", params);
    },
  },
];
