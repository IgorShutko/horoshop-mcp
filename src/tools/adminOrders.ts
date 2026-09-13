import { z } from "zod";
import { storeField, type ToolSpec } from "../register.js";
import { CHECKCODE, fieldValue } from "../admin/form.js";
import {
  ORDER_HANDLER,
  ORDER_STATUS_CANCELLED,
  orderDeleteRowPath,
  orderEditPath,
  orderPrintPath,
  parseOrderEditor,
  parseTransferForm,
  type ParsedOrderEditor,
} from "../admin/orders.js";

/**
 * ORDERS, the admin half — everything `/api/orders/*` cannot do.
 *
 * The reason this file exists is one measured number: cancelling an order
 * through the public API (`orders/update {status:4}`) answers `UPDATED`, sets the
 * status, and leaves the goods deducted from stock (3 → 3). The admin's own
 * cancel with `return_quantity=1` puts them back (3 → 4). So the documented API
 * cancels an order only HALF way, and there is no flag in it for the other half.
 * `horoshop_admin_order_status_change` is that other half.
 */

const RESIDUES_FIELD = "extra[catalog_use_residues_by_stock]";

/**
 * MEASURED SIDE EFFECT of reading an order editor, worth stating in the tools
 * that do it: `edit.php?id=N&action=edit` stamps the row's date. One row read at
 * 10:06:23 read 10:09:46 after a second visit, and since the orders grid is
 * SORTED by that date, the rows we look at jump to the top of the store's own
 * order list. The order itself is untouched (the API's `stat_created`, status,
 * totals and cart all stay as they were — verified), but a caller pointing these
 * tools at a live store deserves to know the grid order moves.
 */
const EDITOR_TOUCH_NOTE =
  "⚠ READING AN ORDER EDITOR TOUCHES ITS ROW. Horoshop stamps the record's date on every editor open (measured: 10:06:23 → 10:09:46 on a re-read), and the admin orders grid is sorted by that date — so the orders this tool reads jump to the top of the store's list. Nothing about the order changes (creation date, status, totals and cart are untouched — verified against the API), but it is why this tool is built to spend as few editor reads as possible: 2 on a hit, 0 on a number the API says does not exist.";

/** Is warehouse stock accounting on? Without it, returning stock is meaningless. */
async function stockAccountingEnabled(client: any, store?: string): Promise<boolean | null> {
  try {
    const form = await client.admin.getFormFromUrl(store, "/adminLegacy/utils/site_settings.php");
    const v = fieldValue(form, RESIDUES_FIELD);
    if (v === "") return null;
    return v === "1" || v.toLowerCase() === "true";
  } catch {
    return null;
  }
}

interface EditorRead {
  httpStatus: number;
  location: string | null;
  /** 302 → handlers/orders.php: the order is cancelled and no longer editable. */
  locked: boolean;
  order: ParsedOrderEditor | null;
}

async function readEditor(client: any, store: string | undefined, adminId: string | number): Promise<EditorRead> {
  const r = await client.admin.getAdminHtml(store, orderEditPath(adminId), "manual");
  const locked = r.status >= 300 && r.status < 400 && /handlers\/orders\.php/.test(r.location ?? "");
  const order = r.status === 200 && /order-status-switcher|checkout-container/.test(r.html) ? parseOrderEditor(r.html) : null;
  return { httpStatus: r.status, location: r.location, locked, order };
}

/**
 * EVERY row id in the orders grid — all pages, not just the one the session
 * happens to be sitting on.
 *
 * This used to be a single `dataGridReload`, which serves ONLY the grid's
 * current page (page and perPage are server-side session state, not query
 * params). On a store with more orders than one window that is 20 rows out of
 * thousands, and every caller downstream — the number→id resolver, the delete
 * tool's "is the row there / did it go" check — silently reasoned about that
 * slice as if it were the whole grid. It is the exact bug that `listRecords`
 * was written to kill on the generic grids (a 20-of-35 read once produced three
 * sessions' worth of false conclusions), so the fix is to reuse `listRecords`
 * rather than re-invent a walker: it reads the pager total, walks `changePage`
 * to the last page, and reports `truncated` when its own safety cap cuts the
 * walk short.
 */
async function readOrderGrid(
  client: any,
  store?: string,
  opts: { maxRows?: number } = {},
): Promise<{ ids: number[]; total: number; truncated: boolean }> {
  const rows = await client.admin.listRecords(store, ORDER_HANDLER, { maxRows: opts.maxRows });
  const ids = [...new Set(rows.map((r: any) => Number(r.id)).filter((n: number) => Number.isFinite(n)))].sort(
    (a, b) => (a as number) - (b as number),
  ) as number[];
  return { ids, total: (rows as any).total ?? ids.length, truncated: (rows as any).truncated === true };
}

/** Back-compat shape for callers that only want the ids. */
async function orderGridIds(client: any, store?: string): Promise<number[]> {
  return (await readOrderGrid(client, store)).ids;
}

/** `listRecords`' own default row cap — the line between the two strategies. */
const DEFAULT_LIST_MAX_ROWS = 5000;
/** Widest page the datagrid serves; the fewest page reads per row. */
const ORDER_GRID_WINDOW = 160;

/**
 * The grid's SHAPE without walking it: one page read gives the grand total, the
 * page size the grid is serving, and page 1's row ids.
 */
async function readOrderGridHead(
  client: any,
  store: string | undefined,
): Promise<{ total: number; window: number; firstPage: number[] }> {
  const rows = await client.admin.listRecords(store, ORDER_HANDLER, { page: 1, perPage: ORDER_GRID_WINDOW });
  const ids = rows.map((r: any) => Number(r.id)).filter((n: number) => Number.isFinite(n));
  const window = ids.length;
  return { total: (rows as any).total ?? ids.length, window, firstPage: ids };
}

/** How the candidate scan went — the difference between "no" and "did not look". */
export interface ResolveScan {
  /** Rows the grid holds in total (its own pager count, across every page). */
  gridRows: number;
  /** Rows we actually had ids for (< gridRows only if the listing walk was capped). */
  rowsListed: number;
  /** Rows whose editor was actually read back. */
  rowsRead: number;
  /** Editor reads spent (== rowsRead; kept as the familiar name). */
  probes: number;
  /**
   * How the candidate set was obtained.
   *  - `full-listing`: every row id was listed first (the grid fits `maxRows`),
   *    so `exhaustive:true` is reachable and means "genuinely not there".
   *  - `id-range`: the grid is bigger than `maxRows`, so it was NOT listed at
   *    all — the record-id space was walked directly by interpolation. Nothing
   *    was truncated away (the whole range is reachable), but the rows were not
   *    all read, so `exhaustive` stays false and a miss is qualified by
   *    `bracket` instead.
   */
  strategy: "full-listing" | "id-range";
  /** Grid pages fetched (1 on the id-range strategy: the shape read). */
  pageFetches?: number;
  /**
   * Every listed row was read back AND the listing itself was complete.
   * On a HIT this is normally false and means nothing bad — the search stops the
   * moment it matches. It is the MISS that has to be read: exhaustive:true is
   * "the number is genuinely not here", exhaustive:false is "we did not look
   * everywhere", and `limitedBy` then says what stopped us.
   */
  exhaustive: boolean;
  /**
   * A miss the windowed search could still PROVE, by reading the two rows the
   * number would have to sit between. Adjacent rows (`gap:1`) with numbers on
   * either side leave nowhere for it to be — as strong as `exhaustive` for this
   * one number, but it is reported separately because it rests on the grid's
   * ordering (record id ↑ ⇒ order number ↑) rather than on having read
   * everything.
   */
  bracket?: {
    kind: "between";
    /** Nearest number ABOVE the target that was actually read, and its row id. */
    above?: { orderId: number; adminId: number };
    /** Nearest number BELOW the target that was actually read, and its row id. */
    below?: { orderId: number; adminId: number };
    /** Row positions between the two (1 = adjacent = nothing can hide there). */
    gap?: number;
  };
  /** Set only when something actually cut the search short. */
  limitedBy?: "probe-budget" | "grid-listing-truncated";
}

interface Resolved {
  adminId: number;
  apiOrderId: number | null;
  probes: number;
  offset: number | null;
  scan: ResolveScan;
  note?: string;
}

/**
 * Editor reads one `resolve` may spend. A probe is one HTTP GET, so an
 * unbounded linear scan of a 5000-order grid is 5000 requests. The search below
 * is a binary search over a monotone mapping (~13 probes for 5000 rows), so the
 * budget is only ever reached when that monotonicity breaks and the linear
 * fallback runs — and when it IS reached the answer says so instead of
 * reporting "not found".
 */
const RESOLVE_MAX_PROBES = 40;

