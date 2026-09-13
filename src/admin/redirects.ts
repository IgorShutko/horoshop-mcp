/**
 * REDIRECT SAFETY — the guards that stand between a bulk write and a broken store.
 *
 * A Horoshop 301 is not a `from → to` pair: it binds an OLD uri to an EXISTING
 * record, and the destination is whatever that record's canonical URL happens to
 * be. That shape makes three mistakes very easy, and the platform stops exactly
 * ONE of them. Measured live on a test store:
 *
 *  - DUPLICATES ARE ACCEPTED. `create` with a uri that already redirects answers
 *    `OK` and hands back a second history_id — twice for the SAME target, and
 *    again for a DIFFERENT one. Three redirects from `/zz6-a`, two of them
 *    pointing at different pages, all created without a murmur. `update` is no
 *    better: pointing an existing redirect at `/katalog`, which already
 *    redirected elsewhere, also answered `OK`. Whichever row the platform then
 *    picks is a coin toss the operator never sees.
 *  - THE SELF-LOOP IS the one case the platform catches: creating a redirect
 *    whose old uri equals the target's own current URL answers
 *    `WARNING: "Старе посилання не може бути таким самим, як і нове."` and
 *    creates nothing. We still check it client-side, because a warning that
 *    arrives after a 200-item batch has already half-run is not a guard.
 *  - CHAINS ARE NOT CHECKED AT ALL. Nothing stops A→B while B→A already exists;
 *    the browser then bounces until it gives up (`ERR_TOO_MANY_REDIRECTS`), and
 *    the page is simply gone for buyers and crawlers alike.
 *
 * So the rule here is: refuse BEFORE the write, name the row that conflicts, and
 * let the caller override deliberately with `force` rather than discover the
 * damage in Search Console three weeks later.
 */

/** One redirect as it exists in the store. */
export interface RedirectRow {
  /** history_id — the only handle `update` / `delete` accept. */
  historyId: string;
  /** The OLD uri that 301s (the "from"). */
  from: string;
  /** Target entity type (4 = pages & categories, 17 = products, 349 = brands…). */
  handler: string;
  /** Target record id. */
  record: string;
  /** The target record's CURRENT canonical URL — where the 301 actually lands. */
  to: string;
  title: string;
}

/** A target record the redirects screen lists, whether or not it has redirects. */
export interface RedirectTargetRow {
  handler: string;
  record: string;
  title: string;
  url: string;
  redirectCount: number;
}

/** What the caller wants created, after target resolution. */
export interface PlannedRedirect {
  from: string;
  handler: string;
  record: string;
  /** Destination URL, for loop checks and the human-readable preview. */
  to: string;
  title?: string;
}

export type Verdict =
  | { ok: true }
  | { ok: false; problem: "duplicate" | "duplicate-in-batch" | "self-loop" | "chain-loop" | "unknown-target"; detail: string };

/**
 * Normalise an old-URI argument WITHOUT being clever about slashes.
 *
 * A trailing slash is not noise here — it is the whole point of half these
 * redirects (`/pro-nas` → `/pro-nas/`), and the platform matches the old uri
 * EXACTLY. So this only fixes what is unambiguously a typo: surrounding
 * whitespace, a full absolute URL pasted from a browser, and a missing leading
 * slash. Anything it changes is reported back, never applied silently.
 */
export function normaliseUri(raw: string): { uri: string; note?: string } {
  const trimmed = String(raw).trim();
  if (trimmed === "") return { uri: "", note: "empty" };
  let uri = trimmed;
  const notes: string[] = [];
  if (/^https?:\/\//i.test(uri)) {
    try {
      const u = new URL(uri);
      uri = u.pathname + u.search;
      notes.push(`absolute URL reduced to its path ("${trimmed}" → "${uri}")`);
    } catch {
      /* leave it alone; the caller will see the raw value in the plan */
    }
  }
  if (!uri.startsWith("/")) {
    uri = "/" + uri;
    notes.push(`leading slash added ("${trimmed}" → "${uri}")`);
  }
  return notes.length ? { uri, note: notes.join("; ") } : { uri };
}

