#!/usr/bin/env node
// Builds a .mcpb bundle: the one-click install path for Claude Desktop, and the
// artefact the MCP registry entry points at. Output: build/horoshop-mcp.mcpb
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = join(ROOT, "build");
const STAGE = join(BUILD, "mcpb");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

rmSync(BUILD, { recursive: true, force: true });
mkdirSync(join(STAGE, "server"), { recursive: true });

// Compiled server + production dependencies only.
execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "inherit" });
cpSync(join(ROOT, "dist"), join(STAGE, "server", "dist"), { recursive: true });
for (const f of ["package.json", "package-lock.json"]) cpSync(join(ROOT, f), join(STAGE, "server", f));
execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts"], { cwd: join(STAGE, "server"), stdio: "inherit" });
cpSync(join(ROOT, "site", "icon.png"), join(STAGE, "icon.png"));

const manifest = {
  manifest_version: "0.2",
  name: "horoshop-mcp",
  display_name: "Хорошоп MCP",
  version: pkg.version,
  description: "Unofficial MCP server for Horoshop stores: catalog, orders, SEO, feeds, admin panel.",
  long_description:
    "Connects an AI assistant to an online store on the Ukrainian e-commerce platform Horoshop. " +
    "118 tools across the documented public API, the admin panel and the storefront cart: catalog, orders, " +
    "categories, SEO and 301 redirects, marketplace feeds, design, localization and store settings. " +
    "One server handles several stores - every tool takes a `store` argument. " +
    "57 of the 71 write tools return a plan of the change and only apply it when called again with `dryRun:false`. " +
    "Unofficial project: not affiliated with or supported by Horoshop.",
  author: { name: "Igor Shutko", url: "https://www.targetplus-agency.com/" },
  homepage: "https://igorshutko.github.io/horoshop-mcp/",
  documentation: "https://github.com/IgorShutko/horoshop-mcp/blob/main/docs/INSTALL.md",
  support: "https://github.com/IgorShutko/horoshop-mcp/issues",
  icon: "icon.png",
  repository: { type: "git", url: "https://github.com/IgorShutko/horoshop-mcp" },
  license: "MIT",
  keywords: ["horoshop", "ecommerce", "ukraine", "catalog", "orders", "seo"],
  server: {
    type: "node",
    entry_point: "server/dist/index.js",
    mcp_config: {
      command: "node",
      args: ["${__dirname}/server/dist/index.js"],
      env: { HOROSHOP_STORES_FILE: "${user_config.stores_file}" },
    },
  },
  user_config: {
    stores_file: {
      type: "file",
      title: "Файл із магазинами (stores.json)",
      description:
        "JSON: назва магазину -> { baseUrl, login, password }. Створіть окремого адміністратора в адмінці Хорошопу і тримайте файл там, куди не мають доступу сторонні.",
      required: true,
      multiple: false,
    },
  },
  compatibility: {
    claude_desktop: ">=0.10.0",
    platforms: ["darwin", "win32", "linux"],
    runtimes: { node: ">=18.0.0" },
  },
};
writeFileSync(join(STAGE, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

execFileSync("npx", ["-y", "@anthropic-ai/mcpb", "pack", STAGE, join(BUILD, "horoshop-mcp.mcpb")], {
  cwd: ROOT,
  stdio: "inherit",
});
