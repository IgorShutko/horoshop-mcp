import type { ResolvedConfig, StoreConfig } from "../config.js";
import { HoroshopError } from "../client.js";
import {
  CHECKCODE,
  buildMultipart,
  buildUrlencoded,
  parseBookValues,
  parseTemplateSchema,
  parseEditForm,
  parseGridColumns,
  parseGridRows,
  parseGridPager,
  parseRedirects,
  relabelGridRows,
  type BookValue,
  type GridColumn,
  type MultipartFile,
  type TemplateGroup,
  type GridRow,
  type ParsedForm,
  type RedirectTarget,
} from "./form.js";
import { withNetworkRetry } from "./retry.js";
import { redactSecrets } from "./redact.js";
import { BROWSER_UA } from "./ua.js";


/**
 * A record's editor address in the legacy admin. The admin is one uniform
 * machine keyed on `handler` (the entity-type id): `data.php?handler=H` lists,
 * `edit.php?id=X&handler=H` edits, `save.php` persists.
 */
export interface EditTarget {
  /** Numeric record id, or "addnew"/"0" to open a create form. */
  id: string | number;
  /** Entity-type id (e.g. 4 = site pages, 263 = coupons, 394 = banners). */
  handler: number;
  handlertable?: string;
  /** Extra query params (e.g. parent). */
  extra?: Record<string, string | number>;
  /** Valueless query flags the editor expects (e.g. showPages). */
  flags?: string[];
}

/**
 * A grid listing that could NOT be completed — the walk collected fewer rows
 * than the grid's own pager declares, and not because a cap stopped it.
 *
 * Attached to `listRecords`' result (and to `searchRecords`') alongside
 * `truncated:true`. See the D1 block inside `listRecords` for the mechanism.
 */
export interface GridIncomplete {
  /** Rows the grid says it holds. */
  expected: number;
  /** Rows actually in hand. */
  collected: number;
  missing: number;
  /** Unstable page ordering (rows evicted across page boundaries), not a cap. */
  cause: "grid-drift";
  repair: { passes: number; requests: number; recovered: number; windows?: number[] };
  /** Ready-to-read explanation — this is what makes the shortfall loud. */
  note: string;
}

/**
 * What the drift repair had to do. Present ONLY when the first walk came back
 * short — so its mere presence is the measurement that the grid drifted, and
 * `recovered === lostOnFirstWalk` means the list is complete after all.
 */
export interface GridDriftRepair {
  passes: number;
  /** Extra page renders spent. */
  requests: number;
  recovered: number;
  /** Rows the plain single walk would have silently dropped. */
  lostOnFirstWalk: number;
  /** Page sizes the repair re-rolled the boundaries at, in order. */
  windows?: number[];
}

/** Repair rounds (sweeps) over the grid before a shortfall is reported as final. */
const GRID_REPAIR_MAX_PASSES = 8;
/** Default ceiling on the extra page fetches a repair may spend (~0.55 s each). */
const GRID_REPAIR_MAX_REQUESTS = 60;
/**
 * Page sizes the repair re-rolls the boundaries at, widest first.
 *
 * The point is that they DIFFER from the walk's own window. Re-rendering the
 * same geometry re-rolls the same lottery — the boundaries fall in the same
 * places, so a row that slipped through a seam has the same small chance of
 * being served again. Changing the window moves every seam: a row stuck at the
 * page-7/8 boundary of a 20-row window sits mid-page at a 160-row one. A wide
 * sweep is also ~8× cheaper, so the same budget buys many more independent
 * re-rolls.
 */
const GRID_REPAIR_WINDOWS = [160, 96, 64];
/** Full re-rolls at the widest window the budget should be able to afford. */
const GRID_REPAIR_SWEEPS = 4;

/**
 * How many extra page renders a repair may spend.
 *
 * `computed` is what the shape of THIS grid asks for. `HOROSHOP_GRID_REPAIR_MAX`
 * overrides it OUTRIGHT, in both directions — it used to be folded in with
 * `Math.min`, which meant raising it changed nothing at all (on a 27-page walk
 * the computed 58 always won, so `=200` and the default were the same run).
 */
function gridRepairBudget(computed: number): number {
  const env = Number(process.env.HOROSHOP_GRID_REPAIR_MAX);
  if (Number.isFinite(env) && env >= 0) return env;
  return Math.min(computed, GRID_REPAIR_MAX_REQUESTS);
}

interface Session {
  cookies: Map<string, string>;
  /**
   * Whether this session has already loaded a real `/adminLegacy/*` page.
   *
   * The core-api login hands back API_SESSION_ID, and that is enough for the
   * legacy grids, for `/core-api/*` and for `/marketplace-integration/*` — but
   * NOT for the price-list import sub-app: measured on the test store, a session
   * whose very first request is `POST /priceListImport/settings/getAvailableSettings`
   * gets the storefront 404 page back (and, with X-Requested-With, a JSON
   * `{status:"HTTP_ERROR",response:{code:404}}`), while the identical POST after
   * ANY `/adminLegacy/…` GET answers `{status:"OK"}`. The PHP session has to be
   * promoted by a legacy page load first. `ensureLegacySession` does exactly one
   * such GET per session and records it here; a re-login drops the flag with the
   * session object it belongs to.
   */
  legacyWarmed?: boolean;
}

function parseSetCookie(res: Response): string[] {
  const anyHeaders = res.headers as unknown as { getSetCookie?: () => string[] };
  if (typeof anyHeaders.getSetCookie === "function") return anyHeaders.getSetCookie();
  const single = res.headers.get("set-cookie");
  return single ? [single] : [];
}

/** The store's custom CSS, plus where it came from — see getClientStyles. */
export interface ClientStyles {
  desktop: string;
  mobile: string;
  /** False when the store has no client-styles editor: the values are UNKNOWN, not empty. */
  available: boolean;
  source: "legacy-ace-editor" | "unavailable";
  note?: string;
}

/**
 * Inner HTML of the element carrying `id`, with the tag nesting balanced.
 * Returns null when there is no such element. A non-greedy `([\s\S]*?)</div>`
 * stops at the FIRST close tag, which is the wrong one whenever the element has
 * children — and the ACE mounts always do.
 */