/** Same URL up to a trailing slash — used to explain near-misses, never to match. */
function slashless(u: string): string {
  return u.length > 1 && u.endsWith("/") ? u.slice(0, -1) : u;
}

/**
 * Resolve a destination URL to the record that owns it.
 *
 * The agency thinks in "`/old` should go to `/new`"; the platform thinks in
 * handler+record. Every row of the redirects screen carries its record's current
 * URL, so this mapping is exact and free — no guessing, no extra request.
 */
export function resolveTargetByUrl(
  targets: RedirectTargetRow[],
  to: string,
): { ok: true; target: RedirectTargetRow } | { ok: false; detail: string } {
  const wanted = normaliseUri(to).uri;
  const exact = targets.filter((t) => t.url === wanted);
  if (exact.length === 1) return { ok: true, target: exact[0] };
  if (exact.length > 1) {
    return {
      ok: false,
      detail: `"${wanted}" matches ${exact.length} records (${exact.map((t) => `${t.handler}:${t.record}`).join(", ")}) — pass handler+record explicitly.`,
    };
  }
  const near = targets.filter((t) => slashless(t.url) === slashless(wanted));
  if (near.length === 1) {
    return {
      ok: false,
      detail: `No record has the URL "${wanted}". The closest is "${near[0].url}" (${near[0].handler}:${near[0].record}, «${near[0].title}») — the trailing slash differs, and Horoshop stores the canonical URL WITH its suffix. Use "${near[0].url}" as \`to\`, or pass handler+record.`,
    };
  }
  const sample = targets.slice(0, 8).map((t) => t.url).join(", ");
  return {
    ok: false,
    detail: `No record on the redirects screen has the URL "${wanted}". A redirect can only point at an EXISTING record (page, category, product, brand…), and its destination is that record's own canonical URL — you cannot redirect to an arbitrary address. Known URLs include: ${sample}${targets.length > 8 ? `, … (${targets.length} total)` : ""}. Pass handler+record if you know them.`,
  };
}

/**
 * Vet a batch against the store AND against itself.
 *
 * `existing` is the complete redirect set — complete matters: the screen renders
 * 20 rows per grid page, and a duplicate check that only saw page 1 would wave
 * through exactly the collisions it exists to stop (on the test store that was 16
 * of 35 redirects visible).
 */
export function vetRedirects(
  existing: RedirectRow[],
  planned: PlannedRedirect[],
  opts: { ignoreHistoryId?: string } = {},
): Array<{ plan: PlannedRedirect; verdict: Verdict }> {
  const live = existing.filter((r) => r.historyId !== opts.ignoreHistoryId);
  const byFrom = new Map<string, RedirectRow>();
  for (const r of live) if (!byFrom.has(r.from)) byFrom.set(r.from, r);

  // Destination map for cycle detection: every hop the storefront would take,
  // existing plus proposed. Built once, walked per item.
  const hop = new Map<string, string>();
  for (const r of live) hop.set(r.from, r.to);
  for (const p of planned) hop.set(p.from, p.to);

  const seenInBatch = new Map<string, PlannedRedirect>();
  const out: Array<{ plan: PlannedRedirect; verdict: Verdict }> = [];

  for (const plan of planned) {
    let verdict: Verdict = { ok: true };

    const dup = byFrom.get(plan.from);
    const twin = seenInBatch.get(plan.from);
    if (plan.from === "") {
      verdict = { ok: false, problem: "self-loop", detail: "The old URI is empty. An empty `from` is not a redirect — the widget treats a blank uri as DELETE." };
    } else if (dup) {
      verdict = {
        ok: false,
        problem: "duplicate",
        detail:
          `"${plan.from}" already redirects to "${dup.to}" (history_id ${dup.historyId}, target ${dup.handler}:${dup.record} «${dup.title}»). ` +
          (dup.to === plan.to
            ? "Horoshop would create a SECOND identical row rather than refuse it."
            : `This would create a CONTRADICTION: two live rows sending "${plan.from}" to different pages, and which one wins is not defined. Update history_id ${dup.historyId} instead, or delete it first.`),
      };
    } else if (twin) {
      verdict = {
        ok: false,
        problem: "duplicate-in-batch",
        detail: `"${plan.from}" appears twice in this batch (→ "${twin.to}" and → "${plan.to}"). Keep one.`,
      };
    } else if (plan.from === plan.to) {
      verdict = {
        ok: false,
        problem: "self-loop",
        detail: `"${plan.from}" is already the target's own URL — a redirect onto itself. Horoshop refuses this one too ("Старе посилання не може бути таким самим, як і нове").`,
      };
    } else {
      // Follow the chain. A short bound is plenty: browsers give up around 20,
      // and anything past a couple of hops is a mistake worth reporting anyway.
      const path = [plan.from];
      let cur = plan.to;
      for (let i = 0; i < 10; i++) {
        if (path.includes(cur)) {
          verdict = {
            ok: false,
            problem: "chain-loop",
            detail: `This closes a redirect LOOP: ${[...path, cur].join(" → ")}. A browser following it ends at ERR_TOO_MANY_REDIRECTS and the page is unreachable for buyers and crawlers. Break the chain first (delete or repoint one of the hops).`,
          };
          break;
        }
        const next = hop.get(cur);
        if (next === undefined) break;
        path.push(cur);
        cur = next;
      }
      if (verdict.ok && path.length > 2) {
        // Not fatal, but a chain still costs link equity and a round trip.
        verdict = { ok: true };
      }
    }

    if (verdict.ok) seenInBatch.set(plan.from, plan);
    out.push({ plan, verdict });
  }
  return out;
}

