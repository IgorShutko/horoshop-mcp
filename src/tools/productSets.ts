import { z } from "zod";
import { storeField, type ToolSpec } from "../register.js";

export const productSetTools: ToolSpec[] = [
  {
    name: "horoshop_product_set_import",
    title: "Import / update product sets",
    description:
      'Upsert "bought together" product sets, matched by the set `article` (which must not clash with a real product article). A set holds 2..N member product articles. Price is either discountPercent off the summed member prices, or an explicit discountedPrice.',
    inputSchema: {
      ...storeField,
      items: z
        .array(
          z.object({
            article: z
              .string()
              .describe("Unique set article (must differ from any product article)."),
            title: z.string().optional().describe('Defaults to "Вместе дешевле".'),
            discountPercent: z
              .number()
              .int()
              .min(0)
              .max(100)
              .optional()
              .describe("Relative discount off the summed member price."),
            discountedPrice: z
              .number()
              .positive()
              .optional()
              .describe("Explicit set price; overrides discountPercent if set."),
            currency: z.string().optional().describe("ISO code, e.g. UAH."),
            enabled: z.boolean().optional(),
            sortOrder: z.number().int().optional(),
            products: z
              .array(z.string())
              .min(2)
              .describe("Member product articles (2 or more, no duplicates)."),
          }),
        )
        .min(1),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
    handler: async (client, args) =>
      client.call(args.store, "productSet/import", { items: args.items }, "POST"),
  },
  {
    name: "horoshop_product_set_remove",
    title: "Remove product sets",
    description:
      "Delete product sets by their set articles. Destructive but scoped to sets only — it never touches real products. Removing a non-existent set returns a WARNING, not an error.",
    inputSchema: {
      ...storeField,
      articles: z
        .array(z.string())
        .min(1)
        .describe("Set articles to delete."),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    },
    handler: async (client, args) =>
      client.call(args.store, "productSet/remove", { articles: args.articles }, "POST"),
  },
];
