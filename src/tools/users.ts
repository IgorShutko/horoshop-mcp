import { z } from "zod";
import { storeField, type ToolSpec } from "../register.js";

export const userTools: ToolSpec[] = [
  {
    name: "horoshop_users_export",
    title: "Export users",
    description:
      "Export registered site users, optionally by registration date range, paginated with offset/limit. B2B stores additionally return customer_group_id, balance, manager, company and role.",
    inputSchema: {
      ...storeField,
      from: z
        .string()
        .optional()
        .describe("Registered from (inclusive): YYYY-MM-DD or DD.MM.YYYY, optional HH:mm:ss."),
      to: z.string().optional().describe("Registered up to (inclusive)."),
      offset: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().optional(),
    },
    annotations: { readOnlyHint: true },
    handler: async (client, args) => {
      const params: Record<string, unknown> = {};
      for (const k of ["from", "to", "offset", "limit"] as const) {
        if (args[k] !== undefined) params[k] = args[k];
      }
      return client.call(args.store, "users/export", params);
    },
  },
  {
    name: "horoshop_users_import",
    title: "Import / update users",
    description:
      "Upsert users, matched by the unique `email`. `title` (full name) and `email` are required. The response log reports per-user codes (0 ok, 1 missing required, 2 validation, 3 error).",
    inputSchema: {
      ...storeField,
      users: z
        .array(z.record(z.any()))
        .min(1)
        .describe(
          "User objects. Required: title, email. Optional: phone, country, city, address, newsletter_subscription (0/1), discount_card{discount,active,date_limit,status}, note. B2B: customer_group_id, balance, balance_currency, manager_id, site_link, company, role.",
        ),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
    handler: async (client, args) =>
      client.call(args.store, "users/import", { users: args.users }, "POST"),
  },
];