export function extractElementById(html: string, id: string): string | null {
  const open = new RegExp(`<([a-z][\\w-]*)((?:[^>]*?\\s)?id=["']${id}["'][^>]*)>`, "i");
  const m = open.exec(html);
  if (!m) return null;
  if (/\/>$/.test(m[0])) return "";
  const tag = m[1];
  const start = m.index + m[0].length;
  const scan = new RegExp(`<(/?)${tag}\\b([^>]*)>`, "gi");
  scan.lastIndex = start;
  let depth = 1;
  let t: RegExpExecArray | null;
  while ((t = scan.exec(html))) {
    if (t[1] === "/") {
      if (--depth === 0) return html.slice(start, t.index);
    } else if (!/\/$/.test(t[2])) {
      depth++;
    }
  }
  // Unbalanced markup: fall back to everything after the opening tag rather than
  // silently returning "" (which a caller could mistake for "no CSS").
  return html.slice(start);
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X"
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * The CSS an ACE mount was seeded with: strip the wrapper markup, then decode
 * the entities the page escaped it with. Skipping the decode round-trips a child
 * combinator as `&gt;` and breaks the rule on save.
 */
export function cleanEditorSeed(raw: string | null): string {
  if (raw === null) return "";
  return decodeEntities(raw.replace(/<[^>]*>/g, "")).trim();
}

/**
 * Talks to the admin panel behind a real login session, which the documented
 * `/api/` layer cannot reach. Auth is a cookie session obtained from the
 * internal `core-api` login (same store credentials); `API_SESSION_ID` is the
 * master cookie, `REMEMBERME` a 7-day refresh. Sessions are cached per store
 * and re-established transparently on a 401.
 */
export class AdminClient {
  private readonly sessions = new Map<string, Session>();
  /** store → (navigation leaf `name` → legacy handler id). Filled lazily, see entityForStore. */
  private readonly navHandlers = new Map<string, Map<string, number> | null>();

  constructor(
    private readonly cfg: ResolvedConfig,
    private readonly resolve: (store?: string) => { name: string; conf: StoreConfig },
  ) {}

  /**
   * Per-store handler for an entity whose number MOVES between stores.
   *
   * Measured: the menu leaf `settings_vchasno_payment_types` is
   * `data.php?handler=458` on one store and `468` on two others, and both grids
   * are byte-identical (18 rows, same ids and labels). Reading the wrong number
   * returns an EMPTY grid with no error — a false OK, the defect class this
   * project keeps getting bitten by. `/core-api/admin/navigation` is the fix:
   * `name` and `url` are identical across stores AND across interface languages
   * (ru «способы оплаты» / uk «способи оплати»), only `old_admin_url` moves.
   *
   * Costs nothing for the other 51 entities: without `navName` this returns the
   * entity untouched and makes no request. If navigation is unreachable or the
   * leaf is missing, it falls back to the registered number — i.e. exactly the
   * previous behaviour, never worse.
   */
  async entityForStore<T extends { handler: number; navName?: string }>(store: string | undefined, ent: T): Promise<T> {
    if (!ent.navName) return ent;
    const { name } = this.resolve(store);
    if (!this.navHandlers.has(name)) {
      try {
        const res = await this.getJson(store, "/core-api/admin/navigation");
        const map = new Map<string, number>();
        const walk = (nodes: any[]): void => {
          for (const n of nodes ?? []) {
            if (n?.children?.length) walk(n.children);
            const m = String(n?.old_admin_url ?? "").match(/data\.php\?handler=(\d+)/);
            if (m && n?.name) map.set(String(n.name), Number(m[1]));
          }
        };
        walk(res.body?.payload?.navigation ?? res.body?.navigation ?? []);
        this.navHandlers.set(name, map.size ? map : null);
      } catch {
        this.navHandlers.set(name, null);
      }
    }
    const found = this.navHandlers.get(name)?.get(ent.navName);
    return found && found !== ent.handler ? { ...ent, handler: found } : ent;
  }

  /**
   * Fetch the raw bytes of an absolute URL (an image to upload, or an existing
   * storefront asset to snapshot for a net-zero restore). No session cookies —
   * these are public assets — but it honours the same timeout as store calls.
   */
  async fetchBytes(url: string): Promise<{ bytes: Uint8Array; contentType: string | null; httpStatus: number }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal, redirect: "follow" });
      const buf = new Uint8Array(await res.arrayBuffer());
      return { bytes: buf, contentType: res.headers.get("content-type"), httpStatus: res.status };
    } catch (e) {
      const cause =
        (e as Error).name === "AbortError"
          ? `request timed out after ${this.cfg.timeoutMs} ms`
          : (e as Error).message;
      throw new HoroshopError(`Failed to fetch bytes from ${url}: ${cause}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Verify that an uploaded asset PATH actually resolves to a real image on the
   * storefront CDN — the fix for "uploaded:true" lying. Horoshop's cover/logo
   * pipeline can register a `/content/…jpg` path in the DB while the file itself
   * is 404 / 0 bytes (notably when fed a WEBP source). Re-reading the form only
   * proves the path CHANGED, not that the file EXISTS, so writers additionally
   * call this: it fetches the path (public asset, resolved against the store's
   * baseUrl) and reports whether it is a real, non-empty image response.
   */
  async verifyAsset(
    store: string | undefined,
    path: string,
  ): Promise<{ ok: boolean; httpStatus: number; contentType: string | null; bytes: number; url: string }> {
    const { conf } = this.resolve(store);
    const url = /^https?:\/\//i.test(path)
      ? path
      : `${conf.baseUrl}${path.startsWith("/") ? "" : "/"}${path}`;
    try {
      const r = await this.fetchBytes(url);
      const ct = r.contentType ? r.contentType.split(";")[0].trim() : null;
      const ok = r.httpStatus >= 200 && r.httpStatus < 300 && r.bytes.length > 0 && (ct ? /^image\//i.test(ct) : true);
      return { ok, httpStatus: r.httpStatus, contentType: ct, bytes: r.bytes.length, url };
    } catch {
      return { ok: false, httpStatus: 0, contentType: null, bytes: 0, url };
    }
  }

  /**
   * Fetch a storefront asset and hand back its BYTES, not just a verdict.
   *
   * verifyAsset answers "does this path serve an image"; this answers "give me
   * the image". It exists for one job: capturing the picture a media-field
   * replace is about to destroy. Replacing a filled field overwrites the file at
   * the previous path (measured on the test store), and `[value]` is not writable, so the
   * old image cannot be recovered afterwards — it has to be taken BEFORE.
   */
  async fetchAsset(
    store: string | undefined,
    path: string,
  ): Promise<{ ok: boolean; httpStatus: number; contentType: string | null; bytes: Uint8Array; url: string }> {
    const { conf } = this.resolve(store);
    const url = /^https?:\/\//i.test(path) ? path : `${conf.baseUrl}${path.startsWith("/") ? "" : "/"}${path}`;
    try {
      const r = await this.fetchBytes(url);
      const ct = r.contentType ? r.contentType.split(";")[0].trim() : null;
      return { ok: r.httpStatus >= 200 && r.httpStatus < 300 && r.bytes.length > 0, httpStatus: r.httpStatus, contentType: ct, bytes: r.bytes, url };
    } catch {
      return { ok: false, httpStatus: 0, contentType: null, bytes: new Uint8Array(), url };
    }
  }

  /**
   * Who the cached/fresh session authenticates as (login, role). The payload also
   * carries `auth_token` - the admin session's live JWT - so it is masked here:
   * an answer that reaches the agent must never carry a usable credential.
   */
  async whoAmI(store?: string): Promise<unknown> {
    const { name, conf } = this.resolve(store);
    const res = await this.fetchSession(name, conf, "/core-api/admin/security/logged_user", {
      headers: { Accept: "application/json" },
    });
    const body: any = await res.json().catch(() => ({}));
    return redactSecrets(body?.payload ?? body);
  }

  /**
   * Read the dynamic parameter spec for a banner template+section+page combo.
   * The banner editor renders its `settings[…]` fields client-side from this
   * widget: `GET /_widget/horoshop_banners_widget/loadSettings/?template=&section=&page=`
   * → `{status:"OK", response:{settings:{id,title,data:{PARAM:{type,name,…}}}}}`.
   * The `data` map is the authoritative list of fields for the combo — crucially
   * it names the image field (`image`) and its target size. (No `/adminLegacy`
   * prefix — this route is served at web root.)
   *
   * Returns the HTTP status together with the parsed JSON: a `res.json().catch`
   * that swallowed the status made an HTTP 400 (theme rejects this
   * template/section/page) indistinguishable from a valid 200 body that simply
   * lacks an image parameter. The caller needs both to explain the failure.
   */
  async bannerLoadSettings(
    store: string | undefined,
    template: string,
    section: string,
    page: string | number,
  ): Promise<{ httpStatus: number; json: any }> {
    const { name, conf } = this.resolve(store);
    const qs = new URLSearchParams({ template, section, page: String(page) }).toString();
    const res = await this.fetchSession(
      name,
      conf,
      `/_widget/horoshop_banners_widget/loadSettings/?${qs}`,
      { headers: { Accept: "application/json" } },
    );
    if (res.status === 401) {
      throw new HoroshopError(`Admin session rejected (401) for "${name}".`);
    }
    const json = await res.json().catch(() => ({}));
    return { httpStatus: res.status, json };
  }

  /**
   * GET the raw HTML of an admin page (no form parsing). Used to read back
   * non-input content the form parser drops — e.g. a banner's image preview
   * block (`data-remove="image"` + the `/content/…` src) that proves an upload
   * landed. Same authenticated session as every other admin call.
   */
  async getAdminHtml(
    store: string | undefined,
    path: string,
    redirect: RequestRedirect = "follow",
  ): Promise<{ status: number; html: string; location: string | null }> {
    const { name, conf } = this.resolve(store);
    const res = await this.fetchSession(name, conf, path, { headers: { Accept: "text/html" } }, redirect);
    if (res.status === 401) {
      throw new HoroshopError(`Admin session rejected (401) for "${name}".`);
    }
    return { status: res.status, html: await res.text(), location: res.headers.get("location") };
  }

  /**
   * POST an urlencoded body to an arbitrary admin path and hand back the raw
   * outcome (status + Location + body), without any form parsing.
   *
   * The order editor needs this and the existing writers cannot serve it: `save`
   * posts multipart to save.php, `saveViaRoute` needs a ParsedForm, and
   * `widgetPost` follows redirects and insists on JSON. An order's status change
   * is a bare `changeStatus/status/return_quantity` POST to edit.php that answers
   * **302 with no body** — following that redirect hides the only signal there is,
   * so callers pass redirect:"manual" and read `location` themselves.
   */
  async postUrlencoded(
    store: string | undefined,
    path: string,
    params: Record<string, string | string[]>,
    opts: { redirect?: RequestRedirect; accept?: string } = {},
  ): Promise<{ httpStatus: number; location: string | null; text: string }> {
    const { name, conf } = this.resolve(store);
    // An array value repeats the key (`ids[]=1&ids[]=2`) — the warehouse ledger
    // is asked for several products in one call that way.
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (Array.isArray(v)) for (const one of v) body.append(k, one);
      else body.append(k, v);
    }
    const res = await this.fetchSession(
      name,
      conf,
      path,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: opts.accept ?? "text/html",
          "X-Requested-With": "XMLHttpRequest",
        },
        body: body.toString(),
      },
      opts.redirect ?? "manual",
    );
    if (res.status === 401) {
      throw new HoroshopError(`Admin session rejected (401) for "${name}".`);
    }
    return { httpStatus: res.status, location: res.headers.get("location"), text: await res.text() };
  }

  /**
   * Promote the PHP session by loading one real legacy page. Idempotent per
   * session and skipped once done — see `Session.legacyWarmed` for why the
   * price-list import sub-app needs it. `/adminLegacy/index.php` answers 302
   * (it bounces to the dashboard), which is enough: the session is promoted by
   * the request, not by the body.
   */
  private async ensureLegacySession(name: string, conf: StoreConfig): Promise<void> {
    if (this.sessions.get(name)?.legacyWarmed) return;
    await this.fetchSession(name, conf, "/adminLegacy/index.php", { headers: { Accept: "text/html" } }, "manual");
    const sess = this.sessions.get(name);
    if (sess) sess.legacyWarmed = true;
  }

  /**
   * POST a JSON body to an admin route and hand back the parsed envelope.
   *
   * The Vue sub-apps (marketplace feeds, price-list import) speak JSON, not the
   * urlencoded/multipart of the legacy editors, and they answer
   * `{status, response}` with `status ∈ {OK, EXCEPTION, VALIDATION_ERROR,
   * HTTP_ERROR}` — an application-level status that is INDEPENDENT of the HTTP
   * code: a rejected URL is `HTTP 200` + `VALIDATION_ERROR`. Callers therefore
   * get both, plus the raw text for the cases where the answer is not JSON at
   * all (the storefront 404 page, which is what an unpromoted session gets).
   *
   * `warmLegacy` runs `ensureLegacySession` first — required for
   * `/priceListImport/*`, unnecessary for `/marketplace-integration/*`.
   */
  async postJson(
    store: string | undefined,
    path: string,
    payload: unknown,
    opts: { warmLegacy?: boolean } = {},
  ): Promise<{ httpStatus: number; status: string | null; response: any; body: any; text: string }> {
    const { name, conf } = this.resolve(store);
    if (opts.warmLegacy) await this.ensureLegacySession(name, conf);
    const res = await this.fetchSession(
      name,
      conf,
      path,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-Requested-With": "XMLHttpRequest",
        },
        body: JSON.stringify(payload ?? {}),
      },
      "manual",
    );
    if (res.status === 401) throw new HoroshopError(`Admin session rejected (401) for "${name}".`);
    const text = await res.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return {
      httpStatus: res.status,
      status: body?.status ?? null,
      response: body?.response ?? null,
      body,
      text,
    };
  }

  /**
   * GET a JSON route of the same Vue sub-apps (`…/params/<id>`,
   * `…/process/importProducts/?token=…`). Same envelope contract as `postJson`.
   */
  async getJson(
    store: string | undefined,
    path: string,
    opts: { warmLegacy?: boolean } = {},
  ): Promise<{ httpStatus: number; status: string | null; response: any; body: any; text: string }> {
    const { name, conf } = this.resolve(store);
    if (opts.warmLegacy) await this.ensureLegacySession(name, conf);
    const res = await this.fetchSession(
      name,
      conf,
      path,
      { headers: { Accept: "application/json", "X-Requested-With": "XMLHttpRequest" } },
      "manual",
    );
    if (res.status === 401) throw new HoroshopError(`Admin session rejected (401) for "${name}".`);
    const text = await res.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return { httpStatus: res.status, status: body?.status ?? null, response: body?.response ?? null, body, text };
  }

  /**
   * GET a plain-text admin route and report its content type — the feed
   * generator answers `text/html` with a 24-byte confirmation sentence, and the
   * public feed URL answers `text/xml` (or the 9 KB storefront 404 page when the
   * feed is off / not generated yet), so the content type is the only reliable
   * way to tell a real feed from a 404 body that also arrives with HTTP 200.
   */
  async getText(
    store: string | undefined,
    path: string,
  ): Promise<{ httpStatus: number; contentType: string | null; text: string }> {
    const { name, conf } = this.resolve(store);
    const res = await this.fetchSession(name, conf, path, { headers: { Accept: "*/*" } }, "follow");
    if (res.status === 401) throw new HoroshopError(`Admin session rejected (401) for "${name}".`);
    return {
      httpStatus: res.status,
      contentType: res.headers.get("content-type"),
      text: await res.text(),
    };
  }

  /**
   * GET an editor form and parse it into a replayable field set.
   *
   * Retried on a connection-level drop, like the datagrid walker: this GET is the
   * READ half of every writer's read-modify-write and of every verification
   * re-read, so one transient `fetch failed` here fails a save that was otherwise
   * fine (seen live: `record_save` reporting "Network error on edit.php" mid-run).
   * It is a GET — replaying it cannot double a write. `save()` is deliberately
   * NOT retried.
   */
  async getEditForm(store: string | undefined, target: EditTarget): Promise<ParsedForm & { url: string }> {
    const { name, conf } = this.resolve(store);
    const url = this.editUrl(target);
    return withNetworkRetry(async () => {
      const res = await this.fetchSession(name, conf, url, { headers: { Accept: "text/html" } });
      if (res.status === 401) {
        throw new HoroshopError(`Admin session rejected (401) for "${name}". Verify the store login/password.`);
      }
      const html = await res.text();
      return { ...parseEditForm(html), url };
    });
  }

  /**
   * Read an editor form rendered by an arbitrary admin URL (e.g. a utils
   * settings page) rather than the standard edit.php. The parsed form still
   * carries its own action (usually save.php) and hidden id/handler fields.
   */
  async getFormFromUrl(store: string | undefined, path: string): Promise<ParsedForm & { url: string }> {
    const { name, conf } = this.resolve(store);
    return withNetworkRetry(async () => {
      const res = await this.fetchSession(name, conf, path, { headers: { Accept: "text/html" } });
      if (res.status === 401) {
        throw new HoroshopError(`Admin session rejected (401) for "${name}".`);
      }
      return { ...parseEditForm(await res.text()), url: path };
    });
  }

  /**
   * Persist a patched form. Read-modify-write: pass the ParsedForm you read plus
   * an overrides map; every untouched field is resent. Returns the transport
   * outcome — callers should verify by re-reading the record.
   *
   * `files` attaches real uploads (logo/favicon/watermark/og, category cover…):
   * each is a `extra[<field>][file]` part carrying actual bytes. When present the
   * body is assembled as binary and the empty-file placeholder is dropped (the
   * real part takes its place). When absent this behaves exactly as before — a
   * plain-text multipart with an empty file part when the form has a file input.
   */
  async save(
    store: string | undefined,
    form: ParsedForm,
    overrides: Record<string, string>,
    files?: MultipartFile[],
  ): Promise<{ httpStatus: number; redirectedTo: string | null }> {
    const { name, conf } = this.resolve(store);
    const hasFiles = !!files && files.length > 0;
    const { boundary, body } = buildMultipart(form.fields, overrides, {
      emptyFileField: hasFiles ? undefined : form.hasFileInput ? "extra[image][file]" : undefined,
      files,
    });
    const action = form.action || "/adminLegacy/save.php";
    const res = await this.fetchSession(
      name,
      conf,
      action,
      {
        method: "POST",
        headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
        body,
      },
      "manual",
    );
    return { httpStatus: res.status, redirectedTo: res.headers.get("location") };
  }

  /**
   * Persist a patched form whose overrides may carry MULTI-VALUE fields (a value
   * that is an array is submitted as several repeated same-named parts). This is
   * the same read-modify-write as `save`, but its `overrides` type admits arrays
   * — needed for the indexed-filter `names[filters][]` multi-select, where a
   * single JSON key cannot express "brand AND price" as two conditions. Kept as a
   * separate method so `save` (which every other writer uses) is untouched; the
   * only new behaviour lives in buildMultipart's additive array branch. Scalar
   * overrides behave exactly like `save`.
   */
  async saveMulti(
    store: string | undefined,
    form: ParsedForm,
    overrides: Record<string, string | string[]>,
    files?: MultipartFile[],
  ): Promise<{ httpStatus: number; redirectedTo: string | null }> {
    const { name, conf } = this.resolve(store);
    const hasFiles = !!files && files.length > 0;
    const { boundary, body } = buildMultipart(form.fields, overrides, {
      emptyFileField: hasFiles ? undefined : form.hasFileInput ? "extra[image][file]" : undefined,
      files,
    });
    const action = form.action || "/adminLegacy/save.php";
    const res = await this.fetchSession(
      name,
      conf,
      action,
      {
        method: "POST",
        headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
        body,
      },
      "manual",
    );
    return { httpStatus: res.status, redirectedTo: res.headers.get("location") };
  }

  /**
   * Resolve the URL (slug) sub-tree parent for a page/category being saved.
   *
   * A page's slug is not a plain field: it is managed by the `zteel.params.url`
   * widget, which keeps its own p_name tree separate from the page tree. To write
   * `names[name][slug]` so it PERSISTS, the form must also carry
   * `names[name][parent]` = the p_name-row id of the PAGE parent — a value the
   * admin JS obtains by POSTing the page-parent id to this widget. Submitting a
   * slug WITHOUT it silently drops the slug (the storefront then 404s). This
   * mirrors that JS call: `POST /_widget/zteel_params_url_Param/updateUriManually/`
   * with the page-parent id and a slug seed, returning the name-row parent id and
   * a normalised (transliterated, latin-only) slug. Works for any parent, empty
   * ones included, so a category tree can be built top-down.
   *
   * `paramId` names which URL-param widget row the alias belongs to. Categories
   * use "1" (the default). Other entities keep their alias under a different
   * widget row — a filter PRESET's alias lives under param_id 5537 — so the caller
   * passes that id to get a non-empty parent. Additive: omit it and this behaves
   * exactly as before for every existing caller.
   */
  async resolveUrlParent(
    store: string | undefined,
    pageParentId: number | string,
    slugSeed: string,
    recordId: number | string = 0,
    paramId: number | string = "1",
  ): Promise<{ parent: string; slug: string; link?: string }> {
    const j = await this.widgetPost(store, "/_widget/zteel_params_url_Param/updateUriManually/", {
      slug: slugSeed,
      param_id: String(paramId),
      record_id: String(recordId),
      parent_id: String(pageParentId),
    });
    const r = j.body?.response ?? {};
    // The widget echoes the normalised slug wrapped in single quotes
    // (e.g. "'nova-katehoriia'"); strip them to the bare slug it will store.
    const rawSlug = r.slug != null ? String(r.slug) : "";
    const slug = rawSlug.replace(/^'+|'+$/g, "");
    const parent = r.parent != null ? String(r.parent) : "";
    return { parent, slug, link: r.link != null ? String(r.link).replace(/\\\//g, "/") : undefined };
  }

  /**
   * Remove an uploaded image from a media field (the admin's own `delImage`
   * flow). `POST js/lookup.php {load:removeImage, id:<recordId>, param:<fieldId>}`
   * — mirrors what clicking the trash icon on a logo/watermark/cover does. This
   * is the correct revert for a settings image: the field's `[id]` is a stable
   * row id, the picture lives in `[value]`, so removing (not re-pointing the id)
   * is how you clear it back to unset. Returns the lookup.php JSON outcome.
   */
  async removeImage(
    store: string | undefined,
    recordId: string | number,
    param: string | number,
  ): Promise<{ httpStatus: number; status?: string; message?: string }> {
    const { name, conf } = this.resolve(store);
    const body = new URLSearchParams({
      load: "removeImage",
      id: String(recordId),
      param: String(param),
      checkcode: CHECKCODE,
    }).toString();
    const res = await this.fetchSession(name, conf, "/adminLegacy/js/lookup.php", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body,
    });
    const j: any = await res.json().catch(() => ({}));
    return { httpStatus: res.status, status: j?.status, message: j?.response?.message };
  }

  /**
   * List an entity's records — ALL of them, across every grid page.
   *
   * The datagrid is two-phase and, crucially, **stateful server-side**: the shell
   * (`data.php`) renders nothing, and `ajax.datagrid.php` serves rows for the
   * grid's *current* page/perPage, which live in the session — the page/perPage
   * are NOT request query params on the reload (passing them does nothing, which
   * is exactly why this used to silently cap at 20 and every "net-zero" check was
   * blind to rows on pages 2+). The real controls the admin JS uses are:
   *   - `load=changePage & page=N` — render page N (and set it as current)
   *   - `load=datagridSetPerPage & value=N` — set the page size (and re-render)
   * Each returns the same row fragment, whose pager (`parseGridPager`) carries the
   * grand total. We read the total off page 1 and walk `changePage` to the last
   * page, so the caller gets the complete set.
   *
   * `opts.perPage` widens the window first (one `setPerPage`, then most entities
   * fit in a single fetch — presets/colors/brands are well under the 160 max);
   * omit it to page at the grid's native window with no session change (the
   * common ≤1-page entity then costs exactly one request, as before). `opts.page`
   * asks for one specific page only. `opts.maxRows` (default 5000) caps the walk
   * so a pathologically large grid (e.g. interface translations, 4000+) can't
   * spin thousands of requests; `truncated` is set on the result if the cap hit.
   *
   * Returns the rows with `total`/`truncated` attached (an array, so every
   * existing caller that just iterates it is unaffected).
   */
  async listRecords(
    store: string | undefined,
    handler: number,
    opts: { parent?: number; page?: number; perPage?: number; maxRows?: number } = {},
  ): Promise<GridRow[] & { total?: number; truncated?: boolean; incomplete?: GridIncomplete }> {
    const { name, conf } = this.resolve(store);
    const dataUrl = `/adminLegacy/data.php?handler=${handler}${opts.parent != null ? `&parent=${opts.parent}` : ""}`;

    // One POST to ajax.datagrid.php; `body` picks the grid action (reload /
    // changePage / setPerPage). All carry the session cookie; changePage/
    // setPerPage forward `parent` exactly as the admin JS does.
    // One transient drop must not lose a 26-page walk: a connection-level
    // failure is retried, a 401/logical failure is not.
    const gridPost = (body: Record<string, string>): Promise<string> =>
      withNetworkRetry(async () => {
        const params = new URLSearchParams({ hid: String(handler), url: dataUrl, ...body });
        if (opts.parent != null) params.set("parent", String(opts.parent));
        const res = await this.fetchSession(name, conf, "/adminLegacy/js/ajax.datagrid.php", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: params.toString(),
        });
        if (res.status === 401) {
          throw new HoroshopError(`Admin session rejected (401) for "${name}".`);
        }
        return res.text();
      });
    const reload = () =>
      gridPost({ datagridLoad: "true", load: "dataGridReload", handler: String(handler), code: CHECKCODE });
    const setPerPage = (value: number) => gridPost({ load: "datagridSetPerPage", value: String(value) });
    const changePage = (page: number) => gridPost({ load: "changePage", page: String(page) });

    const maxRows = opts.maxRows ?? 5000;

    // Single explicit page: normalise the window (only if the caller passed one)
    // then fetch just that page.
    if (opts.page != null) {
      if (opts.perPage != null) await setPerPage(opts.perPage);
      const html = await changePage(opts.page);
      const rows = parseGridRows(html) as GridRow[] & { total?: number };
      const pager = parseGridPager(html);
      if (pager) rows.total = pager.total;
      return relabelGridRows(rows);
    }

    // Fetch ALL. Page 1 comes from the proven `reload` at the native window (the
    // common ≤1-page entity then costs exactly one request and changes nothing).
    // Only when there IS a second page do we widen once to the 160 max, which
    // slashes round-trips on big grids (a 4000-row table drops from ~200 requests
    // to ~26). `opts.perPage` skips the dance and widens up front to that size.
    const WIDE = 160;
    let firstHtml = opts.perPage != null ? await setPerPage(opts.perPage) : await reload();
    if (opts.perPage == null) {
      const p0 = parseGridPager(firstHtml);
      const w0 = p0 ? Math.max(p0.to - p0.from + 1, 1) : parseGridRows(firstHtml).length;
      if (p0 && p0.total > w0 && w0 < WIDE) firstHtml = await setPerPage(WIDE);
    }
    const collected = parseGridRows(firstHtml);
    const pager = parseGridPager(firstHtml);
    const seen = new Set(collected.map((r) => r.id));
    // Effective page size the grid is serving (to − from + 1), falling back to the
    // page-1 count. Guards a divide-by-zero when a grid returns no window info.
    const window = pager ? Math.max(pager.to - pager.from + 1, 1) : Math.max(collected.length, 1);
    const total = pager?.total ?? null;

    const pushPage = (html: string): number => {
      const rows = parseGridRows(html);
      let added = 0;
      for (const r of rows) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        collected.push(r);
        added++;
      }
      return added;
    };

    let truncated = false;
    let incomplete: GridIncomplete | undefined;
    /** Set only when the drift repair actually had to run — telemetry, not noise. */
    let driftRepair: GridDriftRepair | undefined;
    if (total != null && total > collected.length && window > 0) {
      const lastPage = Math.ceil(total / window);
      const maxPages = Math.max(Math.ceil(maxRows / window), 1);
      const stop = Math.min(lastPage, maxPages);
      // Pages that brought fewer new rows than the window is wide: the page
      // OVERLAPPED one already read, i.e. the boundary drifted between renders.
      // Those are where a lost row is (see the repair pass below).
      const drift: number[] = [];
      for (let p = 2; p <= stop; p++) {
        const added = await changePage(p).then(pushPage);
        if (added < window && p < stop) drift.push(p);
      }
      truncated = lastPage > maxPages;

      // ── D1: THE SILENT UNDERCOUNT ──────────────────────────────────────
      // Measured on a 523-product grid: the walk returns 522 (perPage 160) or
      // 515 (perPage 20) rows and used to report neither. The grid sorts on a
      // column with duplicates and NO stable tiebreaker, so two renders of the
      // same page differ at the boundary: a row that sat on page 1 in render A
      // is pushed onto page 2 in render B, while the row that took its place
      // was already collected — `seen` swallows the duplicate and the evicted
      // row appears nowhere. A double count becomes a QUIET SHORTFALL.
      //
      // Two answers, in this order:
      //  1. REPAIR — first re-render the pages around each drift point at the
      //     walk's own window (cheap, and it fixes the common case), then, if
      //     the shortfall survives, RE-ROLL THE BOUNDARIES: sweep the whole
      //     grid again at a DIFFERENT page size. Repeating the same geometry
      //     was the weak half — it re-runs the same lottery with the same
      //     seams, which is why a 27-page walk could burn its whole budget and
      //     still come back one row short. A different window puts the seams
      //     somewhere else entirely and costs ~8× less per sweep.
      //     Bounded by a request budget so a 255-page grid cannot double its
      //     cost.
      //  2. SPEAK — whatever the repair achieved, if `collected.length` is
      //     still under `total` the result says so LOUDLY (`truncated:true` +
      //     `incomplete`). This half is unconditional: an undercount that the
      //     answer does not admit to is the one defect class that cannot be
      //     seen downstream, and it is exactly how this bug survived five waves.
      if (!truncated && collected.length < total) {
        const before = collected.length;
        // Pages touching a drift point, at the walk's own window: round one.
        const targeted = [...new Set(drift.flatMap((p) => [p - 1, p, p + 1]))]
          .filter((p) => p >= 1 && p <= stop)
          .sort((a, b) => a - b);
        /** Renders one full sweep of the grid costs at page size `w`. */
        const sweepCost = (w: number) => Math.max(Math.ceil(total / w), 1);
        // Enough for the targeted round plus GRID_REPAIR_SWEEPS wide re-rolls,
        // and never less than the old formula allowed.
        const budget = gridRepairBudget(
          Math.max(2 * stop + 4, targeted.length + GRID_REPAIR_SWEEPS * sweepCost(WIDE) + 4),
        );
        const windows: number[] = [];
        let spent = 0;
        let passes = 0;
        let cur = window;

        if (targeted.length && collected.length < total) {
          passes++;
          windows.push(cur);
          for (const p of targeted) {
            if (collected.length >= total || spent >= budget) break;
            spent++;
            await changePage(p).then(pushPage);
          }
        }

        // Re-roll: sweep the whole grid at a window the walk did NOT use, so
        // every page boundary lands somewhere else. Cycles through the sizes.
        const reroll = GRID_REPAIR_WINDOWS.filter((w) => w !== window);
        for (
          let i = 0;
          collected.length < total && spent < budget && passes < GRID_REPAIR_MAX_PASSES;
          i++
        ) {
          const want = reroll[i % reroll.length];
          let from = 1;
          if (want !== cur) {
            spent++;
            const html = await setPerPage(want);
            pushPage(html);
            // Trust the pager, not the request: a grid may clamp the size, and
            // a sweep sized from a window we never got would leave a gap.
            const pg = parseGridPager(html);
            cur = pg ? Math.max(pg.to - pg.from + 1, 1) : want;
            from = 2; // setPerPage already served page 1
          }
          passes++;
          windows.push(cur);
          const pages = sweepCost(cur);
          for (let p = from; p <= pages; p++) {
            if (collected.length >= total || spent >= budget) break;
            spent++;
            await changePage(p).then(pushPage);
          }
        }

        // The window is SESSION state. Leaving it where the repair stopped would
        // silently re-window every later call on this handler.
        if (cur !== window) {
          spent++;
          await setPerPage(window).catch(() => {});
        }

        driftRepair = {
          passes,
          requests: spent,
          recovered: collected.length - before,
          lostOnFirstWalk: total - before,
          ...(windows.length ? { windows } : {}),
        };
        if (collected.length < total) {
          incomplete = {
            expected: total,
            collected: collected.length,
            missing: total - collected.length,
            cause: "grid-drift",
            repair: { passes, requests: spent, recovered: collected.length - before, windows },
            note:
              `INCOMPLETE LIST: the grid declares ${total} row(s), the walk could only collect ${collected.length} ` +
              `(${total - collected.length} missing) — this is NOT the safety cap. The grid pages on an unstable ` +
              `sort order, so rows shift across page boundaries between renders and some are served on no page at ` +
              `all. A repair re-read ${spent} page(s) at ${windows.length} window size(s) (${windows.join(", ")}) ` +
              `and recovered ${collected.length - before}. ` +
              `DO NOT treat this list as the complete set (counting, diffing or "not found" conclusions off it are ` +
              `wrong by up to ${total - collected.length}). Narrow the grid instead: \`search\` returns matching ` +
              `rows in one request, \`perPage:160\` uses the fewest pages (a SMALLER perPage loses MORE), or read ` +
              `the entity through its own API export where one exists (products: horoshop_catalog_export).`,
          };
        }
      }
    } else if (total == null && collected.length >= window && window > 0) {
      // No total but a full page came back — keep walking until a short/empty page
      // (defensive: a grid variant that omits the pager count).
      const maxPages = Math.max(Math.ceil(maxRows / window), 1);
      for (let p = 2; p <= maxPages; p++) {
        const added = await changePage(p).then(pushPage);
        if (added < window) break;
      }
    }

    const out = collected as GridRow[] & {
      total?: number;
      truncated?: boolean;
      incomplete?: GridIncomplete;
      driftRepair?: GridDriftRepair;
    };
    if (total != null) out.total = total;
    if (driftRepair) out.driftRepair = driftRepair;
    // `truncated` is the caller-facing "this list is not everything" flag and it
    // is set for BOTH reasons — the safety cap and the drift shortfall — because
    // every existing consumer already branches on it. `incomplete` then says
    // which of the two happened.
    if (truncated || incomplete) out.truncated = true;
    if (incomplete) out.incomplete = incomplete;
    // Labels are only decidable once every row is in hand — a column that repeats
    // on all 11 rows identifies nothing (see relabelGridRows).
    return relabelGridRows(out);
  }

  /**
   * SEARCH a datagrid server-side instead of walking it.
   *
   * `admin_list` on the interface-translation grid (handler 340) reported a hard
   * "Network error": that grid has 4000+ rows, the walker paged through all of
   * them, and one dropped connection in ~26 (or 208, at perPage:20 — a smaller
   * window makes it WORSE, which is why the reporter's `perPage:20` retry failed
   * too) killed the whole call. Listing 4153 rows to reach 4 was never the right
   * shape anyway.
   *
   * The admin itself never does that: every column header carries a filter box
   * whose handler is `dataGridControl('filter', hid, type, param, …)`, posting
   * `load=dataGridControl & action=filter & param=<column> & value1=<text>` to the
   * same `ajax.datagrid.php`. The filter is a substring match, applied server-side,
   * and is **stateful in the session** exactly like page/perPage — so it MUST be
   * cleared afterwards (value1:"") or every later listing silently returns a
   * filtered subset. This method always clears, including on failure.
   *
   * `column` picks the column: a numeric param id, or a header label / substring
   * ("Ключ", "Значение"). Omitted → the first input-filterable column.
   */
  async searchRecords(
    store: string | undefined,
    handler: number,
    opts: { query: string; column?: string | number; parent?: number; maxRows?: number } = { query: "" },
  ): Promise<{
    rows: GridRow[];
    total: number | null;
    column: GridColumn | null;
    columns: GridColumn[];
    truncated: boolean;
    incomplete?: GridIncomplete;
  }> {
    const { name, conf } = this.resolve(store);
    const dataUrl = `/adminLegacy/data.php?handler=${handler}${opts.parent != null ? `&parent=${opts.parent}` : ""}`;

    const gridPost = (body: Record<string, string>): Promise<string> =>
      withNetworkRetry(async () => {
        const params = new URLSearchParams({ hid: String(handler), url: dataUrl, ...body });
        if (opts.parent != null) params.set("parent", String(opts.parent));
        const res = await this.fetchSession(name, conf, "/adminLegacy/js/ajax.datagrid.php", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: params.toString(),
        });
        if (res.status === 401) throw new HoroshopError(`Admin session rejected (401) for "${name}".`);
        return res.text();
      });

    const first = await gridPost({
      datagridLoad: "true",
      load: "dataGridReload",
      handler: String(handler),
      code: CHECKCODE,
    });
    const columns = parseGridColumns(first);
    let col: GridColumn | null = null;
    if (opts.column != null && String(opts.column).trim() !== "") {
      const want = String(opts.column).trim().toLowerCase();
      // "input:N" = the Nth text-filterable column, positionally. Header labels are
      // localised (a ru admin says «Значение», a ua one «Значення»), so a wrapper
      // that always means "the value column" must not match on text.
      const byPos = /^input:(\d+)$/.exec(want);
      col = byPos
        ? (columns.filter((c) => c.type === "input")[Number(byPos[1])] ?? null)
        : (columns.find((c) => c.param === want) ??
          columns.find((c) => c.label.toLowerCase() === want) ??
          columns.find((c) => c.label.toLowerCase().includes(want)) ??
          null);
      if (!col) {
        throw new Error(
          `No filterable column "${opts.column}" on handler ${handler}. Available: ${
            columns.map((c) => `${c.label || "?"}(${c.param}, ${c.type})`).join(", ") || "none"
          }.`,
        );
      }
    } else {
      col = columns.find((c) => c.type === "input") ?? null;
      if (!col) {
        throw new Error(
          `Handler ${handler} has no text-filterable column to search. Columns: ${
            columns.map((c) => `${c.label || "?"}(${c.param}, ${c.type})`).join(", ") || "none"
          }. Use horoshop_admin_list without \`search\`.`,
        );
      }
    }

    const applyFilter = (value: string): Promise<string> =>
      gridPost({
        load: "dataGridControl",
        datagridLoad: "true",
        action: "filter",
        type: "input",
        param: col!.param,
        way: "",
        double: "0",
        informer: String(handler),
        code: CHECKCODE,
        query: "",
        value1: value,
        value2: "",
      });

    const maxRows = opts.maxRows ?? 500;
    try {
      const html = await applyFilter(opts.query);
      const rows = parseGridRows(html);
      const pager = parseGridPager(html);
      const total = pager?.total ?? rows.length;
      const seen = new Set(rows.map((r) => r.id));
      const window = pager ? Math.max(pager.to - pager.from + 1, 1) : Math.max(rows.length, 1);
      let truncated = false;
      let incomplete: GridIncomplete | undefined;
      if (total > rows.length && window > 0) {
        const lastPage = Math.ceil(total / window);
        const stop = Math.min(lastPage, Math.max(Math.ceil(maxRows / window), 1));
        const fetchPage = async (p: number): Promise<number> => {
          let added = 0;
          for (const r of parseGridRows(await gridPost({ load: "changePage", page: String(p) }))) {
            if (seen.has(r.id)) continue;
            seen.add(r.id);
            rows.push(r);
            added++;
          }
          return added;
        };
        for (let p = 2; p <= stop; p++) await fetchPage(p);
        truncated = lastPage > stop;
        // Same drift shortfall as `listRecords` (D1): a filtered grid pages on the
        // same unstable order. Repair, then say so if rows are still missing —
        // a search that quietly returns 11 of 12 matches is worse than a slow one.
        //
        // NOTE: unlike `listRecords` this repair does NOT re-roll the window.
        // The filter is SESSION state on the same grid, and whether
        // `datagridSetPerPage` survives it is unmeasured — a sweep at a window
        // that quietly dropped the filter would merge NON-matching rows into a
        // search result, which is worse than a slow repair. A filtered set is
        // small and has few boundaries anyway.
        if (!truncated && rows.length < total) {
          const before = rows.length;
          const budget = gridRepairBudget(2 * stop + 4);
          let spent = 0;
          let passes = 0;
          while (rows.length < total && spent < budget && passes < GRID_REPAIR_MAX_PASSES) {
            passes++;
            for (let p = 1; p <= stop; p++) {
              if (rows.length >= total || spent >= budget) break;
              spent++;
              await fetchPage(p);
            }
          }
          if (rows.length < total) {
            incomplete = {
              expected: total,
              collected: rows.length,
              missing: total - rows.length,
              cause: "grid-drift",
              repair: { passes, requests: spent, recovered: rows.length - before },
              note:
                `INCOMPLETE SEARCH RESULT: the filtered grid declares ${total} match(es), only ${rows.length} could be ` +
                `collected (${total - rows.length} missing) — the grid pages on an unstable sort order, so rows shift ` +
                `between renders. Narrow the query so the matches fit one page (${window} rows), or read the entity ` +
                `through its own API export where one exists.`,
            };
          }
        }
      }
      return {
        rows: relabelGridRows(rows),
        total,
        column: col,
        columns,
        truncated: truncated || incomplete != null,
        ...(incomplete ? { incomplete } : {}),
      };
    } finally {
      // The filter lives in the SESSION. Leaving it set would quietly shrink every
      // later listing on this handler — clear it whatever happened above.
      await applyFilter("").catch(() => {});
    }
  }

  /**
   * Read one attribute-dictionary value's PER-LANGUAGE titles.
   *
   * `listBookValues` only ever shows the admin's own display language, so the
   * ru/ua split of «Євро» / «Білий» was invisible and untranslatable. The
   * real editor is an AJAX popup: `js/lookup.php?load=loadBookValueForm` returns a
   * form whose inputs are `names[title][<languageIndex>]` (1=ru, 3=ua, 4=en, 5=pl,
   * 6=ro — the same LANG_INDEX as everywhere else).
   */
  async bookValueGet(
    store: string | undefined,
    bookId: number | string,
    valueId: number | string,
  ): Promise<{ titles: Record<string, string>; found: boolean }> {
    const { name, conf } = this.resolve(store);
    const res = await this.fetchSession(name, conf, "/adminLegacy/js/lookup.php", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "XMLHttpRequest",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        load: "loadBookValueForm",
        bookId: String(bookId),
        valueId: String(valueId),
        checkcode: CHECKCODE,
      }).toString(),
    });
    let html = "";
    try {
      html = JSON.parse(await res.text())?.response?.html ?? "";
    } catch {
      html = "";
    }
    const titles: Record<string, string> = {};
    for (const m of html.matchAll(/name="names\[title\]\[(\d+)\]"\s+value="([^"]*)"/g)) {
      titles[m[1]] = decodeEntities(m[2]);
    }
    return { titles, found: Object.keys(titles).length > 0 };
  }

  /**
   * Write a dictionary value's per-language titles.
   *
   * Two steps, exactly as the admin's `saveBookValue()` does them: `lookup.php
   * load=saveBookValue` VALIDATES (answers `{status:"OK"}` or a VERIFY_ERROR), then
   * the same field set is POSTed to `savers/books.php` which persists and 302s.
   * Skipping the validation step is what made earlier attempts look like "the
   * dictionary editor is browser-only" — it is not.
   *
   * `titles` is keyed by language INDEX ("1"=ru, "3"=ua, …). Every language the
   * form renders must be sent (the saver takes the whole row), so callers pass a
   * merged map read from `bookValueGet`.
   */
  async bookValueSave(
    store: string | undefined,
    bookId: number | string,
    valueId: number | string,
    titles: Record<string, string>,
  ): Promise<{ validated: string; httpStatus: number }> {
    const { name, conf } = this.resolve(store);
    const fields: Record<string, string> = {
      action: "save",
      id: String(valueId),
      book: String(bookId),
      checkcode: CHECKCODE,
    };
    for (const [idx, text] of Object.entries(titles)) fields[`names[title][${idx}]`] = text;

    const verify = await this.fetchSession(name, conf, "/adminLegacy/js/lookup.php", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "XMLHttpRequest",
        Accept: "application/json",
      },
      body: new URLSearchParams({ ...fields, load: "saveBookValue" }).toString(),
    });
    let validated = "?";
    let message: string | undefined;
    try {
      const j = JSON.parse(await verify.text());
      validated = j?.status ?? "?";
      message = j?.response?.error_message ?? j?.response?.message;
    } catch {
      validated = `HTTP ${verify.status}`;
    }
    if (validated !== "OK") {
      throw new HoroshopError(
        `Dictionary value ${valueId} (book ${bookId}) was refused by the admin's validation: ${validated}${message ? ` — ${message}` : ""}. Every language's title must be non-empty.`,
      );
    }
    const res = await this.fetchSession(
      name,
      conf,
      "/adminLegacy/savers/books.php",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields).toString(),
      },
      "manual",
    );
    return { validated, httpStatus: res.status };
  }

  /**
   * Persist a change to a LIVE order card.
   *
   * The order editor is not an admin form at all — it is the storefront checkout
   * rendered with `configPresetName=admin_order`, and it posts to `/order/submit/`.
   * Two traps, both measured live and re-measured later:
   *
   *  1. `/order/setAttributes/` answers `{"status":"OK"}` and SAVES NOTHING. The
   *     only persist in the whole flow is `/order/submit/`. A tool built on
   *     setAttributes loses data silently.
   *  2. The form must be serialised WHOLE. Fields the page marks `j-ignore` (the
   *     city, for one) are skipped by the panel's own script but accepted by
   *     submit, so re-sending everything is what makes the city stick.
   *
   * What is deliberately NOT re-sent: `changeStatus` / `status` (they belong to
   * the five status-button sub-forms and would move the order), `return_quantity`
   * (the cancel form) and `leave-page` (we always stay on the page).
   */
  async orderSubmit(
    store: string | undefined,
    adminId: number | string,
    overrides: Record<string, string>,
  ): Promise<{ httpStatus: number; status?: string; message?: string; sentFields: number; body: any }> {
    const { name, conf } = this.resolve(store);
    const path = `/adminLegacy/edit.php?id=${encodeURIComponent(String(adminId))}&action=edit&handler=443&checkcode=${CHECKCODE}`;
    const pageRes = await this.fetchSession(name, conf, path, { headers: { Accept: "text/html" } });
    const html = await pageRes.text();
    const token = html.match(/GLOBAL_CSRF_TOKEN['"]?\s*[:=]\s*['"]([^'"]+)['"]/)?.[1];

    const SKIP = new Set(["changeStatus", "status", "return_quantity", "leave-page"]);
    const fields: Record<string, string> = {};
    for (const m of html.matchAll(/<input\b([^>]*)>/gi)) {
      const attrs = m[1];
      const n = /name=['"]?([^'"\s>]+)/.exec(attrs)?.[1];
      if (!n || SKIP.has(n)) continue;
      const type = /type=['"]?([\w-]+)/.exec(attrs)?.[1]?.toLowerCase();
      if ((type === "checkbox" || type === "radio") && !/\bchecked\b/i.test(attrs)) continue;
      fields[n] = decodeEntities(/value=['"]([^'"]*)['"]/.exec(attrs)?.[1] ?? "");
    }
    for (const m of html.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi)) {
      const n = /name=['"]?([^'"\s>]+)/.exec(m[1])?.[1];
      if (n && !SKIP.has(n)) fields[n] = decodeEntities(m[2]).trim();
    }
    for (const m of html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
      const n = /name=['"]?([^'"\s>]+)/.exec(m[1])?.[1];
      if (!n || SKIP.has(n)) continue;
      const chosen = /<option([^>]*\bselected\b[^>]*)>/i.exec(m[2]) ?? /<option([^>]*)>/i.exec(m[2]);
      fields[n] = /value=['"]?([^'"\s>]*)/.exec(chosen?.[1] ?? "")?.[1] ?? "";
    }

    // `theme` is not in the markup — the panel's script mixes it in, and without
    // it the module factory throws a 503 rather than a validation error.
    Object.assign(fields, { theme: "admin", "stay-on-page": "1" }, overrides);

    const res = await this.fetchSession(name, conf, "/order/submit/", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "XMLHttpRequest",
        Accept: "application/json",
        ...(token ? { "X-CSRF-Token": token } : {}),
      },
      body: new URLSearchParams(fields).toString(),
    });
    const raw = await res.text();
    let body: any = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      body = { raw: raw.slice(0, 200) };
    }
    return { httpStatus: res.status, status: body?.status, message: body?.response?.message ?? body?.message, sentFields: Object.keys(fields).length, body };
  }

  /**
   * One `/order/component/<Component>/<action>/` call on a live order card.
   * The cart line controls (quantity, remove, manual price) carry NO form name —
   * they are `j-ignore` inputs driven by these component routes, so a submit
   * alone can never change what is IN the order.
   */
  async orderComponent(
    store: string | undefined,
    adminId: number | string,
    route: string,
    params: Record<string, string>,
  ): Promise<{ httpStatus: number; status?: string; raw: string; body: any }> {
    const { name, conf } = this.resolve(store);
    const path = `/adminLegacy/edit.php?id=${encodeURIComponent(String(adminId))}&action=edit&handler=443&checkcode=${CHECKCODE}`;
    const pageRes = await this.fetchSession(name, conf, path, { headers: { Accept: "text/html" } });
    const html = await pageRes.text();
    const token = html.match(/GLOBAL_CSRF_TOKEN['"]?\s*[:=]\s*['"]([^'"]+)['"]/)?.[1];
    const userId = /name=['"]?userId['"]?\s+value=['"]?([^'"\s>]*)/.exec(html)?.[1] ?? "";
    const res = await this.fetchSession(name, conf, route, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "XMLHttpRequest",
        Accept: "application/json",
        ...(token ? { "X-CSRF-Token": token } : {}),
      },
      body: new URLSearchParams({
        configPresetName: "admin_order",
        orderId: String(adminId),
        userId,
        handlerId: "443",
        theme: "admin",
        ...params,
      }).toString(),
    });
    const raw = await res.text();
    let body: any = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      body = {};
    }
    return { httpStatus: res.status, status: body?.status, raw: raw.slice(0, 300), body };
  }

  /**
   * Create a NEW attribute dictionary (справочник / book).
   *
   * A live probe measured the generic create form for handler 207 and found "a stub
   * with one field and no name input", concluding the platform has no create
   * form. It has one — it is just not a form. 207 is a hub, and the real «Новый
   * справочник» button intercepts its own submit and calls a route that lives
   * OUTSIDE `/adminLegacy/` altogether:
   *
   *     POST /book/createBook   {title}   X-CSRF-Token: GLOBAL_CSRF_TOKEN
   *     → {"status":"OK","response":{"bookId":385,"redirectUrl":"…?book=385"}}
   *
   * `js/lookup.php?load=checkNewBookData` validates first (same validate-then-
   * persist idiom as `bookValueSave`), so an empty or colliding name is refused
   * before anything is written.
   */
  async bookCreate(
    store: string | undefined,
    title: string,
  ): Promise<{ httpStatus: number; status?: string; bookId?: string; message?: string; validated: string }> {
    const { name, conf } = this.resolve(store);
    const check = await this.fetchSession(name, conf, "/adminLegacy/js/lookup.php", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest", Accept: "application/json" },
      body: new URLSearchParams({ load: "checkNewBookData", action: "newbook", "book[name]": title }).toString(),
    });
    let validated = "?";
    let vmsg: string | undefined;
    try {
      const j: any = JSON.parse(await check.text());
      validated = j?.status ?? "?";
      vmsg = j?.response?.error_message ?? j?.response?.message;
    } catch {
      validated = `HTTP ${check.status}`;
    }
    if (validated !== "OK") {
      throw new HoroshopError(
        `The admin refused the dictionary name "${title}" before writing: ${validated}${vmsg ? ` — ${vmsg}` : ""}. Names must be non-empty and not collide with an existing dictionary.`,
      );
    }

    const token = await this.getCsrfToken(name, conf);
    const res = await this.fetchSession(name, conf, "/book/createBook", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "XMLHttpRequest",
        Accept: "application/json",
        ...(token ? { "X-CSRF-Token": token } : {}),
      },
      body: new URLSearchParams({ title }).toString(),
    });
    const body: any = await res.json().catch(() => ({}));
    return {
      httpStatus: res.status,
      status: body?.status,
      bookId: body?.response?.bookId != null ? String(body.response.bookId) : undefined,
      message: body?.response?.message,
      validated,
    };
  }

  /**
   * Rename an existing dictionary. This one IS a plain legacy form post —
   * `savers/books.php` with `action=edit`, the same saver that persists values.
   * Answers 302 and says nothing, so the caller must re-read the 207 grid.
   */
  async bookRename(
    store: string | undefined,
    bookId: number | string,
    title: string,
  ): Promise<{ httpStatus: number }> {
    const { name, conf } = this.resolve(store);
    const res = await this.fetchSession(
      name,
      conf,
      "/adminLegacy/savers/books.php",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ action: "edit", "book[id]": String(bookId), "book[name]": title }).toString(),
      },
      "manual",
    );
    return { httpStatus: res.status };
  }

  /**
   * Delete records from a flat grid via `ajax.datagrid.php?load=removeSelectedGrids`.
   * Auth is the session cookie only (no checkcode). NOT valid for the pages tree
   * (handler 4) or order statuses (436), which use their own delete flows.
   */
  async deleteRecords(
    store: string | undefined,
    handler: number,
    ids: Array<string | number>,
    opts: { parent?: number; withModifications?: boolean } = {},
  ): Promise<{ httpStatus: number; body: string }> {
    const { name, conf } = this.resolve(store);
    const params = new URLSearchParams({
      // `removeSelectedGridsAndMods` is the products variant of the same grid op
      // (the admin's own "delete selected goods with modifications"): plain
      // removeSelectedGrids deletes exactly the selected ROWS, so deleting a
      // parent SKU leaves its modifications behind as orphans — measured live on
      // the test store, where removing 536 left its modification 537 in the grid.
      load: opts.withModifications ? "removeSelectedGridsAndMods" : "removeSelectedGrids",
      handler: String(handler),
      url: `/adminLegacy/data.php?handler=${handler}`,
    });
    if (opts.parent != null) params.set("parent", String(opts.parent));
    ids.forEach((id, i) => params.set(`ids[${i}]`, String(id)));
    const res = await this.fetchSession(name, conf, "/adminLegacy/js/ajax.datagrid.php", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    return { httpStatus: res.status, body: (await res.text()).slice(0, 200) };
  }

  // ─── Bulk product operations (the products grid's selection toolbar) ────────
  //
  // Selecting rows in the products grid (handler 17) reveals a toolbar with NINE
  // bulk actions. They do NOT share one endpoint — reverse-engineered from the
  // live buttons' onclick and verified against the test store:
  //
  //   Соединить            mergeSelectedCIID()                     ajax.datagrid.php → dialog, then a form POST to data.php
  //   Внести / Вынести     _transfer_income/_transfer_outcome()     lookup.php  (warehouse ledger; horoshop_admin_product_stock_set)
  //   Скопировать товары   copy_products()                         projectAjax.php
  //   Изменить отображение showGroupProductsEditModal('displayInShowcase')
  //                        → updateDisplayInShowcase() → dataGridUpdateValues   ← NOT doEdit: the inline-grid path
  //   Изменить наличие     …('changePresence')      → doEdit {presence}
  //   Изменить иконки      …('changeIcons')         → doEdit {icons}
  //   Изменить акции       …('changeCountdown')     → doEdit {countdown_end_time, countdown_offer_message}
  //   Загружать на мп      …('exportToMarketplace') → doEdit {export_to_marketplace}
  //   Удалить              …('delete')              → removeSelectedGrids()      (deleteRecords, above)
  //
  // Auth for all of them is the session cookie alone: the admin's `sendAjax`
  // helper adds an X-CSRF-Token header, but every one of these was executed live
  // WITHOUT it and answered `{"status":"OK"}`, exactly like the grid delete.

  /**
   * Render one bulk-edit modal — the admin's own form for a group operation.
   *
   * Read-only (it builds HTML, it writes nothing) and it is the authoritative
   * source for that operation's OPTIONS on THIS store: the presence statuses,
   * the sticker list, the marketplaces it is hooked up to. Resolving a name to
   * an id from here beats a hardcoded table, because every one of those lists is
   * per-store data.
   *
   * `type` is the modal name, which is NOT the action name the save uses
   * (`changePresence` renders a form called `presence`) — see groupProductsEdit.
   */
  async groupProductsRenderModal(
    store: string | undefined,
    type: string,
    productIds: Array<string | number>,
  ): Promise<{ httpStatus: number; status?: string; html: string }> {
    const r = await this.postUrlencoded(
      store,
      "/group_products_edit/renderModal/",
      { type, "productIds[]": productIds.map(String) },
      { accept: "application/json" },
    );
    let body: any = {};
    try {
      body = JSON.parse(r.text);
    } catch {
      /* non-JSON answers below */
    }
    return { httpStatus: r.httpStatus, status: body?.status, html: body?.response?.html ?? "" };
  }

  /**
   * Apply a bulk edit to a set of products.
   *
   * `actions` is a flat list of already-encoded parameter pairs, because the
   * shape differs per operation and jQuery's `$.param` is what the server parses:
   *   presence     → [["actions[presence]", "3"]]
   *   icons        → [["actions[icons][12]", "1"]]           (sticker id → 1 on / 0 off)
   *   marketplace  → [["actions[export_to_marketplace][7]", "0"]]
   *   countdown    → [["actions[countdown_end_time]", "1782913420"],
   *                   ["actions[countdown_offer_message][ua]", "…"], …]
   *
   * `countdown_end_time` is a UNIX EPOCH, rendered back in the STORE's timezone
   * (measured: epoch 2026-08-15 12:00:00Z read back as "2026-08-15 15:00:00" on a
   * UTC+3 store), so build it from an instant, never from a local wall clock.
   *
   * The answer carries `isQueue`: a big selection is handed to a background queue
   * and `isFinished` is then false, so a caller that re-reads immediately can see
   * the OLD values without anything having failed.
   */
  async groupProductsEdit(
    store: string | undefined,
    productIds: Array<string | number>,
    actions: Array<[string, string]>,
  ): Promise<{ httpStatus: number; status?: string; isQueue?: boolean; isFinished?: boolean; raw: string }> {
    const params: Record<string, string | string[]> = { "products[]": productIds.map(String) };
    for (const [k, v] of actions) params[k] = v;
    const r = await this.postUrlencoded(store, "/group_products_edit/doEdit/", params, {
      accept: "application/json",
    });
    let body: any = {};
    try {
      body = JSON.parse(r.text);
    } catch {
      /* raw is returned for the caller to report */
    }
    return {
      httpStatus: r.httpStatus,
      status: body?.status,
      isQueue: body?.response?.isQueue,
      isFinished: body?.response?.isFinished,
      raw: r.text.slice(0, 300),
    };
  }

  /**
   * Write edited grid CELLS back — the admin's inline row editor.
   *
   * Selecting rows turns the grid's editable columns into live controls (on the
   * products grid: price, price_old, display_in_showcase) and every change posts
   * here. It is a SEPARATE write surface from both the record editor (save.php)
   * and the group modals — "Изменить отображение" is really this, not a doEdit.
   *
   * The wire format is the grid's own row indexing: each row contributes
   * `names[k][id]=<recordId>` plus one `names[k][<field>]=<value>` per changed
   * cell. `k` only has to be UNIQUE per row — it is not the row's position on the
   * page (verified live: indices 3 and 7 in a two-row payload both landed).
   * A checkbox column is sent as "1"/"0", not on/off.
   */
  async gridUpdateValues(
    store: string | undefined,
    handler: number,
    rows: Array<{ id: string | number; fields: Record<string, string> }>,
  ): Promise<{ httpStatus: number; status?: string; raw: string }> {
    const params: Record<string, string | string[]> = {
      load: "dataGridUpdateValues",
      handler: String(handler),
    };
    rows.forEach((row, k) => {
      params[`names[${k}][id]`] = String(row.id);
      for (const [field, value] of Object.entries(row.fields)) params[`names[${k}][${field}]`] = value;
    });
    const r = await this.postUrlencoded(store, "/adminLegacy/js/ajax.datagrid.php", params, {
      accept: "application/json",
    });
    let body: any = {};
    try {
      body = JSON.parse(r.text);
    } catch {
      /* raw below */
    }
    return { httpStatus: r.httpStatus, status: body?.status, raw: r.text.slice(0, 300) };
  }

  /**
   * Duplicate products. Each copy is a NEW product whose article is the source's
   * prefixed with `copy_` (measured: STK-10 → copy_STK-10), so a
   * second copy of the same source collides on article — copy once, then rename.
   * `copyFiles` also duplicates the image files; false links nothing and is much
   * cheaper.
   */
  async copyProducts(
    store: string | undefined,
    ids: Array<string | number>,
    copyFiles: boolean,
  ): Promise<{ httpStatus: number; status?: string; raw: string }> {
    const r = await this.postUrlencoded(
      store,
      "/adminLegacy/js/projectAjax.php",
      { load: "copy_products", "ids[]": ids.map(String), copy_files: copyFiles ? "1" : "0" },
      { accept: "application/json" },
    );
    let body: any = {};
    try {
      body = JSON.parse(r.text);
    } catch {
      /* raw below */
    }
    return { httpStatus: r.httpStatus, status: body?.status, raw: r.text.slice(0, 300) };
  }

  /**
   * Merge products into one modification group («Соединить»).
   *
   * Two steps. Step 1 (`load=mergeSelectedCIID` on ajax.datagrid.php) only
   * renders the chooser and is read-only; step 2 is the chooser's own form,
   * which has NO action attribute and therefore posts back to the grid page it
   * was opened from — a plain `data.php?handler=<h>` POST, answering with the
   * whole grid page rather than JSON.
   *
   * The result: `mainId` stays a top-level product and every other id becomes a
   * MODIFICATION of it (verified live: the merged product's `parent_article` in
   * catalog/export flipped to the main one's). It cannot be undone by re-posting
   * anything — un-merging is per-product editor work.
   */
  async mergeProducts(
    store: string | undefined,
    handler: number,
    ids: Array<string | number>,
    mainId: string | number,
  ): Promise<{ httpStatus: number; raw: string }> {
    const params: Record<string, string | string[]> = { action: "go-merge", "main-node": String(mainId) };
    for (const id of ids) params[`participate[${id}]`] = String(id);
    const r = await this.postUrlencoded(store, `/adminLegacy/data.php?handler=${handler}`, params, {
      accept: "text/html",
    });
    return { httpStatus: r.httpStatus, raw: r.text.slice(0, 200) };
  }

  /**
   * Does this record still exist?
   *
   * Opening its editor is the cheapest exact answer, and the only practical one
   * for products: verifying a product id by walking the datagrid costs one
   * request per 20 rows of the WHOLE catalog, which is absurd on a 5000-SKU
   * store. A live/existing record answers 200 with its `name=editDoc` form; a
   * deleted or unknown one answers 503 with a ~7 KB error page and no form
   * (measured on the test store: id 536 after deletion and id 999999 both 503).
   *
   * Deliberately raw — no form parsing — so a heavy editor (products) costs one
   * GET and cannot throw for a reason unrelated to existence.
   */
  async recordExists(store: string | undefined, target: EditTarget): Promise<boolean> {
    const { name, conf } = this.resolve(store);
    return withNetworkRetry(async () => {
      const res = await this.fetchSession(name, conf, this.editUrl(target), { headers: { Accept: "text/html" } });
      if (res.status === 401) {
        throw new HoroshopError(`Admin session rejected (401) for "${name}".`);
      }
      if (res.status >= 500) return false;
      const html = await res.text();
      return /name\s*=\s*(?:"editDoc"|'editDoc'|editDoc\b)/i.test(html);
    });
  }

  /**
   * Delete a page/category tree node. The pages tree isn't a datagrid — the
   * trash icon navigates to `savers/pages.php?del=<id>` (GET, session cookie
   * only, no checkcode). Works for text pages, not container nodes.
   */
  async deletePageNode(
    store: string | undefined,
    id: string | number,
  ): Promise<{ httpStatus: number }> {
    const { name, conf } = this.resolve(store);
    const path = `/adminLegacy/savers/pages.php?del=${encodeURIComponent(String(id))}&back=index.php`;
    const res = await this.fetchSession(name, conf, path, { headers: { Accept: "text/html" } }, "manual");
    return { httpStatus: res.status };
  }

  /**
   * Delete one value from an attribute dictionary ("book").
   *
   * The books screen is not a datagrid, so removeSelectedGrids does not reach it;
   * its trash icon navigates to `savers/books.php?id=<valueId>&delvalue=<bookId>`
   * (GET, session cookie only). A value that products still use has NO trash icon
   * at all (`control_del_disabled`), which is why the caller checks `deletable`
   * from listBookValues before calling this.
   */
  async deleteBookValue(
    store: string | undefined,
    bookId: number | string,
    valueId: number | string,
  ): Promise<{ httpStatus: number }> {
    const { name, conf } = this.resolve(store);
    const path = `/adminLegacy/savers/books.php?id=${encodeURIComponent(String(valueId))}&delvalue=${encodeURIComponent(String(bookId))}`;
    const res = await this.fetchSession(name, conf, path, { headers: { Accept: "text/html" } }, "manual");
    return { httpStatus: res.status };
  }

  /**
   * Delete an order status (handler 436) via `js/lookup.php` — its own flow, not
   * the datagrid one. First asks whether the status is "easy" (no orders on it);
   * only then removes it. A status that still holds orders needs reassignment
   * (status_change), which this does not do automatically.
   */
  async deleteOrderStatus(
    store: string | undefined,
    id: string | number,
  ): Promise<{ isEasy: unknown; removed: boolean; httpStatus: number; note?: string }> {
    const { name, conf } = this.resolve(store);
    const post = (body: string) =>
      this.fetchSession(name, conf, "/adminLegacy/js/lookup.php", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
    const ask = await post(`load=status_remove_ask&id=${encodeURIComponent(String(id))}`);
    const askJson: any = await ask.json().catch(() => ({}));
    const isEasy = askJson?.isEasy ?? askJson?.response?.isEasy;
    if (String(isEasy) !== "1") {
      return {
        isEasy,
        removed: false,
        httpStatus: ask.status,
        note: "Status still has orders — deleting it needs reassignment to another status (status_change); not done automatically.",
      };
    }
    const rm = await post(`load=status_remove&id=${encodeURIComponent(String(id))}`);
    return { isEasy, removed: rm.status === 200, httpStatus: rm.status };
  }

  /**
   * Read the store's design "application JSON" — the full 22-subsystem theme
   * config (colours, blocks, homepage layout, header/footer, mobile…). It's
   * embedded inline as `const json = {…}` in the design-editor page; there is no
   * read API. Write (saveJSON) is intentionally not exposed yet.
   */
  async getDesignJson(store: string | undefined): Promise<any> {
    const { name, conf } = this.resolve(store);
    const res = await this.fetchSession(
      name,
      conf,
      `/adminLegacy/utils/design-editor.php?checkcode=${CHECKCODE}`,
      { headers: { Accept: "text/html" } },
    );
    const html = await res.text();
    const m = html.match(/const\s+json\s*=\s*(\{[\s\S]*?\});/);
    if (!m) throw new HoroshopError("Could not locate the design application JSON on the editor page.");
    return JSON.parse(m[1]);
  }

  /**
   * Save the store's design "application JSON" via `lookup.php?load=saveJSON`.
   * Works headless with the api session (unlike the books editor). Style changes
   * (colours/fonts) only reach the storefront after an SCSS recompile; structural
   * changes (blocks, layout, toggles) read from the config directly.
   */
  async saveDesignJson(
    store: string | undefined,
    json: unknown,
  ): Promise<{ httpStatus: number; status?: string; message?: string }> {
    const { name, conf } = this.resolve(store);
    const body = new URLSearchParams({
      load: "saveJSON",
      json: JSON.stringify(json),
      file: "/config/application.json",
      isEditor: "1",
      checkcode: CHECKCODE,
    }).toString();
    const res = await this.fetchSession(name, conf, "/adminLegacy/js/lookup.php", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const j: any = await res.json().catch(() => ({}));
    return { httpStatus: res.status, status: j?.status, message: j?.response?.message };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // BULK IMAGE IMPORT (the «Імпорт зображень» screen)
  //
  // A three-legged pipeline, reverse-engineered from `vue/dist/importimages/
  // bundle.js` and verified live on the test store:
  //   1. `POST /api/import-images/check {images:[filename…]}` — the PLATFORM
  //      matches each FILE NAME to a product by article and answers, per file,
  //      `{success, awsKey, projectUuid, handler, param, parent, sortOrder,
  //      mainTitle}` (or `{success:false, message:"productNotFound"}`).
  //   2. `POST <AWS_API_LINK>/upload_images/upload-image` — multipart
  //      {file, projectUuid, awsKey} with `Authorization: Bearer <CLOUD_TOKEN>`,
  //      to an EXTERNAL host (aws-api.horoshop.ua), answering the stored
  //      `{uri,width,height,fileSize}`.
  //   3. `POST /api/import-images/assign {images:[…], cleanGallery}` — binds the
  //      uploaded uris to the products.
  //
  // Legs 1 and 3 need `Authorization: Bearer <AUTH_TOKEN>` ON TOP of the admin
  // cookie (the cookie alone answers `AUTHORIZATION_ERROR / "Auth required."`),
  // and leg 2 needs a DIFFERENT token. Both tokens plus the AWS base URL are
  // server-rendered inline on the import screen itself — `window.AUTH_TOKEN`,
  // `window.CLOUD_TOKEN`, `window.AWS_API_LINK` — so the whole conveyor is
  // reachable headless. They are short-lived (24 h) and re-read per call rather
  // than cached; a stale JWT here is an opaque 401 from a third-party host.
  // ───────────────────────────────────────────────────────────────────────────

  /** Tokens + AWS endpoint for the bulk image import, read off the import screen. */
  async importImagesTokens(
    store: string | undefined,
  ): Promise<{ authToken: string; cloudToken: string; awsApiLink: string }> {
    const { name, conf } = this.resolve(store);
    const res = await this.fetchSession(
      name,
      conf,
      `/adminLegacy/utils/import-images.php?checkcode=${CHECKCODE}`,
      { headers: { Accept: "text/html" } },
    );
    const html = await res.text();
    const authToken = html.match(/window\.AUTH_TOKEN\s*=\s*['"]([^'"]+)['"]/)?.[1];
    const cloudToken = html.match(/window\.CLOUD_TOKEN\s*=\s*['"]([^'"]+)['"]/)?.[1];
    const awsApiLink = html.match(/window\.AWS_API_LINK\s*=\s*['"]([^'"]+)['"]/)?.[1];
    if (!authToken || !cloudToken || !awsApiLink) {
      throw new HoroshopError(
        `The image-import screen on "${name}" did not carry the tokens it needs ` +
          `(AUTH_TOKEN:${authToken ? "ok" : "missing"}, CLOUD_TOKEN:${cloudToken ? "ok" : "missing"}, ` +
          `AWS_API_LINK:${awsApiLink ? "ok" : "missing"}; HTTP ${res.status}). ` +
          `Usually this login has no rights to «Імпорт зображень», or the screen is off on this store.`,
      );
    }
    return { authToken, cloudToken, awsApiLink };
  }

  /** POST JSON to one of the `/api/import-images/*` routes with the bearer they require. */
  private async importImagesApi(
    store: string | undefined,
    route: "check" | "assign",
    authToken: string,
    payload: unknown,
  ): Promise<{ httpStatus: number; json: any; raw: string }> {
    const { name, conf } = this.resolve(store);
    const res = await this.fetchSession(name, conf, `/api/import-images/${route}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify(payload),
    });
    const raw = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(raw);
    } catch {
      /* reported as raw — the caller decides what an unparseable body means */
    }
    return { httpStatus: res.status, json, raw };
  }

  /**
   * Ask the platform which product each FILE NAME belongs to. Read-only: it
   * resolves names, it does not touch a gallery. This is the half worth running
   * on its own — it says, before a single byte moves, which photos will find no
   * product at all.
   */
  async importImagesCheck(
    store: string | undefined,
    authToken: string,
    filenames: string[],
  ): Promise<Record<string, any>> {
    const res = await this.importImagesApi(store, "check", authToken, { images: filenames });
    const data = res.json?.response?.data;
    if (!data || typeof data !== "object") {
      throw new HoroshopError(
        `import-images/check answered HTTP ${res.httpStatus} without a per-file result: ${res.raw.slice(0, 300)}`,
      );
    }
    return data as Record<string, any>;
  }

  /**
   * Upload ONE file's bytes to Horoshop's image cloud. Distinct host, distinct
   * token, no admin cookie — so its failures are reported verbatim rather than
   * folded into "the admin said no".
   */
  async importImagesUpload(
    store: string | undefined,
    opts: {
      awsApiLink: string;
      cloudToken: string;
      filename: string;
      bytes: Uint8Array;
      contentType: string;
      projectUuid: string;
      awsKey: string;
    },
  ): Promise<{ httpStatus: number; item: any; raw: string }> {
    const form = new FormData();
    const view = opts.bytes;
    const ab = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
    form.append("file", new Blob([ab], { type: opts.contentType }), opts.filename);
    form.append("projectUuid", opts.projectUuid);
    form.append("awsKey", opts.awsKey);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    try {
      const res = await fetch(`${opts.awsApiLink.replace(/\/+$/, "")}/upload_images/upload-image`, {
        method: "POST",
        headers: { Authorization: `Bearer ${opts.cloudToken}`, Accept: "application/json" },
        body: form,
        signal: controller.signal,
      });
      const raw = await res.text();
      let json: any = null;
      try {
        json = JSON.parse(raw);
      } catch {
        /* left null; the caller surfaces `raw` */
      }
      return { httpStatus: res.status, item: json?.data?.items?.[0] ?? null, raw };
    } catch (e) {
      const cause =
        (e as Error).name === "AbortError"
          ? `request timed out after ${this.cfg.timeoutMs} ms`
          : (e as Error).message;
      return { httpStatus: 0, item: null, raw: `Network error on the image cloud (${opts.awsApiLink}): ${cause}` };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Bind uploaded uris to their products.
   *
   * `cleanGallery:true` DELETES each touched product's existing photos before
   * attaching the new ones. That is the admin screen's own DEFAULT (its
   * «Сохранить уже имеющиеся фото в галерее» checkbox ships unchecked), which is
   * why the tool above inverts it and makes preserving the gallery the default.
   */
  async importImagesAssign(
    store: string | undefined,
    authToken: string,
    images: Array<Record<string, unknown>>,
    cleanGallery: boolean,
  ): Promise<{ httpStatus: number; json: any; raw: string }> {
    return this.importImagesApi(store, "assign", authToken, { images, cleanGallery });
  }

  /**
   * Trigger a sitemap rebuild via `utils/sitemap.php?create` (GET, admin session).
   * The endpoint renders the "Карта сайта" admin page and regenerates the
   * `content/export/<host>/*-sitemap.xml` children referenced by the public
   * `/sitemap.xml` index, bumping their `lastmod`. Idempotent and
   * self-restoring — the map simply reflects the current catalog — so there is
   * nothing to undo. Returns the transport outcome; the caller verifies by
   * diffing the public sitemap's lastmods before/after.
   */
  async sitemapRegenerate(store: string | undefined): Promise<{ httpStatus: number }> {
    const { name, conf } = this.resolve(store);
    const res = await this.fetchSession(
      name,
      conf,
      "/adminLegacy/utils/sitemap.php?create",
      { headers: { Accept: "text/html" } },
    );
    if (res.status === 401) {
      throw new HoroshopError(`Admin session rejected (401) for "${name}".`);
    }
    // Drain the body so the socket is released; we only need the status.
    await res.text();
    return { httpStatus: res.status };
  }

  /** Fetch the admin CSRF token (GLOBAL_CSRF_TOKEN) that AJAX write endpoints check. */
  private async getCsrfToken(name: string, conf: StoreConfig): Promise<string | undefined> {
    const res = await this.fetchSession(name, conf, `/adminLegacy/utils/design-editor.php?checkcode=${CHECKCODE}`, {
      headers: { Accept: "text/html" },
    });
    const html = await res.text();
    return html.match(/GLOBAL_CSRF_TOKEN['"]?\s*[:=]\s*['"]([^'"]+)['"]/)?.[1];
  }

  /**
   * Recompile SCSS → CSS so design/CSS changes reach the storefront.
   * `type` is "ajax" for the theme (application JSON) or "clients" for custom CSS.
   * Requires the `X-Requested-With` header (routes to the AJAX handler, not the
   * storefront) plus the CSRF token; only compiles when there is a pending change.
   */
  async recompileScss(
    store: string | undefined,
    type: "ajax" | "clients" = "ajax",
  ): Promise<{ httpStatus: number; status?: string }> {
    const { name, conf } = this.resolve(store);
    const token = await this.getCsrfToken(name, conf);
    const res = await this.fetchSession(name, conf, "/out/utils/scss/", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "XMLHttpRequest",
        ...(token ? { "X-CSRF-Token": token } : {}),
      },
      body: type,
    });
    const j: any = await res.json().catch(() => ({}));
    return { httpStatus: res.status, status: j?.status };
  }

  /**
   * Read the custom CSS (desktop + mobile) from the client-styles editor.
   *
   * Two hazards this has to survive, both of which used to corrupt or lose the
   * client's live CSS on a read-modify-write:
   *
   *  1. The editor may not exist on the store at all. The `Редактор CSS` menu
   *     item is a per-store module: where it is off (seen on a live store), the URL still
   *     resolves but renders an unrelated admin page, and the old parser simply
   *     found no divs and answered `{desktop:"", mobile:""}`. That is
   *     indistinguishable from "this store has no custom CSS" and any
   *     read-modify-write on it silently wipes the live stylesheet. So report
   *     `available:false` explicitly and let the caller refuse to write.
   *  2. The seeded CSS sits in a nested `<div style="display:none">` inside the
   *     ACE mount, so a non-greedy `…</div>` match stops at the wrong tag; and
   *     it is HTML-escaped, so `a > b` reads back as `a &gt; b` and would be
   *     written back corrupted. Balance the tags, then decode the entities.
   */
  async getClientStyles(store: string | undefined): Promise<ClientStyles> {
    const { name, conf } = this.resolve(store);
    const res = await this.fetchSession(
      name,
      conf,
      `/adminLegacy/utils/edit-client-styles.php?checkcode=${CHECKCODE}`,
      { headers: { Accept: "text/html" } },
    );
    const html = await res.text();

    const desktopRaw = extractElementById(html, "default");
    const mobileRaw = extractElementById(html, "mobile");
    const available = desktopRaw !== null || mobileRaw !== null;

    if (!available) {
      return {
        desktop: "",
        mobile: "",
        available: false,
        source: "unavailable",
        note:
          "The client-styles editor is not present on this store: utils/edit-client-styles.php answered without the ACE editor mounts. On Horoshop the «Редактор CSS» item is a per-store admin module — where it is off, this page renders an unrelated form and there is NO admin-reachable source for custom CSS. An empty result here does NOT mean the storefront has no custom CSS (it may still serve /assets/*/production/client.*.css, installed outside the admin). Treat these values as unknown, not as empty, and do not write over them.",
      };
    }

    return {
      desktop: cleanEditorSeed(desktopRaw),
      mobile: cleanEditorSeed(mobileRaw),
      available: true,
      source: "legacy-ace-editor",
    };
  }

  /**
   * Save custom CSS via `lookup.php?load=saveStyles`. Sends both desktop and
   * mobile (read-modify-write is the caller's job), then Horoshop recompiles SCSS.
   */
  async setClientStyles(
    store: string | undefined,
    styles: { desktop: string; mobile: string },
  ): Promise<{ httpStatus: number; status?: string }> {
    const j = await this.widgetPost(store, "/adminLegacy/js/lookup.php", {
      load: "saveStyles",
      type: "client",
      "content[desktop]": styles.desktop,
      "content[mobile]": styles.mobile,
    });
    return { httpStatus: j.httpStatus, status: j.body?.status };
  }

  /**
   * List the values of an attribute-value dictionary ("book", handler 207).
   * A prior GET to `data.php?handler=207&book=<id>` sets the book context the
   * `forms/books.php` page needs to render its rows.
   */
  async listBookValues(store: string | undefined, bookId: number | string): Promise<BookValue[]> {
    const { name, conf } = this.resolve(store);
    await this.fetchSession(name, conf, `/adminLegacy/data.php?handler=207&book=${encodeURIComponent(String(bookId))}`, {
      headers: { Accept: "text/html" },
    });
    const res = await this.fetchSession(
      name,
      conf,
      `/adminLegacy/forms/books.php?book=${encodeURIComponent(String(bookId))}&checkcode=${CHECKCODE}`,
      { headers: { Accept: "text/html" } },
    );
    return parseBookValues(await res.text());
  }

  /**
   * Read a data template's characteristic schema (groups + fields).
   * `forms/handlers.php?edit=<id>` renders the schema as a sortable list rather
   * than as form fields, which is why the plain form reader only ever saw the
   * template's 6 meta inputs.
   */
  async templateSchema(store: string | undefined, templateId: number | string): Promise<TemplateGroup[]> {
    const { name, conf } = this.resolve(store);
    const res = await this.fetchSession(
      name,
      conf,
      `/adminLegacy/forms/handlers.php?edit=${encodeURIComponent(String(templateId))}&checkcode=${CHECKCODE}`,
      { headers: { Accept: "text/html" } },
    );
    return parseTemplateSchema(await res.text());
  }

  /**
   * Create or edit one characteristic on a data template.
   *
   * Its own little subsystem: `params/ajax.php` with `action=saveParam`, indexed
   * `param[0][…]` fields and `handler[0][id]` for the template. `pid` 0 creates.
   * A dictionary-backed select points at its book as `book_<id>` — passing the
   * bare number silently binds the field to a *template* instead and the value
   * then never lands.
   */
  async templateParamSave(
    store: string | undefined,
    templateId: number | string,
    param: Record<string, string>,
  ): Promise<{ status: string; message?: string }> {
    const { name, conf } = this.resolve(store);
    const body = new URLSearchParams({ action: "saveParam", checkcode: CHECKCODE });
    body.set("handler[0][id]", String(templateId));
    for (const [k, v] of Object.entries(param)) body.set(`param[0][${k}]`, v);
    const res = await this.fetchSession(
      name,
      conf,
      "/adminLegacy/params/ajax.php",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Requested-With": "XMLHttpRequest",
          Accept: "application/json",
        },
        body: body.toString(),
      },
    );
    const text = await res.text();
    try {
      const j = JSON.parse(text);
      return { status: j.status ?? "?", message: j.response?.message };
    } catch {
      return { status: `HTTP ${res.status}`, message: text.slice(0, 160) };
    }
  }

  /** Delete one characteristic from a data template by its param id. */
  async templateParamDelete(
    store: string | undefined,
    paramId: number | string,
  ): Promise<{ httpStatus: number }> {
    const { name, conf } = this.resolve(store);
    const res = await this.fetchSession(
      name,
      conf,
      `/adminLegacy/savers/handlers.php?paramdel=${encodeURIComponent(String(paramId))}&checkcode=${CHECKCODE}`,
      { headers: { Accept: "text/html" } },
      "manual",
    );
    return { httpStatus: res.status };
  }

  /** List the dictionaries a select-type characteristic can bind to (`book_<id>` values). */
  async templateParamBooks(
    store: string | undefined,
    templateId: number | string,
    paramId: number | string = 0,
  ): Promise<Array<{ value: string; label: string }>> {
    const { name, conf } = this.resolve(store);
    const res = await this.fetchSession(name, conf, "/adminLegacy/params/ajax.php", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "XMLHttpRequest",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        action: "showParamConfigForm",
        hid: String(templateId),
        pid: String(paramId),
        checkcode: CHECKCODE,
      }).toString(),
    });
    try {
      const html = JSON.parse(await res.text())?.response?.html ?? "";
      const sel = html.match(/<select[^>]*name=['"]?param\[0\]\[table\][^>]*>([\s\S]*?)<\/select>/i);
      if (!sel) return [];
      return [...sel[1].matchAll(/<option[^>]*value=["']([^"']*)["'][^>]*>([^<]*)</gi)]
        .map((m: any) => ({ value: m[1], label: m[2].trim() }))
        .filter((o) => o.value && o.value !== "-1");
    } catch {
      return [];
    }
  }

  /**
   * List URL redirects (301s), grouped by the target record they point to —
   * ACROSS EVERY GRID PAGE, not just the first.
   *
   * The redirects screen looks like a plain server-rendered page, and that is the
   * trap: it renders one datagrid PAGE of target rows (20 by default), so simply
   * GETting `utils/p_url_history.php` returns a slice. Measured on the test store:
   * the page showed 16 redirects across 20 target rows while the store actually
   * held **35 redirects across 39 rows** — the reader was blind to more than half
   * of them, and a duplicate check built on that would have waved through exactly
   * the collisions it exists to stop.
   *
   * So the rows come from the grid itself (`hid=395`, the same
   * `ajax.datagrid.php` machinery `listRecords` drives): widen the window once to
   * the 160 max, then walk `changePage` until a page brings nothing new. Past the
   * last page the grid answers with no rows at all, which is the stop condition.
   */
  async redirectList(
    store: string | undefined,
    opts: { maxPages?: number } = {},
  ): Promise<RedirectTarget[] & { truncated?: boolean }> {
    const { name, conf } = this.resolve(store);
    const url = "/adminLegacy/utils/p_url_history.php";
    const gridPost = (body: Record<string, string>): Promise<string> =>
      withNetworkRetry(async () => {
        const res = await this.fetchSession(name, conf, "/adminLegacy/js/ajax.datagrid.php", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ hid: "395", url, ...body }).toString(),
        });
        if (res.status === 401) {
          throw new HoroshopError(`Admin session rejected (401) for "${name}".`);
        }
        return res.text();
      });

    const WIDE = 160;
    const maxPages = opts.maxPages ?? 50; // 8000 target rows — far past any real store
    const collected: RedirectTarget[] = [];
    const seen = new Set<string>();
    const push = (html: string): number => {
      let added = 0;
      for (const t of parseRedirects(html)) {
        const key = `${t.handler}:${t.record}`;
        if (seen.has(key)) continue;
        seen.add(key);
        collected.push(t);
        added++;
      }
      return added;
    };

    push(await gridPost({ load: "datagridSetPerPage", value: String(WIDE) }));
    let truncated = false;
    for (let p = 2; p <= maxPages; p++) {
      const added = push(await gridPost({ load: "changePage", page: String(p) }));
      if (added === 0) break;
      if (p === maxPages) truncated = true;
    }
    const out = collected as RedirectTarget[] & { truncated?: boolean };
    if (truncated) out.truncated = true;
    return out;
  }

  /**
   * Change an existing redirect's OLD uri. `update` cannot retarget: posting
   * `handler`/`record` alongside is accepted with `OK` and silently ignored —
   * measured on the test store, the row stayed bound to its original record. Moving
   * a redirect to another page is therefore delete + create, which the tool does
   * explicitly (and rolls back if the create fails).
   */
  async redirectUpdate(
    store: string | undefined,
    args: { id: number | string; uri: string },
  ): Promise<{ httpStatus: number; status?: string; message?: string; oldUri?: string; raw?: string; finalUrl?: string; redirected?: boolean; contentType?: string | null; attempts?: number; missed?: number }> {
    const j = await this.widgetPost(
      store,
      "/_widget/p_url_history/update/",
      { id: String(args.id), uri: args.uri },
      { retry: true },
    );
    return {
      httpStatus: j.httpStatus,
      status: j.body?.status,
      message: j.body?.response?.message ?? j.body?.message ?? j.body?.error,
      oldUri: j.body?.response?.oldUri,
      raw: j.raw?.slice(0, 300),
      finalUrl: j.finalUrl,
      redirected: j.redirected,
      contentType: j.contentType,
      attempts: j.attempts,
      missed: j.missed,
    };
  }

  /**
   * The admin's own "Генератор редиректов": mass-create slash/no-slash redirects
   * for whole sections. `type` 1 = links WITH a slash redirect to links WITHOUT,
   * 2 = the other way round. Fire-and-forget — it answers `{status:"OK",
   * response:[]}` and says nothing about what it did, so the caller must diff the
   * redirect set around it (which the tool does).
   */
  async redirectGenerate(
    store: string | undefined,
    args: { handlers: Array<number | string>; type: 1 | 2 },
  ): Promise<{ httpStatus: number; status?: string; message?: string }> {
    const { name, conf } = this.resolve(store);
    const params = new URLSearchParams();
    for (const h of args.handlers) params.append("handlers[]", String(h));
    params.set("type", String(args.type));
    const res = await this.fetchSession(name, conf, "/_widget/p_url_history_generator/generate/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: params.toString(),
    });
    const body = await res.json().catch(() => ({}) as any);
    return { httpStatus: res.status, status: body?.status, message: body?.response?.message };
  }

  /** Create a 301 from `uri` to an existing record (handler = target entity type). */
  async redirectCreate(
    store: string | undefined,
    args: { handler: number | string; record: number | string; uri: string },
  ): Promise<{ httpStatus: number; status?: string; historyId?: string; message?: string }> {
    const j = await this.widgetPost(store, "/_widget/p_url_history/create/", {
      handler: String(args.handler),
      record: String(args.record),
      uri: args.uri,
    });
    return {
      httpStatus: j.httpStatus,
      status: j.body?.status,
      historyId: j.body?.response?.history_id != null ? String(j.body.response.history_id) : undefined,
      message: j.body?.response?.message,
    };
  }

  /** Delete a redirect by its history_id. */
  async redirectDelete(
    store: string | undefined,
    id: number | string,
  ): Promise<{ httpStatus: number; status?: string }> {
    const j = await this.widgetPost(store, "/_widget/p_url_history/delete/", { id: String(id) }, { retry: true });
    return { httpStatus: j.httpStatus, status: j.body?.status };
  }

  /**
   * A widget answer that never reached the widget. Measured on the test store
   * (5 events in 78 calls): the very same POST to
   * `/_widget/p_url_history/update/` occasionally comes back **HTTP 400,
   * `text/html`, body = the STOREFRONT page** — same URL, no redirect followed.
   * The admin route simply did not resolve on that request and the public
   * front-controller answered instead, so nothing was written and nothing was
   * refused. A widget that really ran always answers JSON carrying `status`.
   */
  private static widgetMissed(r: { httpStatus: number; body: any; raw: string }): boolean {
    if (r.body && typeof r.body === "object" && r.body.status !== undefined) return false;
    return r.httpStatus >= 400 || /^\s*<!doctype html/i.test(r.raw);
  }

  /**
   * `retry: true` is ONLY for calls that are idempotent by construction (set
   * this id to this value / delete this id) — repeating them cannot double a
   * write. Creation is deliberately left without it: if a create ever landed
   * while its answer was lost, a retry would mint a second row.
   * `HOROSHOP_WIDGET_RETRY=off` disables it — that is the control arm.
   */
  private async widgetPost(
    store: string | undefined,
    path: string,
    params: Record<string, string>,
    opts: { retry?: boolean } = {},
  ): Promise<{ httpStatus: number; body: any; raw: string; finalUrl: string; redirected: boolean; contentType: string | null; attempts: number; missed: number }> {
    const { name, conf } = this.resolve(store);
    // Five, not three, and the number is measured: the miss rate is NOT
    // stationary — it sat at 6 % across a quiet hour and at 47 % during a burst
    // (control arm 19/40). Three attempts leave 10 % of a burst still
    // failing; five leave 2 %. Retries cost nothing on the happy path because a
    // widget that actually ran always answers JSON and never enters this loop.
    const maxAttempts = opts.retry === true && process.env.HOROSHOP_WIDGET_RETRY !== "off" ? 5 : 1;
    const body = new URLSearchParams(params).toString();
    let out!: { httpStatus: number; body: any; raw: string; finalUrl: string; redirected: boolean; contentType: string | null; attempts: number; missed: number };
    let missed = 0;
    for (let a = 1; a <= maxAttempts; a++) {
      if (a > 1) {
        // Drop the cached session first: the leading hypothesis is that the
        // request was not recognised as an admin one, so re-authenticating is
        // the cheapest thing that could possibly fix it.
        this.sessions.delete(name);
        await new Promise((r) => setTimeout(r, 400 * (a - 1)));
      }
      const res = await this.fetchSession(name, conf, path, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body,
      });
      // Read the text once and parse from it: `res.json()` swallowing a non-JSON
      // body left every widget failure indistinguishable from every other
      // (a 400 with the storefront page in it read as `status: undefined`).
      const raw = await res.text().catch(() => "");
      let parsed: any = {};
      try {
        parsed = raw ? JSON.parse(raw) : {};
      } catch {
        parsed = {};
      }
      out = {
        httpStatus: res.status,
        body: parsed,
        raw,
        finalUrl: res.url,
        redirected: (res as any).redirected === true,
        contentType: res.headers.get("content-type") ?? null,
        attempts: a,
        missed,
      };
      if (!AdminClient.widgetMissed(out)) break;
      missed++;
      out.missed = missed;
    }
    return out;
  }

  /**
   * Persist a form that posts to a "modern" route (urlencoded) instead of the
   * multipart save.php — e.g. languages → `/languages/save/`. Read-modify-write
   * from the parsed edit form plus overrides.
   */
  async saveViaRoute(
    store: string | undefined,
    action: string,
    form: ParsedForm,
    overrides: Record<string, string>,
  ): Promise<{ httpStatus: number; status?: string; body: any }> {
    const { name, conf } = this.resolve(store);
    // redirect:manual — these routes answer with a 302 to a back URL on success;
    // following it can fail and it carries no useful body.
    const res = await this.fetchSession(
      name,
      conf,
      action,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: buildUrlencoded(form.fields, overrides),
      },
      "manual",
    );
    const body = await res.json().catch(() => ({}));
    return { httpStatus: res.status, status: body?.status, body };
  }

  private editUrl(t: EditTarget): string {
    const p = new URLSearchParams();
    p.set("id", String(t.id));
    p.set("handler", String(t.handler));
    if (t.handlertable) p.set("handlertable", t.handlertable);
    p.set("checkcode", CHECKCODE);
    for (const [k, v] of Object.entries(t.extra ?? {})) p.set(k, String(v));
    let qs = p.toString();
    for (const flag of t.flags ?? []) qs += `&${encodeURIComponent(flag)}`;
    return `/adminLegacy/edit.php?${qs}`;
  }

  private cookieHeader(sess: Session): string {
    return [...sess.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  private absorbCookies(sess: Session, res: Response): void {
    for (const raw of parseSetCookie(res)) {
      const first = raw.split(";", 1)[0];
      const eq = first.indexOf("=");
      if (eq <= 0) continue;
      const k = first.slice(0, eq).trim();
      const v = first.slice(eq + 1).trim();
      if (k) sess.cookies.set(k, v);
    }
  }

  private async login(name: string, conf: StoreConfig): Promise<Session> {
    const sess: Session = { cookies: new Map() };
    const res = await this.raw(
      conf,
      "/core-api/admin/security/login",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ login: conf.login, password: conf.password }),
      },
      "manual",
    );
    this.absorbCookies(sess, res);
    if (!sess.cookies.has("API_SESSION_ID")) {
      const detail = res.status === 200
        ? "credentials rejected"
        : `unexpected HTTP ${res.status}`;
      throw new HoroshopError(
        `Admin login failed for "${name}" (${hostOf(conf.baseUrl)}): ${detail}.`,
      );
    }
    this.sessions.set(name, sess);
    return sess;
  }

  private async fetchSession(
    name: string,
    conf: StoreConfig,
    path: string,
    init: RequestInit,
    redirect: RequestRedirect = "follow",
  ): Promise<Response> {
    let sess = this.sessions.get(name) ?? (await this.login(name, conf));
    let res = await this.raw(conf, path, this.withCookies(init, sess), redirect);
    this.absorbCookies(sess, res);

    if (res.status === 401) {
      sess = await this.login(name, conf);
      res = await this.raw(conf, path, this.withCookies(init, sess), redirect);
      this.absorbCookies(sess, res);
    }
    return res;
  }

  private withCookies(init: RequestInit, sess: Session): RequestInit {
    const header = this.cookieHeader(sess);
    return { ...init, headers: { ...(init.headers ?? {}), Cookie: header } };
  }

  private async raw(
    conf: StoreConfig,
    path: string,
    init: RequestInit,
    redirect: RequestRedirect,
  ): Promise<Response> {
    const url = path.startsWith("http") ? path : `${conf.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    try {
      const headers = new Headers(init.headers as HeadersInit | undefined);
      if (!headers.has("User-Agent")) headers.set("User-Agent", BROWSER_UA);
      return await fetch(url, { ...init, headers, redirect, signal: controller.signal });
    } catch (e) {
      const cause =
        (e as Error).name === "AbortError"
          ? `request timed out after ${this.cfg.timeoutMs} ms`
          : (e as Error).message;
      throw new HoroshopError(`Network error on ${path} @ ${hostOf(conf.baseUrl)}: ${cause}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}
