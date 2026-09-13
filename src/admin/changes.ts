import { createHash } from "node:crypto";
import { z } from "zod";
import { previewValue } from "./payloadFile.js";

/**
 * COMPACT DIFFS + APPEND/PREPEND for the admin writers.
 *
 * Two ergonomics defects from the live multilingual rollout, both about the SIZE
 * of what travels through the conversation:
 *
 * 1. THE TRIPLE ECHO. Every verify-by-re-read writer answered with `from`, `to`
 *    AND `now` per field. On a ~4 KB `seo_text` that is ~12 KB of body plus JSON
 *    escaping — ≈28 KB for ONE call, ≈400 KB across a 15-preset rollout. The
 *    operator had to push the whole rollout into a subagent purely so the heavy
 *    answers would settle there. Nothing in those three copies was information:
 *    on success they are the same string three times.
 *    So: SHORT values (≤ LONG_VALUE) are still echoed verbatim — they are cheap
 *    and genuinely useful. LONG values collapse to a marker (length + tail +
 *    sha256) on SUCCESS, and to an actionable mismatch report (expected vs actual
 *    preview + the first differing offset) on FAILURE. `verbose:true` restores
 *    the full from→to→now diff byte for byte.
 *
 * 2. NO APPEND. Adding one block to the end of a 4 KB `seo_text` meant sending
 *    the whole author text back inline: retyping 4 KB of Cyrillic HTML per
 *    preset, with a real chance of corrupting someone else's content on a live
 *    client store. The writers already do a read-modify-write, so the current
 *    value is in hand — `append` / `prepend` just splice a delta onto it.
 */

/** Values longer than this are summarised instead of echoed three times. */
export const LONG_VALUE = 200;

/** The `verbose` switch, identical wording on every writer that compacts. */
export const verboseField = z
  .boolean()
  .optional()
  .describe(
    "Default false: long field values (>200 chars, e.g. a 4 KB seo_text) are summarised in the answer — on success as {length, tail, sha256} instead of the same string echoed as from+to+now, on failure as expected/actual previews plus the first differing offset. Set true to get the full from→to→now diff for every field (heavy: ~3× the field size per field).",
  );

/** Appended to `note` whenever something in the answer was summarised. */
export const COMPACT_NOTE =
  "Long values summarised (length/tail/sha256 instead of from+to+now) — pass verbose:true for the full diff.";

const strLen = (v: unknown): number | null => (typeof v === "string" ? v.length : null);

function isLong(v: unknown): boolean {
  return typeof v === "string" && v.length > LONG_VALUE;
}

/** Stable short fingerprint — two calls can be compared without shipping the text. */
export function shortHash(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex").slice(0, 12);
}

/** One long value → the marker that proves WHAT was written without shipping it. */
export function valueMarker(s: string): { length: number; tail: string; sha256: string } {
  return { length: s.length, tail: s.slice(-60), sha256: shortHash(s) };
}

/** Index of the first differing character, or -1 when the strings are equal. */
export function firstDifference(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

/** The keys a change record may carry a full field value under. */
const VALUE_KEYS = ["from", "to", "now", "delta", "value", "current", "result"] as const;

/**
 * PREVIEW (dryRun) compaction: the caller has NOT written anything yet and wants
 * to eyeball what will be written, so every long value keeps a head+tail window
 * (`previewValue`) rather than collapsing to a hash.
 */
export function compactPreview<T extends Record<string, any>>(c: T, verbose = false): T {
  if (verbose) return c;
  const out: Record<string, any> = { ...c };
  for (const k of VALUE_KEYS) if (typeof out[k] === "string") out[k] = previewValue(out[k]);
  return out as T;
}

/**
 * VERIFIED (dryRun:false) compaction — the fix for the triple echo.
 *
 * Success is a one-line fact: it persisted, here is its length/tail/fingerprint.
 * Failure keeps every bit of diagnostic value: what was expected, what is
 * actually stored, and where the two first diverge — because "did not persist"
 * with no detail is exactly the answer that wastes the next round-trip.
 */
export function compactVerified<T extends Record<string, any>>(c: T, verbose = false): Record<string, any> {
  if (verbose) return c;
  const { from, to, now } = c as { from?: unknown; to?: unknown; now?: unknown };
  if (![from, to, now].some(isLong)) return c;

  const rest: Record<string, any> = { ...c };
  delete rest.from;
  delete rest.to;
  delete rest.now;
  const lengths = { from: strLen(from), to: strLen(to), now: strLen(now) };

  if (c.persisted === true) {
    return { ...rest, compacted: true, lengths, value: valueMarker(String(to ?? "")) };
  }

  const expected = typeof to === "string" ? to : "";
  const actual = typeof now === "string" ? now : null;
  const at = actual === null ? -1 : firstDifference(expected, actual);
  return {
    ...rest,
    compacted: true,
    lengths,
    expected: previewValue(expected),
    actual: actual === null ? null : previewValue(actual),
    ...(at >= 0
      ? {
          firstDifferenceAt: at,
          differenceContext: {
            expected: expected.slice(Math.max(0, at - 40), at + 40),
            actual: (actual ?? "").slice(Math.max(0, at - 40), at + 40),
          },
        }
      : {}),
  };
}

/** True when at least one entry came back summarised (drives the note). */
export function wasCompacted(list: Array<Record<string, any>>): boolean {
  return list.some((c) => c && c.compacted === true);
}

// ---------------------------------------------------------------------------
// APPEND / PREPEND
// ---------------------------------------------------------------------------

export interface SpliceInput {
  /** The value currently stored (read from the form — this IS the read half of RMW). */
  current: string;
  append?: string;
  prepend?: string;
}

/** prepend + current + append. Nothing else is touched — no trimming, no separator. */
export function splice({ current, append, prepend }: SpliceInput): string {
  return `${prepend ?? ""}${current}${append ?? ""}`;
}

/**
 * Refuse a field that is targeted by BOTH `set` and `append`/`prepend`.
 * A silent precedence rule here would be the worst kind of trap: the caller
 * cannot tell from the answer which one won.
 */
export function assertNoSpliceConflict(
  setKeys: Iterable<string>,
  spliceKeys: Iterable<string>,
  label = "set",
): void {
  const s = new Set(setKeys);
  const clash = [...spliceKeys].filter((k) => s.has(k));
  if (clash.length) {
    throw new Error(
      `${clash.join(", ")} given BOTH in \`${label}\` and in \`append\`/\`prepend\`. They are mutually exclusive per field — \`${label}\` REPLACES the value, append/prepend splice onto the stored one. Pick one.`,
    );
  }
}

/** Shared wording for the append/prepend schema fields. */
export const appendDescription = (what: string) =>
  `APPEND to the end of the STORED value instead of replacing it: ${what}. The tool already read-modify-writes, so it reads the current value, glues your delta onto it verbatim (no separator, no trimming) and writes the result — you never have to resend the existing text (a 4 KB seo_text stays where it is, untouched and unrecoded). Mutually exclusive with the replacing field for the SAME field (both = error, never a silent winner). Works with dryRun: the preview shows length before → after plus a head/tail window of the result.`;

export const prependDescription = (what: string) =>
  `PREPEND to the START of the STORED value instead of replacing it: ${what}. Same mechanics and the same mutual exclusion as \`append\`.`;
