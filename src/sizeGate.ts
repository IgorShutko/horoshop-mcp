import { z } from "zod";

/**
 * THE RESPONSE SIZE GATE — one threshold for every reading tool (D2).
 *
 * `catalog_export` grew this mechanism first, for a good reason: a 100-product
 * raw export is ~6.9 MB and 111 KB is what already overflowed one conversation.
 * A "SIZE FIRST" paragraph in a tool description does not help, because the
 * description is read AFTER the payload has already landed in the context.
 *
 * It stayed the ONLY tool with a gate, and the scale run measured what that
 * costs on a real store — with no argument at all:
 *
 *   admin_list entity=interface_translation   1 293 KB   (~330k tokens)
 *   admin_list entity=orders                  1 090 KB
 *   orders_get limit:100                        239 KB
 *   admin_record_get site_settings              187 KB
 *
 * So the check lives here now and `registerTools` applies it to every read-only
 * tool, measuring EXACTLY the text the transport is about to send. A refusal is
 * a normal (successful) answer, not an error: it carries the measured size, the
 * limit, and the narrowing arguments OF THAT TOOL, so the fix is one obvious
 * call away and the mis-scoped read costs one short answer instead of the whole
 * conversation. `allowLarge:true` forces the payload through.
 */

/** Bytes of the pretty-printed answer — the same serialisation registerTools sends. */
export function answerBytes(payload: unknown): number {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return Buffer.byteLength(text, "utf8");
}

/** Default ceiling. Measured, not guessed: 111 KB is what overflowed once. */
export const DEFAULT_MAX_BYTES = 100_000;

/**
 * The active limit. `HOROSHOP_MAX_RESPONSE_BYTES` is the general knob;
 * `HOROSHOP_EXPORT_MAX_BYTES` is honoured too because it was the documented one
 * before the gate became general — an operator who set it keeps their setting.
 */
export function responseSizeLimit(): number {
  for (const key of ["HOROSHOP_MAX_RESPONSE_BYTES", "HOROSHOP_EXPORT_MAX_BYTES"]) {
    const v = Number(process.env[key]);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return DEFAULT_MAX_BYTES;
}

/** Shared input field so every gated tool has the same escape hatch. */
export const allowLargeField = {
  allowLarge: z
    .boolean()
    .optional()
    .describe(
      "Default false. The answer is MEASURED before it is returned, and a payload over the size limit (default 100 KB, override with HOROSHOP_MAX_RESPONSE_BYTES) is REFUSED with its measured size and how to narrow it, instead of overflowing the conversation. Set true to get the whole thing anyway.",
    ),
};

/** True for a payload that is already a gate refusal (do not gate it twice). */
export function isSizeRefusal(payload: unknown): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as Record<string, unknown>).error === "RESPONSE_TOO_LARGE"
  );
}

/**
 * Arguments that actually make an answer smaller. Used to build the hint from
 * the tool's OWN schema, so the advice is never the useless "narrow your query"
 * — it names the parameters this specific tool accepts.
 */
const NARROWING_ARGS = [
  "limit",
  "offset",
  "page",
  "perPage",
  "maxRows",
  "search",
  "searchColumn",
  "ids",
  "from",
  "to",
  "status",
  "parent",
  "includedParams",
  "excludedParams",
  "lite",
  "fields",
  "query",
  "prefix",
  "lang",
];

export function narrowingArgsOf(inputSchema: Record<string, unknown>): string[] {
  return NARROWING_ARGS.filter((k) => k in inputSchema);
}

export interface SizeRefusal {
  error: "RESPONSE_TOO_LARGE";
  oversized: true;
  tool?: string;
  measuredBytes: number;
  limitBytes: number;
  note: string;
  [k: string]: unknown;
}

/**
 * Build the refusal payload. `hint` is the tool-specific sentence telling the
 * caller which of ITS arguments to use; `extra` carries whatever measured facts
 * the tool can add (row counts, bytes per row, the fields it would have held).
 */
export function sizeRefusal(opts: {
  tool?: string;
  bytes: number;
  limit: number;
  hint: string;
  extra?: Record<string, unknown>;
}): SizeRefusal {
  return {
    error: "RESPONSE_TOO_LARGE",
    oversized: true,
    ...(opts.tool ? { tool: opts.tool } : {}),
    ...(opts.extra ?? {}),
    measuredBytes: opts.bytes,
    limitBytes: opts.limit,
    note:
      `NOTHING WAS RETURNED — this answer measured ${Math.round(opts.bytes / 1024)} KB (limit ${Math.round(
        opts.limit / 1024,
      )} KB), which would bury the conversation instead of answering the question. ` +
      `${opts.hint} ` +
      `The read itself succeeded and cost nothing extra; nothing was written. Pass allowLarge:true to force the full payload, or raise HOROSHOP_MAX_RESPONSE_BYTES.`,
  };
}

/**
 * The narrowing advice. A FUNCTION when the useful advice depends on what was
 * actually measured — "limit:30 fits" is a lie on a store whose orders are 4 KB
 * each, and a wrong number costs the caller another oversized round-trip. The
 * tools that can count their own rows compute the figure from the measurement.
 */
export type NarrowHint =
  | string
  | ((ctx: { payload: unknown; bytes: number; limit: number; args: Record<string, unknown> }) => string);

/** How many items of `count` fit under the limit, with 10 % headroom. */
export function fittingCount(count: number, bytes: number, limit: number): number {
  if (count <= 0 || bytes <= 0) return 1;
  const per = bytes / count;
  return Math.max(1, Math.floor((limit * 0.9) / per));
}

/**
 * Gate an already-built payload. Returns the payload untouched when it fits (or
 * when the caller opted out), and the refusal when it does not.
 */
export function gateSize<T>(
  payload: T,
  opts: {
    tool?: string;
    allowLarge?: boolean;
    hint: NarrowHint;
    args?: Record<string, unknown>;
    extra?: Record<string, unknown>;
  },
): T | SizeRefusal {
  if (opts.allowLarge === true || isSizeRefusal(payload)) return payload;
  const limit = responseSizeLimit();
  const bytes = answerBytes(payload);
  if (bytes <= limit) return payload;
  const hint =
    typeof opts.hint === "function"
      ? opts.hint({ payload, bytes, limit, args: opts.args ?? {} })
      : opts.hint;
  return sizeRefusal({ tool: opts.tool, bytes, limit, hint, extra: opts.extra });
}
