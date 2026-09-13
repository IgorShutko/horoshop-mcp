import { z } from "zod";
import { storeField, type ToolSpec } from "../register.js";
import { fittingCount } from "../sizeGate.js";
import { ORDER_STATUS_CANCELLED } from "../admin/orders.js";
import { adminCancelWithStock } from "./adminOrders.js";

const ORDER_STATUS_DESC =
  "1 new, 2 processing, 3 delivered, 4 not delivered, 6 shipping.";

/**
 * THE HALF-CANCEL — measured, not theorised.
 *
 * `POST /api/orders/update/ {status:4}` answers `{"status":"OK","message":"UPDATED"}`
 * and really does move the order to «cancelled». It does NOT put the goods back
 * on the shelf: on the test store a 1-unit order cancelled this way left stock at
 * 3 → 3, while the admin's own cancel with `return_quantity=1` gave 3 → 4. There
 * is no flag for it anywhere in the public API — the lever only exists in the
 * admin editor. So a caller who cancels through this tool and never looks again
 * is left with a store that thinks it sold something it still owns.
 */
const HALF_CANCEL_WARNING =
  "STOCK WAS NOT RETURNED. The public API cancels an order only half way: the status is now 4, but the ordered quantities stay deducted from the warehouse (measured: 3 → 3, while the admin's own cancel with return_quantity=1 gives 3 → 4). The API has no flag for it. AND THIS IS NOT FIXABLE AFTER THE FACT: the cancelled order is un-editable, so re-running this call with returnStock:true is refused («Order is already cancelled»), horoshop_admin_order_status_change throws on the same order, and deleting it returns nothing either (measured: already-cancelled 5 → 5). The goods are written off. The only place the decision existed was the moment of cancelling — next time pass returnStock:true here, or cancel through horoshop_admin_order_status_change (status 4, returnStock:true), which posts the admin's return_quantity and verifies the stock before/after.";

