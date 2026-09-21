#!/usr/bin/env node
// One version everywhere: package.json is what npm publishes, server.json is what
// the registry publishes, and the .mcpb package entry points at a release asset
// whose URL carries the tag. A mismatch means the registry would advertise a
// download that does not exist.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => JSON.parse(readFileSync(join(ROOT, f), "utf8"));

const pkg = read("package.json");
const srv = read("server.json");
const problems = [];

if (pkg.version !== srv.version) problems.push(`server.json ${srv.version} != package.json ${pkg.version}`);
if (pkg.mcpName !== srv.name) problems.push(`package.json mcpName "${pkg.mcpName}" != server name "${srv.name}"`);

for (const p of srv.packages ?? []) {
  if (p.version && p.version !== pkg.version) {
    problems.push(`${p.registryType} package ${p.version} != package.json ${pkg.version}`);
  }
  if (p.registryType === "npm" && p.identifier !== pkg.name) {
    problems.push(`npm package "${p.identifier}" != package name "${pkg.name}"`);
  }
  if (p.registryType === "mcpb" && !p.identifier.includes(`/v${pkg.version}/`)) {
    problems.push(`mcpb URL does not point at v${pkg.version}: ${p.identifier}`);
  }
}

if (problems.length) {
  console.error("version drift:\n  " + problems.join("\n  "));
  process.exit(1);
}
console.error(`versions agree: ${pkg.name}@${pkg.version} as ${srv.name} (${(srv.packages ?? []).map((p) => p.registryType).join(", ") || "no packages"})`);
