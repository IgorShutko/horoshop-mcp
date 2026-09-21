#!/usr/bin/env node
// Regenerates the tool reference from the server's own `tools/list` answer, so
// the docs can never drift from what an MCP client actually sees. Writes three
// artefacts from one source: docs/TOOLS.md (index for humans),
// docs/tools/<section>.md (full parameter tables, one page per section) and
// docs/tools.json (compact index for agents: no prose, one line per tool).
// Usage: npm run docs:tools           write the files
//        npm run docs:tools:check     fail if the files on disk are stale (CI)
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = join(ROOT, "docs");
const TOOLS_DIR = join(DOCS, "tools");
const CHECK = process.argv.includes("--check");

const SECTIONS = [
  [/^horoshop_(list_stores|check_auth)$/, "Setup and diagnostics"],
  [/^horoshop_(catalog|icons)_/, "Catalog (public API)"],
  [/^horoshop_orders_/, "Orders (public API)"],
  [/^horoshop_(pages|users|product_set)_/, "Categories, users, product sets (public API)"],
  [/^horoshop_(payment|delivery|currency)_/, "Payment, delivery, currency (public API)"],
  [/^horoshop_(customer_groups|price_levels)_/, "B2B (public API)"],
  [/^horoshop_hooks_/, "Webhooks (public API)"],
  [/^horoshop_(cart|checkout)_/, "Storefront: cart and checkout"],
  [/^horoshop_admin_(login_check|entities|list|record_)/, "Admin panel: generic engine"],
  [/^horoshop_admin_(order|reports)/, "Admin panel: orders and analytics"],
  [/^horoshop_admin_(products_|product_stock|price_import|import_images|upload_image|export_characteristics)/, "Admin panel: products, prices, images"],
  [/^horoshop_admin_(template|dictionar|product_template)/, "Admin panel: characteristics and dictionaries"],
  [/^horoshop_admin_(category|page_|blog|banner|filter_preset|indexed_filter)/, "Admin panel: categories, pages, blog, banners, filters"],
  [/^horoshop_admin_(redirect|seo|sitemap|robots)/, "Admin panel: SEO, sitemap, redirects"],
  [/^horoshop_admin_feed/, "Admin panel: marketplace feeds"],
  [/^horoshop_admin_(design|css|language|interface_translation)/, "Admin panel: design and localization"],
  [/^horoshop_admin_(settings|store_|checkout_option|tracking|coupons|prro)/, "Admin panel: store settings, marketing, fiscal receipts"],
];

function listTools() {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      HOROSHOP_STORES: JSON.stringify({ demo: { baseUrl: "https://example.invalid", login: "x", password: "y" } }),
    };
    delete env.HOROSHOP_STORES_FILE;
    const p = spawn(process.execPath, [join(ROOT, "dist", "index.js")], { env, stdio: ["pipe", "pipe", "inherit"] });
    const send = (m) => p.stdin.write(JSON.stringify(m) + "\n");
    const timer = setTimeout(() => { p.kill(); reject(new Error("tools/list timed out")); }, 60_000);
    let buf = "";
    p.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id === 1) {
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
        } else if (msg.id === 2) {
          clearTimeout(timer);
          p.kill();
          resolve(msg.result.tools);
        }
      }
    });
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "tools-doc", version: "1" } },
    });
  });
}

// House style: plain hyphens instead of em dashes.
const dash = (s) => String(s ?? "").replace(/ — /g, " - ").replace(/—/g, "-");
const cell = (s) => dash(s).replace(/\r?\n+/g, " ").replace(/\|/g, "\\|");
const anchor = (s) => s.toLowerCase().replace(/[^a-z0-9 _-]/g, "").trim().replace(/ /g, "-");

function typeOf(schema = {}) {
  if (schema.enum) return schema.enum.map((v) => JSON.stringify(v)).join(" \\| ");
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  const alts = schema.anyOf || schema.oneOf;
  if (alts) return [...new Set(alts.map(typeOf))].join(" \\| ");
  if (schema.type === "array") return `${typeOf(schema.items)}[]`;
  if (Array.isArray(schema.type)) return schema.type.join(" \\| ");
  return schema.type || "any";
}

function access(a = {}) {
  if (a.readOnlyHint) return "read-only";
  const parts = [a.destructiveHint ? "destructive write" : "write"];
  if (a.idempotentHint) parts.push("idempotent");
  return parts.join(", ");
}

const tools = await listTools();
const groups = new Map(SECTIONS.map(([, title]) => [title, []]));
const unmatched = [];
for (const t of tools) {
  const hit = SECTIONS.find(([re]) => re.test(t.name));
  if (hit) groups.get(hit[1]).push(t);
  else unmatched.push(t);
}
if (unmatched.length) groups.set("Other", unmatched);

const sections = [...groups].filter(([, list]) => list.length).map(([title, list]) => ({
  title,
  list,
  file: `${anchor(title)}.md`,
}));

