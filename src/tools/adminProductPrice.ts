import { z } from "zod";
import { storeField, type ToolSpec } from "../register.js";
import { PRODUCTS_HANDLER, resolveProducts, type Resolved } from "./adminProductGroup.js";

/**
 * BULK PRICE EDITING — the grid's inline price cells, deliberately left out of
 * horoshop_admin_products_group_edit twice because price "deserves its own
 * design". This file is that design.
 *
 * The write surface is the same one «Изменить отображение» turned out to be:
 * `ajax.datagrid.php load=dataGridUpdateValues`, one `names[k][id]` per row plus
 * one `names[k][price]` / `names[k][price_old]` per changed cell, with `k` any
 * unique key (NOT the row's position). Nothing new is discovered here; what is
 * new is everything around the write.
 *
 * WHY THE CEREMONY. Price is the only field where a mistake costs money the
 * moment it lands: the wrong number is on the storefront, in the marketplace
 * feeds and in the ads within minutes, and it is charged to real customers. So
 * this tool is not "one more setter". Its shape assumes the caller will
 * eventually get an argument wrong, and tries to make that survivable:
 *
 *   - it addresses products by ARTICLE, because an internal grid id is a number
 *     nobody can sanity-check by eye (is 517 the T-shirt or the sticker pack?);
 *   - it previews by default, and the preview is per-product arithmetic, not a
 *     restatement of the arguments — the only way to catch "-90" typed for "-9"
 *     or a percent that was meant to be a fixed amount is to SEE both prices;
 *   - it refuses outright on prices that cannot be real, and demands a
 *     value-bearing confirmation on the two mistakes that are merely plausible
 *     (too many products, too large a move);
 *   - it verifies through the PUBLIC catalog/export API, which shares neither
 *     the transport nor the credentials of the admin session that wrote — the
 *     endpoint answering `{"status":"OK"}` proves only that it was asked;
 *   - and it hands back a ready-to-run rollback payload, because "keep a copy of
 *     the old prices" is advice everybody agrees with and nobody follows.
 */

// ─── fixed guard thresholds ──────────────────────────────────────────────────

/**
 * Above this many products a call must state the count it believes it is
 * touching. And above this share a single price may not move without an
 * acknowledgement.
 *
 * These are CEILINGS, not defaults: `scaleThreshold` / `changeThresholdPercent`
 * may lower them, never raise them. A tunable guard is not a guard — the first
 * thing anyone does with a refusal that offers a knob is turn the knob. The only
 * way past these is to say, explicitly, what you are about to do.
 */
const SCALE_THRESHOLD = 50;
const CHANGE_THRESHOLD_PERCENT = 50;

/** Rows per `dataGridUpdateValues` POST. Small on purpose: see `writeChunks`. */
const CHUNK_ROWS = 50;

/** Money comparison tolerance — half a cent. */
const EPSILON = 0.005;

// ─── money ───────────────────────────────────────────────────────────────────

function decimalsOf(step: number): number {
  const s = String(step);
  const dot = s.indexOf(".");
  return dot < 0 ? 0 : s.length - dot - 1;
}

/** Round to a step (0.01 = cents, 1 = whole, 10 = nearest ten), float noise removed. */
function roundToStep(value: number, step: number): number {
  const r = Math.round(value / step) * step;
  return Number(r.toFixed(Math.max(decimalsOf(step), 2)));
}

/**
 * The wire form of a price: a plain decimal, at most 2 places, no exponent, no
 * trailing zeros. The grid cell is a text input, so whatever string is built
 * here IS the price — `1e3` or `719.1000000000001` would be parsed by someone
 * else's rules, or not at all.
 */
function priceString(v: number): string {
  const s = v.toFixed(2);
  if (s.endsWith(".00")) return s.slice(0, -3);
  return s.endsWith("0") ? s.slice(0, -1) : s;
}

