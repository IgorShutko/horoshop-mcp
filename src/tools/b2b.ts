import { storeField, type ToolSpec } from "../register.js";

export const b2bTools: ToolSpec[] = [
  {
    name: "horoshop_customer_groups_export",
    title: "Export customer groups (B2B)",
    description:
      "List B2B customer groups (id, title, visible price level, product visibility, dropshipping flag, allowed payment/delivery methods). Use customer_group_id from here when importing users. " +
      "NEEDS THE B2B MODULE: on a store that does not have it, this endpoint answers `FORBIDDEN: Use of the method is not allowed` — that is the plan talking, not a broken call, and no argument fixes it. The groups still exist in the admin and are reachable the other way: horoshop_admin_record_get / horoshop_admin_record_save on entity `customer_groups` (handler 440).",
    inputSchema: { ...storeField },
    annotations: { readOnlyHint: true },
    handler: async (client, args) =>
      client.call(args.store, "customer-groups/export"),
  },
  {
    name: "horoshop_price_levels_export",
    title: "Export price levels (B2B)",
    description:
      "List configured price levels/types (id, title). Use these level_id values in catalog_import's price_levels[]. The retail price is still set via the plain `price` field, not here. " +
      "NEEDS THE B2B MODULE: without it the endpoint answers `FORBIDDEN: Use of the method is not allowed` — a plan restriction, not a bad request. Read the levels through the admin instead: horoshop_admin_record_get / horoshop_admin_record_save on entity `price_levels` (handler 439).",
    inputSchema: { ...storeField },
    annotations: { readOnlyHint: true },
    handler: async (client, args) =>
      client.call(args.store, "price-levels/export"),
  },
];
