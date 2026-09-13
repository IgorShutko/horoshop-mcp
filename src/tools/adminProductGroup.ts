import { z } from "zod";
import { storeField, type ToolSpec } from "../register.js";
import type { GridRow } from "../admin/form.js";

/**
 * BULK product operations — the toolbar the products grid reveals once rows are
 * selected. Nine buttons, and until now exactly two of them were reachable from
 * this server («Удалить» → horoshop_admin_record_delete, «Внести/Вынести» →
 * horoshop_admin_product_stock_set). This file covers the other seven.
 *
 * They are three different write surfaces wearing one toolbar (see the contract
 * block on AdminClient.groupProductsEdit):
 *   - `group_products_edit/doEdit/` — presence, icons, countdown, marketplace
 *   - `ajax.datagrid.php load=dataGridUpdateValues` — display (and price cells):
 *     the INLINE grid editor, which is not the record editor and not doEdit
 *   - `projectAjax.php load=copy_products` / a `data.php` form POST — copy, merge
 *
 * Everything here addresses products the way the rest of the catalog tools do —
 * by ARTICLE — and resolves that to the internal grid id itself, because the
 * bulk endpoints only speak internal ids and nothing else in the toolset hands
 * them to a human.
 */

export const PRODUCTS_HANDLER = 17;

/** How many products a single call may touch without an explicit override. */
const DEFAULT_MAX_PRODUCTS = 500;

// ─── product resolution ──────────────────────────────────────────────────────

export interface Resolved {
  id: string;
  article: string;
  row: GridRow;
}

/**
 * Resolve articles (and/or raw ids) to grid rows in ONE paged walk.
 *
 * The alternative — the per-article `searchRecords` + ledger echo that
 * horoshop_admin_product_stock_set uses — costs two requests PER article, which
 * for a 300-SKU bulk edit is 600 requests. One walk of the grid is 1 request per
 * 160 rows and gives the same exact match, because `parseGridRows` now carries
 * the row's «Код» cell (the article) structurally.
 */
