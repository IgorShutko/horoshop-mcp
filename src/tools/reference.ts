import { z } from "zod";
import { storeField, type ToolSpec } from "../register.js";

export const referenceTools: ToolSpec[] = [
  {
    name: "horoshop_payment_export",
    title: "Export payment options",
    description:
      "List the store's payment options (id, multilingual title/description, payment_method, enabled, gateway link). The ids appear on orders as payment_type.id.",
    inputSchema: { ...storeField },
    annotations: { readOnlyHint: true },
    handler: async (client, args) => client.call(args.store, "payment/export"),
  },
  {
    name: "horoshop_payment_methods",
    title: "Export payment methods",
    description:
      "List payment methods (id, title, is_simple). is_simple=false means the buyer is sent to a payment gateway after checkout. Referenced by payment options' payment_method.",
    inputSchema: { ...storeField },
    annotations: { readOnlyHint: true },
    handler: async (client, args) =>
      client.call(args.store, "payment/exportMethods"),
  },
  {
    name: "horoshop_delivery_export",
    title: "Export delivery options",
    description:
      "List delivery options (id, multilingual title, type, enabled, allowed payment ids, price_options). The ids appear on orders as delivery_type.id and differ per store.",
    inputSchema: { ...storeField },
    annotations: { readOnlyHint: true },
    handler: async (client, args) => client.call(args.store, "delivery/export"),
  },
  {
    name: "horoshop_delivery_types",
    title: "Export delivery types",
    description:
      "List delivery type categories (id, multilingual title), e.g. courier, warehouse pickup, Ukrposhta. Referenced by delivery options' type.",
    inputSchema: { ...storeField },
    annotations: { readOnlyHint: true },
    handler: async (client, args) =>
      client.call(args.store, "delivery/exportTypes"),
  },
  {
    name: "horoshop_currency_export",
    title: "Export currencies and rates",
    description:
      "Export currencies and exchange rates. By default only front-enabled currencies are returned; filter by ISO codes or ids. enabledOnly, when set, ignores the iso filter.",
    inputSchema: {
      ...storeField,
      iso: z
        .array(z.string())
        .optional()
        .describe("ISO codes to export, e.g. ['UAH','USD']."),
      ids: z
        .array(z.number().int())
        .optional()
        .describe("Currency ids to export (sent as `id`)."),
      enabledOnly: z
        .boolean()
        .optional()
        .describe("Only front-enabled currencies (default true). Ignores `iso` when set."),
    },
    annotations: { readOnlyHint: true },
    handler: async (client, args) => {
      const params: Record<string, unknown> = {};
      if (args.iso !== undefined) params.iso = args.iso;
      if (args.ids !== undefined) params.id = args.ids;
      if (args.enabledOnly !== undefined) params.enabledOnly = args.enabledOnly;
      return client.call(args.store, "currency/export", params);
    },
  },
];
