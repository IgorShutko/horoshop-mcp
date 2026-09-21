# AGENTS.md

Instructions for AI agents working **on this repository**. If you are an agent using the server to run a store, read `docs/TOOLS.md` (or `docs/tools.json`) instead — this file is about changing the code.

## What this is

An MCP server that connects AI agents to [Horoshop](https://horoshop.ua/) stores: 118 stdio tools over the documented public API, the admin panel (internal, undocumented endpoints) and the storefront cart. One process serves many stores; every tool takes an optional `store` argument.

TypeScript, ESM, Node 18+. No test framework, no bundler, no runtime beyond three dependencies.

## Commands

```bash
npm install
npm run build          # tsc -> dist/
npm test               # smoke: boots the server, checks the tool contract
npm run docs:tools     # regenerate docs/TOOLS.md, docs/tools/*.md, docs/tools.json
npm run docs:tools:check   # CI: fail if those files drifted from the code
```

A change is finished when `npm run build`, `npm test` and `npm run docs:tools:check` all pass. There is no watch-mode test runner; run the three commands.

## Invariants (breaking these breaks users)

1. **stdout belongs to JSON-RPC.** Log with `console.error`. A single `console.log` makes every MCP client fail to parse the stream; `npm test` asserts stdout stays clean.
2. **118 tools is a floor, not a snapshot.** `npm test` fails below it. Removing a tool is a deliberate decision, never a side effect.
3. **Writes are dry by default.** A write tool takes `dryRun` (default `true`) and returns the planned change; only `dryRun:false` persists. Bulk or destructive operations additionally require an explicit confirmation argument.
4. **Verify writes by reading back.** The platform answers `success` on writes that did not happen. After persisting, re-read the record and compare — the existing tools do this, new ones must too.
5. **Secrets never leave in a response.** `src/admin/redact.ts` masks values under keys matching `key|token|secret|password|signature|private`. It is an output filter and deep-clones: never feed a redacted object back into a save.
6. **The tool reference is generated.** Do not hand-edit `docs/TOOLS.md`, `docs/tools/*.md` or `docs/tools.json`.
7. **Prompts may only name tools that exist.** `src/prompts.ts` holds the ready-made scenarios the client lists; a scenario that cites a removed or misspelled tool sends the model hunting for nothing. `npm test` checks every `horoshop_*` mention against `tools/list`, so rename a tool and the prompts fail with it.
8. **No credentials in the tree.** `stores.json` is git-ignored. Never commit logins, passwords, tokens or client admin URLs — including in docs, comments and test fixtures.

## Layout

| Path | What lives there |
|---|---|
| `src/index.ts` | entry point; assembles every tool set and connects stdio |
| `src/config.ts` | `stores.json` loading, base-URL normalization |
| `src/client.ts` | documented public API client |
| `src/admin/` | admin-panel engine: session, form parsing, guards, redaction |
| `src/tools/` | the tools themselves, grouped by area |
| `src/prompts.ts` | ready-made scenarios (MCP prompts), written in Ukrainian for the shop owner |
| `scripts/smoke.mjs` | the smoke test |
| `scripts/tools-doc.mjs` | doc generator (single source of truth for the reference) |
| `docs/` | install guides (uk/ru/en), tool reference, internals |

## Adding a tool

1. Add a `ToolSpec` in the matching `src/tools/*.ts`: `name` (`horoshop_…`), `title`, `description`, `inputSchema` (spread `...storeField`), `annotations` (`readOnlyHint` / `destructiveHint` / `idempotentHint`), `handler`.
2. If you created a new file, import its array in `src/index.ts`.
3. Write descriptions for a model that has never seen the admin panel: say what the tool returns, what it costs, and which failure looks like success. Long descriptions are fine — they are the only documentation the model gets at call time.
4. `npm run build && npm test && npm run docs:tools`, then commit the regenerated docs with the code.

## Testing against a real store

There is no mock. Point `HOROSHOP_STORES` at a test store you own, never at a client's live store. Reading a live store is usually safe; writing to one is not, and opening an order card there reorders the admin's sort column.

## Style

Plain hyphens, not em dashes. Comments explain *why* (especially platform quirks that look like bugs); the code says what. Match the surrounding file.
