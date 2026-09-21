#!/usr/bin/env node
// Smoke test: boots the built server over stdio and checks the contract every
// MCP client depends on. No framework — run with `npm test`.
import { spawn } from "node:child_process";
import { strict as assert } from "node:assert";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIN_TOOLS = 118;

function rpc() {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      HOROSHOP_STORES: JSON.stringify({
        demo: { baseUrl: "https://example.invalid/api/", login: "x", password: "y" },
      }),
    };
    delete env.HOROSHOP_STORES_FILE;
    const p = spawn(process.execPath, [join(ROOT, "dist", "index.js")], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const send = (m) => p.stdin.write(JSON.stringify(m) + "\n");
    const noise = [];
    let stderr = "";
    let buf = "";
    let tools = [];
    let prompts = [];
    const timer = setTimeout(() => {
      p.kill();
      reject(new Error("tools/list timed out after 60s"));
    }, 60_000);

    p.stderr.on("data", (d) => (stderr += d));
    p.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          // stdout is the JSON-RPC channel: anything else breaks every client.
          noise.push(line);
          continue;
        }
        if (msg.id === 1) {
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
        } else if (msg.id === 2) {
          tools = msg.result.tools;
          send({ jsonrpc: "2.0", id: 3, method: "prompts/list" });
        } else if (msg.id === 3) {
          prompts = msg.result.prompts;
          send({
            jsonrpc: "2.0",
            id: 4,
            method: "prompts/get",
            params: { name: "category_seo", arguments: { store: "myshop", category: "Кросівки" } },
          });
        } else if (msg.id === 4) {
          clearTimeout(timer);
          p.kill();
          resolve({ tools, prompts, rendered: msg.result, noise, stderr });
        }
      }
    });
    p.on("error", reject);
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } },
    });
  });
}

const { tools, prompts, rendered, noise, stderr } = await rpc();

assert.equal(noise.length, 0, `non-JSON written to stdout (breaks MCP clients):\n${noise.slice(0, 3).join("\n")}`);
assert.ok(tools.length >= MIN_TOOLS, `expected >= ${MIN_TOOLS} tools, got ${tools.length}`);
assert.match(stderr, /ready — \d+ tools/, `startup line missing from stderr:\n${stderr}`);

const names = tools.map((t) => t.name);
assert.equal(new Set(names).size, names.length, "duplicate tool names");

for (const t of tools) {
  assert.match(t.name, /^horoshop_[a-z0-9_]+$/, `bad tool name: ${t.name}`);
  assert.ok(t.description?.trim(), `${t.name}: empty description`);
  assert.ok(t.inputSchema?.type === "object", `${t.name}: missing object inputSchema`);
  assert.ok(t.annotations && typeof t.annotations === "object", `${t.name}: missing annotations`);
}

// Every store-scoped tool must accept `store` — multi-store routing depends on it.
// Exempt: tools that answer from the server's own tables, without touching a store.
const STORELESS = new Set(["horoshop_list_stores", "horoshop_admin_entities"]);
const noStore = tools.filter((t) => !STORELESS.has(t.name) && !t.inputSchema?.properties?.store);
assert.equal(noStore.length, 0, `tools missing the 'store' argument: ${noStore.map((t) => t.name).join(", ")}`);

const { normalizeBaseUrl } = await import(join(ROOT, "dist", "config.js"));
for (const [input, want] of [
  ["https://shop.ua", "https://shop.ua"],
  ["https://shop.ua/", "https://shop.ua"],
  ["https://shop.ua/api", "https://shop.ua"],
  ["https://shop.ua/api/", "https://shop.ua"],
  ["shop.ua", "https://shop.ua"],
]) {
  assert.equal(normalizeBaseUrl(input), want, `normalizeBaseUrl(${input})`);
}

// Prompts are the ready-made scenarios a client shows in its own menu.
assert.ok(prompts.length >= 7, `expected >= 7 prompts, got ${prompts.length}`);
const toolNames = new Set(names);
for (const p of prompts) {
  assert.match(p.name, /^[a-z0-9_]+$/, `bad prompt name: ${p.name}`);
  assert.ok(p.title?.trim(), `${p.name}: empty title`);
  assert.ok(p.description?.trim(), `${p.name}: empty description`);
}

const text = rendered.messages?.[0]?.content?.text ?? "";
assert.equal(rendered.messages.length, 1, "prompts/get should return one message");
assert.ok(text.includes("Кросівки"), "prompts/get did not substitute its argument");
assert.ok(text.includes("myshop"), "prompts/get did not substitute the store");

// A scenario that names a tool the server does not have sends the model hunting
// for something that is not there. Check every mention against tools/list.
const { prompts: specs } = await import(join(ROOT, "dist", "prompts.js"));
const sample = Object.fromEntries(
  specs.flatMap((s) => Object.keys(s.args ?? {})).map((k) => [k, "X"]),
);
const mentioned = new Set(
  specs.flatMap((s) => s.build(sample).match(/horoshop_[a-z0-9_]+/g) ?? []),
);
const missing = [...mentioned].filter((n) => !toolNames.has(n));
assert.equal(missing.length, 0, `prompts mention tools that do not exist: ${missing.join(", ")}`);

const readOnly = tools.filter((t) => t.annotations.readOnlyHint).length;
console.log(
  `smoke ok — ${tools.length} tools (${readOnly} read-only, ${tools.length - readOnly} write), ` +
    `${prompts.length} prompts naming ${mentioned.size} tools, stdout clean`,
);