/**
 * Parse a redirect map in the format an agency actually receives it: a CSV/TSV
 * export with one `old,new` pair per line.
 *
 * Horoshop's own «Импорт редиректов» eats exactly this shape — its step-2 screen
 * offers two column roles, "Ссылка источник (откуда)" and "Ссылка назначения
 * (куда)" — but it is a three-request wizard (upload → configure → process) that
 * writes with no duplicate or loop check whatsoever. Reading the file here
 * instead sends the same rows through the guards in this module, which is the
 * whole point.
 *
 * Deliberately forgiving about the delimiter (tab, semicolon or comma — whichever
 * appears first on a line) and about a header row, and deliberately strict about
 * everything else: a line that does not yield two non-empty cells is reported,
 * not skipped silently.
 */
export function parseRedirectFile(text: string): { rows: Array<{ from: string; to: string }>; skipped: string[] } {
  const rows: Array<{ from: string; to: string }> = [];
  const skipped: string[] = [];
  const lines = text.split(/\r?\n/);
  for (const [i, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const sep = ["\t", ";", ","].filter((s) => line.includes(s)).sort((a, b) => line.indexOf(a) - line.indexOf(b))[0];
    if (!sep) {
      skipped.push(`line ${i + 1}: "${line.slice(0, 60)}" — no delimiter (expected tab, ";" or ",").`);
      continue;
    }
    const idx = line.indexOf(sep);
    const from = line.slice(0, idx).trim().replace(/^"|"$/g, "");
    const to = line.slice(idx + 1).split(sep)[0].trim().replace(/^"|"$/g, "");
    if (!from || !to) {
      skipped.push(`line ${i + 1}: "${line.slice(0, 60)}" — needs two non-empty columns (old URL, new URL).`);
      continue;
    }
    // A header row: neither cell looks like a path or a URL.
    const pathish = (s: string) => s.startsWith("/") || /^https?:\/\//i.test(s);
    if (rows.length === 0 && !pathish(from) && !pathish(to)) {
      skipped.push(`line ${i + 1}: treated as a header row ("${from}" / "${to}").`);
      continue;
    }
    rows.push({ from, to });
  }
  return { rows, skipped };
}

/** How many hops a `from` takes before it lands — a chain longer than 1 is worth saying out loud. */
export function chainLength(existing: RedirectRow[], from: string, to: string): string[] {
  const hop = new Map<string, string>();
  for (const r of existing) hop.set(r.from, r.to);
  hop.set(from, to);
  const path = [from];
  let cur = to;
  for (let i = 0; i < 10; i++) {
    path.push(cur);
    const next = hop.get(cur);
    if (next === undefined || path.includes(next)) break;
    cur = next;
  }
  return path;
}