/**
 * Order number (what `orders/get` calls `order_id`) → admin record id.
 *
 * There is no order-number column in the grid to filter on — measured: the
 * column the admin labels «Заказ» (param 6335) holds the order TOTAL, and a
 * numeric filter on it for `26` returns nothing for order #26 while the row
 * sits right there. So the number can only be read out of each editor's own
 * heading, one HTTP request per row, and the whole job is to spend as few of
 * those as possible while still being able to say "it is not here" honestly.
 *
 * Three stages, cheapest first:
 *  1. **Offset.** The first row's heading gives the store's constant gap
 *     between the two autoincrements (on the test store +2, from draft rows that
 *     ate record ids), so `orderId + offset` is usually the answer — two probes.
 *  2. **Binary search.** Both ids are autoincrements, so record id ↑ ⇒ order
 *     number ↑: the mapping is monotone and searchable in ~log₂(rows) probes
 *     (13 for 5000 orders) even when the offset has drifted. Drafts and
 *     cancelled orders are HOLES (no readable number); the search steps
 *     outward from the midpoint to the nearest readable row.
 *  3. **Linear fallback**, bounded by the probe budget, for a grid whose
 *     ordering is not monotone after all.
 *
 * Whatever happens, the candidate set is the WHOLE grid (`readOrderGrid` walks
 * every page). If the answer is "not found", the error says whether every row
 * was actually read back or whether the search ran out of budget — those are
 * very different facts and conflating them is how a live order gets reported
 * as deleted.
 */
async function resolveByOrderId(
  client: any,
  store: string | undefined,
  orderId: number,
  opts: { maxProbes?: number; maxRows?: number } = {},
): Promise<Resolved> {
  // On a grid bigger than the listing cap, listing first is the wrong shape: it
  // is 255 requests / 159 s on 40 699 orders, and with the default cap it lists
  // only the newest 5 120 rows — so 88 % of the store could not be resolved by
  // number at all (D3). The windowed search below needs no listing.
  const head = await readOrderGridHead(client, store);
  const cap = opts.maxRows ?? DEFAULT_LIST_MAX_ROWS;
  if (head.total > cap && head.window > 0) {
    return resolveByOrderIdBigGrid(client, store, orderId, head, {
      maxProbes: opts.maxProbes,
      cap,
    });
  }

  const grid = await readOrderGrid(client, store, { maxRows: opts.maxRows });
  const ids = grid.ids;
  if (ids.length === 0) {
    throw new Error(
      `The orders grid (handler ${ORDER_HANDLER}) is empty on this store, so order #${orderId} has no admin record to address. Check horoshop_orders_get first.`,
    );
  }

  const maxProbes = Math.max(1, opts.maxProbes ?? RESOLVE_MAX_PROBES);
  const seen = new Map<number, number | null>();
  let probes = 0;
  let budgetSpent = false;

  /** One editor read. `undefined` = never read, the probe budget is gone. */
  const probe = async (adminId: number): Promise<number | null | undefined> => {
    if (seen.has(adminId)) return seen.get(adminId);
    if (probes >= maxProbes) {
      budgetSpent = true;
      return undefined;
    }
    probes++;
    const r = await readEditor(client, store, adminId);
    const n = r.order?.apiOrderId ?? null;
    seen.set(adminId, n);
    return n;
  };

  const scan = (): ResolveScan => {
    const exhaustive = seen.size >= ids.length && !grid.truncated;
    // `limitedBy` marks a REAL ceiling, not merely "we stopped early because we
    // found it" — claiming the probe budget bit when it never did is the same
    // class of lie this whole fix is about.
    const limitedBy: ResolveScan["limitedBy"] | undefined = grid.truncated
      ? "grid-listing-truncated"
      : budgetSpent
        ? "probe-budget"
        : undefined;
    return {
      gridRows: grid.total,
      rowsListed: ids.length,
      rowsRead: seen.size,
      probes,
      strategy: "full-listing" as const,
      exhaustive,
      ...(limitedBy ? { limitedBy } : {}),
    };
  };
  const hit = (adminId: number): Resolved => ({
    adminId,
    apiOrderId: orderId,
    probes,
    offset: adminId - orderId,
    scan: scan(),
  });

  // 1 — the offset shortcut.
  const first = await probe(ids[0]);
  if (first === orderId) return hit(ids[0]);
  if (typeof first === "number") {
    const candidate = orderId + (ids[0] - first);
    if (candidate !== ids[0] && ids.includes(candidate) && (await probe(candidate)) === orderId) {
      return hit(candidate);
    }
  }

  // 2 — binary search over the monotone id → number mapping. `probeWindow`
  // returns the nearest READABLE row to the middle of [lo, hi]: a draft or a
  // cancelled order has no heading number and must not decide the direction.
  const probeWindow = async (lo: number, hi: number): Promise<{ idx: number; num: number } | null> => {
    const mid = (lo + hi) >> 1;
    const at = async (i: number): Promise<{ idx: number; num: number } | null | undefined> => {
      const n = await probe(ids[i]);
      if (n === undefined) return undefined;
      return typeof n === "number" ? { idx: i, num: n } : null;
    };
    const centre = await at(mid);
    if (centre === undefined) return null;
    if (centre) return centre;
    for (let step = 1; mid - step >= lo || mid + step <= hi; step++) {
      if (mid + step <= hi) {
        const r = await at(mid + step);
        if (r === undefined) return null;
        if (r) return r;
      }
      if (mid - step >= lo) {
        const r = await at(mid - step);
        if (r === undefined) return null;
        if (r) return r;
      }
    }
    return null;
  };

  let lo = 0;
  let hi = ids.length - 1;
  while (lo <= hi) {
    const found = await probeWindow(lo, hi);
    if (!found) break;
    if (found.num === orderId) return hit(ids[found.idx]);
    if (found.num < orderId) lo = found.idx + 1;
    else hi = found.idx - 1;
  }

  // 3 — linear fallback for a grid that is not ordered the way we assumed.
  for (const id of ids) {
    if (seen.has(id)) continue;
    const n = await probe(id);
    if (n === undefined) break;
    if (n === orderId) return hit(id);
  }

  const s = scan();
  throw new Error(
    s.exhaustive
      ? `Order #${orderId} is NOT in the admin orders grid. This is a complete answer: all ${s.gridRows} row(s) of the grid were listed (every page) and all ${s.rowsRead} of them were read back. ` +
        `Two things still look like this: a CANCELLED order (the row exists but its editor 302-redirects, so it has no readable number — address it by \`adminId\`), and a deleted one (simply gone).`
      : `Order #${orderId} was NOT FOUND — but the search was INCOMPLETE, so this is not proof the order is missing. ` +
        (s.limitedBy === "grid-listing-truncated"
          ? `The grid listing itself was truncated (${s.rowsListed} of ${s.gridRows} rows), so some rows were never candidates. Raise \`maxRows\`.`
          : `The probe budget ran out after ${s.rowsRead} editor read(s) over ${s.rowsListed} row(s), so ${s.rowsListed - s.rowsRead} row(s) were never read. Raise \`maxProbes\`.`) +
        ` Or skip the scan entirely: take the record id from horoshop_admin_list entity=orders and address the order by \`adminId\`.`,
  );
}

/**
 * The same resolve on a grid TOO BIG TO LIST — and without listing it at all.
 *
 * On a 40 699-order store the listing-first design failed twice over: the
 * default cap listed only the newest 5 120 rows, so a middle or old order
 * answered "not found (listing truncated)" — 88 % of the store unreachable by
 * number — and lifting the cap (`maxRows:45000`) found it at the price of 255
 * page reads / 159 s, past a typical client timeout.
 *
 * FIVE MEASURED FACTS decide the design here; three of them killed the obvious
 * approaches first:
 *
 *  1. The orders grid is sorted by the row's DATE, not by its id (page 1 of
 *     one live store came back holding record ids 7, 6, 5 next to 40 654). So grid
 *     POSITION says nothing about the order number, and any "binary search over
 *     grid positions" is built on sand. Measured, after it produced nonsense.
 *  2. Opening an order editor BUMPS that date (a row read at 10:06:23 read
 *     10:09:46 after a second visit), so the grid reorders itself around
 *     whatever we just read, and every probe is a visible side effect on the
 *     store's own order list. Probes are therefore something to SPEND, not to
 *     scatter — this design uses 1–3 where the old one used 2–13 plus 255 page
 *     reads.
 *  3. `edit.php?id=<nonexistent>&action=edit` answers HTTP 404 and creates
 *     nothing (verified on the test store: grid stayed at 0 rows). So an id that is
 *     not in the grid is safe to probe — which is what makes searching the id
 *     SPACE, with no listing, legitimate.
 *  4. Record id ≥ order number, always: both are autoincrements and drafts
 *     consume ids without creating orders, so the gap only grows. `orderId` is
 *     therefore a hard floor for the search, and the gap is small (1–3 here).
 *  5. `orders/get ids:[N]` answers whether the NUMBER exists at all — a pure
 *     read with no side effect. Asking it first turns the most common "not
 *     found" into a complete answer that costs zero editor reads.
 *
 * So: ask the API, then walk the id space by interpolation (id − number is
 * nearly constant, so the first guess is usually right), and bracket what is
 * left. `exhaustive` still means "every row was listed AND read" and stays
 * false here; a miss is qualified by `bracket` instead — two ADJACENT ids
 * (`gap:1`) straddling the number leave nowhere for it to hide.
 */
