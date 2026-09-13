/**
 * Outbound redaction for admin config payloads.
 *
 * The design "application JSON" is not only design: alongside colours and blocks
 * it carries the store's live payment credentials (`payment.liqPay_Horoshop.private_key`,
 * `payment.PayPalREST.live.clientSecret`, …). A tool called "read design config"
 * must never hand those to a model: they end up in transcripts, MCP logs and on
 * disk when the caller saves the response.
 *
 * TWO RULES, and the second one is the dangerous one to get wrong:
 *
 *  1. Redaction is an OUTPUT filter only. `redactSecrets` deep-CLONES; it never
 *     mutates its input. The read-modify-write path (design_set) must merge into
 *     the RAW json — merging a redacted copy would write the mask string back and
 *     destroy the client's real payment keys. Never feed a redacted object to a save.
 *
 *  2. A masked string keeps its length (`•••• (40 chars)`), the same contract as
 *     adminPrro.ts, so a caller can still tell "set" from "empty" and diff a
 *     before/after without ever seeing the value.
 */

/** Keys whose string values are credentials. Matched case-insensitively, anywhere in the key. */
export const SECRET_KEY_RE = /key|token|secret|password|signature|apikey|private/i;

/** Mask a secret for output: never the value, only "set?" + length. */
export function maskSecret(raw: string): string {
  return raw ? `•••• (${raw.length} chars)` : "(empty)";
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Horoshop marks a config value that actually lives in the general settings as
 * `{"source":"db","field_name":"…"}` — a POINTER, not a credential. `novaposhta_api.api_key`
 * is exactly this on every store checked, so matching the key name alone would
 * mask a field name and tell the caller nothing. Pointers are left readable.
 */
function isDbPointer(v: unknown): boolean {
  return isObject(v) && typeof v.source === "string" && "field_name" in v;
}

/**
 * Deep-clone `value`, masking every string that sits under a secret-looking key.
 * A secret-looking key that holds an object masks the whole subtree (a credential
 * bag like `{live:{clientSecret}}` must not leak through an inner key that happens
 * to look innocent) — except for `{source:"db"}` pointers.
 */
export function redactSecrets(value: unknown, inSecret = false): unknown {
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, inSecret));
  if (isObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const secret = inSecret || (SECRET_KEY_RE.test(k) && !isDbPointer(v));
      out[k] = redactSecrets(v, secret);
    }
    return out;
  }
  if (inSecret && typeof value === "string") return maskSecret(value);
  return value;
}

/** Sections never returned by design tools: they are credentials, not design. */
export const REDACTED_SECTIONS = new Set(["payment"]);

export const REDACTED_SECTION_MARKER =
  "[redacted — payment credentials are never returned by design tools]";