export async function resolveProducts(
  client: any,
  store: string | undefined,
  articles: string[] | undefined,
  productIds: Array<string | number> | undefined,
): Promise<{ found: Resolved[]; missing: string[]; gridRows: number; truncated: boolean }> {
  const rows: GridRow[] & { truncated?: boolean } = await client.admin.listRecords(store, PRODUCTS_HANDLER, {});
  const byArticle = new Map<string, GridRow>();
  const byId = new Map<string, GridRow>();
  for (const r of rows) {
    byId.set(r.id, r);
    // Exact match only. A substring match binds "TEE-ORBIT" to
    // "TEE-ORBIT-XL" and silently edits the wrong SKU.
    if (r.code && !byArticle.has(r.code)) byArticle.set(r.code, r);
  }

  const found: Resolved[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  const take = (row: GridRow | undefined, wanted: string) => {
    if (!row) {
      missing.push(wanted);
      return;
    }
    if (seen.has(row.id)) return; // the same product named twice is not two edits
    seen.add(row.id);
    found.push({ id: row.id, article: row.code ?? "", row });
  };
  for (const a of articles ?? []) take(byArticle.get(String(a)), String(a));
  for (const i of productIds ?? []) take(byId.get(String(i)), String(i));

  return { found, missing, gridRows: rows.length, truncated: rows.truncated === true };
}

// ─── modal option lists (per-store dictionaries) ─────────────────────────────

interface Option {
  id: string;
  title: string;
}

/**
 * Options of one `<select>` in a rendered bulk-edit modal.
 *
 * The modal IS the dictionary: which presence statuses exist, which stickers,
 * which marketplaces the store is wired to — all per-store, all rendered right
 * there. Reading them from the modal means a name→id resolution that cannot
 * drift from what the admin would have done.
 */
function parseSelectOptions(html: string, name: string): Option[] {
  const re = new RegExp(`<select\\b[^>]*name=["']?${name}["']?[^>]*>([\\s\\S]*?)</select>`, "i");
  const block = re.exec(html)?.[1];
  if (!block) return [];
  const out: Option[] = [];
  for (const m of block.matchAll(/<option[^>]*value=["']?([^"'>]*)["']?[^>]*>([\s\S]*?)<\/option>/gi)) {
    const id = m[1].trim();
    const title = m[2].replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
    out.push({ id, title });
  }
  return out;
}

async function modalOptions(
  client: any,
  store: string | undefined,
  type: string,
  sampleIds: string[],
  selectName: string,
): Promise<Option[]> {
  const modal = await client.admin.groupProductsRenderModal(store, type, sampleIds);
  if (!modal.html) {
    throw new Error(
      `The admin did not render the «${type}» bulk-edit modal (HTTP ${modal.httpStatus}, status ${modal.status ?? "?"}). ` +
        `Without it the option list for this operation cannot be read, so nothing was written.`,
    );
  }
  return parseSelectOptions(modal.html, selectName);
}

/**
 * Name-or-id → id, against the store's own list.
 *
 * Deliberately strict in BOTH directions. A name is matched case-insensitively
 * and exactly; a numeric id is matched against the same list rather than trusted,
 * because these endpoints answer `{"status":"OK"}` for an id that means nothing
 * and simply change nothing — the failure would be invisible.
 *
 * (This is the mirror image of the catalog_import trap, where `icons[]` matches
 * stickers BY NAME and an id creates junk stickers literally called "3"/"12".
 * Here the wire format is the id; the name is the ergonomic. Same rule either
 * way: never let an unvalidated value through.)
 */
function pickOption(options: Option[], wanted: string | number, what: string): Option {
  const w = String(wanted).trim();
  const byId = options.find((o) => o.id === w && o.id !== "");
  if (byId) return byId;
  const byName = options.find((o) => o.title.toLowerCase() === w.toLowerCase());
  if (byName) return byName;
  const list = options.filter((o) => o.id !== "").map((o) => `${o.id}=${o.title}`).join(" | ") || "(none)";
  throw new Error(
    `No ${what} matches "${w}" on this store. The admin offers: ${list}. ` +
      `Pass the title (matched exactly, case-insensitively) or one of those ids — ` +
      `an id that is not in the list is accepted by Horoshop and changes nothing.`,
  );
}

// ─── countdown time ──────────────────────────────────────────────────────────

/**
 * "YYYY-MM-DD HH:MM[:SS]" (store-local) or an ISO instant → unix epoch seconds.
 *
 * `countdown_end_time` travels as an epoch and comes back rendered in the STORE's
 * timezone (measured on a UTC+3 store: epoch for 12:00:00Z read back as
 * "2026-08-15 15:00:00"). A bare local string is therefore ambiguous unless the
 * caller also says which offset it means, so `utcOffsetMinutes` is explicit and
 * an ISO string with a zone skips the question entirely.
 */
function toEpochSeconds(value: string, utcOffsetMinutes: number): number {
  const s = value.trim();
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(s);
  if (zoned) {
    const t = Date.parse(s);
    if (Number.isNaN(t)) throw new Error(`endTime "${value}" is not a valid ISO instant.`);
    return Math.floor(t / 1000);
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (!m) {
    throw new Error(
      `endTime "${value}" is not understood. Pass "YYYY-MM-DD HH:MM[:SS]" (read as store-local, see utcOffsetMinutes) ` +
        `or a zoned ISO instant like "2026-08-15T12:00:00Z".`,
    );
  }
  const [, y, mo, d, h, mi, se] = m;
  const asUtc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +(se ?? "0"));
  return Math.floor(asUtc / 1000) - utcOffsetMinutes * 60;
}

// ─── verification ────────────────────────────────────────────────────────────

const VERIFY_FIELDS = [
  "article",
  "display_in_showcase",
  "presence",
  "icons",
  "export_to_marketplace",
  "countdown_end_time",
  "price",
];

/** Re-read the touched articles from catalog/export, keyed by article. */
async function readBack(
  client: any,
  store: string | undefined,
  articles: string[],
): Promise<Map<string, any>> {
  if (!articles.length) return new Map();
  const res: any = await client.call(store, "catalog/export", {
    expr: { article: articles },
    limit: Math.max(articles.length, 1),
    includedParams: VERIFY_FIELDS,
  });
  const products: any[] = res?.response?.products ?? res?.products ?? [];
  return new Map(products.map((p) => [String(p.article), p]));
}

/** The one field an operation touches, as catalog/export reports it. */
function observed(op: string, p: any): unknown {
  if (!p) return null;
  switch (op) {
    case "display":
      return p.display_in_showcase;
    case "presence":
      return p.presence?.id ?? null;
    case "icons":
      return (p.icons ?? []).map((i: any) => i.id);
    case "marketplace":
      return (p.export_to_marketplace ?? []).map((m: any) => m.id);
    case "countdown":
      return p.countdown_end_time ?? null;
    default:
      return null;
  }
}

// ─── tools ───────────────────────────────────────────────────────────────────

const articlesArg = z
  .array(z.string())
  .optional()
  .describe("Articles (SKUs) to act on, matched EXACTLY. Either this or productIds (or both).");

const productIdsArg = z
  .array(z.union([z.number().int(), z.string()]))
  .optional()
  .describe("Internal grid product ids (from horoshop_admin_list entity=products). Either this or articles.");

export const adminProductGroupTools: ToolSpec[] = [
  {
    name: "horoshop_admin_products_group_edit",
    title: "Bulk-edit products (grid group operations)",
    description:
      "Apply ONE change to MANY products at once — the admin's own bulk toolbar, the one that appears under the products grid when you tick rows. Address products by `article` (exact match, resolved to internal ids for you) or by `productIds`. Operations: " +
      "`display` (show/hide on the storefront — the most-used one), `presence` (availability status), `icons` (hang or remove a sticker), `countdown` (the promo timer + its offer message), `marketplace` (include/exclude from a marketplace feed), `copy` (duplicate the products). " +
      "DRY RUN BY DEFAULT: it resolves every article, reports HOW MANY products would be touched and, per product, the CURRENT value → the NEW value, plus which articles it could not find. Pass dryRun:false to apply; it then re-reads the touched articles from catalog/export and reports the real before/after per product, so a silent no-op cannot pass for success. " +
      "Name resolution is done against the STORE's own lists, read from the admin modal: pass a sticker/presence/marketplace by TITLE (\"Хит\", \"Нет в наличии\") or by id — either way it is validated against what this store actually offers, because Horoshop answers «OK» for an id that means nothing and changes nothing. " +
      "⚠ `copy` CREATES products: each copy's article is the source's prefixed with `copy_`, so copying the same product twice collides on article. ⚠ A large selection is handed to a BACKGROUND QUEUE (`queued:true` in the answer) — the values then change a moment later, and an immediate re-read can still show the old ones. " +
      "Not here: deleting (horoshop_admin_record_delete entity=products), warehouse stock (horoshop_admin_product_stock_set — the grid's «Внести»/«Вынести»), and merging (horoshop_admin_products_merge).",
    inputSchema: {
      ...storeField,
      articles: articlesArg,
      productIds: productIdsArg,
      operation: z
        .enum(["display", "presence", "icons", "countdown", "marketplace", "copy"])
        .describe(
          "display = show/hide in the showcase · presence = availability status · icons = sticker on/off · countdown = promo timer · marketplace = feed membership on/off · copy = duplicate products.",
        ),
      value: z
        .boolean()
        .optional()
        .describe("display: true = shown, false = hidden. icons/marketplace: true = attach, false = remove. Ignored by the others."),
      presence: z
        .union([z.string(), z.number().int()])
        .optional()
        .describe('operation=presence: the availability status by title ("Нет в наличии", "Є в наявності") or id.'),
      icon: z
        .union([z.string(), z.number().int()])
        .optional()
        .describe('operation=icons: the sticker by title ("Хит", "Новинка") or id. Combine with `value` to attach or remove it.'),
      marketplace: z
        .union([z.string(), z.number().int()])
        .optional()
        .describe('operation=marketplace: the marketplace/feed by title ("Multisearch Feed") or id. Combine with `value`.'),
      endTime: z
        .string()
        .optional()
        .describe('operation=countdown: when the timer ends — "YYYY-MM-DD HH:MM[:SS]" (store-local) or a zoned ISO instant ("2026-08-15T12:00:00Z").'),
      utcOffsetMinutes: z
        .number()
        .int()
        .optional()
        .describe("operation=countdown: the store's UTC offset in minutes for a bare local endTime. Default 180 (Kyiv summer time). Ignored for a zoned ISO instant."),
      message: z
        .record(z.string())
        .optional()
        .describe('operation=countdown: the offer message per language, e.g. {"ua":"Знижка діє до","ru":"Скидка действует до"}. Pass "" to clear a language.'),
      copyImages: z
        .boolean()
        .optional()
        .describe("operation=copy: also duplicate the image files. Default false (much cheaper; the copy then has no images of its own)."),
      maxProducts: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(`Safety cap on how many products one call may touch. Default ${DEFAULT_MAX_PRODUCTS}.`),
      dryRun: z.boolean().optional().describe("Default true: resolve and preview, write nothing. Set false to apply."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    handler: async (client, args) => {
      const op = args.operation as string;
      const hasArticles = Array.isArray(args.articles) && args.articles.length > 0;
      const hasIds = Array.isArray(args.productIds) && args.productIds.length > 0;
      if (!hasArticles && !hasIds) {
        throw new Error("Pass `articles` and/or `productIds` — there is nothing to act on.");
      }

      const { found, missing, gridRows, truncated } = await resolveProducts(
        client,
        args.store,
        args.articles,
        args.productIds,
      );
      if (truncated) {
        throw new Error(
          `The products grid listing was truncated at ${gridRows} rows, so an article that exists further down would be reported as missing — refusing to run a bulk edit on a partial view.`,
        );
      }
      if (found.length === 0) {
        return {
          store: args.store ?? null,
          operation: op,
          affected: 0,
          notFound: missing,
          note: "None of the given articles/ids exist in the products grid. Nothing was written.",
        };
      }
      const cap = args.maxProducts ?? DEFAULT_MAX_PRODUCTS;
      if (found.length > cap) {
        throw new Error(
          `This call would touch ${found.length} products, over the ${cap} cap. Raise \`maxProducts\` deliberately, or split the batch.`,
        );
      }

      const ids = found.map((f) => f.id);
      const articles = found.map((f) => f.article).filter(Boolean);

      // What is about to change, described once for the dry run and the answer.
      let change: { field: string; to: unknown; label: string };
      let actions: Array<[string, string]> = [];

      if (op === "display") {
        if (typeof args.value !== "boolean") throw new Error("operation=display needs `value` (true = shown, false = hidden).");
        change = { field: "display_in_showcase", to: args.value ? 1 : 0, label: args.value ? "shown in the showcase" : "hidden" };
      } else if (op === "presence") {
        if (args.presence == null) throw new Error("operation=presence needs `presence` (a status title or id).");
        const opt = pickOption(await modalOptions(client, args.store, "changePresence", ids.slice(0, 1), "id"), args.presence, "availability status");
        actions = [["actions[presence]", opt.id]];
        change = { field: "presence", to: Number(opt.id), label: `presence → ${opt.title} (id ${opt.id})` };
      } else if (op === "icons") {
        if (args.icon == null) throw new Error("operation=icons needs `icon` (a sticker title or id).");
        if (typeof args.value !== "boolean") throw new Error("operation=icons needs `value` (true = attach the sticker, false = remove it).");
        const opt = pickOption(await modalOptions(client, args.store, "changeIcons", ids.slice(0, 1), "id"), args.icon, "sticker");
        actions = [[`actions[icons][${opt.id}]`, args.value ? "1" : "0"]];
        change = { field: "icons", to: `${args.value ? "+" : "−"}${opt.id}`, label: `${args.value ? "attach" : "remove"} sticker «${opt.title}» (id ${opt.id})` };
      } else if (op === "marketplace") {
        if (args.marketplace == null) throw new Error("operation=marketplace needs `marketplace` (a feed title or id).");
        if (typeof args.value !== "boolean") throw new Error("operation=marketplace needs `value` (true = include, false = exclude).");
        const opt = pickOption(await modalOptions(client, args.store, "exportToMarketplace", ids.slice(0, 1), "id"), args.marketplace, "marketplace");
        actions = [[`actions[export_to_marketplace][${opt.id}]`, args.value ? "1" : "0"]];
        change = { field: "export_to_marketplace", to: `${args.value ? "+" : "−"}${opt.id}`, label: `${args.value ? "include in" : "exclude from"} «${opt.title}» (id ${opt.id})` };
      } else if (op === "countdown") {
        if (!args.endTime) throw new Error("operation=countdown needs `endTime`.");
        const offset = args.utcOffsetMinutes ?? 180;
        const epoch = toEpochSeconds(String(args.endTime), offset);
        actions = [["actions[countdown_end_time]", String(epoch)]];
        for (const [lang, text] of Object.entries((args.message ?? {}) as Record<string, string>)) {
          actions.push([`actions[countdown_offer_message][${lang}]`, String(text)]);
        }
        // Show it the way catalog/export will read it back — store-local wall
        // clock — so the dry run's from→to compares like with like instead of
        // putting a local string next to a UTC instant.
        const storeLocal = new Date((epoch + offset * 60) * 1000).toISOString().replace("T", " ").slice(0, 19);
        change = {
          field: "countdown_end_time",
          to: storeLocal,
          label: `timer ends ${storeLocal} store-local (epoch ${epoch}, ${new Date(epoch * 1000).toISOString()})`,
        };
      } else {
        // copy
        change = { field: "(new products)", to: `copy_<article>`, label: `duplicate ${found.length} product(s)${args.copyImages ? " with their images" : " without images"}` };
      }

      const before = await readBack(client, args.store, articles);
      const preview = found.map((f) => ({
        article: f.article,
        productId: f.id,
        ...(op === "copy"
          ? { copyArticle: `copy_${f.article}` }
          : { from: observed(op, before.get(f.article)), to: change.to }),
      }));

      if (args.dryRun !== false) {
        return {
          store: args.store ?? null,
          operation: op,
          dryRun: true,
          affected: found.length,
          change: change.label,
          products: preview,
          notFound: missing,
          ...(op === "copy"
            ? {
                warning:
                  `This CREATES ${found.length} new product(s), each with the article "copy_<source article>". ` +
                  `Copying a product that already has a copy_ twin fails on the duplicate article. Copies are created with the source's settings — check display/presence before they go live.`,
              }
            : {}),
          note: "Nothing was written. Set dryRun:false to apply.",
        };
      }

      // ── write ──
      let queued = false;
      let raw = "";
      if (op === "display") {
        const res = await client.admin.gridUpdateValues(
          args.store,
          PRODUCTS_HANDLER,
          found.map((f) => ({ id: f.id, fields: { display_in_showcase: args.value ? "1" : "0" } })),
        );
        raw = res.raw;
        if (res.status !== "OK") {
          throw new Error(`The grid refused the inline update (HTTP ${res.httpStatus}, status ${res.status ?? "?"}): ${res.raw}`);
        }
      } else if (op === "copy") {
        const res = await client.admin.copyProducts(args.store, ids, args.copyImages === true);
        raw = res.raw;
        if (res.status !== "OK") {
          throw new Error(`copy_products failed (HTTP ${res.httpStatus}, status ${res.status ?? "?"}): ${res.raw}`);
        }
      } else {
        const res = await client.admin.groupProductsEdit(args.store, ids, actions);
        raw = res.raw;
        queued = res.isQueue === true || res.isFinished === false;
        if (res.status !== "OK") {
          throw new Error(`The bulk edit was rejected (HTTP ${res.httpStatus}, status ${res.status ?? "?"}): ${res.raw}`);
        }
      }

      // ── verify ──
      if (op === "copy") {
        const after = await resolveProducts(client, args.store, found.map((f) => `copy_${f.article}`), undefined);
        return {
          store: args.store ?? null,
          operation: op,
          dryRun: false,
          affected: found.length,
          change: change.label,
          created: after.found.map((f) => ({ article: f.article, productId: f.id })),
          notCreated: after.missing,
          catalogRows: after.gridRows,
          notFound: missing,
          note:
            after.missing.length === 0
              ? `Verified: ${after.found.length} copy/copies now exist in the products grid. They are NEW products — set their own article, price and images before they sell.`
              : `⚠ ${after.missing.length} expected copy/copies did not appear (${after.missing.join(", ")}). A copy_ article that already existed is the usual cause.`,
        };
      }

      const after = await readBack(client, args.store, articles);
      const results = found.map((f) => {
        const from = observed(op, before.get(f.article));
        const now = observed(op, after.get(f.article));
        return {
          article: f.article,
          productId: f.id,
          from,
          after: now,
          changed: JSON.stringify(from) !== JSON.stringify(now),
        };
      });
      const changedCount = results.filter((r) => r.changed).length;
      const unchanged = results.filter((r) => !r.changed).map((r) => r.article);

      return {
        store: args.store ?? null,
        operation: op,
        dryRun: false,
        affected: found.length,
        change: change.label,
        verifiedChanged: changedCount,
        products: results,
        notFound: missing,
        ...(queued ? { queued: true } : {}),
        raw: raw.slice(0, 200),
        note:
          changedCount === found.length
            ? `Verified against catalog/export: all ${changedCount} product(s) now carry the new value.`
            : queued
              ? `Horoshop QUEUED this batch (isQueue), so ${unchanged.length} product(s) still read the old value — that is the queue, not a failure. Re-read in a moment with horoshop_catalog_export.`
              : `⚠ ${unchanged.length} product(s) read back UNCHANGED (${unchanged.slice(0, 10).join(", ")}${unchanged.length > 10 ? ", …" : ""}). ` +
                "The endpoint answered OK, so the value was most likely already what you asked for — or it was rejected silently. Compare each product's `from` with what you intended.",
      };
    },
  },
  {
    name: "horoshop_admin_products_merge",
    title: "Merge products into one modification group",
    description:
      "Merge several products into ONE — the grid's «Соединить». The product you name as `main` stays a top-level product; every other one becomes a MODIFICATION of it (its `parent_article` flips to the main product's), which is how a store turns four separately-loaded size SKUs into one product with a size selector. " +
      "⚠ THERE IS NO UNDO. Nothing in the admin re-splits a merged group — separating them again is per-product editor work. Treat the dry run as the safety step. " +
      "DRY RUN BY DEFAULT: resolves the articles and shows which product stays main and which get absorbed. Pass dryRun:false to merge; it then re-reads the catalog and reports each product's resulting parent_article, so a merge that did not take is visible.",
    inputSchema: {
      ...storeField,
      articles: articlesArg,
      productIds: productIdsArg,
      main: z
        .union([z.string(), z.number().int()])
        .describe("The product that stays top-level and receives the others as modifications — its article or its internal id. Must be one of the products being merged."),
      dryRun: z.boolean().optional().describe("Default true: preview without merging. Set false to merge (irreversible)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    handler: async (client, args) => {
      const { found, missing, truncated, gridRows } = await resolveProducts(
        client,
        args.store,
        args.articles,
        args.productIds,
      );
      if (truncated) {
        throw new Error(`The products grid listing was truncated at ${gridRows} rows — refusing to merge on a partial view.`);
      }
      if (found.length < 2) {
        throw new Error(
          `A merge needs at least 2 existing products; ${found.length} resolved${missing.length ? ` (not found: ${missing.join(", ")})` : ""}.`,
        );
      }
      const want = String(args.main);
      const main = found.find((f) => f.id === want || f.article === want);
      if (!main) {
        throw new Error(
          `\`main\` ("${want}") is not among the products being merged: ${found.map((f) => `${f.article}(${f.id})`).join(", ")}.`,
        );
      }
      const absorbed = found.filter((f) => f.id !== main.id);

      if (args.dryRun !== false) {
        return {
          store: args.store ?? null,
          dryRun: true,
          main: { article: main.article, productId: main.id },
          absorbed: absorbed.map((f) => ({ article: f.article, productId: f.id })),
          affected: found.length,
          notFound: missing,
          warning:
            `IRREVERSIBLE: ${absorbed.length} product(s) would stop being standalone products and become modifications of «${main.article}». There is no un-merge.`,
          note: "Nothing was written. Set dryRun:false to merge.",
        };
      }

      const res = await client.admin.mergeProducts(args.store, PRODUCTS_HANDLER, found.map((f) => f.id), main.id);
      if (res.httpStatus >= 400) {
        throw new Error(`The merge POST failed (HTTP ${res.httpStatus}): ${res.raw}`);
      }

      // The merge answers with the whole grid page, not a status — so the proof is
      // the catalog: every absorbed article must now report the main's parent.
      const check: any = await client.call(args.store, "catalog/export", {
        expr: { article: found.map((f) => f.article).filter(Boolean) },
        limit: Math.max(found.length, 1),
        includedParams: ["article", "parent_article"],
      });
      const rows: any[] = check?.response?.products ?? check?.products ?? [];
      const parentOf = new Map(rows.map((p) => [String(p.article), String(p.parent_article ?? "")]));
      const results = found.map((f) => ({
        article: f.article,
        productId: f.id,
        parentArticle: parentOf.get(f.article) ?? null,
        isMain: f.id === main.id,
        merged: f.id === main.id ? parentOf.get(f.article) === f.article : parentOf.get(f.article) === main.article,
      }));
      const ok = results.filter((r) => r.merged).length;

      return {
        store: args.store ?? null,
        dryRun: false,
        httpStatus: res.httpStatus,
        main: { article: main.article, productId: main.id },
        affected: found.length,
        verified: ok,
        products: results,
        notFound: missing,
        note:
          ok === found.length
            ? `Verified: ${absorbed.length} product(s) now report parent_article «${main.article}». This cannot be undone from here.`
            : `⚠ Only ${ok} of ${found.length} report the merged parent. Re-read with horoshop_catalog_export includedParams:["article","parent_article"] before merging anything else.`,
      };
    },
  },
];
