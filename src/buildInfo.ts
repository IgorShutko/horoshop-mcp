import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Build visibility (FIX #1). A running MCP process keeps the code it
 * was started with until it is RESTARTED — `npm run build` alone does not reload
 * it. So a tool can silently serve a stale build while `dist/` on disk is already
 * newer, and nothing surfaces the mismatch (the symptom that made a rebuilt
 * `catalog_import` look like it had "no dryRun").
 *
 * This module bakes no codegen: it reads the mtime of the compiled JS in `dist/`.
 *  - At process start it snapshots the NEWEST mtime across `dist/**\/*.js` — the
 *    build the running process was actually loaded from (frozen for the life of
 *    the process, because this module's top-level runs exactly once).
 *  - On demand it re-reads `dist/` and, if disk is newer than the snapshot, flags
 *    `stale:true` — i.e. someone rebuilt but did not restart. That is the field
 *    `check_auth` / `list_stores` expose so the mismatch is visible.
 *
 * Compiles to `dist/buildInfo.js`; `import.meta.url` therefore resolves to that
 * file, its directory is `dist/`, and `../package.json` is the repo/package root.
 */

const HERE = dirname(fileURLToPath(import.meta.url)); // .../dist
const PKG_PATH = join(HERE, "..", "package.json");

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(PKG_PATH, "utf8"));
    return typeof pkg?.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Newest mtime (ms) across the compiled JS in `dist/` — the build time on disk. */
function newestDistMtime(): number {
  // Only the two members used; dodges @types/node's generic Dirent<Buffer|string>.
  type Ent = { name: string; isDirectory(): boolean };
  let newest = 0;
  const walk = (dir: string): void => {
    let entries: Ent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as unknown as Ent[];
    } catch {
      return;
    }
    for (const ent of entries) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(p);
      } else if (ent.name.endsWith(".js")) {
        try {
          const m = statSync(p).mtimeMs;
          if (m > newest) newest = m;
        } catch {
          /* unreadable file — ignore */
        }
      }
    }
  };
  walk(HERE);
  return newest;
}

/** Compact, sortable build id derived from the build's mtime. */
function buildIdOf(mtimeMs: number): string {
  return mtimeMs > 0 ? Math.round(mtimeMs).toString(36) : "unknown";
}

const VERSION = readVersion();
// Frozen at process start: the build this running process was loaded from.
const PROCESS_MTIME = newestDistMtime();
const PROCESS_BUILT_AT = PROCESS_MTIME > 0 ? new Date(PROCESS_MTIME).toISOString() : null;
const PROCESS_BUILD_ID = buildIdOf(PROCESS_MTIME);

export interface BuildStatus {
  version: string;
  build: string;
  builtAt: string | null;
  stale: boolean;
  /** Present only when stale: the newer build sitting in `dist/`. */
  distBuild?: string;
  distBuiltAt?: string | null;
  note?: string;
}

/** The build the running process is executing, plus a live staleness check. */
export function buildStatus(): BuildStatus {
  const liveMtime = newestDistMtime();
  // 1 ms of slack avoids an equal-mtime false positive right after a build.
  const stale = liveMtime > PROCESS_MTIME + 1;
  return {
    version: VERSION,
    build: PROCESS_BUILD_ID,
    builtAt: PROCESS_BUILT_AT,
    stale,
    ...(stale
      ? {
          distBuild: buildIdOf(liveMtime),
          distBuiltAt: new Date(liveMtime).toISOString(),
          note:
            "dist/ on disk is NEWER than the code this process is running — the server is serving a STALE build. RESTART the MCP process (a reconnect is NOT enough) so the latest build loads.",
        }
      : {}),
  };
}

/**
 * A spreadable warning for tools that are NOT the build-status tools.
 *
 * `check_auth`/`list_stores` report the build unconditionally, but nobody calls
 * them before a bulk write — and the whole point of the original incident is that
 * a rebuilt `catalog_import` looked like it had no `dryRun` because the process
 * was still running old code. So the catalog tools mix this in: nothing at all
 * when the build is current (no noise on the happy path), and a loud
 * `serverBuild` block the moment dist/ is newer than the running process.
 */
export function staleBuildWarning(): { serverBuild?: BuildStatus } {
  const s = buildStatus();
  return s.stale ? { serverBuild: s } : {};
}

/** One-line startup banner for stderr. */
export function startupLine(): string {
  return `[horoshop-mcp] build ${PROCESS_BUILD_ID} (v${VERSION}${PROCESS_BUILT_AT ? `, built ${PROCESS_BUILT_AT}` : ""})`;
}