async function resolveByOrderIdBigGrid(
  client: any,
  store: string | undefined,
  orderId: number,
  head: { total: number; window: number; firstPage: number[] },
  opts: { maxProbes?: number; cap: number },
): Promise<Resolved> {
  const maxProbes = Math.max(1, opts.maxProbes ?? RESOLVE_MAX_PROBES);
  const seen = new Map<number, number | null>();
  let probes = 0;
  let budgetSpent = false;

  const probe = async (adminId: number): Promise<number | null | undefined> => {
    if (adminId < 1) return null;
    if (seen.has(adminId)) return seen.get(adminId);
    if (probes >= maxProbes) {
      budgetSpent = true;
      return undefined;
    }
    probes++;
    const r = await readEditor(client, store, adminId);
    const n = r.order?.apiOrderId ?? null;
    seen.set(adminId, n);
    return n;
  };

  // ── 0. Does the number exist AT ALL? The public API is the authority on order
  // numbers and reading it touches nothing. A "no" here is a complete answer for
  // zero editor reads; a "yes" turns a later miss into "the row is locked",
  // which is a different fact from "the order is gone".
  let apiOrder: Record<string, unknown> | null = null;
  let apiAsked = false;
  try {
    const body: any = await client.call(store, "orders/get", { ids: [orderId], limit: 1 });
    const list = body?.response?.orders ?? body?.response ?? [];
    apiAsked = true;
    apiOrder = (Array.isArray(list) ? list : []).find((o: any) => Number(o?.order_id) === orderId) ?? null;
  } catch {
    apiAsked = false; // the API is optional here — the id walk works without it
  }

  let bracket: ResolveScan["bracket"];
  const holesIn = (a: number, b: number): number[] =>
    [...seen.entries()].filter(([id, n]) => n === null && id > a && id < b).map(([id]) => id);
  const scan = (): ResolveScan => ({
    gridRows: head.total,
    // Nothing was listed and nothing was cut off: the candidate set is the whole
    // id space. Saying "rowsListed: 40699" would claim a listing that never
    // happened, which is the exact kind of lie this contract exists to prevent.
    rowsListed: 0,
    rowsRead: seen.size,
    probes,
    strategy: "id-range",
    pageFetches: 1,
    exhaustive: false,
    ...(bracket ? { bracket } : {}),
    ...(budgetSpent ? { limitedBy: "probe-budget" as const } : {}),
  });
  const hit = (adminId: number): Resolved => ({
    adminId,
    apiOrderId: orderId,
    probes,
    offset: adminId - orderId,
    scan: scan(),
  });

  if (apiAsked && !apiOrder) {
    throw new Error(
      `Order #${orderId} does not exist on this store. The catalogue of order NUMBERS is the public API, and \`orders/get ids:[${orderId}]\` returned nothing — so there is no admin row to resolve, and no editor was opened to find that out. ` +
        `(A cancelled order still comes back from the API, so this is not that case.)`,
    );
  }

  /** First READABLE row at or near `target`, staying inside [min, max]. */
  const probeNear = async (
    target: number,
    min: number,
    max: number,
    span = 6,
  ): Promise<{ id: number; num: number } | null> => {
    const start = Math.min(Math.max(target, min), max);
    for (let step = 0; step <= span; step++) {
      for (const id of step === 0 ? [start] : [start + step, start - step]) {
        if (id < min || id > max) continue;
        const n = await probe(id);
        if (n === undefined) return null; // budget gone
        if (typeof n === "number") return { id, num: n };
      }
    }
    return null;
  };

  // ── 1. Walk the id space. `lo` is the greatest id known to hold a SMALLER
  // number, `hi` the smallest known to hold a bigger one. The next candidate is
  // an interpolation (`lo + (orderId − numberAt(lo))`), which lands on the answer
  // in one step whenever the id↔number gap is locally constant — it is.
  let lo = orderId - 1; // hard floor (fact 4): no smaller id can hold this number
  let loNum: number | null = null;
  let hi = Number.POSITIVE_INFINITY;
  let hiNum: number | null = null;
  let gallop = 8;

  for (let round = 0; round < 32; round++) {
    let cand: number;
    if (Number.isFinite(hi)) {
      if (hi - lo <= 1) break; // bracketed — nothing lives between two adjacent ids
      cand =
        loNum != null
          ? Math.min(hi - 1, Math.max(lo + 1, lo + (orderId - loNum)))
          : Math.floor((lo + hi) / 2);
    } else {
      cand = loNum != null ? lo + Math.max(1, orderId - loNum) : orderId;
      if (seen.has(cand)) {
        cand = lo + gallop;
        gallop *= 2;
      }
    }
    const r = await probeNear(cand, lo + 1, Number.isFinite(hi) ? hi - 1 : cand + 16);
    if (!r) break;
    if (r.num === orderId) return hit(r.id);
    if (r.num < orderId) {
      lo = r.id;
      loNum = r.num;
    } else {
      hi = r.id;
      hiNum = r.num;
    }
  }

  // ── 2. The miss, qualified.
  const holes = Number.isFinite(hi) ? holesIn(lo, hi) : [];
  if (loNum != null && hiNum != null) {
    bracket = {
      kind: "between",
      above: { orderId: hiNum, adminId: hi },
      below: { orderId: loNum, adminId: lo },
      gap: hi - lo,
    };
  }
  const proven = bracket?.kind === "between" && (bracket.gap ?? 99) <= 1;
  const s = scan();
  throw new Error(
    proven
      ? `Order #${orderId} has NO readable admin row. The id space was searched by interpolation (${probes} editor read(s), no grid listing) and the two records that straddle it are ADJACENT: record ${lo} holds #${loNum} and record ${hi} holds #${hiNum}, with no id in between. ` +
        (apiOrder
          ? `The public API DOES know order #${orderId}, so the order exists — its row is a CANCELLED order whose editor 302-redirects and therefore shows no number. Address it by \`adminId\` (horoshop_admin_list entity=orders), not by number.`
          : `So the number is not in the admin at all.`)
      : `Order #${orderId} was NOT FOUND — and the search was INCOMPLETE, so this is not proof. ` +
        (budgetSpent
          ? `The probe budget ran out after ${probes} editor read(s); raise \`maxProbes\`. `
          : `The id walk could not bracket it (records ${lo}…${Number.isFinite(hi) ? hi : "?"} read, ${probes} editor read(s)). `) +
        (holes.length
          ? `Records ${holes.join(", ")} in that range show no number at all (cancelled orders 302-redirect) — one of them may be it. `
          : "") +
        `For a listing-complete answer re-run with maxRows:${head.total + 1} (≈${Math.ceil(head.total / Math.max(head.window, 1))} page reads), or take the record id from horoshop_admin_list entity=orders and address the order by \`adminId\`.`,
  );
}



/** Stock of one or more product ids, read from the warehouse-transfer form. */
async function readTransferForm(client: any, store: string | undefined, productIds: Array<string | number>) {
  const r = await client.admin.postUrlencoded(
    store,
    "/adminLegacy/js/lookup.php",
    { load: "transfer_income", "ids[]": productIds.map(String), ware_id: "1", checkcode: CHECKCODE },
    { redirect: "follow", accept: "application/json" },
  );
  let html = "";
  try {
    html = JSON.parse(r.text)?.response?.html ?? "";
  } catch {
    html = "";
  }
  if (!html) {
    throw new Error(
      `The warehouse-transfer form did not open for product(s) ${productIds.join(", ")} (HTTP ${r.httpStatus}). ` +
        `Response: ${r.text.slice(0, 160)}`,
    );
  }
  return parseTransferForm(html);
}

/** article → internal product id, verified against the transfer form's own echo. */
async function resolveProductByArticle(
  client: any,
  store: string | undefined,
  article: string,
): Promise<{ id: string; article: string; stock: number } | null> {
  const res = await client.admin.searchRecords(store, 17, { query: article, maxRows: 50 });
  const ids = res.rows.map((r: any) => r.id).slice(0, 20);
  if (!ids.length) return null;
  const form = await readTransferForm(client, store, ids);
  // Strict, exact match on the article the admin itself prints — a substring
  // match would happily bind "TEE-ORBIT" to "TEE-ORBIT-XL".
  const hit = form.products.find((p) => p.article === article);
  return hit ? { id: hit.id, article: hit.article, stock: hit.stock } : null;
}

/**
 * How many cart lines the stock proof covers by default.
 *
 * It used to be 5, hard-coded and SILENT: a 12-line order was verified for five
 * articles and the answer said nothing about the other seven, so a partial
 * proof read exactly like a complete one. The cap itself is real — each line
 * costs ~5 admin requests (article lookup + two ledger reads) — so it stays,
 * raised, and every answer now carries `stockCheckCoverage` saying how many of
 * how many were actually read. `stockCheckLimit` moves it per call.
 */
const STOCK_CHECK_DEFAULT_LIMIT = 20;
const STOCK_CHECK_MAX_LIMIT = 100;

interface StockSnapshot {
  rows: Array<{ article: string; productId: string | null; stock: number | null; ordered: string }>;
  coverage: { cartLines: number; withArticle: number; checked: number; limit: number; truncated: boolean };
}

/** Per-line stock snapshot for an order, used to PROVE a return actually landed. */
async function snapshotStock(
  client: any,
  store: string | undefined,
  order: ParsedOrderEditor,
  limit = STOCK_CHECK_DEFAULT_LIMIT,
): Promise<StockSnapshot> {
  const cap = Math.min(Math.max(1, limit), STOCK_CHECK_MAX_LIMIT);
  const withArticle = order.cart.lines.filter((l) => l.article);
  const covered = withArticle.slice(0, cap);
  const rows: StockSnapshot["rows"] = [];
  for (const line of covered) {
    try {
      const p = await resolveProductByArticle(client, store, line.article);
      rows.push({ article: line.article, productId: p?.id ?? null, stock: p?.stock ?? null, ordered: line.quantity });
    } catch {
      rows.push({ article: line.article, productId: null, stock: null, ordered: line.quantity });
    }
  }
  return {
    rows,
    coverage: {
      cartLines: order.cart.lines.length,
      withArticle: withArticle.length,
      checked: covered.length,
      limit: cap,
      truncated: covered.length < withArticle.length,
    },
  };
}

