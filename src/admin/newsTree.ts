import type { GridRow } from "./form.js";

/**
 * Blog / news rubric plumbing — the reverse-engineered truth about h_news.parent.
 *
 * A news article's RUBRIC (which section it lists under: «Блог», «Новини», a
 * policy page…) is the `h_news.parent` column. The whole class of "the article
 * always lands in the wrong rubric / can't be moved / delete can't find it" bugs
 * came from three facts that are only visible once you probe the live admin:
 *
 *  1. The rubric is set by the `names[parent]` VALUE in the save.php POST. On
 *     create, `edit.php?id=addnew&parent=R` seeds the names[parent] <select> to R;
 *     submitting it stores rubric R. An explicit names[parent]=R override is
 *     authoritative regardless of the seed (proven: seed 1001, override 686 →
 *     article landed in 686).
 *  2. The edit form's names[parent] <select> is re-seeded from the URL `&parent=`
 *     (defaulting to the store's first blog node when absent) and does NOT reflect
 *     the stored rubric. So reading it back is a lie, and a read-modify-write that
 *     blindly RESENDS it silently MOVES the article to that default rubric.
 *     OMITTING names[parent] from the POST preserves the stored rubric (proven).
 *  3. The only truthful read of the rubric is the admin datagrid: a parent-scoped
 *     `data.php?handler=172&parent=R` reload lists exactly the articles in rubric
 *     R, and each row's second cell is the rubric's title. (A no-parent reload is
 *     stateful server-side — it returns whichever rubric the session last touched —
 *     so it is not a reliable "all articles" read within a reused session.)
 *
 * These helpers give the blog tools (and the generic delete) a truthful rubric:
 * discover the store's «Блог» node by title, check an article's rubric via the
 * grid, and resolve an id's rubric by scanning the page-tree nodes.
 */

/** Handler / table for blog & news articles. Same across stores; ids are per-store. */
export const NEWS_HANDLER = 172;

/** A page-tree node whose title reads as the blog/news listing rubric. */
const BLOG_TITLE_RE = /(^|\b)(блог|blog|blogul)($|\b)/i;

/** Cache of the resolved «Блог» node id per store (the page tree is stable within a run). */
const blogNodeCache = new Map<string, number>();

export interface PageNode {
  id: number;
  parent: number;
  /** All available language titles joined, primary (ua) first. */
  title: string;
  /** The primary-language title alone, for exact matching. */
  primary: string;
}

/** Every page-tree node from the documented `pages/export` API ({id, parent, title}). */
export async function pageTreeNodes(client: any, store: string | undefined): Promise<PageNode[]> {
  const body = await client.call(store, "pages/export", {});
  const arr: any[] = body?.response?.pages ?? (Array.isArray(body?.response) ? body.response : []);
  return arr.map((p) => {
    const t = p.title ?? {};
    const primary = String(t.ua ?? t.ru ?? t.en ?? t.ro ?? p.id);
    const title = [t.ua, t.ru, t.en, t.ro].filter(Boolean).map(String).join(" | ") || String(p.id);
    return { id: Number(p.id), parent: Number(p.parent ?? 0), title, primary };
  });
}

/**
 * Resolve the store's «Блог» listing node — the rubric a new article should
 * default into. The node id is PER-STORE (1001 on the test store, others differ), so a
 * hardcoded default lands articles in whatever section that id happens to be on a
 * different store (the original bug: 1001 is «Політика» on some stores). Discover
 * it by title from the page tree instead; fall back to `fallback` when no
 * blog-titled node exists. Cached per store.
 */
export async function resolveBlogNode(client: any, store: string | undefined, fallback: number): Promise<number> {
  const key = store ?? "(default)";
  const cached = blogNodeCache.get(key);
  if (cached !== undefined) return cached;
  let node = fallback;
  try {
    const nodes = await pageTreeNodes(client, store);
    const exact = nodes.find((n) => /^(блог|blog|blogul)$/i.test(n.primary.trim()));
    const loose = nodes.find((n) => BLOG_TITLE_RE.test(n.title));
    if (exact) node = exact.id;
    else if (loose) node = loose.id;
  } catch {
    /* keep fallback — pages/export unavailable */
  }
  blogNodeCache.set(key, node);
  return node;
}

/**
 * Is article `id` currently in rubric `parent`? Authoritative check via the admin
 * grid (the edit form's names[parent] does not reflect storage — see the module
 * note). Returns true when the parent-scoped grid contains the id.
 */
export async function articleInRubric(
  client: any,
  store: string | undefined,
  handler: number,
  id: string | number,
  parent: number,
): Promise<boolean> {
  const rows: GridRow[] = await client.admin.listRecords(store, handler, { parent });
  return rows.some((r) => String(r.id) === String(id));
}

/**
 * Resolve each article id's real rubric (h_news.parent) by scanning the page-tree
 * nodes' parent-scoped grids — the deterministic read of the rubric. Returns a map
 * of the ids that were found to `{ parent, label }`; ids not under any node are
 * simply absent (the caller treats them as not-found). `preferParents` (the blog
 * node, a caller hint) are scanned first so the common case exits after one grid
 * read; scanning stops early once every wanted id is located.
 */
export async function resolveNewsRubrics(
  client: any,
  store: string | undefined,
  handler: number,
  ids: Array<string | number>,
  preferParents: number[] = [],
): Promise<Map<string, { parent: number; label: string }>> {
  const wanted = new Set(ids.map(String));
  const found = new Map<string, { parent: number; label: string }>();
  if (wanted.size === 0) return found;

  const nodes = await pageTreeNodes(client, store).catch(() => [] as PageNode[]);
  const order = [...new Set([...preferParents, ...nodes.map((n) => n.id)])].filter((n) => Number.isFinite(n) && n > 0);

  for (const p of order) {
    if (found.size === wanted.size) break;
    let rows: GridRow[];
    try {
      rows = await client.admin.listRecords(store, handler, { parent: p });
    } catch {
      continue;
    }
    for (const r of rows) {
      const key = String(r.id);
      if (wanted.has(key) && !found.has(key)) found.set(key, { parent: p, label: r.label });
    }
  }
  return found;
}
