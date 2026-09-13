import { z } from "zod";
import { storeField, type ToolSpec } from "../register.js";

/**
 * The buyer's side of the shop: cart and checkout.
 *
 * Why these exist: the documented `/api/` has no cart (it answers
 * UNDEFINED_FUNCTION) and the admin only configures the funnel's inputs, so
 * "does a real customer actually reach checkout" was unanswerable from here.
 * The cart is a widget (`/_widget/ajax_cart/`) that the shop's own JS drives;
 * these tools speak its protocol, keeping a buyer session per store.
 *
 * This is a TEST/QA surface, not an order-placing one: it fills a cart and reads
 * what checkout offers. Submitting a real order is deliberately not exposed.
 */

/**
 * Trim the widget's fat payload down to what a human wants to see.
 * Shape note: lines are a hash-keyed map (not an array) and the money lives one
 * level deeper, in `total.total` — `total.sum` does not exist.
 */
function summarize(response: any): any {
  const total = response?.total ?? response ?? {};
  const itemsRaw = total.items ?? {};
  const items = (Array.isArray(itemsRaw) ? itemsRaw : Object.values(itemsRaw)).map((i: any) => ({
    hash: i?.hash,
    id: i?.id,
    article: i?.article,
    title: typeof i?.title === "object" ? (i.title?.ua ?? Object.values(i.title ?? {})[0]) : i?.title,
    quantity: i?.quantity,
    price: i?.price,
    available: i?.is_available,
  }));
  const money = total.total ?? {};
  return {
    items,
    count: items.length,
    quantity: money.quantity ?? 0,
    sum: money.sum ?? 0,
    discount: total?.discount,
    coupon: total?.coupon_data?.code || undefined,
  };
}

/** Read one labelled `<select>`'s options out of the checkout markup. */
function selectOptions(html: string, name: string): Array<{ id: string; title: string }> {
  const sel = html.match(
    new RegExp(`<select[^>]*name=["']${name.replace(/[[\]]/g, "\\$&")}["'][^>]*>([\\s\\S]*?)</select>`, "i"),
  );
  if (!sel) return [];
  return [...sel[1].matchAll(/<option[^>]*value=["']([^"']*)["'][^>]*>([^<]*)</gi)]
    .map((m) => ({ id: m[1], title: m[2].replace(/\s+/g, " ").trim() }))
    .filter((o) => o.id && o.title);
}

