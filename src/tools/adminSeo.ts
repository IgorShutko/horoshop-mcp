import { z } from "zod";
import { storeField, type ToolSpec } from "../register.js";
import { fieldValue } from "../admin/form.js";

/**
 * SEO-facing admin surfaces that live outside the general-settings form and the
 * documented API:
 *
 *  - The "Дополнительные SEO настройки" screen (`utils/additional_seo_settings.php`)
 *    — a self-POST singleton (the form's action is the page itself, urlencoded,
 *    with a hidden `action=save`), NOT save.php. Five booleans that decide how
 *    canonical/noindex on pagination, SEO text on GET-param URLs, and the catalog
 *    and brand breadcrumb levels behave. The same five flags also exist inside the
 *    big site_settings form (they are one and the same `extra[...]` on page id=1),
 *    but this is their native screen and its own write endpoint. Save mechanism
 *    verified on the test store: read-modify-write, replay every field (including the
 *    hidden `action=save` and the oddly-named `save-robots` submit) and POST
 *    urlencoded back to the page; a success answers 302.
 *
 *  - robots.txt: read-only. There is NO robots editor in this admin — the
 *    `save-robots` button is just the (mis-named) submit for the five SEO flags,
 *    the page carries no robots textarea, and the candidate editor URLs 404.
 *    Horoshop generates `/robots.txt` on the platform side, so it is surfaced here
 *    as a storefront read only; there is no supported write path.
 *
 *  - Sitemap: regeneration (`utils/sitemap.php?create`) and a public read of the
 *    `/sitemap.xml` index and its children.
 */

const SEO_URL = "/adminLegacy/utils/additional_seo_settings.php?checkcode=yamete_kudasai";

/** The five booleans on the additional-SEO screen: human key -> raw field + label. */
const SEO_FIELDS = {
  paginationCanonicalFirstPage: {
    field: "extra[pagination_canonical_on_first_page]",
    label: "Canonical на первую страницу пагинации",
  },
  paginationNoindex: {
    field: "extra[pagination_noindex]",
    label: "Не индексировать страницы пагинации (noindex)",
  },
  seoTextWithGetParams: {
    field: "extra[enabled_seo_text_with_get_params]",
    label: "Показывать SEO-текст на URL с GET-параметрами",
  },
  catalogInBreadcrumbs: {
    field: "extra[show_catalog_in_breadcrumbs]",
    label: "Страница «Каталог» в хлебных крошках",
  },
  brandInBreadcrumbs: {
    field: "extra[show_brand_in_breadcrumbs]",
    label: "Ссылка на Бренд в хлебных крошках товара",
  },
} as const;

type SeoKey = keyof typeof SEO_FIELDS;
const SEO_KEYS = Object.keys(SEO_FIELDS) as SeoKey[];

/** Read all five flags out of a parsed form as booleans (checkbox is on when "1"). */
function readSeoFlags(form: { fields: any[] } & any): Record<SeoKey, boolean> {
  const out = {} as Record<SeoKey, boolean>;
  for (const key of SEO_KEYS) out[key] = fieldValue(form, SEO_FIELDS[key].field) === "1";
  return out;
}

/** PoW-aware storefront fetch of a plain-text/xml path (robots.txt, sitemap.xml). */
async function storefrontText(
  client: any,
  store: string | undefined,
  path: string,
): Promise<{ httpStatus: number; body: string; size: number }> {
  const { httpStatus, html } = await client.shop.page(store, path);
  return { httpStatus, body: html, size: html.length };
}

/**
 * The PoW anti-bot serves its challenge with HTTP 200 and a ~518-byte body that
 * sets `defaultHash` and reloads (see storefront.ts). `client.shop.page` clears
 * it on the happy path, but if the clear ever fails we must not hand the
 * challenge back as if it were the file. This spots a body that is the challenge
 * (or otherwise too small to be real content).
 */
function looksLikeChallenge(body: string): boolean {
  return /defaultHash\s*=/.test(body) || /challenge_passed/.test(body) || body.trim().length < 32;
}

/**
 * A real robots.txt has at least one directive line. Anything without one — an
 * HTML challenge page, an error page, an empty body — is not robots.txt, whatever
 * HTTP code it came with.
 */
function looksLikeRobots(body: string): boolean {
  return /^\s*(User-agent|Disallow|Allow|Sitemap|Crawl-delay|Host|Content-signal)\s*:/im.test(body);
}