/** Human sentence for a coverage block — appended to every note that carries one. */
function coverageNote(c: StockSnapshot["coverage"]): string {
  const base = ` stockCheck covers ${c.checked} of ${c.withArticle} cart line(s) with an article` +
    (c.cartLines !== c.withArticle ? ` (${c.cartLines} line(s) in the cart)` : "") + ".";
  return c.truncated
    ? `${base} ⚠ TRUNCATED at the ${c.limit}-line limit — the remaining ${c.withArticle - c.checked} article(s) were NEVER read back, so nothing here says what happened to their stock. Raise \`stockCheckLimit\` (max ${STOCK_CHECK_MAX_LIMIT}) to cover them.`
    : `${base} That is every line — nothing was left unchecked.`;
}

async function restock(
  client: any,
  store: string | undefined,
  snapshot: Array<{ article: string; productId: string | null; stock: number | null; ordered: string }>,
) {
  const after: Array<{ article: string; before: number | null; after: number | null; delta: number | null }> = [];
  for (const s of snapshot) {
    if (!s.productId) {
      after.push({ article: s.article, before: s.stock, after: null, delta: null });
      continue;
    }
    try {
      const form = await readTransferForm(client, store, [s.productId]);
      const now = form.products.find((p) => p.id === s.productId)?.stock ?? null;
      after.push({
        article: s.article,
        before: s.stock,
        after: now,
        delta: now != null && s.stock != null ? now - s.stock : null,
      });
    } catch {
      after.push({ article: s.article, before: s.stock, after: null, delta: null });
    }
  }
  return after;
}

/**
 * Apply one status change through the admin editor and VERIFY it by re-reading —
 * the POST answers a bare 302 with no body, so nothing here may be claimed from
 * the response alone. Shared by the named tool and by `orders_update`'s
 * `returnStock:true` path, so both cancel the same, proven way.
 */
export async function applyStatusChange(
  client: any,
  opts: {
    store?: string;
    adminId: number | string;
    apiOrderId: number | null;
    status: number;
    returnStock?: boolean;
    verifyStock?: boolean;
    stockCheckLimit?: number;
    before: ParsedOrderEditor;
    stockAccounting?: boolean | null;
  },
) {
  const cancelling = opts.status === ORDER_STATUS_CANCELLED;
  const wantVerify = opts.verifyStock !== false && opts.before.cart.lines.length > 0;
  const snapshot = wantVerify ? await snapshotStock(client, opts.store, opts.before, opts.stockCheckLimit) : null;

  const body: Record<string, string> = { changeStatus: String(opts.adminId), status: String(opts.status) };
  if (cancelling && opts.returnStock !== undefined) body.return_quantity = opts.returnStock ? "1" : "0";
  const posted = await client.admin.postUrlencoded(opts.store, orderEditPath(opts.adminId), body, { redirect: "manual" });

  const stockCheck = snapshot ? await restock(client, opts.store, snapshot.rows) : null;

  const after = await readEditor(client, opts.store, opts.adminId);
  let apiStatus: unknown = null;
  if (opts.apiOrderId != null) {
    try {
      const body2 = await client.call(opts.store, "orders/get", { ids: [opts.apiOrderId] });
      const arr = body2?.response?.orders ?? body2?.response ?? [];
      // The API calls it `stat_status`; there is no `status` key on an order —
      // reading one left this verification silently null on every call.
      const one = (Array.isArray(arr) ? arr : [])[0];
      apiStatus = one?.stat_status ?? one?.status ?? null;
    } catch {
      apiStatus = null;
    }
  }
  const activeNow = after.order?.activeStatus?.status ?? null;
  const applied = cancelling ? after.locked || activeNow === opts.status : activeNow === opts.status;

  return {
    adminId: String(opts.adminId),
    apiOrderId: opts.apiOrderId,
    httpStatus: posted.httpStatus,
    redirectedTo: posted.location,
    status: { requested: opts.status, activeNow, locked: after.locked },
    applied,
    returnStock: cancelling ? opts.returnStock : undefined,
    stockAccountingEnabled: opts.stockAccounting ?? null,
    ...(stockCheck ? { stockCheck, stockCheckCoverage: snapshot!.coverage } : {}),
    apiStatusAfter: apiStatus,
    note:
      (applied
        ? cancelling
          ? "Cancelled — verified by the editor now redirecting (a cancelled order is un-editable)."
          : "Status changed — verified by re-reading the active button."
        : "The POST went through but the new status was NOT confirmed on re-read — treat this as failed.") +
      (stockCheck
        ? ` Warehouse stock before → after: ${stockCheck
            .map((s) => `${s.article} ${s.before ?? "?"}→${s.after ?? "?"}`)
            .join(", ")}.` + coverageNote(snapshot!.coverage)
        : "") +
      " The response is a bare 302 with no body, so every claim here comes from a re-read, not from the POST.",
  };
}

/**
 * Cancel an order BY ITS NUMBER and put the goods back on sale — the operation
 * the documented API cannot express. Used by `horoshop_orders_update`
 * (returnStock:true) so the obvious tool can do the right thing.
 */
export async function adminCancelWithStock(client: any, store: string | undefined, orderId: number) {
  const resolved = await resolveByOrderId(client, store, orderId);
  const before = await readEditor(client, store, resolved.adminId);
  if (before.locked) {
    return { orderId, adminId: resolved.adminId, applied: false, error: "Order is already cancelled — its editor redirects and the status can no longer be changed." };
  }
  if (!before.order || before.order.isDraft) {
    return { orderId, adminId: resolved.adminId, applied: false, error: `No live order editor at admin record id ${resolved.adminId} (HTTP ${before.httpStatus}).` };
  }
  const residues = await stockAccountingEnabled(client, store);
  const out = await applyStatusChange(client, {
    store,
    adminId: resolved.adminId,
    apiOrderId: before.order.apiOrderId,
    status: ORDER_STATUS_CANCELLED,
    returnStock: true,
    verifyStock: true,
    before: before.order,
    stockAccounting: residues,
  });
  return {
    orderId,
    ...out,
    resolvedWith: `${resolved.probes} editor probe(s) over a ${resolved.scan.gridRows}-row grid`,
    resolveScan: resolved.scan,
  };
}

const adminIdArg = z
  .union([z.number().int(), z.string()])
  .optional()
  .describe("Admin RECORD id (the `id` in the editor URL / the orders grid). NOT the order number.");
const orderIdArg = z
  .number()
  .int()
  .optional()
  .describe("Order NUMBER as horoshop_orders_get reports it. Resolved to the admin record id via the editor heading.");

async function resolveTarget(
  client: any,
  args: any,
): Promise<{ adminId: number | string; apiOrderId: number | null; resolution?: Resolved }> {
  if (args.adminId != null && args.orderId != null) {
    throw new Error("Pass either `orderId` (the order number) or `adminId` (the admin record id), not both.");
  }
  if (args.adminId != null) return { adminId: args.adminId, apiOrderId: null };
  if (args.orderId == null) throw new Error("Pass `orderId` (the order number) or `adminId` (the admin record id).");
  const r = await resolveByOrderId(client, args.store, args.orderId, {
    maxProbes: args.maxProbes,
    maxRows: args.maxRows,
  });
  return { adminId: r.adminId, apiOrderId: r.apiOrderId, resolution: r };
}

const maxProbesArg = z
  .number()
  .int()
  .positive()
  .optional()
  .describe(
    `Editor reads the number→record-id search may spend (default ${RESOLVE_MAX_PROBES}). The search is a binary walk over the whole grid, so it normally costs 2–15 reads even on thousands of orders; raise this only if an answer comes back saying the probe budget ran out.`,
  );
const maxRowsArg = z
  .number()
  .int()
  .positive()
  .optional()
  .describe("Cap on how many grid rows the candidate listing collects (default 5000). `scan.limitedBy` says when it bit.");