export const shopCartTools: ToolSpec[] = [
  {
    name: "horoshop_cart_get",
    title: "Read the buyer's cart",
    description:
      "Read the current cart for this store's buyer session — lines (with their hash), quantities and totals. The session is kept per store, so add/remove/get see the same cart. Use it to test the funnel: what a real customer would have before checkout.",
    inputSchema: { ...storeField },
    annotations: { readOnlyHint: true },
    handler: async (client, args) => {
      const r = await client.shop.cartInit(args.store);
      return { status: r.status, cart: summarize(r.response) };
    },
  },
  {
    name: "horoshop_cart_add",
    title: "Add a product to the cart",
    description:
      "Add a product to the buyer's cart by its internal product id (NOT the article — take `id` from the storefront's data-id, or the record id in horoshop_admin_redirect_list where handler 17 = products). Returns the updated cart. This exercises the real widget the shop's JS uses, so a SUCCESSFUL add proves the product is genuinely buyable. " +
      "READ `CART_EXCEPTION` CAREFULLY — it has two very different causes, and the common one is the boring one. " +
      "FIRST check whether the product is actually buyable right now: with stock accounting ON (horoshop_admin_settings_catalog useResiduesByStock) a product whose quantity is 0, or whose presence is \"not in stock\", is refused with exactly this status, and so is a hidden product (display_in_showcase:0). That is the shop working correctly, not a broken cart. Confirm with horoshop_cart_get: if the session returns a cart at all (status OK), the anti-bot has been cleared and the session is fine — the refusal is about the product. " +
      "ONLY THEN suspect the transport: the buyer session sends a fixed non-browser User-Agent, so a store behind a strict proof-of-work / bot filter can bounce every request and answer `CART_EXCEPTION` for EVERY product. The two are told apart by horoshop_cart_get, so check it before telling anyone their catalogue is broken.",
    inputSchema: {
      ...storeField,
      product: z.union([z.number().int(), z.string()]).describe("Internal product id (e.g. 515)."),
      quantity: z.number().int().positive().optional().describe("Default 1."),
      type: z
        .string()
        .optional()
        .describe('Cart item type; default "product". The server rejects unregistered types by name.'),
    },
    annotations: { readOnlyHint: false },
    handler: async (client, args) => {
      const r = await client.shop.cartAppend(args.store, {
        id: args.product,
        quantity: args.quantity,
        type: args.type,
      });
      if (r.status !== "OK") {
        return {
          status: r.status,
          error: r.response,
          note:
            'Cart refused the product. "INCORRECT VALUE" usually means a wrong/blank id; "Type \'x\' is not registered" means the type is not a cart item type on this store; a hidden product (display_in_showcase:0) is not buyable either.',
        };
      }
      return { status: r.status, cart: summarize(r.response) };
    },
  },
  {
    name: "horoshop_cart_set_quantity",
    title: "Change a cart line's quantity",
    description:
      "Set the quantity of one cart line, addressed by its `hash` (from horoshop_cart_get). Returns the updated cart.",
    inputSchema: {
      ...storeField,
      hash: z.string().describe("Line hash from horoshop_cart_get."),
      quantity: z.number().int().positive().describe("New quantity."),
    },
    annotations: { readOnlyHint: false },
    handler: async (client, args) => {
      const r = await client.shop.cartSetQuantity(args.store, args.hash, args.quantity);
      return { status: r.status, cart: summarize(r.response) };
    },
  },
  {
    name: "horoshop_cart_remove",
    title: "Remove a cart line",
    description: "Remove one line from the cart by its `hash` (from horoshop_cart_get).",
    inputSchema: {
      ...storeField,
      hash: z.string().describe("Line hash from horoshop_cart_get."),
    },
    annotations: { readOnlyHint: false },
    handler: async (client, args) => {
      const r = await client.shop.cartRemove(args.store, args.hash);
      return { status: r.status, cart: summarize(r.response) };
    },
  },
  {
    name: "horoshop_cart_apply_coupon",
    title: "Apply a coupon to the cart",
    description:
      "Apply a coupon/certificate code to the buyer's cart and report what the cart says — the honest way to check that a code (from horoshop_admin_coupons_generate, or an existing record in entity \"coupons\") actually discounts anything. Measured end to end on a live store: cart 799 → 599 with a 25 % coupon, so the discount really is observable from here. " +
      "The cart must have a line first — a coupon on an empty cart proves nothing, and horoshop_cart_add refuses products that are out of stock (see its note). Pass an empty code to clear the coupon. Same transport caveat as horoshop_cart_add: on a store with a strict bot filter every code comes back rejected, so a \"not accepted\" is only evidence when the same session can add to the cart at all.",
    inputSchema: {
      ...storeField,
      code: z.string().describe("Coupon or certificate code."),
    },
    annotations: { readOnlyHint: false },
    handler: async (client, args) => {
      const r = await client.shop.cartCoupon(args.store, args.code);
      const cart = summarize(r.response);
      return {
        status: r.status,
        cart,
        applied: !!cart.coupon,
        note: cart.coupon ? `Coupon "${cart.coupon}" is on the cart.` : "The cart came back without a coupon — the code was not accepted.",
      };
    },
  },
  {
    name: "horoshop_checkout_inspect",
    title: "Inspect the checkout page",
    description:
      "Fetch the checkout page as the buyer with the current cart and report what it offers: which delivery and payment options are actually rendered, and the cart lines it shows. An empty cart redirects to the home page — add something first. This is how to verify that enabling/disabling a payment or delivery option in the admin reached the place where money changes hands. Caveat as in horoshop_cart_add: the buyer session's User-Agent is a fixed non-browser string, so a store with a strict bot filter can answer the challenge page instead of the checkout and the option list comes back empty — that is the filter talking, not the checkout configuration.",
    inputSchema: { ...storeField },
    annotations: { readOnlyHint: true },
    handler: async (client, args) => {
      const cart = await client.shop.cartInit(args.store);
      const summary = summarize(cart.response);
      const page = await client.shop.page(args.store, "/checkout/");
      if (page.httpStatus !== 200) {
        return {
          httpStatus: page.httpStatus,
          cart: summary,
          reachable: false,
          note: summary.count === 0
            ? "Checkout redirected: the cart is empty. Add a product with horoshop_cart_add first."
            : `Checkout returned HTTP ${page.httpStatus}.`,
        };
      }
      // The checkout offers delivery and payment as two selects whose option ids
      // are the same ids horoshop_delivery_export / horoshop_payment_export use,
      // so the two lists can be compared directly.
      const delivery = selectOptions(page.html, "Delivery[delivery_type]");
      const payment = selectOptions(page.html, "Payment[payment_type]");
      return {
        httpStatus: 200,
        reachable: true,
        size: page.html.length,
        cart: summary,
        delivery,
        payment,
        note:
          `Checkout offers ${delivery.length} delivery and ${payment.length} payment option(s). These ids match horoshop_delivery_export / horoshop_payment_export — anything enabled there but missing here never reached the buyer.`,
      };
    },
  },
];
