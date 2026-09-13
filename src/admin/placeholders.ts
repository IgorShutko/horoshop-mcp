import { z } from "zod";

/**
 * STOREFRONT TEMPLATE TOKENS — the guard against overwriting a template with a
 * constant.
 *
 * THE INCIDENT. A sticker's front title on a live store read
 * `−{DISCOUNT_PERCENT}%`: Horoshop substitutes each product's own discount
 * into it at render time. Translating the shop, the operator saw a Ukrainian-
 * looking string in `admin_list`, wrote a plain Russian replacement over it, and
 * the token was gone. Nothing errored, nothing looked broken — every product
 * simply started showing the same frozen text where its own percentage belonged.
 * That is the worst shape of data loss: silent, wide (every product carrying the
 * sticker) and invisible in the answer, because the write "succeeded".
 *
 * THE RULE. Losing a token is never something the caller can do by accident:
 *  - dryRun says which tokens the new value drops (`placeholderWarnings`);
 *  - a real write is REFUSED unless `allowPlaceholderLoss:true` says it is meant.
 * Keeping the token — the normal case, e.g. translating the text around it — is
 * silent. A guard that fires on ordinary work would just be trained away.
 *
 * WHAT COUNTS AS A TOKEN. Two families, both taken from Horoshop's own docs
 * rather than invented here:
 *  - UPPERCASE/underscored inside braces — the storefront substitutions:
 *    {DISCOUNT_PERCENT}, {COUNTDOWN_INFO}, {MONOBANK_PARTS}, {PARTS} …
 *    Read structurally (any {UPPER_SNAKE} matches), so a token this list has
 *    never seen is still protected.
 *  - the documented lowercase SEO-template variables, matched EXACTLY: {title},
 *    {site}, {price}, {brand}… A structural lowercase rule would fire on any
 *    brace in body HTML/CSS, so those are an explicit closed set.
 */

/** Any {UPPER_SNAKE_TOKEN} — the storefront substitution family, read by shape. */
const UPPER_TOKEN_RE = /\{[A-Z][A-Z0-9_]*\}/g;

/** Any {word} candidate, checked against KNOWN_LOWER_TOKENS below. */
const BRACED_WORD_RE = /\{[A-Za-z][A-Za-z0-9_.]*\}/g;

/**
 * The lowercase template variables Horoshop documents for SEO templates, sticker
 * text and filter presets. Exact match only — `{color}` is a token, `{color:red}`
 * (a CSS rule inside a body) is not.
 */
const KNOWN_LOWER_TOKENS = new Set([
  "title",
  "site",
  "parent",
  "article",
  "article_for_display",
  "mod_title",
  "short_description",
  "brand",
  "color",
  "currency",
  "price",
  "price_old",
  "price_min",
  "quantity",
  "volume",
  "phone_number",
  "pageNumber",
  "pagesCount",
  "gallery.count",
  "gallery.sortorder",
]);

/** Every distinct template token in a string, in order of first appearance. */
export function findPlaceholders(s: string): string[] {
  if (typeof s !== "string" || !s.includes("{")) return [];
  const found: string[] = [];
  const add = (t: string) => {
    if (!found.includes(t)) found.push(t);
  };
  for (const m of s.match(UPPER_TOKEN_RE) ?? []) add(m);
  for (const m of s.match(BRACED_WORD_RE) ?? []) {
    if (KNOWN_LOWER_TOKENS.has(m.slice(1, -1))) add(m);
  }
  return found;
}

/** Tokens the STORED value has and the new one does not — i.e. what a write destroys. */
export function lostPlaceholders(from: unknown, to: unknown): string[] {
  if (typeof from !== "string" || typeof to !== "string") return [];
  const before = findPlaceholders(from);
  if (before.length === 0) return [];
  const after = new Set(findPlaceholders(to));
  return before.filter((t) => !after.has(t));
}