/** A money argument must be a finite number with at most 2 decimal places. */
function assertMoney(value: number, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${what} must be a finite number, got ${JSON.stringify(value)}.`);
  }
  if (Math.abs(Number(value.toFixed(2)) - value) > 1e-9) {
    throw new Error(
      `${what} = ${value} has more than 2 decimal places. Money here is stored to the cent — ` +
        `round it yourself so the price you asked for is the price that is verified.`,
    );
  }
  return Number(value.toFixed(2));
}

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
};

// ─── reading current prices (the independent channel) ────────────────────────

interface Current {
  price: number;
  priceOld: number;
  discount: number;
}

/**
 * Current prices straight from the PUBLIC catalog/export API.
 *
 * Used for both the "before" column and the post-write verification, and that is
 * the point: the write goes out over the admin session (cookie auth, legacy
 * grid endpoint), while this reads over the documented API with the store's API
 * credentials. Two transports, two credentials, two code paths — so "the admin
 * said OK" and "the catalog says 719.10" are genuinely different claims.
 */
async function readPrices(
  client: any,
  store: string | undefined,
  articles: string[],
): Promise<Map<string, Current>> {
  const out = new Map<string, Current>();
  for (let i = 0; i < articles.length; i += 100) {
    const slice = articles.slice(i, i + 100);
    const res: any = await client.call(store, "catalog/export", {
      expr: { article: slice },
      limit: slice.length,
      includedParams: ["article", "price", "price_old", "discount"],
    });
    const products: any[] = res?.response?.products ?? res?.products ?? [];
    for (const p of products) {
      out.set(String(p.article), {
        price: num(p.price),
        priceOld: num(p.price_old),
        discount: num(p.discount),
      });
    }
  }
  return out;
}

// ─── planning ────────────────────────────────────────────────────────────────

interface Target {
  article: string;
  productId: string;
  was: number;
  becomes: number;
  delta: number;
  /** null when the old price was 0 — a relative move off zero has no meaning. */
  deltaPercent: number | null;
  wasPriceOld: number;
  /** null = price_old is not being written for this product. */
  becomesPriceOld: number | null;
  discount: number;
}

/** Fixed 2-decimal rounding for display sums, so a table never shows 1707.2999999. */
const money = (v: number): number => Number(v.toFixed(2));

// ─── writing ─────────────────────────────────────────────────────────────────

/**
 * Post the rows in small chunks rather than one giant body.
 *
 * An urlencoded body carrying 500 products is ~2000 parameters, and no limit on
 * that endpoint has ever been measured. A body that gets truncated somewhere
 * upstream would apply a PARTIAL price change and still answer OK — which is the
 * one failure mode this tool must never hide. Fifty rows a request is
 * comfortably inside anything, and every chunk is reported, so a batch that dies
 * halfway is visible as "3 of 7 requests" and its rollback payload (built from
 * the before-snapshot of the WHOLE batch) still restores what did land.
 */
async function writeChunks(
  client: any,
  store: string | undefined,
  rows: Array<{ id: string; fields: Record<string, string> }>,
): Promise<{ requests: number; raw: string }> {
  let requests = 0;
  let raw = "";
  for (let i = 0; i < rows.length; i += CHUNK_ROWS) {
    const chunk = rows.slice(i, i + CHUNK_ROWS);
    const res = await client.admin.gridUpdateValues(store, PRODUCTS_HANDLER, chunk);
    requests++;
    raw = res.raw;
    if (res.status !== "OK") {
      throw new Error(
        `The grid refused the price update on request ${requests} of ${Math.ceil(rows.length / CHUNK_ROWS)} ` +
          `(HTTP ${res.httpStatus}, status ${res.status ?? "?"}): ${res.raw}. ` +
          (requests > 1
            ? `⚠ The ${(requests - 1) * CHUNK_ROWS} product(s) in the earlier request(s) WERE written and are not rolled back automatically — ` +
              `re-read them with horoshop_catalog_export and restore from your own before-snapshot.`
            : `Nothing was written.`),
      );
    }
  }
  return { requests, raw };
}

// ─── tool ────────────────────────────────────────────────────────────────────

export const adminProductPriceTools: ToolSpec[] = [
  {
    name: "horoshop_admin_products_price_set",
    title: "Bulk-set product prices (by article, with guards and rollback)",
    description:
      "Change the PRICE of many products at once, addressed by ARTICLE. Three modes: `absolute` (set the price outright), `percent` (move it by a signed percentage: -10 means 10% CHEAPER, not 'price becomes 10% of itself') and `amount` (move it by a signed sum in the store's currency). Optionally writes `price_old` too — the struck-through 'old price' — either as a value you give, or, with `setPriceOldFromCurrent:true`, by copying each product's CURRENT price there, which is how a sale is normally staged. " +
      "DRY RUN BY DEFAULT and the preview is the point: it shows, per product, `was → becomes` with the delta in both currency and %, plus a summary (how many products, the summed shift). Read it before you set dryRun:false — the arithmetic is the only thing that catches -90 typed for -9, or a percentage meant as a fixed sum. " +
      "GUARDS. (1) A price that would land at zero or below is REFUSED, always, with no override. (2) Touching more than 50 products requires `confirmProductCount` set to the exact number resolved — a bare 'true' would not have caught the article list being longer than you thought. (3) Any product moving more than 50% requires `confirmBigChange:true`, and the refusal names the offenders. (4) An article that does not resolve is refused rather than silently skipped (`allowMissing:true` to proceed without it) — a mistyped SKU quietly missing its own sale is the failure nobody notices. (5) `price_old` at or below the new price is reported as a warning (an 'old price' that is lower than the new one shows the storefront a discount running the wrong way). Thresholds may be LOWERED via `scaleThreshold` / `changeThresholdPercent`, never raised. " +
      "VERIFICATION AND ROLLBACK. After writing, every touched article is re-read through the public catalog/export API — a different transport with different credentials from the admin session that wrote — and any product whose price is not what was asked for is listed explicitly; `saved:true` on its own is never the answer. The response also carries a `rollback` block: a complete, ready-to-run argument set for this same tool that puts every price back exactly as it was, pre-armed with whatever confirmations it will itself need. " +
      "⚠ A product with a non-zero `discount` shows the storefront a recalculated price, so the number set here is not the number on the shelf — those products are flagged. ⚠ Modifications (size/colour children) are ordinary rows here and are priced individually; setting the parent does NOT move its children. Not here: quantities and stock (horoshop_admin_product_stock_set), price levels / wholesale tiers (horoshop_price_levels_export), and everything else about a product (horoshop_catalog_import).",
    inputSchema: {
      ...storeField,
      articles: z
        .array(z.string())
        .optional()
        .describe("Articles (SKUs) to reprice, matched EXACTLY. Use with `mode` + price/percent/amount. Mutually exclusive with `items`."),
      items: z
        .array(
          z.object({
            article: z.string().describe("The product's article (SKU)."),
            price: z.number().optional().describe("The new price for this product. Omit to leave the price alone and only set priceOld."),
            priceOld: z.number().optional().describe("The new struck-through old price for this product. 0 clears it."),
          }),
        )
        .optional()
        .describe(
          "Per-product ABSOLUTE prices — the shape a `rollback` block comes back in, so restoring is a copy-paste. Mutually exclusive with `articles`/`mode`/`percent`/`amount`.",
        ),
      mode: z
        .enum(["absolute", "percent", "amount"])
        .optional()
        .describe(
          "absolute = set `price` to a fixed value · percent = move it by a signed % (-10 = 10% cheaper) · amount = move it by a signed sum. Required with `articles`; implied by `items`.",
        ),
      price: z.number().optional().describe("mode=absolute: the new price for every article listed. Must be > 0 and have at most 2 decimals."),
      percent: z.number().optional().describe("mode=percent: the signed change, e.g. -15 for 15% off, 10 for 10% dearer."),
      amount: z.number().optional().describe("mode=amount: the signed change in store currency, e.g. -50 or 120."),
      priceOld: z
        .number()
        .optional()
        .describe("Also write this struck-through old price to every article listed. 0 clears it. Mutually exclusive with setPriceOldFromCurrent."),
      setPriceOldFromCurrent: z
        .boolean()
        .optional()
        .describe(
          "Also copy each product's CURRENT price into its price_old, so the storefront strikes through what it used to cost. The normal way to stage a sale; pointless (and flagged) if the new price is higher.",
        ),
      roundTo: z
        .number()
        .optional()
        .describe(
          "Rounding step for COMPUTED prices only — 0.01 cents (default), 1 whole units, 10 nearest ten, 0.5, etc. Never applied in absolute mode: a price you stated is written exactly as stated.",
        ),
      scaleThreshold: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(`Lower the ${SCALE_THRESHOLD}-product confirmation threshold for this call. Values above ${SCALE_THRESHOLD} are clamped — the guard cannot be loosened.`),
      changeThresholdPercent: z
        .number()
        .positive()
        .optional()
        .describe(`Lower the ${CHANGE_THRESHOLD_PERCENT}% per-product confirmation threshold for this call. Values above ${CHANGE_THRESHOLD_PERCENT} are clamped.`),
      confirmProductCount: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          "The number of products you believe this call touches. Required above the scale threshold, and whenever given it must match exactly — if it does not, the call is refused even under the threshold.",
        ),
      confirmBigChange: z.boolean().optional().describe("Acknowledge that some product's price moves more than the change threshold. The refusal lists which ones and by how much."),
      allowMissing: z.boolean().optional().describe("Proceed even though some articles did not resolve. Default false: an unresolved article refuses the whole call."),
      dryRun: z.boolean().optional().describe("Default true: resolve, compute and preview, write nothing. Set false to apply."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    handler: async (client, args) => {
      // ── 1. argument shape ─────────────────────────────────────────────────
      const hasItems = Array.isArray(args.items) && args.items.length > 0;
      const hasArticles = Array.isArray(args.articles) && args.articles.length > 0;
      if (hasItems && hasArticles) {
        throw new Error("Pass EITHER `items` (per-product prices) OR `articles` + `mode` — not both, because they would disagree about what the new price is.");
      }
      if (!hasItems && !hasArticles) {
        throw new Error("Pass `articles` (with `mode`) or `items` — there is nothing to reprice.");
      }
      if (args.priceOld != null && args.setPriceOldFromCurrent === true) {
        throw new Error("`priceOld` and `setPriceOldFromCurrent` both write price_old and would contradict each other. Pick one.");
      }

      const roundTo = args.roundTo ?? 0.01;
      if (!(roundTo > 0)) throw new Error("`roundTo` must be a positive step, e.g. 0.01, 1 or 10.");

      let mode: "absolute" | "percent" | "amount";
      const perItem = new Map<string, { price?: number; priceOld?: number }>();
      if (hasItems) {
        if (args.mode && args.mode !== "absolute") {
          throw new Error("`items` carries the finished prices, so mode is always absolute. Drop `mode` (or use `articles` for a computed change).");
        }
        if (args.price != null || args.percent != null || args.amount != null) {
          throw new Error("`items` already states each price — `price`/`percent`/`amount` would fight it.");
        }
        mode = "absolute";
        for (const it of args.items as Array<{ article: string; price?: number; priceOld?: number }>) {
          const key = String(it.article);
          if (perItem.has(key)) throw new Error(`Article "${key}" is listed twice in \`items\` — which price is the real one?`);
          if (it.price == null && it.priceOld == null) {
            throw new Error(`\`items\` entry for "${key}" sets neither price nor priceOld.`);
          }
          perItem.set(key, {
            price: it.price == null ? undefined : assertMoney(it.price, `items["${key}"].price`),
            priceOld: it.priceOld == null ? undefined : assertMoney(it.priceOld, `items["${key}"].priceOld`),
          });
        }
      } else {
        if (!args.mode) throw new Error("`mode` is required with `articles`: absolute, percent or amount.");
        mode = args.mode;
        if (mode === "absolute" && args.price == null && args.priceOld == null && args.setPriceOldFromCurrent !== true) {
          throw new Error("mode=absolute needs `price` (or a price_old-only edit via `priceOld` / `setPriceOldFromCurrent`).");
        }
        if (mode === "percent" && args.percent == null) throw new Error("mode=percent needs `percent` (signed: -10 = 10% cheaper).");
        if (mode === "amount" && args.amount == null) throw new Error("mode=amount needs `amount` (signed: -50 = 50 cheaper).");
        if (mode !== "absolute" && args.price != null) {
          throw new Error(`mode=${mode} computes the new price from the current one — \`price\` would be ignored, which is exactly the kind of silence this tool refuses.`);
        }
      }
      if (args.price != null) assertMoney(args.price, "price");
      if (args.priceOld != null) assertMoney(args.priceOld, "priceOld");
      if (args.percent != null && !Number.isFinite(args.percent)) throw new Error("`percent` must be a finite number.");
      if (args.amount != null) assertMoney(args.amount, "amount");

      // Guard ceilings: a caller may tighten them, never loosen them.
      const scaleThreshold = Math.min(args.scaleThreshold ?? SCALE_THRESHOLD, SCALE_THRESHOLD);
      const changeThreshold = Math.min(args.changeThresholdPercent ?? CHANGE_THRESHOLD_PERCENT, CHANGE_THRESHOLD_PERCENT);
      const clamped: string[] = [];
      if (args.scaleThreshold != null && args.scaleThreshold > SCALE_THRESHOLD) {
        clamped.push(`scaleThreshold ${args.scaleThreshold} → ${SCALE_THRESHOLD}`);
      }
      if (args.changeThresholdPercent != null && args.changeThresholdPercent > CHANGE_THRESHOLD_PERCENT) {
        clamped.push(`changeThresholdPercent ${args.changeThresholdPercent} → ${CHANGE_THRESHOLD_PERCENT}`);
      }

      // ── 2. resolve articles → grid rows ───────────────────────────────────
      const wanted = hasItems ? [...perItem.keys()] : (args.articles as string[]).map(String);
      const { found, missing, gridRows, truncated }: { found: Resolved[]; missing: string[]; gridRows: number; truncated: boolean } =
        await resolveProducts(client, args.store, wanted, undefined);
      if (truncated) {
        throw new Error(
          `The products grid listing was truncated at ${gridRows} rows, so an article further down would be reported as missing and quietly skipped — refusing to reprice on a partial view.`,
        );
      }
      if (found.length === 0) {
        throw new Error(
          `None of the ${wanted.length} article(s) exist in the products grid (${gridRows} rows scanned): ${missing.slice(0, 20).join(", ")}${missing.length > 20 ? ", …" : ""}. Nothing was written.`,
        );
      }

      // ── 3. current prices, through the public API ─────────────────────────
      const articles = found.map((f) => f.article);
      const before = await readPrices(client, args.store, articles);
      const noPrice = articles.filter((a) => !before.has(a));
      if (noPrice.length) {
        throw new Error(
          `catalog/export returned no row for ${noPrice.length} resolved product(s): ${noPrice.slice(0, 10).join(", ")}. ` +
            `Without the current price there is nothing to compute a change from and nothing to roll back to, so this call is refused rather than guessed.`,
        );
      }

      // ── 4. plan every product ─────────────────────────────────────────────
      const targets: Target[] = found.map((f) => {
        const cur = before.get(f.article)!;
        const item = perItem.get(f.article);

        let becomes = cur.price;
        if (mode === "absolute") {
          const explicit = hasItems ? item?.price : (args.price as number | undefined);
          if (explicit != null) becomes = explicit;
        } else if (mode === "percent") {
          becomes = roundToStep(cur.price * (1 + (args.percent as number) / 100), roundTo);
        } else {
          becomes = roundToStep(cur.price + (args.amount as number), roundTo);
        }

        let becomesPriceOld: number | null = null;
        if (args.setPriceOldFromCurrent === true) becomesPriceOld = cur.price;
        else if (args.priceOld != null) becomesPriceOld = args.priceOld as number;
        else if (hasItems && item?.priceOld != null) becomesPriceOld = item.priceOld;

        const delta = money(becomes - cur.price);
        return {
          article: f.article,
          productId: f.id,
          was: cur.price,
          becomes,
          delta,
          deltaPercent: cur.price > 0 ? Number(((delta / cur.price) * 100).toFixed(2)) : null,
          wasPriceOld: cur.priceOld,
          becomesPriceOld,
          discount: cur.discount,
        };
      });

      /**
       * Is `price` itself being written for this product?
       *
       * A computed mode always writes it; an absolute call writes it only where a
       * price was actually stated, so `priceOld`-only edits leave the price cell
       * out of the payload entirely rather than re-sending the current value.
       * Everything downstream — the refusals, the payload, the rollback — keys off
       * this one predicate, so they cannot disagree about what was touched.
       */
      const wantsPrice = (t: Target): boolean =>
        mode !== "absolute" || (hasItems ? perItem.get(t.article)?.price != null : args.price != null);

      // ── 5. HARD refusal: a price that cannot be real ──────────────────────
      // Not a policy, a fact — so it fires in dry runs too, and no argument
      // waives it. This is the "minus instead of plus" and the "forgot to divide
      // by 100" that reaches the storefront as free goods.
      const impossible = targets.filter((t) => wantsPrice(t) && !(t.becomes > 0));
      if (impossible.length) {
        throw new Error(
          `REFUSED: ${impossible.length} product(s) would land at a price of zero or less — ` +
            impossible.slice(0, 15).map((t) => `${t.article} ${t.was} → ${t.becomes}`).join(", ") +
            (impossible.length > 15 ? ", …" : "") +
            `. There is no confirmation for this; a product priced at 0 sells for nothing. Check the sign and the scale of ${mode === "percent" ? "`percent`" : mode === "amount" ? "`amount`" : "`price`"}.`,
        );
      }
      const negativeOld = targets.filter((t) => t.becomesPriceOld != null && (t.becomesPriceOld as number) < 0);
      if (negativeOld.length) {
        throw new Error(`REFUSED: price_old cannot be negative (${negativeOld.map((t) => t.article).join(", ")}). Pass 0 to clear it.`);
      }

      // ── 6. policy blockers ────────────────────────────────────────────────
      // A dry run REPORTS these and still shows its table — refusing to preview
      // would withhold the very numbers needed to decide. A real write throws.
      const blockers: string[] = [];

      if (missing.length && args.allowMissing !== true) {
        blockers.push(
          `${missing.length} article(s) did not resolve and would be silently skipped: ${missing.slice(0, 20).join(", ")}${missing.length > 20 ? ", …" : ""}. ` +
            `Fix the article(s), or pass allowMissing:true to reprice only the ${found.length} that exist.`,
        );
      }
      if (args.confirmProductCount != null && args.confirmProductCount !== found.length) {
        blockers.push(
          `confirmProductCount says ${args.confirmProductCount} but ${found.length} product(s) resolved. ` +
            `The mismatch is the guard doing its job — check the article list before re-sending with ${found.length}.`,
        );
      } else if (found.length > scaleThreshold && args.confirmProductCount == null) {
        blockers.push(
          `This touches ${found.length} products, over the ${scaleThreshold}-product threshold. Re-send with confirmProductCount:${found.length} to say you mean it.`,
        );
      }
      const big = targets.filter((t) =>
        !wantsPrice(t) ? false : t.deltaPercent == null ? t.delta !== 0 : Math.abs(t.deltaPercent) > changeThreshold,
      );
      if (big.length && args.confirmBigChange !== true) {
        blockers.push(
          `${big.length} product(s) move more than ${changeThreshold}%: ` +
            big.slice(0, 15).map((t) => `${t.article} ${t.was} → ${t.becomes} (${t.deltaPercent == null ? "from 0" : `${t.deltaPercent > 0 ? "+" : ""}${t.deltaPercent}%`})`).join(", ") +
            (big.length > 15 ? `, … and ${big.length - 15} more` : "") +
            `. If that is the intent, re-send with confirmBigChange:true.`,
        );
      }

      // ── 7. warnings (never block) ─────────────────────────────────────────
      const priceOldTooLow = targets
        .filter((t) => {
          const po = t.becomesPriceOld ?? t.wasPriceOld;
          return po > 0 && po <= t.becomes;
        })
        .map((t) => ({
          article: t.article,
          priceOld: t.becomesPriceOld ?? t.wasPriceOld,
          price: t.becomes,
          issue: (t.becomesPriceOld ?? t.wasPriceOld) === t.becomes ? "equal to the new price" : "BELOW the new price",
        }));
      const discounted = targets.filter((t) => t.discount !== 0).map((t) => ({ article: t.article, discount: t.discount }));
      const noop = targets.filter((t) => wantsPrice(t) && t.delta === 0).map((t) => t.article);

      const warnings: Record<string, unknown> = {};
      if (priceOldTooLow.length) {
        warnings.priceOldNotAbovePrice = {
          products: priceOldTooLow,
          why: "A struck-through «old price» that is not higher than the price being charged shows a discount running backwards (or none at all). This is the usual sign error when staging a sale — it does not block the write.",
        };
      }
      if (discounted.length) {
        warnings.discountRecalculates = {
          products: discounted,
          why: "These products carry a non-zero `discount`, so the storefront shows a price recalculated from the one set here — the shelf price will not equal the number in this table.",
        };
      }
      if (noop.length) {
        warnings.alreadyAtTargetPrice = { products: noop.slice(0, 30), count: noop.length, why: "Already at the requested price; they are still sent, and will verify as unchanged." };
      }
      if (clamped.length) {
        warnings.thresholdsClamped = { clamped, why: "Guard thresholds may be lowered but not raised. Use confirmProductCount / confirmBigChange to proceed deliberately instead." };
      }

      const sumBefore = money(targets.reduce((s, t) => s + t.was, 0));
      const sumAfter = money(targets.reduce((s, t) => s + t.becomes, 0));
      const summary = {
        products: targets.length,
        priceSumBefore: sumBefore,
        priceSumAfter: sumAfter,
        totalShift: money(sumAfter - sumBefore),
        totalShiftPercent: sumBefore > 0 ? Number((((sumAfter - sumBefore) / sumBefore) * 100).toFixed(2)) : null,
        cheaper: targets.filter((t) => t.delta < 0).length,
        dearer: targets.filter((t) => t.delta > 0).length,
        unchanged: targets.filter((t) => t.delta === 0).length,
        writesPriceOld: targets.filter((t) => t.becomesPriceOld != null).length,
      };

      const label =
        mode === "absolute"
          ? hasItems
            ? `set ${targets.filter((t) => wantsPrice(t)).length} price(s) and ${summary.writesPriceOld} price_old(s) individually`
            : args.price != null
              ? `price → ${args.price}`
              : `price_old only (price left alone)`
          : mode === "percent"
            ? `price ${(args.percent as number) > 0 ? "+" : ""}${args.percent}% (rounded to ${roundTo})`
            : `price ${(args.amount as number) > 0 ? "+" : ""}${args.amount} (rounded to ${roundTo})`;

      const table = targets.map((t) => ({
        article: t.article,
        productId: t.productId,
        was: t.was,
        becomes: t.becomes,
        delta: t.delta,
        deltaPercent: t.deltaPercent,
        ...(t.becomesPriceOld != null ? { priceOldWas: t.wasPriceOld, priceOldBecomes: t.becomesPriceOld } : {}),
      }));

      // ── 8. dry run ────────────────────────────────────────────────────────
      if (args.dryRun !== false) {
        return {
          store: args.store ?? null,
          mode,
          dryRun: true,
          change: label,
          affected: targets.length,
          summary,
          products: table,
          notFound: missing,
          guards: { scaleThreshold, changeThresholdPercent: changeThreshold, aboveScaleThreshold: targets.length > scaleThreshold, productsOverChangeThreshold: big.length },
          ...(blockers.length ? { blockers } : {}),
          ...(Object.keys(warnings).length ? { warnings } : {}),
          note: blockers.length
            ? `Nothing was written, and dryRun:false would be REFUSED as it stands — see \`blockers\` (${blockers.length}).`
            : "Nothing was written. Check `was → becomes` per product, then set dryRun:false to apply.",
        };
      }

      // ── 9. write ──────────────────────────────────────────────────────────
      if (blockers.length) {
        throw new Error(`REFUSED, nothing was written:\n- ${blockers.join("\n- ")}`);
      }

      // One row per product, carrying ONLY the cells being changed. Horoshop
      // updates exactly the keys it is given (verified: a price-only row leaves
      // price_old alone), so an untouched field must not appear in the payload —
      // re-sending "the current value" would overwrite whatever changed in the
      // seconds since it was read.
      const rows = targets
        .map((t) => {
          const fields: Record<string, string> = {};
          if (wantsPrice(t)) fields.price = priceString(t.becomes);
          if (t.becomesPriceOld != null) fields.price_old = priceString(t.becomesPriceOld);
          return { id: t.productId, fields };
        })
        .filter((r) => Object.keys(r.fields).length > 0);

      if (rows.length === 0) {
        throw new Error("Nothing to write: no product would change price and no price_old was requested.");
      }

      const wrotePriceOld = targets.some((t) => t.becomesPriceOld != null);
      const { requests, raw } = await writeChunks(client, args.store, rows);

      // ── 10. verify through the other channel ──────────────────────────────
      const after = await readPrices(client, args.store, articles);
      const results = targets.map((t) => {
        const now = after.get(t.article);
        const actual = now?.price ?? null;
        const actualOld = now?.priceOld ?? null;
        const priceOk = actual != null && Math.abs(actual - t.becomes) < EPSILON;
        const oldOk = t.becomesPriceOld == null ? true : actualOld != null && Math.abs(actualOld - (t.becomesPriceOld as number)) < EPSILON;
        return {
          article: t.article,
          productId: t.productId,
          was: t.was,
          expected: t.becomes,
          actual,
          delta: t.delta,
          ok: priceOk && oldOk,
          ...(t.becomesPriceOld != null ? { priceOldExpected: t.becomesPriceOld, priceOldActual: actualOld } : {}),
          // Collateral check: a price-only write must not have moved price_old.
          ...(t.becomesPriceOld == null && actualOld != null && Math.abs(actualOld - t.wasPriceOld) >= EPSILON
            ? { priceOldChangedUnasked: { was: t.wasPriceOld, now: actualOld } }
            : {}),
        };
      });
      const mismatches = results.filter((r) => !r.ok);
      const collateral = results.filter((r) => (r as any).priceOldChangedUnasked);

      // ── 11. the rollback payload ──────────────────────────────────────────
      // Built from the BEFORE snapshot of every product this call attempted, so
      // it restores a half-applied batch just as well as a complete one, and it
      // restores ONLY the fields that were written — a rollback that also reset
      // a price_old nobody touched would be a second unasked-for edit.
      // It also carries the confirmations it will itself trip, because a
      // rollback that is refused by its own guards is not a rollback.
      const rollbackItems = targets
        .filter((t) => wantsPrice(t) || t.becomesPriceOld != null)
        .map((t) => ({
          article: t.article,
          ...(wantsPrice(t) ? { price: t.was } : {}),
          ...(t.becomesPriceOld != null ? { priceOld: t.wasPriceOld } : {}),
        }));
      const rollbackBig = targets.filter(
        (t) => wantsPrice(t) && (t.becomes > 0 ? Math.abs(((t.was - t.becomes) / t.becomes) * 100) > changeThreshold : true),
      ).length;
      const rollback = {
        tool: "horoshop_admin_products_price_set",
        arguments: {
          ...(args.store ? { store: args.store } : {}),
          items: rollbackItems,
          dryRun: false,
          // Always stated, even under the threshold: by the time this runs, an
          // article may have been deleted or renamed, and a count that no longer
          // matches should stop the rollback rather than quietly restore a subset.
          // `allowMissing` is deliberately NOT pre-set for the same reason.
          confirmProductCount: rollbackItems.length,
          ...(rollbackBig > 0 ? { confirmBigChange: true } : {}),
        },
        note: `Run this to put all ${rollbackItems.length} price(s) back exactly as they were before this call. It is pre-armed with the confirmations its own guards require.`,
      };

      return {
        store: args.store ?? null,
        mode,
        dryRun: false,
        change: label,
        affected: targets.length,
        requests,
        summary,
        verified: {
          checkedVia: "catalog/export (public API) — a different transport and credential from the admin session that wrote",
          ok: results.length - mismatches.length,
          mismatched: mismatches.length,
          ...(wrotePriceOld ? { wrotePriceOld: summary.writesPriceOld } : {}),
        },
        products: results,
        ...(mismatches.length ? { mismatches } : {}),
        ...(collateral.length ? { collateralChanges: collateral } : {}),
        notFound: missing,
        rollback,
        ...(Object.keys(warnings).length ? { warnings } : {}),
        raw: raw.slice(0, 200),
        note:
          mismatches.length === 0
            ? `Verified through catalog/export: all ${results.length} product(s) now carry the price that was asked for. Keep the \`rollback\` block until you are sure.`
            : `⚠ ${mismatches.length} of ${results.length} product(s) do NOT read back at the expected price — see \`mismatches\` (expected vs actual per product). The grid answered OK, so this is a silent rejection or a partially applied batch, not a transport error. Run the \`rollback\` block to restore, then investigate.`,
      };
    },
  },
];