export const orderTools: ToolSpec[] = [
  {
    name: "horoshop_orders_get",
    title: "Get orders",
    description:
      "Fetch orders, optionally filtered by date range, ids, or status, and paginated with offset/limit. " +
      "MEASURED on 264 live orders across two stores: the Nova Poshta block `delivery_data` (deliveryOperatorType, tnNumber, tnId, tnStatusName, tnTrackingUpdateDate, estimatedDeliveryDate, ownTTNPicked, departure, destination) arrives WITHOUT additionalData — what the flag adds is one extra key, `additional_data.recipient_warehouse_ref` (the branch GUID), for +2.7% of payload — NOT the doubling this description used to claim (measured 89.2 KB -> 91.6 KB over the same 22 orders). On an unprocessed order `tnNumber` is null: the block exists, the waybill does not yet. " +
      "`total_sum` is the sum of the LINES and excludes delivery (matched Σ products[].total_price on 264/264). The two totals split discounts by KIND, which is why they so often look identical: a PRODUCT discount is already baked into the line `price` (`discount_marker:\"PRICE_OLD\"`) so BOTH totals carry it — hence `total_default` equalled `total_sum` on 264/264 live orders. An ORDER-LEVEL discount (coupon / manager) is what separates them: MEASURED on a test-store order, a 799 item with a 25% coupon gave `total_default` 799, `total_sum` 599, `coupon_percent` 25, `coupon_discount_value` 200, with the line `price` untouched at 799 (`discount_marker:\"NONE\"`). So `total_default` is the total BEFORE ORDER-LEVEL discounts, not before all discounts, and `total_default - total_sum` is exactly the order-level discount. Use `total_sum` for revenue; to size a PRODUCT discount go per line, the difference is 0. `delivery_price` was only ever -1 or 0 there (-1 = not calculated), so never add it blindly. " +
      "Every line carries `type`, and on all 415 lines measured its value was `\"product\"` — `gift`/`gift_parent`/`set_main`/`set_item` are the documented values for gift and bundle rows, which that sample did not contain. " +
      "`analytics` (utm_source/medium/campaign/term/content + google_client_id) is present on 264/264. Three traps there, all measured: (1) `utm_campaign` CAN BE A NUMBER, not a string (seen: 23964436493 on Google Ads orders) — coerce with String() before any string operation or the report throws; (2) direct traffic arrives in THREE forms in one and the same sample — `(direct)`, `(none)` and an empty string — consolidate all three or the channel split double-counts; (3) EMPTY UTM DOES NOT MEAN DIRECT: the tags are read by storefront JS, so an order placed without JS (raw HTTP) arrives with empty tags even though all five were on the landing URL. Attribute empty as UNKNOWN, not as direct. B2B stores add customer_details / dropshipping_details. " +
      "`user` IS NOT A CUSTOMER ID — do not group by it. Most orders on a Horoshop store are placed without an account, so the field is close to unique per order (5369 distinct values across 5408 orders on one store) and counting it reports almost every order as a new customer. Group by PHONE NUMBER for anything about customers, repeat purchases, LTV or retention (the same store: 4416 real customers, 695 of them repeat). " +
      "What this does NOT return: the buyer's and the manager's comments, the per-line editing view, and the admin's own status-button state — those live in the admin editor (horoshop_admin_order_get). The `order_id` here is the order NUMBER; every admin route addresses a different record id (horoshop_admin_order_resolve bridges them).",
    inputSchema: {
      ...storeField,
      from: z
        .string()
        .optional()
        .describe("From date (inclusive): YYYY-MM-DD or DD.MM.YYYY, optional HH:mm:ss."),
      to: z.string().optional().describe("To date (inclusive), same formats as `from`."),
      ids: z.array(z.number().int()).optional().describe("Specific order numbers."),
      status: z
        .union([z.number().int(), z.array(z.number().int())])
        .optional()
        .describe(`Filter by status. ${ORDER_STATUS_DESC}`),
      additionalData: z
        .boolean()
        .optional()
        .describe(
          "Adds ONE key: `additional_data.recipient_warehouse_ref` (the Nova Poshta branch GUID). " +
            "It does NOT gate the TTN — measured, `delivery_data` (tnNumber, tnStatusName, estimatedDeliveryDate, …) " +
            "arrives with the flag off. Costs +2.7% of payload, so leaving it off will not shrink an oversized answer.",
        ),
      offset: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().optional(),
    },
    annotations: { readOnlyHint: true },
    // Measured: limit:100 is 239–395 KB — one page of orders is already over the
    // gate, and a 40 000-order store answers with megabytes if you let it. The
    // suggested `limit` is COMPUTED from this very answer: order size varies by
    // store (2.4 KB here, 4 KB there) and a hardcoded number sends the caller
    // straight into a second refusal.
    narrowHint: ({ payload, bytes, limit }) => {
      const orders = (payload as any)?.response?.orders;
      const n = Array.isArray(orders) ? orders.length : 0;
      const per = n > 0 ? Math.round(bytes / n) : 0;
      const fits = n > 0 ? fittingCount(n, bytes, limit) : 0;
      return (
        `Narrow it and call again: ` +
        (n > 0
          ? `this answer held ${n} order(s) at ~${per} B each, so about \`limit:${fits}\` fits — walk the rest with \`offset\`. `
          : `lower \`limit\` and walk with \`offset\`. `) +
        `\`from\`/\`to\` scope a date range, \`status\` filters, \`ids\` fetches specific order numbers. Dropping \`additionalData\` will NOT rescue an oversized answer — measured, it is worth 2.7% (89.2 KB -> 91.6 KB), because the Nova Poshta block \`delivery_data\` arrives with or without it; lower \`limit\` instead.`
      );
    },
    handler: async (client, args) => {
      const params: Record<string, unknown> = {};
      for (const k of ["from", "to", "ids", "status", "additionalData", "offset", "limit"] as const) {
        if (args[k] !== undefined) params[k] = args[k];
      }
      return client.call(args.store, "orders/get", params);
    },
  },
  {
    name: "horoshop_orders_update",
    title: "Update orders",
    description:
      `Update order status, payment flag and/or tracking code, in a batch. ${ORDER_STATUS_DESC} The response log reports per-order success/failure. ` +
      "⚠️ CANCELLING (status 4) THROUGH THE API ONLY DOES HALF THE JOB. It sets the status and leaves the goods deducted from stock — measured: 3 → 3 through this API, 3 → 4 through the admin's own cancel with return_quantity=1. Nothing in the public API can return them. So this tool now demands a decision whenever status 4 is in the batch: pass `returnStock:true` and those orders are cancelled through the ADMIN path instead (stock goes back on sale, verified before/after), `returnStock:false` to keep the API behaviour deliberately, or omit it and the answer carries a loud `stockWarning` telling you the goods are still counted as sold. " +
      "THE STOCK DECISION IS ONE-SHOT AND THIS TOOL HAS NO DRY RUN — it writes the moment you call it. Once an order is cancelled its editor is locked forever, so nothing brings the goods back afterwards: not a second call with returnStock:true, not order_status_change, not deleting the order. Decide before you send, not after you read the warning. " +
      "Stock only means anything when warehouse accounting is on (`extra[catalog_use_residues_by_stock]`); with it off, availability is the manual `presence` field.",
    inputSchema: {
      ...storeField,
      orders: z
        .array(
          z.object({
            order_id: z.number().int(),
            status: z
              .number()
              .int()
              .optional()
              .describe(ORDER_STATUS_DESC),
            tracking_code: z
              .string()
              .optional()
              .describe("Shipment tracking code (shown in the user's profile)."),
            payed: z
              .union([z.literal(0), z.literal(1)])
              .optional()
              .describe("0 not paid, 1 paid."),
          }),
        )
        .min(1),
      returnStock: z
        .boolean()
        .optional()
        .describe(
          "Only meaningful when the batch contains a cancellation (status 4). true → those orders are cancelled through the ADMIN editor with return_quantity=1, so the ordered quantities go back on sale (this is the ONLY way; the public API cannot do it). false → keep the plain API cancel, which leaves them deducted. Omit and you get the API behaviour plus an explicit warning.",
        ),
    },
    annotations: {
      readOnlyHint: false,
      // A status-4 batch is irreversible (the order becomes permanently
      // un-editable and, without returnStock, the goods are written off) and
      // there is no dry run here — the sibling admin_order_status_change marks
      // the same act destructive.
      destructiveHint: true,
      idempotentHint: true,
    },
    handler: async (client, args) => {
      const orders = args.orders as Array<Record<string, unknown>>;
      const cancels = orders.filter((o) => Number(o.status) === ORDER_STATUS_CANCELLED);

      if (args.returnStock !== undefined && cancels.length === 0) {
        throw new Error(
          `\`returnStock\` only applies to a cancellation (status ${ORDER_STATUS_CANCELLED}); this batch has none. Horoshop ignores return_quantity on every other status, so honouring it here would be a false promise.`,
        );
      }

      // The honest path: cancel through the admin editor so the goods come back.
      if (args.returnStock === true) {
        const cancelIds = new Set(cancels.map((o) => Number(o.order_id)));
        // Anything else in the same payload (payed / tracking_code, or a
        // non-cancel order) still goes through the documented API.
        const apiPayload = orders
          .map((o) => (cancelIds.has(Number(o.order_id)) ? stripStatus(o) : o))
          .filter((o) => Object.keys(o).length > 1);
        const apiResult = apiPayload.length
          ? await client.call(args.store, "orders/update", { orders: apiPayload }, "PUT")
          : null;

        const cancelled: unknown[] = [];
        for (const o of cancels) {
          cancelled.push(await adminCancelWithStock(client, args.store, Number(o.order_id)));
        }
        return {
          store: args.store ?? null,
          returnStock: true,
          cancelledViaAdmin: cancelled,
          ...(apiResult ? { apiUpdate: apiResult } : {}),
          note:
            "Cancellations were ROUTED to the admin editor (changeStatus + return_quantity=1) — the only path that returns stock. Read `applied` on each entry before believing it landed: an order that was already cancelled has a locked editor and comes back applied:false with nothing returned. `stockCheck` carries the ordered product's warehouse stock before → after for the ones that did apply, and `stockCheckCoverage` next to it says how many cart lines that actually covered (the read-back is capped, but never silently — `truncated:true` means the rest were not looked at). Any other field in the batch went through the documented API." +
            (cancelled.some((c: any) => c && c.applied === false)
              ? " ⚠ At least one cancellation did NOT apply — see its own note."
              : "") +
            (apiPayload.length ? "" : " No API call was needed."),
        };
      }

      const result = await client.call(args.store, "orders/update", { orders }, "PUT");
      if (cancels.length === 0) return result;
      return {
        ...(result as Record<string, unknown>),
        cancelledOrders: cancels.map((o) => Number(o.order_id)),
        stockWarning: HALF_CANCEL_WARNING,
        stockReturned: false,
        ...(args.returnStock === false
          ? { note: "returnStock:false — the goods were deliberately left deducted from stock." }
          : {}),
      };
    },
  },
  {
    name: "horoshop_orders_get_statuses",
    title: "Get available order statuses",
    description:
      "List all order statuses configured on the store (id, multilingual title, is_successful). Horoshop v4+. Use to resolve the numeric statuses returned by orders_get. Note the admin's status switcher labels these differently — status 6 reads «Отправлен» there but is titled «Доставляется», and status 4 is «Отменен» in the editor and «Не доставлен» here; these API names are the ones to report.",
    inputSchema: { ...storeField },
    annotations: { readOnlyHint: true },
    handler: async (client, args) =>
      client.call(args.store, "orders/get_available_statuses"),
  },
];

/** The same order minus `status` — used when the cancel is done elsewhere. */
function stripStatus(order: Record<string, unknown>): Record<string, unknown> {
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(order)) if (k !== "status") rest[k] = v;
  return rest;
}
