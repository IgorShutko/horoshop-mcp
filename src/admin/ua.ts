/**
 * Browser User-Agent for every request this server makes to a store, admin
 * panel and storefront alike.
 *
 * Stores sit behind a bot filter that does not answer with an error: on
 * one live store a UA-less admin login returned HTTP 200 with
 * `{user:{logged:false}}` and no session cookie — indistinguishable from a
 * wrong password — while the identical request carrying this header logged in.
 * A short "Mozilla/5.0" is not enough; the filter wants a full browser string.
 */
export const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
