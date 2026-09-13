/**
 * Transient-network retry, shared by the bulk catalog writer and the admin
 * datagrid walker.
 *
 * Both hit the same failure: a single dropped connection in the middle of a long
 * sequence of requests kills the whole operation. For the catalog that was a
 * ~400 KB POST; for the datagrid it is page 14 of a 26-page walk over the 4000-row
 * interface-translation grid — one `fetch failed` and the caller sees "Network
 * error", never the 4000 rows.
 *
 * A network drop is not deterministic, so it is worth retrying. A Horoshop-level
 * error (`ERROR`, `HTTP_ERROR`, a 401, a validation refusal) IS deterministic and
 * must NOT be retried — repeating it only wastes time and can double a write.
 */

/** True for errors that are worth another attempt (connection-level, not logical). */
export function isRetryableNetworkError(e: unknown): boolean {
  const m = String((e as Error)?.message ?? e).toLowerCase();
  return /network error calling|fetch failed|econnreset|socket hang|other side closed|terminated|und_err|enotfound|eai_again|etimedout|timed out|network|connection/.test(
    m,
  );
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Run `fn`, retrying only transient network failures. Linear backoff
 * (300/600/900 ms). `attempts` counts the FIRST call, so 3 = one call + two
 * retries. Anything non-retryable is rethrown immediately.
 */
export async function withNetworkRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let a = 1; a <= attempts; a++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!isRetryableNetworkError(e) || a === attempts) throw e;
      await sleep(300 * a);
    }
  }
  throw lastErr;
}
