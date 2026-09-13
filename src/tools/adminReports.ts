import { storeField, type ToolSpec } from "../register.js";

/**
 * Store analytics / reports — the admin's «Аналитика» dashboard, read-only.
 *
 * This closes the last documented tool-hole on the docs coverage scale (row A1,
 * «Отчёты: сводка, заказы, сумма продаж, средний чек, посетители, конверсии,
 * топ продаж») — classified ✗ (our gap), not ⛔ (platform limit). Every other
 * ✗ row is either already served by an API-JSON export (orders/users → Excel is
 * the same data) or a measured platform limit (order composition).
 *
 * ── ENDPOINT (reverse-engineered on a test store) ───────────────────────────
 * The «Аналитика» menu leaf is a React micro-frontend at `/reports/dashboard`
 * whose single data call is `GET /reports/dashboard/data`, answering the usual
 * Horoshop envelope `{status:"OK", response:{data:{…}}}`. `response.data` holds:
 *   - `masterReports[]`  — the CURRENT period, one entry per report:
 *       · orders      → totalOrders, ordersPerDay, totalSum, averageCheck
 *       · conversion  → totalVisitors, visitorsPerDay, cnv{Created,Started,
 *                       Completed,Delivered}, sum{Created,Started,Completed,Delivered}
 *       · topProducts / topFavorites → row lists (`.data`)
 *   - `comparisonReports[]` — the PREVIOUS period, same reports, each carrying a
 *       DAILY time series in `.data` (fromDate/toDate/sum/quantity/averageCheck)
 *       and its `detailing` (granularity, e.g. daily).
 *   - `reportsMetadata` — currency ({id,abbr}) and `actualDateOfReports`.
 *   - `startedReportingDate` — when this store began collecting analytics.
 *
 * ── MEASURED CEILING: the window is fixed, not a parameter ───────────────────
 * The endpoint returns the platform's DEFAULT window (master ≈ current period,
 * comparison ≈ previous period, detailed daily) and IGNORES a date range: 15
 * shapes were measured on the test store (GET `dateFrom/dateTo`, `from/to`, `start/finish`,
 * `period`, `range`, … and POST bodies `{dateFrom,dateTo}`, `{period:{…}}`,
 * `{filter:{…}}`, …) — every one returned the identical master (0) and the same
 * fixed 7-day comparison span. Extra path segments are a catch-all
 * (`/reports/dashboard/data/zzbogus` == `/reports/dashboard/data`), so they are
 * not sub-reports. A custom range is driven inside the React app by a mechanism
 * not recoverable from the entry bundle (a lazy-loaded chunk); until it is
 * measured, this tool reports the default window rather than guess a param that
 * silently does nothing. For an arbitrary date range today, aggregate
 * `horoshop_orders_get` instead.
 *
 * Read-only: a GET, no session mutation, safe on client stores.
 */

interface Metric {
  id?: string;
  units?: string;
  value?: number;
}
interface MasterReport {
  name?: string;
  metrics?: Record<string, Metric> | Metric[];
  data?: unknown[];
  detailing?: unknown;
}

/** Flatten a report's `{id:{value}}` metric map to `{id: value}`. */
function flattenMetrics(metrics: MasterReport["metrics"]): Record<string, number> {
  const out: Record<string, number> = {};
  if (!metrics) return out;
  // `metrics` is an object keyed by metric id on populated reports, but an empty
  // ARRAY on reports with no metrics (topProducts/topFavorites) — handle both.
  const entries = Array.isArray(metrics)
    ? metrics.map((m) => [m.id ?? "", m] as const)
    : Object.entries(metrics);
  for (const [id, m] of entries) {
    if (id && m && typeof m.value === "number") out[id] = m.value;
  }
  return out;
}

function byName(list: MasterReport[] | undefined, name: string): MasterReport | undefined {
  return (list ?? []).find((r) => r.name === name);
}

/**
 * Reshape `response.data` into a compact, complete summary. Pure (no I/O) so the
 * parse can be checked against a captured sample without a live call. Nothing is
 * dropped: unknown metric ids flow through flattenMetrics, so a metric Horoshop
 * adds later appears without a code change.
 */
export function shapeReportsDashboard(data: any): Record<string, unknown> {
  const master: MasterReport[] = data?.masterReports ?? [];
  const comparison: MasterReport[] = data?.comparisonReports ?? [];
  const currency = data?.reportsMetadata?.currency ?? null;

  const shapeSide = (list: MasterReport[]) => {
    const orders = byName(list, "orders");
    const conv = byName(list, "conversion");
    const topProducts = byName(list, "topProducts");
    const topFavorites = byName(list, "topFavorites");
    return {
      orders: flattenMetrics(orders?.metrics),
      conversion: flattenMetrics(conv?.metrics),
      topProducts: Array.isArray(topProducts?.data) ? topProducts.data : [],
      topFavorites: Array.isArray(topFavorites?.data) ? topFavorites.data : [],
      // The daily chart series lives on each comparison report's `.data`; surface
      // the orders one (sum/quantity/averageCheck per day) as the headline trend.
      ordersDaily: Array.isArray(orders?.data) ? orders.data : [],
      conversionDaily: Array.isArray(conv?.data) ? conv.data : [],
      ...(orders?.detailing ? { detailing: orders.detailing } : {}),
    };
  };

  return {
    currency,
    actualDateOfReports: data?.reportsMetadata?.actualDateOfReports ?? null,
    startedReportingDate: data?.startedReportingDate ?? null,
    currentPeriod: shapeSide(master),
    previousPeriod: shapeSide(comparison),
  };
}

export const adminReportTools: ToolSpec[] = [
  {
    name: "horoshop_admin_reports_dashboard",
    title: "Read the store analytics dashboard (Аналитика)",
    description:
      "Read the admin «Аналитика» dashboard in one call — no order pagination. Returns, for the store's default reporting window: `currentPeriod` and `previousPeriod`, each with `orders` (totalOrders, ordersPerDay, totalSum, averageCheck), `conversion` (totalVisitors, visitorsPerDay, cnvCreated/Started/Completed/Delivered and their sums), `topProducts`, `topFavorites`, and a DAILY series (`ordersDaily`: per-day sum/quantity/averageCheck) for charting the trend — plus `currency`, `actualDateOfReports`, `startedReportingDate`. " +
      "MEASURED LIMIT: the endpoint returns a FIXED default window and ignores date-range parameters (15 GET/POST shapes measured), so there is no from/to argument — for an arbitrary date range, aggregate `horoshop_orders_get` instead. Read-only; safe on any store.",
    inputSchema: { ...storeField },
    annotations: { readOnlyHint: true },
    handler: async (client, args) => {
      const r = await client.admin.getJson(args.store, "/reports/dashboard/data");
      // Guard the false-OK class this project keeps getting bitten by: the
      // storefront 404 page and an unpromoted session both arrive as HTTP 200,
      // and a catch-all route answers `{status:"OK"}` with no `data`. Require the
      // real shape before reporting success.
      const data = r.response?.data;
      if (r.status !== "OK" || !data || !Array.isArray(data.masterReports)) {
        throw new Error(
          `Analytics dashboard unavailable for this store (httpStatus ${r.httpStatus}, status ${r.status ?? "none"}). ` +
            `Expected {status:"OK", response:{data:{masterReports:[…]}}}; got ${JSON.stringify(r.body ?? r.text)?.slice(0, 200)}.`,
        );
      }
      return { store: args.store ?? null, ...shapeReportsDashboard(data) };
    },
  },
];