export interface PlaceholderWarning {
  /** Field the tokens are being dropped from (form field name, or lang.field). */
  field: string;
  /** Tokens present in the stored value and absent from the new one. */
  lost: string[];
  /** Tokens the new value still carries (empty = the value is now fully static). */
  kept: string[];
}

/**
 * Scan a writer's planned changes for token loss. Works on the uniform
 * `{field, from, to}` shape every admin writer builds; `labelOf` renames the
 * field for tools whose planned entries are keyed differently (page_seo_set).
 */
export function scanPlaceholderLoss(
  planned: Array<Record<string, any>>,
  labelOf: (p: Record<string, any>) => string = (p) => String(p.formField ?? p.field ?? "?"),
): PlaceholderWarning[] {
  const out: PlaceholderWarning[] = [];
  for (const p of planned) {
    const lost = lostPlaceholders(p.from, p.to);
    if (lost.length === 0) continue;
    out.push({ field: labelOf(p), lost, kept: findPlaceholders(String(p.to ?? "")) });
  }
  return out;
}

/** One-line summary per field, used in both the refusal and the dry-run note. */
const summarise = (w: PlaceholderWarning[]): string =>
  w.map((x) => `${x.field} loses ${x.lost.join(", ")}`).join("; ");

/**
 * REFUSE a write that silently turns a template into a constant. Thrown before
 * anything is posted, so a refused call changes nothing at all.
 */
export function assertPlaceholdersKept(warnings: PlaceholderWarning[], allowed: boolean): void {
  if (allowed || warnings.length === 0) return;
  throw new Error(
    `REFUSED — this write would delete storefront template token(s): ${summarise(warnings)}. ` +
      `The STORED value contains a placeholder Horoshop substitutes at render time (a discount percent, a price, a countdown, an SEO variable); the new value does not, so every page using it would freeze on your static text instead of the computed one. ` +
      `Nothing would error and nothing would look broken — that is exactly how a sticker reading "−{DISCOUNT_PERCENT}%" was once overwritten with a constant and the loss went unnoticed. ` +
      `Re-send the value WITH the token(s) in it (translate the text around them), or pass allowPlaceholderLoss:true if dropping the substitution is deliberate.`,
  );
}

/** Note that rides along with a dry-run preview carrying warnings. */
export const placeholderPreviewNote = (warnings: PlaceholderWarning[]): string =>
  `⚠ TEMPLATE TOKEN LOSS: ${summarise(warnings)}. Those are storefront substitutions (a discount percent, a price, an SEO variable), not literal text — a value without them renders frozen for every product/page that uses it. dryRun:false will be REFUSED unless you pass allowPlaceholderLoss:true.`;

/** Note attached when the caller deliberately overrode the guard. */
export const placeholderOverrideNote = (warnings: PlaceholderWarning[]): string =>
  `Template token(s) dropped on purpose (allowPlaceholderLoss:true): ${summarise(warnings)}.`;

/** The opt-out switch, identical wording on every writer that guards. */
export const allowPlaceholderLossField = z
  .boolean()
  .optional()
  .describe(
    "Default false. A write whose NEW value drops a storefront template token that the STORED value had ({DISCOUNT_PERCENT}, {PRICE}, {title}…) is REFUSED, because that silently turns a per-product substitution into frozen text. Set true only when losing the token is intended.",
  );

/** Sentence appended to a guarded writer's description. */
export const PLACEHOLDER_GUARD_DOC =
  "TEMPLATE TOKENS ARE PROTECTED: if the stored value contains a storefront placeholder ({DISCOUNT_PERCENT}, {COUNTDOWN_INFO}, {title}, {price}…) and your new value does not, dryRun reports `placeholderWarnings` and a real write is REFUSED until you pass allowPlaceholderLoss:true — overwriting such a value with a constant freezes the substitution for every product/page that uses it, with nothing erroring and nothing looking broken. Keeping the token (the normal case when translating) passes silently.";
