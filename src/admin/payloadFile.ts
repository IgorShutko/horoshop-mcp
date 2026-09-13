import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z, type ZodRawShape } from "zod";

/**
 * BULK PAYLOAD FROM DISK for the admin WRITERS — the fix that removes the reason
 * to bypass them.
 *
 * The incident this exists to prevent: article bodies are 15–19 KB,
 * page bodies 22 KB, a category's SEO text 16 KB. None of that fits in a tool
 * argument, so the operator fell back to a hand-rolled `getEditForm` + `save`
 * read-modify-write — and walked straight onto the undocumented `h_news.parent`
 * mine, which relocated 10 published articles into the wrong rubric. The content
 * was never the problem; the ARGUMENT SIZE was. `catalog_import` already solved
 * this with `productsFile`; this module is the same idea for the admin writers.
 *
 * Contract, deliberately boring so it cannot surprise:
 *  - `payloadFile` is an ABSOLUTE path to a JSON OBJECT whose keys are the very
 *    same argument names the tool accepts inline.
 *  - `store`, `dryRun` and `payloadFile` itself are CONTROL args: they stay inline
 *    and are refused inside the file (silently ignoring them would be a trap).
 *  - Any other key may come from the file, but never from both places: passing one
 *    inline AND in the file is an error, not a silent precedence rule.
 *  - Unknown keys are rejected with the list of valid names (a typo in a 20 KB
 *    payload is otherwise invisible).
 *  - The merged object is validated against the tool's own zod schema, so a file
 *    is held to exactly the same type contract as inline arguments.
 */

/** Args every tool owns itself — never accepted from the payload file. */
export const CONTROL_KEYS = ["store", "dryRun", "payloadFile"] as const;

/** Read + validate the file into a plain object. Throws an actionable error. */
export function loadPayloadFile(filePath: string): Record<string, unknown> {
  if (!isAbsolute(filePath)) {
    throw new Error(`payloadFile must be an ABSOLUTE path (got "${filePath}").`);
  }
  if (!existsSync(filePath)) {
    throw new Error(`payloadFile not found: ${filePath}`);
  }
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (e) {
    throw new Error(`Cannot read payloadFile ${filePath}: ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`payloadFile ${filePath} is not valid JSON: ${(e as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `payloadFile ${filePath} must be a JSON OBJECT of tool arguments (e.g. {"text":"…","ru":{"text":"…"}}), not ${Array.isArray(parsed) ? "an array" : typeof parsed}.`,
    );
  }
  const obj = parsed as Record<string, unknown>;
  if (Object.keys(obj).length === 0) {
    throw new Error(`payloadFile ${filePath} is an empty object — nothing to write.`);
  }
  return obj;
}

/**
 * Merge `args.payloadFile` into `args` under the rules above and re-validate the
 * result against the tool's schema. Returns `args` untouched when no file was
 * passed, so every existing inline call is bit-for-bit unaffected.
 */
export function withPayloadFile<T extends Record<string, any>>(
  args: T,
  schema: ZodRawShape,
  toolName: string,
): T & { payloadFileUsed?: { path: string; keys: string[] } } {
  const filePath = args.payloadFile as string | undefined;
  if (!filePath) return args;

  const fromFile = loadPayloadFile(filePath);
  const allowed = new Set(Object.keys(schema));
  const control = new Set<string>(CONTROL_KEYS);

  const unknown = Object.keys(fromFile).filter((k) => !allowed.has(k));
  if (unknown.length) {
    throw new Error(
      `payloadFile ${filePath}: unknown key(s) ${unknown.join(", ")}. ${toolName} accepts: ${[...allowed]
        .filter((k) => !control.has(k))
        .join(", ")}.`,
    );
  }
  const controlInFile = Object.keys(fromFile).filter((k) => control.has(k));
  if (controlInFile.length) {
    throw new Error(
      `payloadFile ${filePath}: ${controlInFile.join(", ")} must be passed as a tool argument, not inside the file (it controls how the call runs, not what is written).`,
    );
  }
  const both = Object.keys(fromFile).filter((k) => args[k] !== undefined);
  if (both.length) {
    throw new Error(
      `payloadFile ${filePath}: ${both.join(", ")} given BOTH inline and in the file. payloadFile is mutually exclusive with the content arguments — pass each field in exactly one place.`,
    );
  }

  const merged: Record<string, unknown> = { ...args, ...fromFile };
  delete merged.payloadFile;
  const parsed = z.object(schema).safeParse(merged);
  if (!parsed.success) {
    throw new Error(
      `payloadFile ${filePath} failed validation for ${toolName}: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return {
    ...(merged as T),
    payloadFileUsed: { path: filePath, keys: Object.keys(fromFile) },
  };
}

/**
 * Shorten one value for a dry-run preview.
 *
 * The whole point of `payloadFile` is that the content does not fit in the
 * conversation; echoing a 22 KB body back as `{from, to}` would put it right back
 * there. Long strings become `{length, head, tail}` — enough to eyeball that the
 * right text is going to the right field, without the payload.
 */
export function previewValue(v: string, limit = 220): string | { length: number; head: string; tail: string } {
  if (typeof v !== "string" || v.length <= limit) return v;
  return { length: v.length, head: v.slice(0, limit), tail: v.slice(-60) };
}

// `previewChange` used to live here; it is now `compactPreview` in ./changes.ts,
// which windows the same keys but also knows about `delta` (append/prepend) and
// the `verbose` switch. Nothing imports the old name any more.

/** The schema field itself — identical wording on every tool that supports it. */
export const payloadFileField = (toolName: string) =>
  z
    .string()
    .optional()
    .describe(
      `ABSOLUTE path to a JSON file holding this tool's content arguments (same key names, e.g. {"text":"<15 KB of HTML>","ru":{"text":"…"}}). Use it when the content is too large for a tool argument — article bodies (15–19 KB), page bodies (22 KB), category SEO text (16 KB). MUTUALLY EXCLUSIVE with the inline content fields: a key passed both ways is an error. store/dryRun/payloadFile stay inline. Works with dryRun (default true) exactly like ${toolName} inline.`,
    );
