/**
 * Which of a store's languages are ENABLED, read from the languages grid
 * (handler 339), whose row cells are [sortorder, enabled(Да/Нет), code].
 *
 * Shared by two callers:
 *  - `admin_page_get` — to flag that a DISABLED language's title/text is usually
 *    Horoshop platform demo content ("This is demo store"), not real data.
 *  - `catalog_import` — to warn (FIX #3) that an i18n cell written to a
 *    disabled language is SILENTLY DROPPED by Horoshop (it answers OK but persists
 *    nothing, and export never returns the cell until the language is enabled).
 *
 * Cached briefly per store: on/off state changes rarely and a bulk read must not
 * refetch it on every record.
 */

/** The language codes Horoshop stores under a numeric index (ru=1, ua=3, …). */
export const LANG_CODES = new Set(["ua", "ru", "en", "pl", "ro"]);

const LANG_STATE_TTL_MS = 300_000;
const langStateCache = new Map<string, { states: Record<string, boolean>; ts: number }>();

/** A grid "enabled" cell → boolean, tolerant of the ru/ua/en admin locales. */
function parseEnabledCell(cell: string): boolean | null {
  const c = cell.trim().toLowerCase();
  if (["да", "так", "yes", "1", "on", "enabled", "вкл"].includes(c)) return true;
  if (["нет", "ні", "no", "0", "off", "disabled", "выкл", "викл"].includes(c)) return false;
  return null;
}

/**
 * Map of language code → enabled(bool) for a store, e.g. {ua:true, ru:true,
 * en:false}. A code is present only when the grid gave a readable on/off cell for
 * it; a language the grid does not mention is simply absent (callers treat
 * "absent" as "unknown", never as disabled). Returns `{}` if the grid is
 * unreadable on this store/account — the caller degrades gracefully rather than
 * failing the read/write.
 */
export async function languageStates(
  client: any,
  store: string | undefined,
): Promise<Record<string, boolean>> {
  const key = store ?? "(default)";
  const hit = langStateCache.get(key);
  if (hit && Date.now() - hit.ts < LANG_STATE_TTL_MS) return hit.states;
  const states: Record<string, boolean> = {};
  try {
    const rows = await client.admin.listRecords(store, 339);
    for (const r of rows as Array<{ cells?: string[] }>) {
      const cells = Array.isArray(r.cells) ? r.cells : [];
      const code = cells.map((c) => c.trim().toLowerCase()).find((c) => LANG_CODES.has(c));
      if (!code) continue;
      let enabled: boolean | null = null;
      for (const c of cells) {
        const e = parseEnabledCell(c);
        if (e !== null) {
          enabled = e;
          break;
        }
      }
      if (enabled !== null) states[code] = enabled;
    }
  } catch {
    // Languages grid unreadable on this store/account — omit the flag rather than fail.
  }
  langStateCache.set(key, { states, ts: Date.now() });
  return states;
}

// ---------------------------------------------------------------------------
// WHICH LANGUAGE A GRID LABEL IS WRITTEN IN
// ---------------------------------------------------------------------------

/**
 * `admin_list` labels come from the datagrid's own cells, and the grid renders
 * an i18n column in ONE language — so a record whose Russian is already written
 * still shows its Ukrainian title, and reads as "not translated yet". That cost
 * real data: the operator overwrote a sticker that already held correct Russian,
 * and another whose text was the template `−{DISCOUNT_PERCENT}%`.
 *
 * WHICH language, measured rather than assumed: the admin chrome carries
 * `window.LANGUAGE` (the panel's own UI language, `uk|ru|en|…`) next to
 * `FIRST_LANGUAGE`/`SYSTEM_LANGUAGE` (the store's primary language index). The
 * grid follows `window.LANGUAGE`, NOT the first language - proven on one store,
 * where FIRST_LANGUAGE=3 (ua) while `window.LANGUAGE='ru'` and the benefits grid
 * shows the Russian titles; on another `window.LANGUAGE='uk'` and the same
 * grid shows Ukrainian. Reading the store's language list would therefore have
 * reported the wrong language on half the stores tested.
 *
 * Cost: ONE cached GET of an admin page per store — never a per-record fetch.
 * The grid gives no per-row language data, so N extra requests would be the only
 * alternative, and this answer (which language you are looking at) is what
 * actually prevents the mistake.
 */
export interface GridLabelLanguage {
  /** Language code of the label text (ua/ru/en/pl/ro), or null when unreadable. */
  code: string | null;
  /** Raw `window.LANGUAGE` value as the admin spells it (uk, ru, …). */
  raw: string | null;
  /** The store's first/primary language code, when the page declares it. */
  firstLanguage: string | null;
}

/** The admin spells Ukrainian "uk"; Horoshop's i18n indices call it "ua". */
const UI_LANG_ALIASES: Record<string, string> = { uk: "ua", ua: "ua", ru: "ru", en: "en", pl: "pl", ro: "ro" };
const INDEX_TO_CODE: Record<string, string> = { "1": "ru", "3": "ua", "4": "en", "5": "pl", "6": "ro" };

const gridLangCache = new Map<string, { value: GridLabelLanguage; ts: number }>();
const GRID_LANG_TTL_MS = 600_000;

/** Pull the language markers out of an admin chrome page. Exported for tests. */
export function parseAdminLanguageMarkers(html: string): GridLabelLanguage {
  const raw = /window\.LANGUAGE\s*=\s*['"]([a-z-]+)['"]/i.exec(html)?.[1]?.toLowerCase() ?? null;
  const firstIdx = /FIRST_LANGUAGE:\s*(\d+)/.exec(html)?.[1] ?? /SYSTEM_LANGUAGE:\s*(\d+)/.exec(html)?.[1] ?? null;
  return {
    code: raw ? (UI_LANG_ALIASES[raw] ?? raw) : null,
    raw,
    firstLanguage: firstIdx ? (INDEX_TO_CODE[firstIdx] ?? null) : null,
  };
}

/**
 * Language of the datagrid's label text for a store. Cached per store; a store
 * whose admin page cannot be read returns nulls and the caller simply omits the
 * flag rather than guessing.
 */
export async function gridLabelLanguage(
  client: any,
  store: string | undefined,
  handler: number,
): Promise<GridLabelLanguage> {
  const key = store ?? "(default)";
  const hit = gridLangCache.get(key);
  if (hit && Date.now() - hit.ts < GRID_LANG_TTL_MS) return hit.value;
  let value: GridLabelLanguage = { code: null, raw: null, firstLanguage: null };
  try {
    const { html } = await client.admin.getAdminHtml(store, `/adminLegacy/data.php?handler=${handler}`);
    value = parseAdminLanguageMarkers(html);
  } catch {
    // Chrome page unreadable — report nothing rather than a guess.
  }
  gridLangCache.set(key, { value, ts: Date.now() });
  return value;
}