interface ParsedSitemap {
  /** A `<sitemapindex>` pointing at child sitemaps. */
  isIndex: boolean;
  /** A flat `<urlset>` (a single sitemap, not an index). */
  isUrlset: boolean;
  /** Child sitemap URLs (index only) — the `<loc>` inside each `<sitemap>` block. */
  children: string[];
  /** Per-child `<lastmod>` (index only), aligned to `children`. */
  childLastmods: Array<string | null>;
  /** Number of `<url>` entries (urlset only; 0 for an index). */
  urlCount: number;
}

/**
 * Parse either sitemap flavour. The test store serves a `<sitemapindex>` at /sitemap.xml
 * that points at flat `<urlset>` children, but a store with a single small
 * catalog can serve a bare `<urlset>` there instead. The two are structurally
 * different — an index's `<loc>`s are CHILD SITEMAPS to recurse into, a urlset's
 * `<loc>`s are PAGE URLs to count — so the parser must not confuse them. It
 * scopes `children` to `<loc>`s that sit inside a `<sitemap>` block (index), and
 * `urlCount` to `<url>` entries (urlset). Feeding a urlset to the old parser
 * would have returned every page URL as a "child sitemap" and then tried to
 * fetch each one as XML.
 */
function parseSitemap(xml: string): ParsedSitemap {
  const isIndex = /<sitemapindex[\s>]/i.test(xml);
  const isUrlset = /<urlset[\s>]/i.test(xml);
  const blocks = [...xml.matchAll(/<sitemap[\s>][\s\S]*?<\/sitemap>/gi)].map((m) => m[0]);
  const children: string[] = [];
  const childLastmods: Array<string | null> = [];
  for (const b of blocks) {
    const loc = b.match(/<loc>\s*([^<]+?)\s*<\/loc>/i)?.[1];
    if (!loc) continue;
    children.push(loc);
    childLastmods.push(b.match(/<lastmod>\s*([^<]+?)\s*<\/lastmod>/i)?.[1] ?? null);
  }
  return {
    isIndex,
    isUrlset,
    children,
    childLastmods,
    urlCount: (xml.match(/<url[\s>]/gi) ?? []).length,
  };
}

/**
 * Read /sitemap.xml and resolve it to a uniform shape regardless of flavour.
 * For an index: fetch each child and count its `<url>`s. For a flat urlset: the
 * document IS the sitemap, so report its own `<url>` count with no recursion.
 */
async function readSitemap(
  client: any,
  store: string | undefined,
): Promise<{
  isIndex: boolean;
  isUrlset: boolean;
  indexBytes: number;
  httpStatus: number;
  children: Array<{ url: string; lastmod: string | null; urlCount: number }>;
  totalUrls: number;
}> {
  const idx = await storefrontText(client, store, "/sitemap.xml");
  const parsed = parseSitemap(idx.body);
  const base = client.resolveStore(store).conf.baseUrl;
  const toPath = (loc: string) => (loc.startsWith("http") ? loc.slice(base.length) : loc);

  if (parsed.isIndex && parsed.children.length) {
    const children: Array<{ url: string; lastmod: string | null; urlCount: number }> = [];
    for (let i = 0; i < parsed.children.length; i++) {
      const loc = parsed.children[i];
      const c = await storefrontText(client, store, toPath(loc));
      children.push({ url: loc, lastmod: parsed.childLastmods[i] ?? null, urlCount: parseSitemap(c.body).urlCount });
    }
    return {
      isIndex: true,
      isUrlset: false,
      indexBytes: idx.size,
      httpStatus: idx.httpStatus,
      children,
      totalUrls: children.reduce((n, c) => n + c.urlCount, 0),
    };
  }

  // Flat urlset (or an empty/degenerate document): no children to recurse into.
  return {
    isIndex: false,
    isUrlset: parsed.isUrlset,
    indexBytes: idx.size,
    httpStatus: idx.httpStatus,
    children: [],
    totalUrls: parsed.urlCount,
  };
}

const seoBoolSchema: Record<string, z.ZodTypeAny> = {};
for (const key of SEO_KEYS) {
  seoBoolSchema[key] = z.boolean().optional().describe(SEO_FIELDS[key].label);
}