/** docs/TOOLS.md — the index: every tool in one table, details one click away. */
function indexPage() {
  const out = ["# Tool reference", ""];
  out.push(
    `Generated from the server's own \`tools/list\` answer: **${tools.length} tools**. ` +
      "Do not edit by hand; run `npm run docs:tools` after changing a tool.",
    "",
    "Every tool accepts an optional `store` argument (the store name from your configuration). " +
      "Access labels come from the MCP tool annotations: **read-only** tools never change the store; " +
      "**destructive** tools can delete or overwrite data and usually require `dryRun:false` plus an explicit confirmation.",
    "",
    "Agents: `tools.json` next to this file is the same index without the prose - one compact record per tool.",
    "",
    "## Sections",
    "",
    "| Section | Tools | Reference |",
    "|---|---|---|",
  );
  for (const s of sections) out.push(`| ${s.title} | ${s.list.length} | [tools/${s.file}](tools/${s.file}) |`);
  out.push("", "## All tools", "", "| Tool | Access | Summary |", "|---|---|---|");
  for (const s of sections) {
    for (const t of s.list) {
      out.push(`| [\`${t.name}\`](tools/${s.file}#${anchor(t.name)}) | ${access(t.annotations)} | ${cell(t.title)} |`);
    }
  }
  out.push("");
  return out.join("\n");
}

/** docs/tools/<section>.md — full descriptions and parameter tables. */
function sectionPage(s) {
  const out = [`# ${s.title}`, ""];
  out.push(`${s.list.length} tools. Part of the [tool reference](../TOOLS.md); generated by \`npm run docs:tools\`.`, "");
  out.push("| Tool | Access | Summary |", "|---|---|---|");
  for (const t of s.list) out.push(`| [\`${t.name}\`](#${anchor(t.name)}) | ${access(t.annotations)} | ${cell(t.title)} |`);
  out.push("");
  for (const t of s.list) {
    out.push(`## ${t.name}`, "");
    out.push(`**${dash(t.title)}** · ${access(t.annotations)}`, "");
    out.push(dash(t.description).trim(), "");
    const props = t.inputSchema?.properties || {};
    const required = new Set(t.inputSchema?.required || []);
    const names = Object.keys(props);
    if (names.length) {
      out.push("| Parameter | Type | Required | Description |", "|---|---|---|---|");
      for (const n of names) {
        out.push(`| \`${n}\` | ${typeOf(props[n])} | ${required.has(n) ? "yes" : "no"} | ${cell(props[n].description)} |`);
      }
      out.push("");
    }
  }
  return out.join("\n");
}

/** Compact call signature: `entity, id, fields?, store?` — required first. */
function signature(t) {
  const props = t.inputSchema?.properties || {};
  const required = new Set(t.inputSchema?.required || []);
  return Object.keys(props)
    .sort((a, b) => Number(required.has(b)) - Number(required.has(a)))
    .map((n) => `${n}${required.has(n) ? "" : "?"}: ${typeOf(props[n]).replace(/\\\|/g, "|")}`)
    .join(", ");
}

/** docs/tools.json — machine index: what exists, what it costs, where to read more. */
function toolsJson() {
  const payload = {
    server: "horoshop-mcp",
    generated_by: "npm run docs:tools",
    tool_count: tools.length,
    sections: sections.map((s) => ({ title: s.title, doc: `docs/tools/${s.file}`, tools: s.list.length })),
    tools: sections.flatMap((s) =>
      s.list.map((t) => ({
        name: t.name,
        section: s.title,
        summary: dash(t.title),
        access: access(t.annotations),
        read_only: Boolean(t.annotations?.readOnlyHint),
        destructive: Boolean(t.annotations?.destructiveHint),
        supports_dry_run: Boolean(t.inputSchema?.properties?.dryRun),
        doc: `docs/tools/${s.file}#${anchor(t.name)}`,
        // One line instead of a nested schema: an agent greps this file to pick a
        // tool, then reads `doc` for the full parameter table.
        params: signature(t),
      })),
    ),
  };
  return JSON.stringify(payload, null, 2) + "\n";
}

const artefacts = new Map([
  [join(DOCS, "TOOLS.md"), indexPage()],
  [join(DOCS, "tools.json"), toolsJson()],
  ...sections.map((s) => [join(TOOLS_DIR, s.file), sectionPage(s)]),
]);

const read = (f) => (existsSync(f) ? readFileSync(f, "utf8") : null);

if (CHECK) {
  const stale = [...artefacts].filter(([f, body]) => read(f) !== body).map(([f]) => f);
  const orphans = existsSync(TOOLS_DIR)
    ? readdirSync(TOOLS_DIR).map((f) => join(TOOLS_DIR, f)).filter((f) => !artefacts.has(f))
    : [];
  if (stale.length || orphans.length) {
    console.error(
      `[tools-doc] docs are stale. Run \`npm run docs:tools\` and commit.\n` +
        [...stale.map((f) => `  changed: ${f}`), ...orphans.map((f) => `  orphan:  ${f}`)].join("\n"),
    );
    process.exit(1);
  }
  console.error(`[tools-doc] docs match the server: ${tools.length} tools, ${artefacts.size} files.`);
} else {
  rmSync(TOOLS_DIR, { recursive: true, force: true });
  mkdirSync(TOOLS_DIR, { recursive: true });
  for (const [f, body] of artefacts) writeFileSync(f, body);
  const kb = (f) => Math.round(Buffer.byteLength(artefacts.get(f)) / 1024);
  console.error(
    `[tools-doc] wrote ${artefacts.size} files: TOOLS.md ${kb(join(DOCS, "TOOLS.md"))} KB, ` +
      `tools.json ${kb(join(DOCS, "tools.json"))} KB, ${sections.length} section pages, ${tools.length} tools` +
      `${unmatched.length ? `, ${unmatched.length} in "Other": ${unmatched.map((t) => t.name).join(", ")}` : ""}`,
  );
}
