import type { ResolvedConfig, StoreConfig } from "../config.js";
import { HoroshopError } from "../client.js";
import { BROWSER_UA } from "./ua.js";

/**
 * Drives the storefront as a buyer would: cart and checkout.
 *
 * Neither is in the documented `/api/` (it answers UNDEFINED_FUNCTION for
 * "cart") and neither is in the admin — the cart is a widget the shop's own
 * JavaScript talks to, so this is the only way to exercise the funnel that
 * actually takes the money.
 *
 * Three things gate it, all learned on a live store:
 *  1. A PoW anti-bot: the first response is a 518-byte script that sets
 *     `challenge_passed=<hash>` and reloads. The hash is inline, so we read it
 *     and send the cookie ourselves. NOTE: HTTP 200 alone proves nothing here —
 *     the challenge itself is served with 200.
 *  2. A per-page CSRF token, `GLOBAL_CSRF_TOKEN`, inline in every storefront
 *     page. It must go in the `X-CSRF-Token` HEADER; as a form field the widget
 *     answers BAD_CSRF.
 *  3. A session cookie that carries the cart between calls.
 */

interface Shopper {
  cookies: Map<string, string>;
  csrf?: string;
}

export interface CartResult {
  status: string;
  response: any;
}

const CART_WIDGET_ID = "1";

export class StorefrontClient {
  private readonly shoppers = new Map<string, Shopper>();

  constructor(
    private readonly cfg: ResolvedConfig,
    private readonly resolve: (store?: string) => { name: string; conf: StoreConfig },
  ) {}

  /** Drop the cached buyer session (and its cart) for a store. */
  reset(store?: string): void {
    const { name } = this.resolve(store);
    this.shoppers.delete(name);
  }

  /** Cart contents + totals, as the shop's own widget sees them. */
  async cartInit(store?: string): Promise<CartResult> {
    return this.cart(store, "init", {});
  }

  /**
   * Put a product in the cart. `type` is the cart item type the shop registers —
   * plain catalog products are "product"; the server rejects anything else with
   * "Type 'x' is not registered", and omitting it with "INCORRECT VALUE".
   */
  async cartAppend(
    store: string | undefined,
    product: { id: string | number; quantity?: number; type?: string },
  ): Promise<CartResult> {
    return this.cart(store, "appendProduct", {
      "product[id]": String(product.id),
      "product[type]": product.type ?? "product",
      "product[quantity]": String(product.quantity ?? 1),
    });
  }

  /** Change a line's quantity. `hash` comes from the cart's items map. */
  async cartSetQuantity(store: string | undefined, hash: string, quantity: number): Promise<CartResult> {
    return this.cart(store, "setProductQuantityByHash", { hash, quantity: String(quantity) });
  }

  /** Remove a line by its hash. */
  async cartRemove(store: string | undefined, hash: string): Promise<CartResult> {
    return this.cart(store, "removeProductByHash", { hash });
  }

  /** Apply a coupon/certificate code to the cart. */
  async cartCoupon(store: string | undefined, code: string): Promise<CartResult> {
    return this.cart(store, "setCouponCode", { code, skin: "" });
  }

  /** Fetch a storefront page through the anti-bot, as the buyer's session. */
  async page(store: string | undefined, path: string): Promise<{ httpStatus: number; html: string }> {
    const { name, conf } = this.resolve(store);
    const s = await this.shopper(name, conf);
    const res = await this.get(conf, path, s);
    const html = await res.text();
    return { httpStatus: res.status, html };
  }

  private async cart(
    store: string | undefined,
    action: string,
    data: Record<string, string>,
  ): Promise<CartResult> {
    const { name, conf } = this.resolve(store);
    const s = await this.shopper(name, conf);
    const body = new URLSearchParams({ id: CART_WIDGET_ID, ...data });
    const res = await this.fetch(conf, `/_widget/ajax_cart/${action}/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "XMLHttpRequest",
        "X-CSRF-Token": s.csrf ?? "",
        Cookie: this.cookieHeader(s),
      },
      body: body.toString(),
    });
    this.absorb(s, res);
    const text = await res.text();
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new HoroshopError(
        `Cart "${action}" did not return JSON (HTTP ${res.status}). The storefront may have served the anti-bot challenge instead: ${text.slice(0, 120)}`,
      );
    }
    if (parsed.status === "BAD_CSRF") {
      // Token rotates with the page; refresh once and retry.
      await this.refreshCsrf(conf, s);
      const retry = await this.fetch(conf, `/_widget/ajax_cart/${action}/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Requested-With": "XMLHttpRequest",
          "X-CSRF-Token": s.csrf ?? "",
          Cookie: this.cookieHeader(s),
        },
        body: body.toString(),
      });
      this.absorb(s, retry);
      parsed = JSON.parse(await retry.text());
    }
    return { status: parsed.status ?? "?", response: parsed.response };
  }

  /** Establish a buyer session: pass the PoW challenge and grab a CSRF token. */
  private async shopper(name: string, conf: StoreConfig): Promise<Shopper> {
    const cached = this.shoppers.get(name);
    if (cached?.csrf) return cached;
    const s: Shopper = cached ?? { cookies: new Map() };
    this.shoppers.set(name, s);
    await this.refreshCsrf(conf, s);
    return s;
  }

  private async refreshCsrf(conf: StoreConfig, s: Shopper): Promise<void> {
    const res = await this.get(conf, "/", s);
    const html = await res.text();
    const token = html.match(/GLOBAL_CSRF_TOKEN:\s*'([a-f0-9]+)'/i)?.[1];
    if (!token) {
      throw new HoroshopError(
        "No GLOBAL_CSRF_TOKEN on the storefront home page — cannot drive the cart. The page may be behind an anti-bot that did not clear.",
      );
    }
    s.csrf = token;
  }

  /** GET a page, clearing the PoW challenge if it is served. */
  private async get(conf: StoreConfig, path: string, s: Shopper): Promise<Response> {
    let res = await this.fetch(conf, path, { headers: { Cookie: this.cookieHeader(s) } });
    this.absorb(s, res);
    const body = await res.clone().text();
    const challenge = body.match(/defaultHash\s*=\s*"([a-f0-9]+)"/)?.[1];
    if (challenge) {
      // The "PoW" is theatre: the page burns a random 0.8–1.3 s in a loop and
      // then sets a hash that is already in the markup. Setting it is enough.
      s.cookies.set("challenge_passed", challenge);
      res = await this.fetch(conf, path, { headers: { Cookie: this.cookieHeader(s) } });
      this.absorb(s, res);
    }
    return res;
  }

  private cookieHeader(s: Shopper): string {
    return [...s.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  private absorb(s: Shopper, res: Response): void {
    const anyHeaders = res.headers as unknown as { getSetCookie?: () => string[] };
    const raw = typeof anyHeaders.getSetCookie === "function"
      ? anyHeaders.getSetCookie()
      : ((h) => (h ? [h] : []))(res.headers.get("set-cookie"));
    for (const line of raw) {
      const first = line.split(";", 1)[0];
      const eq = first.indexOf("=");
      if (eq <= 0) continue;
      s.cookies.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
    }
  }

  private async fetch(conf: StoreConfig, path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    try {
      return await fetch(`${conf.baseUrl}${path}`, {
        ...init,
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": BROWSER_UA,
          ...(init.headers ?? {}),
        },
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
