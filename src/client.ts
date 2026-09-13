import type { ResolvedConfig, StoreConfig } from "./config.js";
import { AdminClient } from "./admin/session.js";
import { StorefrontClient } from "./admin/storefront.js";

/** Horoshop tokens live for 600 s; refresh a little early to avoid races. */
const TOKEN_TTL_MS = 600_000;
const TOKEN_SAFETY_MS = 30_000;

export class HoroshopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HoroshopError";
  }
}

interface TokenEntry {
  token: string;
  issuedAt: number;
}

interface HttpResult {
  httpStatus: number;
  body: any;
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

export class HoroshopClient {
  private readonly tokens = new Map<string, TokenEntry>();
  private adminClient?: AdminClient;
  private shopClient?: StorefrontClient;

  constructor(private readonly cfg: ResolvedConfig) {}

  /**
   * Admin-panel access (control-panel session, not the /api/ token) for the
   * operations the documented API cannot perform — page/category SEO and body
   * text, coupons, banners. Constructed lazily on first use.
   */
  get admin(): AdminClient {
    return (this.adminClient ??= new AdminClient(this.cfg, (store) => this.resolveStore(store)));
  }

  /**
   * The storefront as a buyer sees it: cart and checkout. Neither exists in the
   * documented `/api/` nor in the admin — the cart is a widget only the shop's
   * own JavaScript talks to. Constructed lazily; keeps a session (and therefore
   * a cart) per store.
   */
  get shop(): StorefrontClient {
    return (this.shopClient ??= new StorefrontClient(this.cfg, (store) => this.resolveStore(store)));
  }

  /** Public, credential-free view of configured stores (for discovery tools). */
  listStores(): Array<{ name: string; baseUrl: string; isDefault: boolean }> {
    return Object.entries(this.cfg.stores).map(([name, conf]) => ({
      name,
      baseUrl: conf.baseUrl,
      isDefault: name === this.cfg.defaultStore,
    }));
  }

  resolveStore(store?: string): { name: string; conf: StoreConfig } {
    const names = Object.keys(this.cfg.stores);
    if (names.length === 0) {
      throw new HoroshopError(
        "No Horoshop stores are configured. Set HOROSHOP_STORES (JSON) or HOROSHOP_STORES_FILE for the server.",
      );
    }
    const name = store ?? this.cfg.defaultStore;
    if (!name) {
      throw new HoroshopError(
        `No store specified and no default is set. Pass "store" as one of: [${names.join(", ")}].`,
      );
    }
    const conf = this.cfg.stores[name];
    if (!conf) {
      throw new HoroshopError(
        `Unknown store "${name}". Configured stores: [${names.join(", ")}].`,
      );
    }
    return { name, conf };
  }

  /**
   * Call any Horoshop API function. Handles token acquisition/caching and a
   * single transparent re-auth if the token expired mid-flight. Returns the
   * parsed response body (`{ status, response }`) for the caller to shape.
   */
  async call(
    store: string | undefined,
    func: string,
    params: Record<string, unknown> = {},
    method: "POST" | "PUT" = "POST",
  ): Promise<any> {
    const { name, conf } = this.resolveStore(store);

    let token = await this.getToken(name, conf);
    let result = await this.http(conf, func, { token, ...params }, method);

    if (this.isAuthError(result)) {
      token = await this.getToken(name, conf, true);
      result = await this.http(conf, func, { token, ...params }, method);
    }

    this.assertOk(name, func, result);
    return result.body;
  }

  /** Authenticate against a store, caching the resulting token. */
  private async authenticate(name: string, conf: StoreConfig): Promise<string> {
    const result = await this.http(
      conf,
      "auth",
      { login: conf.login, password: conf.password },
      "POST",
    );
    const token = result.body?.response?.token;
    if (result.body?.status !== "OK" || typeof token !== "string") {
      const reason =
        result.body?.response?.message ??
        "login/password rejected by the store";
      throw new HoroshopError(
        `Authentication failed for store "${name}" (${hostOf(conf.baseUrl)}): ${reason}`,
      );
    }
    this.tokens.set(name, { token, issuedAt: Date.now() });
    return token;
  }

