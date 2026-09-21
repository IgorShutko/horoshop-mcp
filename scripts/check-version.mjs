#!/usr/bin/env node
// package.json, server.json and its npm package entry must carry one version:
// the registry publishes what server.json claims, npm publishes package.json.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => JSON.parse(readFileSync(join(ROOT, f), "utf8"));

const pkg = read("package.json");
const srv = read("server.json");
const entry = srv.packages?.find((p) => p.registryType === "npm");

const problems = [];
if (pkg.version !== srv.version) problems.push(`server.json ${srv.version} != package.json ${pkg.version}`);
if (entry && entry.version !== pkg.version) problems.push(`server.json npm package ${entry.version} != package.json ${pkg.version}`);
if (entry && entry.identifier !== pkg.name) problems.push(`server.json npm package "${entry.identifier}" != package name "${pkg.name}"`);
if (pkg.mcpName !== srv.name) problems.push(`package.json mcpName "${pkg.mcpName}" != server name "${srv.name}"`);

if (problems.length) {
  console.error("version drift:\n  " + problems.join("\n  "));
  process.exit(1);
}
console.error(`versions agree: ${pkg.name}@${pkg.version} as ${srv.name}`);