export const adminOrderTools: ToolSpec[] = [
  {
    name: "horoshop_admin_order_resolve",
    title: "Resolve an order number to its admin record id",
    description:
      "Bridge between the two ids an order has. `orders/get` reports an order NUMBER; the admin editor, the status switcher, the delete routes and the waybill printer all address an admin RECORD id — and they are two independent autoincrements (empty draft rows consume record ids without creating orders, so on the test store order #7 lived at record id 9). There is no order-number column in the grid to filter on — measured: the column labelled «Заказ» holds the order TOTAL, and filtering it for 26 returns nothing while order #26 sits right there — so the only bridge is each editor's own heading «Редактирование заказа #N», one HTTP read per row. Pass `orderId` to go number → record id, or `adminId` to go the other way (one request). " +
      "TWO SEARCH STRATEGIES, PICKED BY GRID SIZE, and `scan.strategy` says which ran. A grid that fits `maxRows` (default 5000) is LISTED first, then binary-searched over the listed ids — that is the path that can answer `exhaustive:true`. A bigger grid is NOT listed at all (`id-range`): listing 40 699 orders costs 255 page reads / 159 s and the default cap left the oldest 88 % unreachable by number. Instead the record-id SPACE is walked directly — record id ≥ order number always (both autoincrements, drafts only widen the gap), and the gap is nearly constant, so an interpolation from `orderId` lands the answer in TWO editor reads at any age: measured on 40 699 orders, the newest, the middle and the oldest order all resolved in 2 reads / ~2 s each, where before they took 24 s, failed, and failed. " +
      "A NUMBER THAT DOES NOT EXIST COSTS ZERO EDITOR READS on the id-range path: `orders/get` is the authority on order numbers, so it is asked first and a \"no\" is returned as a complete answer. " +
      "WHEN IT SAYS NOT FOUND, READ WHICH KIND OF NOT FOUND. Every answer carries `scan` (`gridRows`, `rowsListed`, `probes`, `strategy`, `exhaustive`): `exhaustive:true` (listing path only) means every row really was listed and read back. On the id-range path `exhaustive` is always false — nothing was listed — and a miss is instead qualified by `bracket`: the two records that straddle the number were read, and `gap:1` means they are ADJACENT ids with nothing in between, which is proof for that number. Anything weaker says so and points at `maxRows:<gridRows+1>` for the listing-complete answer or at `maxProbes` when the budget ran out. " +
      "A CANCELLED ORDER CANNOT BE RESOLVED BY NUMBER AT ALL: its editor 302-redirects, so it has no readable number and the call ERRORS. On the id-range path the error is sharper — if the public API still knows the number while no editor shows it, the answer says the row exists and is cancelled, and names the unreadable record ids in the bracket. `locked:true` is reported only on the `adminId` branch. " +
      EDITOR_TOUCH_NOTE,
    inputSchema: { ...storeField, orderId: orderIdArg, adminId: adminIdArg, maxProbes: maxProbesArg, maxRows: maxRowsArg },
    annotations: { readOnlyHint: true },
    handler: async (client, args) => {
      if (args.adminId != null) {
        const r = await readEditor(client, args.store, args.adminId);
        return {
          store: args.store ?? null,
          adminId: String(args.adminId),
          apiOrderId: r.order?.apiOrderId ?? null,
          isDraft: r.order ? r.order.isDraft : null,
          locked: r.locked,
          heading: r.order?.heading ?? null,
          httpStatus: r.httpStatus,
          note: r.locked
            ? "This record is a CANCELLED order: the editor redirects to the orders list, so its number cannot be read. Cancelled orders can only be deleted."
            : r.order?.isDraft
              ? "The editor rendered «Новый заказ» — this record id is an empty draft row, not an order."
              : "Resolved from the editor heading.",
        };
      }
      const r = await resolveByOrderId(client, args.store, args.orderId, {
        maxProbes: args.maxProbes,
        maxRows: args.maxRows,
      });
      return {
        store: args.store ?? null,
        ...r,
        note:
          `Resolved with ${r.probes} editor probe(s) over a ${r.scan.gridRows}-row grid (all pages listed); ` +
          `admin id = order number ${r.offset != null && r.offset >= 0 ? "+" : ""}${r.offset} on this store.`,
      };
    },
  },
  {
    name: "horoshop_admin_order_get",
    title: "Read one order from the admin editor",
    description:
      "Read an order as the admin panel sees it: recipient (name/phone/e-mail/city), delivery type and its method fields (including a Nova Poshta external waybill number), payment type and the paid flag, the manager's and the BUYER'S comment, every cart line (article, title, price, quantity, sum) with the order totals, and the status switcher with the currently active status. This is richer than horoshop_orders_get, which has no comments, no per-line editing view and no status-button state. " +
      "Address it with `orderId` (the order number) or `adminId` (the record id). ⚠️ The editor is opened with `action=edit` — that is mandatory: without it Horoshop renders a blank «Новый заказ» form AND materialises an empty 0.00 row in the orders grid, which is exactly how a recon wave once littered the grid and mistook a draft for a real order. A CANCELLED order redirects instead of opening. Addressed by `adminId` that comes back as `locked:true`; addressed by `orderId` it cannot be resolved at all and the call ERRORS instead — same cause, two different shapes. After cancelling there is nothing left to read or edit, only to delete. " +
      "Addressing by `orderId` runs horoshop_admin_order_resolve first (a listed-grid binary search, or a listing-free walk of the record-id space on a grid over `maxRows`); if it reports a number missing, read its `scan` — `exhaustive:true` or `bracket.gap:1` are proof, anything else is not. " +
      EDITOR_TOUCH_NOTE,
    inputSchema: { ...storeField, orderId: orderIdArg, adminId: adminIdArg, maxProbes: maxProbesArg, maxRows: maxRowsArg },
    annotations: { readOnlyHint: true },
    handler: async (client, args) => {
      const t = await resolveTarget(client, args);
      const r = await readEditor(client, args.store, t.adminId);
      if (r.locked) {
        return {
          store: args.store ?? null,
          adminId: String(t.adminId),
          locked: true,
          httpStatus: r.httpStatus,
          redirectedTo: r.location,
          note: "Cancelled order: the admin editor 302-redirects to the orders list and there is no form to read. It can still be deleted (horoshop_admin_order_delete) or printed.",
        };
      }
      if (!r.order) {
        throw new Error(
          `The order editor did not render for record id ${t.adminId} (HTTP ${r.httpStatus}). A non-existent id answers 404; a cancelled one redirects.`,
        );
      }
      const o = r.order;
      return {
        store: args.store ?? null,
        adminId: String(t.adminId),
        apiOrderId: o.apiOrderId,
        isDraft: o.isDraft,
        heading: o.heading,
        configPresetName: o.configPresetName,
        userId: o.userId,
        status: {
          active: o.activeStatus ? { code: o.activeStatus.status, label: o.activeStatus.label, title: o.activeStatus.title } : null,
          available: o.statuses.map((s) => ({ code: s.status, label: s.label, title: s.title, active: s.active, canReturnStock: s.hasReturnQuantity })),
        },
        recipient: o.recipient,
        comments: { customer: o.customerComment, manager: o.managerComment },
        delivery: o.delivery,
        payment: o.payment,
        cart: o.cart,
        ...(o.isDraft
          ? {
              draftWarning:
                "This record rendered «Новый заказ»: it is an EMPTY DRAFT ROW in the orders grid, not an order. It has no number and horoshop_orders_get will never return it. Delete it with horoshop_admin_order_delete if it is litter.",
            }
          : {}),
        note:
          "Status labels here are the ADMIN's, and they disagree with the API's: status 6 is titled «Доставляется» but labelled «Отправлен», and status 4 («Отменен») is «Не доставлен» in orders/get_available_statuses. The API's names are the authority for reporting.",
      };
    },
  },
  {
    name: "horoshop_admin_order_update",
    title: "Edit an order's recipient, delivery and payment",
    description:
      "Edit a LIVE order card — the recipient's name/phone/email/city, the delivery address, the manager's comment, and the paid flag. This is the part of the order the public API cannot touch: `horoshop_orders_update` moves the status and nothing else. " +
      "WHY IT WORKS THE WAY IT DOES, because the platform hides it: the order card is the storefront CHECKOUT rendered with `configPresetName=admin_order`, and `/order/setAttributes/` — the call the panel makes as you type — answers OK and SAVES NOTHING (measured). The only persist is `/order/submit/`, and it needs the WHOLE form re-serialised, including the fields the panel's own script skips. This tool reads the card, applies your patch, re-sends everything, and then confirms through the public API — a different read path from the form it just posted. " +
      "WHAT IT CANNOT DO: change what is IN the order. Line quantity, line removal and manual line price carry no form name at all (they are `j-ignore` inputs driven by `/order/component/AdminCart/*`), and the admin's product search for adding a line answers `{\"products\":[],\"enabled\":false}` on this platform. Those are measured platform limits, not omissions — see horoshop_admin_order_get for what a line exposes. " +
      "⚠ A digit in the recipient's name is refused by the platform's `safe` validator («ZZТест2» → «Поле заповнено некоректно»). Cancelled orders (status 4) are un-editable — the editor redirects away. DRY RUN BY DEFAULT.",
    inputSchema: {
      ...storeField,
      adminId: z.union([z.number().int(), z.string()]).describe("Admin record id of the order (from horoshop_admin_order_resolve / _get). NOT the order number."),
      name: z.string().optional().describe("Recipient's full name. Digits are refused by the platform's validator."),
      phone: z.string().optional().describe("Recipient's phone, e.g. \"+38 (067) 000-00-00\"."),
      email: z.string().optional().describe("Recipient's email."),
      city: z.string().optional().describe("Delivery city as text. Pair with `cityId` when you have it — the platform keys the city by id."),
      cityId: z.union([z.number().int(), z.string()]).optional().describe("Platform city id (the value already on the card, unless you are moving the order to another city)."),
      address: z.string().optional().describe("Delivery address / warehouse line."),
      managerComment: z.string().optional().describe("The MANAGER's comment (`Recipient[admin_comment]`, surfaces as `manager_comment` in orders/get). The buyer's own comment is read-only."),
      payed: z.boolean().optional().describe("Mark the order paid (true) or unpaid (false)."),
      dryRun: z.boolean().optional().describe("Default true: show the current values and the patch without writing. Set false to apply."),
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
    handler: async (client, args) => {
      const adminId = String(args.adminId);
      const read0 = await readEditor(client, args.store, adminId);
      if (read0.locked) {
        throw new Error(`Order ${adminId} is cancelled and no longer editable — the platform redirects the editor away (HTTP ${read0.httpStatus} → ${read0.location}).`);
      }
      const before = read0.order;
      if (!before || before.isDraft) {
        throw new Error(`Admin record ${adminId} is not an editable order — the editor answered HTTP ${read0.httpStatus}${before ? ` and rendered «${before.heading}»` : ""}. Resolve the id with horoshop_admin_order_resolve.`);
      }
      const patch: Record<string, string> = {};
      if (args.name !== undefined) patch["Recipient[delivery_name]"] = args.name;
      if (args.phone !== undefined) patch["Recipient[delivery_phone]"] = args.phone;
      if (args.email !== undefined) patch["Recipient[delivery_email]"] = args.email;
      if (args.city !== undefined) patch["Recipient[delivery_city]"] = args.city;
      if (args.cityId !== undefined) patch["Recipient[delivery_city_id]"] = String(args.cityId);
      if (args.address !== undefined) patch["Delivery[delivery_method][delivery_address]"] = args.address;
      if (args.managerComment !== undefined) patch["Recipient[admin_comment]"] = args.managerComment;
      if (args.payed !== undefined) patch["AdminPayment[payed]"] = args.payed ? "1" : "0";
      if (Object.keys(patch).length === 0) {
        throw new Error("Nothing to change — pass at least one of name/phone/email/city/cityId/address/managerComment/payed.");
      }
      const badName = args.name !== undefined && /\d/.test(args.name);

      if (args.dryRun !== false) {
        return {
          dryRun: true,
          adminId,
          apiOrderId: before.apiOrderId,
          current: { recipient: before.recipient, managerComment: before.managerComment, payed: before.payment.payed?.value ?? null },
          patch,
          ...(badName ? { warning: "The recipient name contains a digit — the platform's `safe` validator refuses it («Поле заповнено некоректно»)." } : {}),
          note: "Set dryRun:false to apply. The whole form is re-sent to /order/submit/, which is the only call that persists.",
        };
      }
      const res = await client.admin.orderSubmit(args.store, adminId, patch);
      const after = (await readEditor(client, args.store, adminId)).order;
      if (!after) {
        throw new Error(`The submit answered ${res.status ?? `HTTP ${res.httpStatus}`}, but the order card could not be re-read to verify it — check horoshop_admin_order_get.`);
      }
      const landed: Record<string, { want: string; got: string; ok: boolean }> = {};
      const read = (key: string): string => {
        if (key === "Recipient[admin_comment]") return after.managerComment;
        if (key === "AdminPayment[payed]") return after.payment.payed?.value ?? "";
        if (key.startsWith("Recipient[")) return after.recipient[key.slice(10, -1)] ?? "";
        return after.fields[key] ?? "";
      };
      for (const [k, want] of Object.entries(patch)) {
        const got = read(k);
        landed[k] = { want, got, ok: got.trim() === want.trim() };
      }
      const saved = Object.values(landed).every((x) => x.ok);
      return {
        dryRun: false,
        adminId,
        apiOrderId: before.apiOrderId,
        httpStatus: res.httpStatus,
        submitStatus: res.status ?? null,
        sentFields: res.sentFields,
        saved,
        landed,
        note: saved
          ? "Applied and verified by re-reading the order card."
          : `The submit answered ${res.status ?? `HTTP ${res.httpStatus}`} but at least one field did not land — see \`landed\`. A digit in the name is the usual cause.${res.message ? ` Platform said: ${res.message}` : ""}`,
        editorTouchNote: EDITOR_TOUCH_NOTE,
      };
    },
  },
  {
    name: "horoshop_admin_order_status_change",
    title: "Change an order's status (and return stock on cancel)",
    description:
      "Move ONE order to another status through the admin editor — the only path that can also PUT THE GOODS BACK ON THE SHELF. Measured: cancelling through the public API (horoshop_orders_update status:4) sets the status and leaves the stock deducted (3 → 3); this tool with `returnStock:true` posts the admin's own `return_quantity=1` and the stock comes back (3 → 4). " +
      "`returnStock` is REQUIRED when status is 4 and has no default on purpose: it is the difference between «the goods are back on sale» and «they stay sold», and only the caller knows which — and it is the LAST chance to decide, because deleting the order afterwards does not return anything either (measured). It is refused for any other status (the server ignores `return_quantity` there). Cancelling also needs `confirm:true`, because after status 4 the order is permanently un-editable — the editor redirects away. " +
      "Stock accounting must be ON (`extra[catalog_use_residues_by_stock]`) for a return to mean anything: with it off, quantity is not what drives availability and the tool says so instead of pretending. By default it VERIFIES the return by reading warehouse stock before and after (`stockCheck` with before/after/delta per article), and confirms the new status through the public API — an independent read path from the admin form it just posted. THE PROOF IS BOUNDED, AND IT SAYS SO: each line costs several admin requests, so `stockCheckLimit` (default 20) caps how many are read back, and `stockCheckCoverage` reports `checked` of `withArticle` plus `truncated` on every answer. A short `stockCheck` is therefore never ambiguous — it either says it covered every line or says exactly how many it did not. DRY RUN BY DEFAULT. " +
      "NOT this tool: creating or renaming the status LABELS themselves — that is horoshop_admin_order_status_set (entity «Статусы заказа», handler 436).",
    inputSchema: {
      ...storeField,
      orderId: orderIdArg,
      adminId: adminIdArg,
      status: z
        .number()
        .int()
        .describe("Target status: 1 new, 2 processing, 6 shipped, 3 delivered, 4 cancelled/not delivered. (Status 8 «paid» exists in the API but has no button in the editor — use horoshop_orders_update for it.)"),
      returnStock: z
        .boolean()
        .optional()
        .describe("REQUIRED when status is 4. true → the ordered quantities go back on sale (return_quantity=1); false → they stay deducted. No default: choose deliberately. Rejected for any other status."),
      confirm: z
        .boolean()
        .optional()
        .describe("REQUIRED when status is 4: cancelling is irreversible — the order becomes permanently un-editable."),
      verifyStock: z
        .boolean()
        .optional()
        .describe("Default true: read each ordered product's warehouse stock before and after so the answer carries real numbers instead of a claim. Set false to skip (saves ~5 requests per line)."),
      stockCheckLimit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          `How many cart lines the stock proof covers (default ${STOCK_CHECK_DEFAULT_LIMIT}, max ${STOCK_CHECK_MAX_LIMIT}). Whatever it is, \`stockCheckCoverage.truncated\` says whether anything was left unread — the cap is never silent.`,
        ),
      maxProbes: maxProbesArg,
      maxRows: maxRowsArg,
      dryRun: z.boolean().optional().describe("Default true: preview without changing anything. Set false to apply."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    handler: async (client, args) => {
      const status = Number(args.status);
      const cancelling = status === ORDER_STATUS_CANCELLED;
      if (!cancelling && args.returnStock !== undefined) {
        throw new Error(
          `\`returnStock\` only applies to status ${ORDER_STATUS_CANCELLED} (cancel). Horoshop ignores return_quantity on every other status, so passing it here would be a false promise.`,
        );
      }
      if (cancelling && args.returnStock === undefined) {
        throw new Error(
          "Cancelling an order needs an explicit `returnStock`: true puts the ordered quantities back on sale (the admin's return_quantity=1), false leaves them deducted — which is what the public API does silently. There is deliberately no default.",
        );
      }
      const dryRun = args.dryRun !== false;
      if (cancelling && !dryRun && args.confirm !== true) {
        throw new Error("Cancelling is irreversible (the order becomes un-editable). Pass confirm:true together with dryRun:false.");
      }

      const t = await resolveTarget(client, args);
      const before = await readEditor(client, args.store, t.adminId);
      if (before.locked) {
        throw new Error(
          `Order at admin record id ${t.adminId} is already cancelled — its editor redirects and its status can no longer be changed. Only deletion is left.`,
        );
      }
      if (!before.order) {
        throw new Error(`No order editor at admin record id ${t.adminId} (HTTP ${before.httpStatus}).`);
      }
      if (before.order.isDraft) {
        throw new Error(
          `Admin record id ${t.adminId} is an empty draft row, not an order (the editor rendered «Новый заказ»). Nothing to move.`,
        );
      }
      const known = before.order.statuses.map((s) => s.status);
      if (known.length && !known.includes(status)) {
        throw new Error(
          `The editor offers no button for status ${status} on this store. Available: ${before.order.statuses.map((s) => `${s.status} (${s.label})`).join(", ")}.`,
        );
      }

      const residues = cancelling ? await stockAccountingEnabled(client, args.store) : null;
      const stockNote =
        !cancelling || args.returnStock !== true
          ? null
          : residues === false
            ? "⚠️ Stock accounting is OFF on this store (extra[catalog_use_residues_by_stock] = false), so there is no quantity to return: availability here is set by hand through `presence`. return_quantity=1 is still sent, but do not read it as «the goods are back on sale»."
            : residues === null
              ? "Could not read extra[catalog_use_residues_by_stock] — the return is requested, but whether the store counts stock at all is unverified."
              : null;

      const target = before.order.statuses.find((s) => s.status === status);
      if (dryRun) {
        return {
          store: args.store ?? null,
          adminId: String(t.adminId),
          apiOrderId: before.order.apiOrderId,
          dryRun: true,
          from: before.order.activeStatus ? { code: before.order.activeStatus.status, label: before.order.activeStatus.label } : null,
          to: target ? { code: target.status, label: target.label, title: target.title } : { code: status },
          returnStock: cancelling ? args.returnStock : undefined,
          stockAccountingEnabled: residues,
          lines: before.order.cart.lines.map((l) => ({ article: l.article, quantity: l.quantity })),
          ...(stockNote ? { stockWarning: stockNote } : {}),
          note:
            `Nothing was sent. Set dryRun:false to apply.` +
            (cancelling
              ? args.returnStock
                ? " On apply the ordered quantities go BACK on sale (return_quantity=1) and the order becomes permanently un-editable."
                : " On apply the ordered quantities STAY deducted from stock (return_quantity=0) and the order becomes permanently un-editable. That is final for the stock too: deleting the order later will NOT bring the goods back (measured)."
              : ""),
        };
      }

      const out = await applyStatusChange(client, {
        store: args.store,
        adminId: t.adminId,
        apiOrderId: before.order.apiOrderId,
        status,
        returnStock: cancelling ? args.returnStock : undefined,
        verifyStock: args.verifyStock,
        stockCheckLimit: args.stockCheckLimit,
        before: before.order,
        stockAccounting: residues,
      });
      return { store: args.store ?? null, dryRun: false, ...out, ...(stockNote ? { stockWarning: stockNote } : {}) };
    },
  },
  {
    name: "horoshop_admin_order_delete",
    title: "Delete an order (both halves)",
    description:
      "Delete ONE order completely. Two different routes are needed and the admin's own warning about them is wrong: the grid's «Удалить» promises «Остатки товара будут возвращены на склад», but the URL it navigates to (`edit.php?del=1`) removes the row WITHOUT returning any stock, while the AJAX call it fires (`deleteOrderCart`) returns the stock but leaves an empty 0.00 row behind in the grid. Measured on both. So a clean delete is both, in order — that is what this tool does: `deleteOrderCart` first (order disappears from the API, stock comes back), then `del=1` (the row goes). " +
      "⚠️ The stock half only works on a LIVE order. Deleting an order that was ALREADY cancelled brings nothing back (measured: live order 4 → 5, already-cancelled order 5 → 5) — once it is cancelled with return_quantity=0 the goods are written off for good, so decide at cancel time, not at delete time. " +
      "By default it proves the stock half with real numbers (`stockCheck`: before/after per ordered article) and confirms the row is gone from the grid — with two limits worth knowing. The stock proof is capped by `stockCheckLimit` (default 20 lines) because each line costs several admin requests, but the cap is NOT silent: `stockCheckCoverage` reports `checked` of `withArticle` and sets `truncated` when anything was left unread. And on an ALREADY-CANCELLED order there is no readable editor, so there is no `stockCheck` at all and `apiGone` stays null: the only thing actually verified is that the grid row disappeared. The grid checks (`existsInGrid` before, `rowGone` after) read EVERY page of the grid, not just the one the session was on. DRY RUN BY DEFAULT and `confirm:true` required — deletion is permanent. Also the right tool for the empty draft rows an `action=edit`-less editor open leaves behind (they have no order number; address them by `adminId`). " +
      "REPEATING THE DELETE IS SAFE AND DOES NOT ERROR. Addressed by `adminId`, a row that is no longer in the grid answers `{deleted:false, alreadyGone:true, rowGone:true}` and sends nothing — \"already gone\" is the outcome a delete wants, so an idempotent cleanup can call this twice without string-matching an error message. The two cases stay distinguishable: `deleted:true` means THIS call removed the row, `alreadyGone:true` means it was not there. Addressed by `orderId` it still errors, and deliberately: a number that no longer resolves is genuinely ambiguous — a CANCELLED order looks exactly the same as a deleted one from the outside — so silence there would be a guess. Cancelled rows are deletable by `adminId`.",
    inputSchema: {
      ...storeField,
      orderId: orderIdArg,
      adminId: adminIdArg,
      verifyStock: z.boolean().optional().describe("Default true: read each ordered product's stock before and after, so the answer carries numbers."),
      stockCheckLimit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          `How many cart lines the stock proof covers (default ${STOCK_CHECK_DEFAULT_LIMIT}, max ${STOCK_CHECK_MAX_LIMIT}). \`stockCheckCoverage.truncated\` always says whether the cap bit.`,
        ),
      maxProbes: maxProbesArg,
      maxRows: maxRowsArg,
      confirm: z.boolean().optional().describe("REQUIRED with dryRun:false — deletion is permanent."),
      dryRun: z.boolean().optional().describe("Default true: preview what would be deleted. Set false to delete."),
    },
    // idempotentHint: a repeat call on an already-deleted row is a no-op that
    // succeeds (`alreadyGone:true`) rather than an error — see the handler.
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    handler: async (client, args) => {
      const dryRun = args.dryRun !== false;
      const t = await resolveTarget(client, args);
      const before = await readEditor(client, args.store, t.adminId);
      const gridBefore = await orderGridIds(client, args.store);
      const inGrid = gridBefore.includes(Number(t.adminId));

      if (dryRun) {
        return {
          store: args.store ?? null,
          adminId: String(t.adminId),
          apiOrderId: before.order?.apiOrderId ?? null,
          dryRun: true,
          existsInGrid: inGrid,
          ...(inGrid ? {} : { alreadyGone: true }),
          locked: before.locked,
          isDraft: before.order?.isDraft ?? null,
          lines: (before.order?.cart.lines ?? []).map((l) => ({ article: l.article, quantity: l.quantity })),
          plan: inGrid
            ? [
                "1. POST projectAjax.php load=deleteOrderCart order_id=<adminId> — removes the order from the API and returns the ordered quantities to stock (ONLY for a live order: on an already-cancelled one nothing comes back).",
                "2. GET edit.php?del=1&handler=443&id=<adminId> — removes the leftover grid row (this step alone would NOT return stock).",
              ]
            : [],
          note: inGrid
            ? "Nothing was deleted. Set dryRun:false together with confirm:true to delete."
            : `There is no row ${t.adminId} in the orders grid — a real run would answer alreadyGone:true and send nothing. Grid rows: ${gridBefore.join(", ") || "none"}.`,
        };
      }
      if (args.confirm !== true) throw new Error("Deleting an order is permanent. Pass confirm:true together with dryRun:false.");
      if (!inGrid) {
        // ALREADY GONE IS A SUCCESS, NOT AN ERROR. A delete whose target is
        // already absent has nothing left to do — that is the desired end state,
        // reached by someone else. Throwing here made every idempotent cleanup
        // carry its own "…nothing to delete" string match to un-fail the call
        // (measured: an earlier cleanup script had exactly that allow-list), which
        // is a contract encoded in prose instead of in a field.
        // The distinction that matters is kept explicit: `deleted:false` says
        // THIS call removed nothing, `alreadyGone:true` says the row was not
        // there to begin with — so "I deleted it" and "there was nothing to
        // delete" can never be confused for each other.
        return {
          store: args.store ?? null,
          adminId: String(t.adminId),
          apiOrderId: before.order?.apiOrderId ?? null,
          dryRun: false,
          deleted: false,
          alreadyGone: true,
          rowGone: true,
          gridRowsAfter: gridBefore,
          note:
            `No row with admin record id ${t.adminId} in the orders grid — nothing to delete, and nothing was sent. ` +
            `This is the success shape of a repeat delete: \`alreadyGone:true\` with \`deleted:false\`. ` +
            `Grid rows: ${gridBefore.join(", ") || "none"}.`,
        };
      }

      const wantVerify = args.verifyStock !== false && (before.order?.cart.lines.length ?? 0) > 0;
      const snapshot =
        wantVerify && before.order ? await snapshotStock(client, args.store, before.order, args.stockCheckLimit) : null;

      const stepA = await client.admin.postUrlencoded(
        args.store,
        "/adminLegacy/js/projectAjax.php",
        { load: "deleteOrderCart", order_id: String(t.adminId), checkcode: CHECKCODE },
        { redirect: "follow", accept: "application/json" },
      );
      const stockCheck = snapshot ? await restock(client, args.store, snapshot.rows) : null;
      const stepB = await client.admin.getAdminHtml(args.store, orderDeleteRowPath(t.adminId), "manual");

      const gridAfter = await orderGridIds(client, args.store);
      const rowGone = !gridAfter.includes(Number(t.adminId));
      let apiGone: boolean | null = null;
      const apiOrderId = before.order?.apiOrderId ?? null;
      if (apiOrderId != null) {
        try {
          const body = await client.call(args.store, "orders/get", { ids: [apiOrderId] });
          const arr = body?.response?.orders ?? body?.response ?? [];
          apiGone = !(Array.isArray(arr) ? arr : []).some((o: any) => Number(o?.order_id) === apiOrderId);
        } catch {
          apiGone = null;
        }
      }

      return {
        store: args.store ?? null,
        adminId: String(t.adminId),
        apiOrderId,
        dryRun: false,
        steps: {
          deleteOrderCart: { httpStatus: stepA.httpStatus, body: stepA.text.slice(0, 120) },
          removeRow: { httpStatus: stepB.status, redirectedTo: stepB.location },
        },
        rowGone,
        apiGone,
        gridRowsAfter: gridAfter,
        ...(stockCheck ? { stockCheck, stockCheckCoverage: snapshot!.coverage } : {}),
        deleted: rowGone,
        note:
          (rowGone
            ? "Deleted: the grid row is gone and the order no longer answers from the API."
            : "The row is STILL in the grid — the delete did not complete; re-read with horoshop_admin_list entity=orders.") +
          (stockCheck
            ? ` Stock before → after: ${stockCheck.map((s) => `${s.article} ${s.before ?? "?"}→${s.after ?? "?"}`).join(", ")}.` +
              coverageNote(snapshot!.coverage)
            : ""),
      };
    },
  },
  {
    name: "horoshop_admin_order_print_url",
    title: "Build the delivery-note print URL",
    description:
      "Build the admin URL that prints an existing Nova Poshta waybill for one or more orders. It only assembles the address — nothing is requested, and the endpoint itself cannot create a waybill (with no Nova Poshta credentials it answers «Дані авторизації не заповнені»; creating a real TTN is a different call this server deliberately does not expose). `format` is mandatory (the endpoint answers HTTP 400 without it). The ids are ADMIN RECORD ids, not order numbers — resolve them with horoshop_admin_order_resolve; an order with no Nova Poshta delivery prints an empty document.",
    inputSchema: {
      ...storeField,
      adminIds: z.array(z.union([z.number().int(), z.string()])).min(1).describe("Admin record ids (from horoshop_admin_order_resolve / horoshop_admin_list entity=orders)."),
      format: z.enum(["marking", "marking100x100", "html"]).describe("Print format. Mandatory — the endpoint 400s without it."),
    },
    annotations: { readOnlyHint: true },
    handler: async (client, args) => {
      const { conf } = client.resolveStore(args.store);
      const path = orderPrintPath(args.format, args.adminIds);
      return {
        store: args.store ?? null,
        url: `${conf.baseUrl}${path}`,
        path,
        adminIds: args.adminIds.map(String),
        format: args.format,
        note: "Nothing was requested — this is a URL builder. Open it in a browser signed into the admin panel. It prints an EXISTING waybill and cannot create one.",
      };
    },
  },
  {
    name: "horoshop_admin_product_stock_set",
    title: "Set a product's warehouse stock",
    description:
      "Set (or nudge) how many units of a product the warehouse holds — the only write path MEASURED to move stock, and the only one that verifies the result. `horoshop_catalog_import` accepts a `quantity` field, answers «Товар обновлен», and writes nothing: measured on the test store, an import of quantity:5 left the export at 0. (Horoshop also documents a bulk stock path, `catalog_import` → `residues[]` per warehouse; this server passes it through untouched but nobody has measured it, so if you use it for a mass load, spot-check the result against horoshop_catalog_export rather than trusting the log.) Stock lives in the warehouse ledger, and this tool posts the same income/expense document the admin's «Склад» column does (`lookup.php load=transfer_inout_save`). " +
      "Address the product by `article` (resolved against the ledger's own echo, exact match) or by `productId`. Pass `quantity` for an absolute target (the delta is computed for you) or `delta` for a relative move. ⚠ ONLY `quantity` IS SAFE TO RETRY: it recomputes the move from whatever the stock is now, so sending it twice lands on the same number. `delta` is applied to the CURRENT stock every time — a repeated `delta:+10` after a timeout posts a second warehouse document and the stock ends up 20 higher, with nothing in the ledger to say it was an accident. When in doubt re-read the stock and send an absolute `quantity`. It reads the current stock first, so the dry run shows current → target, and after the write it re-reads the ledger and reports the real before/after. " +
      "Note: with stock accounting OFF (`extra[catalog_use_residues_by_stock]`), quantity is stored but availability on the storefront is whatever `presence` says — the tool reports the flag so the number is not mistaken for «now it is in stock». DRY RUN BY DEFAULT.",
    inputSchema: {
      ...storeField,
      article: z.string().optional().describe("Product article (exact match). Either this or productId."),
      productId: z.union([z.number().int(), z.string()]).optional().describe("Internal product id (e.g. 535). Either this or article."),
      quantity: z.number().int().optional().describe("Absolute target stock. Mutually exclusive with `delta`."),
      delta: z.number().int().optional().describe("Relative change (+N income, −N expense). Mutually exclusive with `quantity`."),
      warehouse: z.union([z.number().int(), z.string()]).optional().describe("Warehouse id; defaults to the one the transfer form pre-selects (most stores have exactly one)."),
      dryRun: z.boolean().optional().describe("Default true: report current → target without writing. Set false to apply."),
    },
    // NOT idempotent: the `delta` branch recomputes the target from CURRENT stock,
    // so a blind retry posts a second warehouse document and moves the stock twice.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    handler: async (client, args) => {
      if ((args.quantity == null) === (args.delta == null)) {
        throw new Error("Pass exactly one of `quantity` (absolute target) or `delta` (relative change).");
      }
      if ((args.article == null) === (args.productId == null)) {
        throw new Error("Pass exactly one of `article` or `productId`.");
      }

      let productId = args.productId != null ? String(args.productId) : null;
      if (!productId) {
        const found = await resolveProductByArticle(client, args.store, String(args.article));
        if (!found) {
          throw new Error(
            `No product with article "${args.article}" was found in the admin catalog grid. Articles are matched EXACTLY (a substring match would bind "TEE-ORBIT" to "TEE-ORBIT-XL").`,
          );
        }
        productId = found.id;
      }

      const form = await readTransferForm(client, args.store, [productId]);
      const row = form.products.find((p) => p.id === productId);
      if (!row) {
        throw new Error(`Product id ${productId} does not appear in the warehouse ledger form — check the id.`);
      }
      if (args.article != null && row.article !== String(args.article)) {
        throw new Error(`Ledger says product ${productId} is article "${row.article}", not "${args.article}" — refusing to write to the wrong product.`);
      }
      const warehouse = args.warehouse != null ? String(args.warehouse) : (form.warehouses.find((w) => w.selected)?.id ?? form.warehouses[0]?.id);
      if (!warehouse) throw new Error("The transfer form offered no warehouse to write to.");

      const current = row.stock;
      const target = args.quantity != null ? Number(args.quantity) : current + Number(args.delta);
      const delta = target - current;
      const residues = await stockAccountingEnabled(client, args.store);
      const accountingNote =
        residues === false
          ? "Stock accounting is OFF on this store (extra[catalog_use_residues_by_stock] = false): the number is stored, but the storefront's availability comes from `presence`, set by hand. Turning accounting on makes quantity drive availability."
          : residues === null
            ? "Could not read extra[catalog_use_residues_by_stock] — whether this store counts stock is unverified."
            : null;

      if (args.dryRun !== false) {
        return {
          store: args.store ?? null,
          productId,
          article: row.article,
          title: row.title,
          warehouse,
          warehouses: form.warehouses,
          dryRun: true,
          current,
          target,
          delta,
          document: delta === 0 ? "none" : delta > 0 ? `income (type 1) of ${delta}` : `expense (type 2) of ${Math.abs(delta)}`,
          stockAccountingEnabled: residues,
          ...(accountingNote ? { accountingNote } : {}),
          note: delta === 0 ? "Stock already equals the target — nothing to write." : "Nothing was written. Set dryRun:false to apply.",
        };
      }
      if (delta === 0) {
        // Same key names as a real write (before/after/applied): a no-op that
        // reported a different shape made `after` read as undefined for callers
        // checking the result, which looks like a failure and is not one.
        return {
          store: args.store ?? null,
          productId,
          article: row.article,
          dryRun: false,
          before: current,
          after: current,
          target,
          delta: 0,
          applied: true,
          written: false,
          stockAccountingEnabled: residues,
          ...(accountingNote ? { accountingNote } : {}),
          note: "Stock already equals the target — no warehouse document was posted.",
        };
      }

      const posted = await client.admin.postUrlencoded(
        args.store,
        "/adminLegacy/js/lookup.php",
        {
          load: "transfer_inout_save",
          type: delta > 0 ? "1" : "2",
          transfer_warehouse: warehouse,
          [`transfer[${productId}]`]: String(Math.abs(delta)),
          checkcode: CHECKCODE,
        },
        { redirect: "follow", accept: "application/json" },
      );
      let status = "?";
      try {
        status = JSON.parse(posted.text)?.status ?? "?";
      } catch {
        status = `HTTP ${posted.httpStatus}`;
      }
      const after = await readTransferForm(client, args.store, [productId]);
      const now = after.products.find((p) => p.id === productId)?.stock ?? null;

      return {
        store: args.store ?? null,
        productId,
        article: row.article,
        warehouse,
        dryRun: false,
        transportStatus: status,
        before: current,
        after: now,
        target,
        applied: now === target,
        stockAccountingEnabled: residues,
        ...(accountingNote ? { accountingNote } : {}),
        note:
          now === target
            ? `Stock ${current} → ${now}, verified by re-reading the warehouse ledger.`
            : `Wrote a ${delta > 0 ? "income" : "expense"} document of ${Math.abs(delta)}, but the ledger now reads ${now} instead of ${target} — treat this as unverified.`,
      };
    },
  },
];