export const adminSeoTools: ToolSpec[] = [
  {
    name: "horoshop_admin_seo_settings_get",
    title: "Read the additional SEO settings (pagination canonical/noindex, breadcrumbs)",
    description:
      "Read the five booleans on the store's 'Дополнительные SEO настройки' screen: `paginationCanonicalFirstPage` (canonical → first pagination page), `paginationNoindex` (noindex the pagination pages), `seoTextWithGetParams` (show the SEO text on URLs that carry GET params), `catalogInBreadcrumbs` (add the 'Каталог' level to breadcrumbs), and `brandInBreadcrumbs` (add the brand link to a product's breadcrumbs). Read-only. Write them with horoshop_admin_seo_settings_set.",
    inputSchema: { ...storeField },
    annotations: { readOnlyHint: true },
    handler: async (client, args) => {
      const form = await client.admin.getFormFromUrl(args.store, SEO_URL);
      return {
        store: args.store,
        source: "additional_seo_settings.php",
        values: readSeoFlags(form),
      };
    },
  },
  {
    name: "horoshop_admin_seo_settings_set",
    title: "Set the additional SEO settings (self-POST screen)",
    description:
      "Turn any of the five 'Дополнительные SEO настройки' booleans on or off: `paginationCanonicalFirstPage`, `paginationNoindex`, `seoTextWithGetParams`, `catalogInBreadcrumbs`, `brandInBreadcrumbs` (all true=on). This screen is a self-POST singleton (it posts back to itself, not save.php); the tool does a read-modify-write and verifies by re-reading the form. `paginationNoindex` and the canonical flag steer how search engines treat pagination — change them deliberately. Call horoshop_admin_seo_settings_get first to see the current state. DRY RUN BY DEFAULT.",
    inputSchema: {
      ...storeField,
      ...seoBoolSchema,
      dryRun: z.boolean().optional().describe("Default true: preview the change. Set false to apply."),
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
    handler: async (client, args) => {
      const form = await client.admin.getFormFromUrl(args.store, SEO_URL);
      const before = readSeoFlags(form);

      const set: Record<string, string> = {};
      const touched: SeoKey[] = [];
      for (const key of SEO_KEYS) {
        if (args[key] === undefined) continue;
        set[SEO_FIELDS[key].field] = args[key] ? "1" : "0";
        touched.push(key);
      }
      if (touched.length === 0) {
        throw new Error(`Nothing to set. Pass one or more of: ${SEO_KEYS.join(", ")}.`);
      }

      const planned = touched.map((key) => ({
        key,
        field: SEO_FIELDS[key].field,
        from: before[key],
        to: !!args[key],
      }));
      if (args.dryRun !== false) {
        return { store: args.store, dryRun: true, willChange: planned };
      }

      // Self-POST: the form's action is the page itself, urlencoded, with a hidden
      // action=save. saveViaRoute replays every field (incl. the mis-named
      // save-robots submit) and posts urlencoded to that action; success = 302.
      const res = await client.admin.saveViaRoute(args.store, form.action, form, set);
      const after = readSeoFlags(await client.admin.getFormFromUrl(args.store, SEO_URL));
      const changes = planned.map((p) => ({
        ...p,
        now: after[p.key],
        persisted: after[p.key] === p.to,
      }));
      const ok = changes.every((c) => c.persisted);
      return {
        store: args.store,
        dryRun: false,
        saved: ok,
        httpStatus: res.httpStatus,
        changes,
        note: ok ? "Saved and verified by re-reading the form." : "Some flags did not persist — see `changes`.",
      };
    },
  },
  {
    name: "horoshop_admin_robots_get",
    title: "Read the store's live robots.txt",
    description:
      "Fetch the store's live `/robots.txt` from the storefront (through the anti-bot). READ-ONLY: Horoshop generates robots.txt on the platform side — there is no admin editor for it (the 'save-robots' button on the SEO screen is just the mis-named submit for the SEO flags, and no robots textarea exists), so there is no supported write path from here. Use this to audit what crawlers are told, and to confirm the Sitemap: line points at the right URL.",
    inputSchema: { ...storeField },
    annotations: { readOnlyHint: true },
    handler: async (client, args) => {
      let r = await storefrontText(client, args.store, "/robots.txt");
      let clearedChallenge = false;

      // If the body is the PoW challenge (or otherwise not robots), the anti-bot
      // did not clear. Drop the buyer session and re-fetch once: the fresh
      // session re-passes the challenge (reads `defaultHash`, sets
      // `challenge_passed`) before requesting the file again.
      if (!looksLikeRobots(r.body) && looksLikeChallenge(r.body)) {
        client.shop.reset(args.store);
        r = await storefrontText(client, args.store, "/robots.txt");
        clearedChallenge = true;
      }

      // Still not robots.txt — return an actionable error, never the challenge
      // masquerading as robots. HTTP 200 alone proves nothing behind the anti-bot.
      if (!looksLikeRobots(r.body)) {
        return {
          store: args.store,
          httpStatus: r.httpStatus,
          bytes: r.size,
          editable: false,
          error:
            "The storefront did not return a real robots.txt — the body has no robots directives and looks like the anti-bot challenge or an error page. HTTP status is not proof here. Try again shortly; if it persists the PoW challenge is not clearing for this session.",
          bodyPreview: r.body.slice(0, 200),
        };
      }

      const sitemapLine = r.body.match(/^\s*Sitemap:\s*(\S+)/im)?.[1];
      return {
        store: args.store,
        httpStatus: r.httpStatus,
        bytes: r.size,
        ...(clearedChallenge ? { clearedChallenge: true } : {}),
        sitemap: sitemapLine ?? null,
        editable: false,
        note: "robots.txt is platform-generated on Horoshop; no admin write path exists.",
        robots: r.body,
      };
    },
  },
  {
    name: "horoshop_admin_sitemap_regenerate",
    title: "Regenerate the store's XML sitemap",
    description:
      "Rebuild the store's sitemap via the admin's `utils/sitemap.php?create`. The public `/sitemap.xml` may be a `<sitemapindex>` pointing at generated children (pages / catalog) or a single flat `<urlset>`; either way this refreshes it to reflect the current catalog. Non-destructive and idempotent — the map just mirrors reality, so there is nothing to undo. Worth calling after a catalog import or a batch of URL/redirect changes. Returns two distinct signals: `accepted` (the endpoint ran) and `contentChanged` (the URL counts actually moved). NOTE: `lastmod` is bumped on every rebuild, so it is NOT used as the change signal — `regenerated` means 'the rebuild ran', not 'the URL set changed'; watch `contentChanged` for the latter.",
    inputSchema: { ...storeField },
    annotations: { readOnlyHint: false, idempotentHint: true },
    handler: async (client, args) => {
      const before = await readSitemap(client, args.store);
      const res = await client.admin.sitemapRegenerate(args.store);
      const after = await readSitemap(client, args.store);

      // `lastmod` bumps on every call, so it is a useless change signal. The
      // meaningful one is whether the URL set actually moved: total URLs, the
      // per-child counts, or the child set itself.
      const countsBefore = JSON.stringify(before.children.map((c) => [c.url, c.urlCount]));
      const countsAfter = JSON.stringify(after.children.map((c) => [c.url, c.urlCount]));
      const contentChanged = before.totalUrls !== after.totalUrls || countsBefore !== countsAfter;
      const accepted = res.httpStatus === 200;

      return {
        store: args.store,
        httpStatus: res.httpStatus,
        accepted,
        // Backwards-compatible field: true = the regeneration request ran. It is
        // deliberately NOT tied to lastmod (which always moves). See contentChanged.
        regenerated: accepted,
        contentChanged,
        before: { isIndex: before.isIndex, totalUrls: before.totalUrls, children: before.children },
        after: { isIndex: after.isIndex, totalUrls: after.totalUrls, children: after.children },
        note: accepted
          ? contentChanged
            ? "Sitemap rebuilt and the URL set changed (see before vs after totals)."
            : "Sitemap rebuild accepted; URL counts are unchanged (lastmod always bumps, so that alone is not treated as a change)."
          : `Unexpected HTTP ${res.httpStatus} from sitemap.php?create.`,
      };
    },
  },
  {
    name: "horoshop_admin_sitemap_status",
    title: "Read the store's XML sitemap (index + child URL counts)",
    description:
      "Read the store's public `/sitemap.xml` without touching anything. Handles BOTH flavours: a `<sitemapindex>` (reports each child sitemap, its `lastmod`, and how many `<url>` entries it holds) and a flat `<urlset>` (reports the single sitemap's own `<url>` count, no recursion). Use it to check the sitemap's health, or to capture a 'before' snapshot around a horoshop_admin_sitemap_regenerate call.",
    inputSchema: { ...storeField },
    annotations: { readOnlyHint: true },
    handler: async (client, args) => {
      const s = await readSitemap(client, args.store);
      return {
        store: args.store,
        httpStatus: s.httpStatus,
        isIndex: s.isIndex,
        isUrlset: s.isUrlset,
        indexBytes: s.indexBytes,
        childCount: s.children.length,
        totalUrls: s.totalUrls,
        children: s.children,
        ...(s.isIndex ? {} : { note: "Flat <urlset> — a single sitemap, not an index. totalUrls counts its own <url> entries." }),
      };
    },
  },
];