  private async getToken(
    name: string,
    conf: StoreConfig,
    forceRefresh = false,
  ): Promise<string> {
    const cached = this.tokens.get(name);
    const fresh =
      cached && Date.now() - cached.issuedAt < TOKEN_TTL_MS - TOKEN_SAFETY_MS;
    if (!forceRefresh && fresh) return cached!.token;
    return this.authenticate(name, conf);
  }

  private async http(
    conf: StoreConfig,
    func: string,
    payload: Record<string, unknown>,
    method: "POST" | "PUT",
  ): Promise<HttpResult> {
    const url = `${conf.baseUrl}/api/${func}/`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (e) {
      const cause = (e as Error).name === "AbortError"
        ? `request timed out after ${this.cfg.timeoutMs} ms`
        : (e as Error).message;
      throw new HoroshopError(
        `Network error calling ${func} on ${hostOf(conf.baseUrl)}: ${cause}`,
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let body: any = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        if (!res.ok) {
          throw new HoroshopError(
            `HTTP ${res.status} from ${func} on ${hostOf(conf.baseUrl)}: ${text.slice(0, 200)}`,
          );
        }
        throw new HoroshopError(
          `Non-JSON response from ${func} on ${hostOf(conf.baseUrl)}: ${text.slice(0, 200)}`,
        );
      }
    }
    return { httpStatus: res.status, body };
  }

  private isAuthError({ httpStatus, body }: HttpResult): boolean {
    if (httpStatus === 401) return true;
    if (body?.status === "ERROR" || body?.status === "HTTP_ERROR") {
      const msg = String(
        body?.response?.message ?? body?.response ?? "",
      ).toLowerCase();
      return /unauthor|not authorized|invalid token|token|авториз|токен/.test(
        msg,
      );
    }
    return false;
  }

  /**
   * Horoshop statuses: OK / EMPTY / WARNING are all non-fatal (WARNING carries a
   * per-record log on imports; EMPTY just means no data). ERROR / EXCEPTION /
   * HTTP_ERROR are fatal.
   *
   * EVERYTHING ELSE IS FATAL TOO. `UNDEFINED_FUNCTION` used to fall through this
   * check — HTTP 200, unrecognised status, empty `response` — and reached the
   * caller as a successful result with no data. "This store has no order
   * statuses" and "this store does not implement the method" are different
   * facts, and letting the second masquerade as the first put a wrong number in
   * a client report. An unknown status is an error until proven otherwise.
   */
  private assertOk(name: string, func: string, { httpStatus, body }: HttpResult): void {
    const status = body?.status;
    if (status === "OK" || status === "EMPTY" || status === "WARNING") return;

    if (status === "UNDEFINED_FUNCTION") {
      throw new HoroshopError(
        `Method ${func} is not supported on store "${name}" (UNDEFINED_FUNCTION). ` +
          `The store answered HTTP 200 with an empty response — this is a fact about the API, not about the store's data: do not read it as "no records".`,
      );
    }

    if (status === "HTTP_ERROR") {
      const code = body?.response?.code ?? "";
      const msg = String(body?.response?.message ?? "");
      const hint = /payload is not json/i.test(msg)
        ? " — validate the JSON, ensure UTF-8 with no BOM"
        : "";
      throw new HoroshopError(
        `Horoshop HTTP_ERROR ${code} on ${func} @ ${name}: ${msg}${hint}`,
      );
    }
    if (status === "ERROR" || status === "EXCEPTION") {
      const detail =
        body?.response?.message ?? JSON.stringify(body?.response ?? {});
      throw new HoroshopError(`Horoshop ${status} on ${func} @ ${name}: ${detail}`);
    }
    if (httpStatus < 200 || httpStatus >= 300) {
      throw new HoroshopError(
        `HTTP ${httpStatus} on ${func} @ ${name}: ${JSON.stringify(body).slice(0, 200)}`,
      );
    }
    if (typeof status === "string" && status !== "") {
      throw new HoroshopError(
        `Horoshop answered ${status} on ${func} @ ${name} (HTTP ${httpStatus}) — not a success status. ` +
          `Only OK / EMPTY / WARNING mean the call worked; treat this as a failed call, not as empty data. ` +
          `Response: ${JSON.stringify(body?.response ?? {}).slice(0, 200)}`,
      );
    }
    // A 2xx body with no status field at all (some endpoints answer bare JSON) —
    // nothing to assert on; let the caller inspect it.
  }
}
