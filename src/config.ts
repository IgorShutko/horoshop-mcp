import { readFileSync } from "node:fs";
import { z } from "zod";

/**
 * A single Horoshop store the server can talk to. Credentials are per-store —
 * Horoshop issues a token from `login`/`password` against the store domain.
 */
export const StoreConfigSchema = z.object({
  baseUrl: z.string().min(1),
  login: z.string().min(1),
  password: z.string().min(1),
});
export type StoreConfig = z.infer<typeof StoreConfigSchema>;

export interface ResolvedConfig {
  stores: Record<string, StoreConfig>;
  defaultStore?: string;
  timeoutMs: number;
}

const StoresMapSchema = z.record(StoreConfigSchema);

/**
 * Horoshop API endpoints live under `<baseUrl>/api/<func>/`. Users may hand us
 * a bare domain, a URL with a trailing slash, or one that already ends in
 * `/api` — normalise all of them to a scheme-qualified origin with no trailing
 * slash and no `/api` suffix.
 */
export function normalizeBaseUrl(raw: string): string {
  let url = raw.trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  url = url.replace(/\/+$/, "");
  url = url.replace(/\/api$/i, "");
  return url;
}

function readStoresSource(env: NodeJS.ProcessEnv): unknown {
  if (env.HOROSHOP_STORES) {
    try {
      return JSON.parse(env.HOROSHOP_STORES);
    } catch (e) {
      throw new Error(
        `HOROSHOP_STORES is not valid JSON: ${(e as Error).message}`,
      );
    }
  }
  if (env.HOROSHOP_STORES_FILE) {
    let text: string;
    try {
      text = readFileSync(env.HOROSHOP_STORES_FILE, "utf8");
    } catch (e) {
      throw new Error(
        `Cannot read HOROSHOP_STORES_FILE (${env.HOROSHOP_STORES_FILE}): ${(e as Error).message}`,
      );
    }
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error(
        `HOROSHOP_STORES_FILE (${env.HOROSHOP_STORES_FILE}) is not valid JSON: ${(e as Error).message}`,
      );
    }
  }
  return undefined;
}

/**
 * Build the runtime config from the environment. Missing store config is not
 * fatal — the server still starts and lists its tools, but any API call returns
 * an actionable "no stores configured" error. Malformed config IS fatal so the
 * operator notices the typo immediately.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const source = readStoresSource(env);

  let stores: Record<string, StoreConfig> = {};
  if (source !== undefined) {
    const parsed = StoresMapSchema.safeParse(source);
    if (!parsed.success) {
      throw new Error(
        `Invalid store configuration: ${parsed.error.issues
          .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
          .join("; ")}`,
      );
    }
    stores = Object.fromEntries(
      Object.entries(parsed.data).map(([name, conf]) => [
        name,
        { ...conf, baseUrl: normalizeBaseUrl(conf.baseUrl) },
      ]),
    );
  }

  const names = Object.keys(stores);
  let defaultStore = env.HOROSHOP_DEFAULT_STORE?.trim() || undefined;
  if (defaultStore && !stores[defaultStore]) {
    throw new Error(
      `HOROSHOP_DEFAULT_STORE "${defaultStore}" is not one of the configured stores: [${names.join(", ")}]`,
    );
  }
  if (!defaultStore && names.length === 1) defaultStore = names[0];

  const timeoutMs = Number(env.HOROSHOP_TIMEOUT_MS) || 120_000;

  return { stores, defaultStore, timeoutMs };
}
