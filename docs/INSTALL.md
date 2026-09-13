# Install and connect

horoshop-mcp is a local MCP server that talks over **stdio**. Any client that can start a local command and pass it environment variables can use it. This page covers credentials, the three ways to launch the server, and step-by-step setup for 22 clients.

## Contents

- [1. Get Horoshop credentials](#1-get-horoshop-credentials)
- [2. Create stores.json](#2-create-storesjson)
- [3. Choose how to launch the server](#3-choose-how-to-launch-the-server)
- [4. Register the server in your client](#4-register-the-server-in-your-client)
- [Timeouts](#timeouts)
- [Windows notes](#windows-notes)
- [Check that it works](#check-that-it-works)
- [Troubleshooting](#troubleshooting)

## 1. Get Horoshop credentials

The server signs in with a Horoshop **admin user**. The same login and password open the public API (`POST /api/auth/`) and the control panel that the `horoshop_admin_*` tools drive.

1. In your store's control panel open **Settings → Admins** («Настройки → Админы» in the Russian interface) and click **Add**. Only a user with the **Owner** role can create users.
2. Choose a role. Admin-panel tools act with that role's permissions: for example, a *Content-manager* has no access to orders and customers, while *Owner* sees everything.
3. Save the login and password.

Create a dedicated user for the server instead of reusing a personal login, so you can revoke it at any time without locking yourself out. The API token lives 600 seconds and the server renews it on its own.

If `horoshop_check_auth` rejects credentials that do open the control panel, ask Horoshop support whether API access is enabled for your store.

## 2. Create stores.json

One file can hold any number of stores. The key is the short name you (or the AI agent) pass as `store` on every call.

```json
{
  "myshop": { "baseUrl": "https://myshop.com.ua", "login": "api-user", "password": "REPLACE_ME" },
  "othershop": { "baseUrl": "othershop.ua", "login": "api-user", "password": "REPLACE_ME" }
}
```

- `baseUrl` is forgiving: a bare domain, a trailing slash or a `/api` suffix all work.
- With one store configured it becomes the default. With several, set `HOROSHOP_DEFAULT_STORE` or pass `store` explicitly.
- Keep the file outside shared folders. On macOS and Linux run `chmod 600 stores.json`.
- Instead of a file you can put the same JSON into the `HOROSHOP_STORES` environment variable. A file is safer: client configs get copied, synced and screenshotted.

All environment variables are listed in the [README](../README.md#configuration).

## 3. Choose how to launch the server

You need **Node.js 18 or newer** and **Git** for all three ways.

| Way | Launch command | When to pick it |
|---|---|---|
| **A. npx from GitHub** | `npx -y github:IgorShutko/horoshop-mcp` | No clone to manage. The first start downloads and builds the package (about 20 seconds), later starts come from the npm cache. |
| **B. Global install** | `horoshop-mcp` | Install once with `npm install -g github:IgorShutko/horoshop-mcp`, run the same command again to update. |
| **C. Clone and build** | `node /abs/path/to/horoshop-mcp/dist/index.js` | Most predictable: no shims, pinned to the commit you checked out. Best for Windows and for development. |

Way C:

```bash
git clone https://github.com/IgorShutko/horoshop-mcp.git
cd horoshop-mcp
npm install
```

`npm install` also compiles TypeScript into `dist/` (the `prepare` script). To update later: `git pull && npm install`, then restart your MCP client.

**Every example below uses way C.** For A or B change only `command` and `args`:

| Way | macOS / Linux | Windows |
|---|---|---|
| A | `"command": "npx", "args": ["-y", "github:IgorShutko/horoshop-mcp"]` | `"command": "cmd", "args": ["/c", "npx", "-y", "github:IgorShutko/horoshop-mcp"]` |
| B | `"command": "horoshop-mcp", "args": []` | `"command": "cmd", "args": ["/c", "horoshop-mcp"]` |
| C | `"command": "node", "args": ["/abs/path/to/horoshop-mcp/dist/index.js"]` | `"command": "node", "args": ["C:/path/to/horoshop-mcp/dist/index.js"]` |

For CLI commands the same rule applies: whatever follows `--` (or the server name) is the launch command.

## 4. Register the server in your client

| Client | Where the config lives | Jump to |
|---|---|---|
| Claude Code | `claude mcp add` or `.mcp.json` | [Claude Code](#claude-code) |
| Claude Desktop | `claude_desktop_config.json` | [Claude Desktop](#claude-desktop) |
| Cursor | `~/.cursor/mcp.json` | [Cursor](#cursor) |
| OpenAI Codex (CLI, IDE, app) | `codex mcp add` or `~/.codex/config.toml` | [Codex](#openai-codex) |
| Hermes Agent | `hermes mcp add` or `~/.hermes/config.yaml` | [Hermes Agent](#hermes-agent) |
| VS Code (GitHub Copilot) | `.vscode/mcp.json` | [VS Code](#vs-code-github-copilot) |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | [Windsurf](#windsurf) |
| Gemini CLI | `gemini mcp add` or `~/.gemini/settings.json` | [Gemini CLI](#gemini-cli) |
| Zed | `settings.json` → `context_servers` | [Zed](#zed) |
| Cline | `cline_mcp_settings.json` | [Cline](#cline) |
| Roo Code | `.roo/mcp.json` | [Roo Code](#roo-code) |
| Continue | `~/.continue/config.yaml` | [Continue](#continue) |
| OpenCode | `opencode.json` | [OpenCode](#opencode) |
| LM Studio | `~/.lmstudio/mcp.json` | [LM Studio](#lm-studio) |
| Goose | `goose configure` or `config.yaml` | [Goose](#goose) |
| Kiro | `~/.kiro/settings/mcp.json` | [Kiro](#kiro) |
| JetBrains IDEs (AI Assistant) | Settings dialog | [JetBrains](#jetbrains-ides-ai-assistant) |
| GitHub Copilot CLI | `~/.copilot/mcp-config.json` | [Copilot CLI](#github-copilot-cli) |
| Amp | `amp mcp add` or `settings.json` | [Amp](#amp) |
| Warp | Settings dialog | [Warp](#warp) |
| Qwen Code | `qwen mcp add` or `~/.qwen/settings.json` | [Qwen Code](#qwen-code) |
| Crush | `crush.json` | [Crush](#crush) |
| Anything else | stdio command + env | [Other clients](#other-clients) |

Replace `/abs/path/to/...` with real absolute paths. Relative paths break because clients start servers from their own working directory.

### Claude Code

One command, available in all your projects (`-s user`):

```bash
claude mcp add horoshop -s user -e HOROSHOP_STORES_FILE=/abs/path/to/stores.json -- node /abs/path/to/horoshop-mcp/dist/index.js
```

Without cloning:

```bash
claude mcp add horoshop -s user -e HOROSHOP_STORES_FILE=/abs/path/to/stores.json -- npx -y github:IgorShutko/horoshop-mcp
```

Scopes: `local` (default: this project, only you), `project` (writes `.mcp.json` in the repository root, shared through git), `user` (every project). A hand-written `.mcp.json` looks like this:

```json
{
  "mcpServers": {
    "horoshop": {
      "type": "stdio",
      "command": "node",
      "args": ["/abs/path/to/horoshop-mcp/dist/index.js"],
      "env": { "HOROSHOP_STORES_FILE": "/abs/path/to/stores.json" }
    }
  }
}
```

Check: `claude mcp list` in the terminal or `/mcp` inside a session. On Windows use `cmd /c npx -y github:IgorShutko/horoshop-mcp` after `--`.

### Claude Desktop

Open **Settings → Developer → Edit Config** from the Claude menu, or edit the file directly:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "horoshop": {
      "command": "node",
      "args": ["/abs/path/to/horoshop-mcp/dist/index.js"],
      "env": { "HOROSHOP_STORES_FILE": "/abs/path/to/stores.json" }
    }
  }
}
```

Quit Claude completely and start it again: closing the window is not enough. Desktop apps do not load your shell profile, so if Node came from nvm or a similar manager, put the absolute path to the `node` binary into `command` (run `which node` or `where node` to find it). Logs: `~/Library/Logs/Claude/mcp*.log` on macOS, `%APPDATA%\Claude\logs` on Windows.

### Cursor

Global: `~/.cursor/mcp.json`. Per project: `.cursor/mcp.json`.

```json
{
  "mcpServers": {
    "horoshop": {
      "type": "stdio",
      "command": "node",
      "args": ["/abs/path/to/horoshop-mcp/dist/index.js"],
      "env": { "HOROSHOP_STORES_FILE": "/abs/path/to/stores.json" }
    }
  }
}
```

Cursor also accepts `"envFile": "/abs/path/to/.env"` for stdio servers. The server list with connection status is in Cursor's settings under MCP; server logs are in the Output panel, channel **MCP Logs**.

### OpenAI Codex

The Codex CLI, the IDE extension and the desktop app share one configuration, so adding the server once is enough.

```bash
codex mcp add horoshop --env HOROSHOP_STORES_FILE=/abs/path/to/stores.json -- node /abs/path/to/horoshop-mcp/dist/index.js
```

Then raise the timeouts in `~/.codex/config.toml` (or project `.codex/config.toml`). Codex waits only 60 seconds for a tool call by default, and bulk imports can take longer:

```toml
[mcp_servers.horoshop]
command = "node"
args = ["/abs/path/to/horoshop-mcp/dist/index.js"]
env = { "HOROSHOP_STORES_FILE" = "/abs/path/to/stores.json" }
startup_timeout_sec = 60
tool_timeout_sec = 300
```

`startup_timeout_sec = 60` matters for way A, where the first start builds the package. On Windows write paths as TOML literal strings: `args = ['C:\path\to\horoshop-mcp\dist\index.js']`. Check: `codex mcp list`, or `/mcp` in a session.

### Hermes Agent

[Hermes Agent](https://github.com/NousResearch/hermes-agent) by Nous Research:

```bash
hermes mcp add horoshop --command node --env HOROSHOP_STORES_FILE=/abs/path/to/stores.json --args /abs/path/to/horoshop-mcp/dist/index.js
```

`--args` must be the last flag. The same in `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  horoshop:
    command: "node"
    args: ["/abs/path/to/horoshop-mcp/dist/index.js"]
    env:
      HOROSHOP_STORES_FILE: "/abs/path/to/stores.json"
    timeout: 300
```

Check: `hermes mcp list`, `hermes mcp test horoshop`, or `/reload-mcp` in a chat.

### VS Code (GitHub Copilot)

Workspace: `.vscode/mcp.json`. For all workspaces run **MCP: Open User Configuration** from the Command Palette. Note the top-level key is `servers`, not `mcpServers`:

```json
{
  "servers": {
    "horoshop": {
      "type": "stdio",
      "command": "node",
      "args": ["/abs/path/to/horoshop-mcp/dist/index.js"],
      "env": { "HOROSHOP_STORES_FILE": "/abs/path/to/stores.json" }
    }
  }
}
```

From a terminal:

```bash
code --add-mcp '{"name":"horoshop","command":"node","args":["/abs/path/to/horoshop-mcp/dist/index.js"],"env":{"HOROSHOP_STORES_FILE":"/abs/path/to/stores.json"}}'
```

`${env:VAR}` is not expanded inside `mcp.json`, so write the paths literally. Check: **MCP: List Servers** → select the server → **Show Output**.

### Windsurf

`~/.codeium/windsurf/mcp_config.json` (Windows: `%USERPROFILE%\.codeium\windsurf\mcp_config.json`), or open it from the Cascade panel through the MCP icon:

```json
{
  "mcpServers": {
    "horoshop": {
      "command": "node",
      "args": ["/abs/path/to/horoshop-mcp/dist/index.js"],
      "env": { "HOROSHOP_STORES_FILE": "/abs/path/to/stores.json" }
    }
  }
}
```

Windsurf expands `${env:VAR}` in this file. Newer builds with the Devin Local agent read the same shape from `~/.config/devin/mcp_config.json` (Windows: `%APPDATA%\devin\mcp_config.json`) or `.devin/mcp_config.json` in the project.

### Gemini CLI

```bash
gemini mcp add -s user -e HOROSHOP_STORES_FILE=/abs/path/to/stores.json horoshop node /abs/path/to/horoshop-mcp/dist/index.js
```

Or `~/.gemini/settings.json` (per project: `.gemini/settings.json`):

```json
{
  "mcpServers": {
    "horoshop": {
      "command": "node",
      "args": ["/abs/path/to/horoshop-mcp/dist/index.js"],
      "env": { "HOROSHOP_STORES_FILE": "/abs/path/to/stores.json" }
    }
  }
}
```

The default call timeout is 10 minutes, which is enough. Check: `gemini mcp list`, or `/mcp list` in a session.

### Zed

`~/.config/zed/settings.json` (Windows: `%APPDATA%\Zed\settings.json`), or **Settings → AI → MCP Servers → Add Server**:

```json
{
  "context_servers": {
    "horoshop": {
      "command": "node",
      "args": ["/abs/path/to/horoshop-mcp/dist/index.js"],
      "env": { "HOROSHOP_STORES_FILE": "/abs/path/to/stores.json" },
      "timeout": 300000
    }
  }
}
```

Zed stops waiting after 60 seconds unless `timeout` (milliseconds) says otherwise. Older guides show a nested `"command": { "path": ... }` form; the flat form above is the current one. A green dot next to the server means it is running.

### Cline

In the Cline panel open **MCP Servers → Configure → Configure MCP Servers**. That opens `cline_mcp_settings.json`:

```json
{
  "mcpServers": {
    "horoshop": {
      "command": "node",
      "args": ["/abs/path/to/horoshop-mcp/dist/index.js"],
      "env": { "HOROSHOP_STORES_FILE": "/abs/path/to/stores.json" },
      "disabled": false,
      "autoApprove": [],
      "timeout": 300
    }
  }
}
```

`timeout` is in seconds (default 60). Leave `autoApprove` empty or list only read-only tools.

### Roo Code

Per project: `.roo/mcp.json`. Globally: the MCP panel → **Edit Global MCP**.

```json
{
  "mcpServers": {
    "horoshop": {
      "command": "node",
      "args": ["/abs/path/to/horoshop-mcp/dist/index.js"],
      "env": { "HOROSHOP_STORES_FILE": "/abs/path/to/stores.json" },
      "timeout": 300,
      "disabled": false
    }
  }
}
```

`timeout` is in seconds (default 60).

### Continue

Add to `~/.continue/config.yaml` (per project: `.continue/config.yaml`):

```yaml
mcpServers:
  - name: horoshop
    command: node
    args:
      - /abs/path/to/horoshop-mcp/dist/index.js
    env:
      HOROSHOP_STORES_FILE: /abs/path/to/stores.json
```

### OpenCode

`~/.config/opencode/opencode.json`, or `opencode.json` in the project root:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "horoshop": {
      "type": "local",
      "command": ["node", "/abs/path/to/horoshop-mcp/dist/index.js"],
      "environment": { "HOROSHOP_STORES_FILE": "/abs/path/to/stores.json" },
      "enabled": true
    }
  }
}
```

### LM Studio

**Program → Install → Edit mcp.json**, or edit `~/.lmstudio/mcp.json` (Windows: `%USERPROFILE%\.lmstudio\mcp.json`):

```json
{
  "mcpServers": {
    "horoshop": {
      "command": "node",
      "args": ["/abs/path/to/horoshop-mcp/dist/index.js"],
      "env": { "HOROSHOP_STORES_FILE": "/abs/path/to/stores.json" }
    }
  }
}
```

### Goose

Run `goose configure` → **Add Extension** → **Command-line Extension**, answer the prompts (name, command, timeout, environment variables). The result in `~/.config/goose/config.yaml` (Windows: `%APPDATA%\Block\goose\config\config.yaml`):

```yaml
extensions:
  horoshop:
    name: horoshop
    type: stdio
    cmd: node
    args: ["/abs/path/to/horoshop-mcp/dist/index.js"]
    envs: { "HOROSHOP_STORES_FILE": "/abs/path/to/stores.json" }
    enabled: true
    timeout: 300
```

### Kiro

User level: `~/.kiro/settings/mcp.json`. Workspace: `.kiro/settings/mcp.json`.

```json
{
  "mcpServers": {
    "horoshop": {
      "command": "node",
      "args": ["/abs/path/to/horoshop-mcp/dist/index.js"],
      "env": { "HOROSHOP_STORES_FILE": "/abs/path/to/stores.json" },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

### JetBrains IDEs (AI Assistant)

Open **Settings → Tools → AI Assistant → Model Context Protocol (MCP) → Add**. Fill in the command (`node`), the argument (`/abs/path/to/horoshop-mcp/dist/index.js`) and the environment variable `HOROSHOP_STORES_FILE`, or paste JSON and add the variable in the environment field:

```json
{ "mcpServers": { "horoshop": { "command": "node", "args": ["/abs/path/to/horoshop-mcp/dist/index.js"] } } }
```

If Claude Desktop already has the server, **Import from Claude** copies it.

### GitHub Copilot CLI

Run `copilot`, type `/mcp add`, fill in the fields and save with Ctrl+S. Or edit `~/.copilot/mcp-config.json`:

```json
{
  "mcpServers": {
    "horoshop": {
      "command": "node",
      "args": ["/abs/path/to/horoshop-mcp/dist/index.js"],
      "env": { "HOROSHOP_STORES_FILE": "/abs/path/to/stores.json" },
      "tools": ["*"]
    }
  }
}
```

### Amp

```bash
amp mcp add horoshop -- node /abs/path/to/horoshop-mcp/dist/index.js
```

Then add the environment variable in `~/.config/amp/settings.json` (per workspace: `.amp/settings.json`):

```json
{
  "amp.mcpServers": {
    "horoshop": {
      "command": "node",
      "args": ["/abs/path/to/horoshop-mcp/dist/index.js"],
      "env": { "HOROSHOP_STORES_FILE": "/abs/path/to/stores.json" }
    }
  }
}
```

### Warp

**Settings → AI → MCP Servers → Add MCP Server**, choose the stdio type and paste:

```json
{
  "horoshop": {
    "command": "node",
    "args": ["/abs/path/to/horoshop-mcp/dist/index.js"],
    "env": { "HOROSHOP_STORES_FILE": "/abs/path/to/stores.json" }
  }
}
```

### Qwen Code

```bash
qwen mcp add -s user -e HOROSHOP_STORES_FILE=/abs/path/to/stores.json horoshop node /abs/path/to/horoshop-mcp/dist/index.js
```

Or `~/.qwen/settings.json` (per project: `.qwen/settings.json`) with the same `mcpServers` block as [Gemini CLI](#gemini-cli). The default timeout is 10 minutes.

### Crush

`crush.json` in the project, or `~/.config/crush/crush.json`:

```json
{
  "mcp": {
    "horoshop": {
      "type": "stdio",
      "command": "node",
      "args": ["/abs/path/to/horoshop-mcp/dist/index.js"],
      "env": { "HOROSHOP_STORES_FILE": "/abs/path/to/stores.json" }
    }
  }
}
```

### Other clients

Look for "add a local (stdio) MCP server" in your client's docs and provide:

- **command:** `node`
- **arguments:** `/abs/path/to/horoshop-mcp/dist/index.js`
- **environment:** `HOROSHOP_STORES_FILE=/abs/path/to/stores.json`

Most clients use the `mcpServers` JSON shape shown in [Claude Desktop](#claude-desktop).

## Timeouts

Most calls finish in a few seconds, but bulk catalog imports, price-list imports and image uploads can run for a couple of minutes (each HTTP request to the store may take up to `HOROSHOP_TIMEOUT_MS`, 120 seconds by default). Raise the client's per-call timeout where its default is short:

| Client | Setting | Default | Suggested |
|---|---|---|---|
| OpenAI Codex | `tool_timeout_sec` | 60 s | 300 |
| Zed | `timeout` (ms) | 60 s | 300000 |
| Cline | `timeout` (s) | 60 s | 300 |
| Roo Code | `timeout` (s) | 60 s | 300 |
| Goose | `timeout` (s) | asked when adding | 300 |
| Hermes Agent | `timeout` (s) | 300 s | keep |
| Gemini CLI, Qwen Code | `timeout` (ms) | 10 min | keep |

Other clients do not document a per-call timeout.

## Windows notes

- `npx` and globally installed commands are `.cmd` shims on Windows, and most clients cannot start them directly. Wrap them: `"command": "cmd", "args": ["/c", "npx", "-y", "github:IgorShutko/horoshop-mcp"]`. Way C (`node` plus a path) needs no wrapper.
- In JSON either escape backslashes (`"C:\\Users\\me\\stores.json"`) or use forward slashes (`"C:/Users/me/stores.json"`); Node accepts both.
- In TOML use single quotes for paths with backslashes: `'C:\Users\me\stores.json'`.

## Check that it works

1. Ask the agent: *"List my Horoshop stores."* It should call `horoshop_list_stores` and show your store names (never passwords).
2. Ask: *"Check authentication for myshop, both the API and the admin panel."* That runs `horoshop_check_auth` and `horoshop_admin_login_check`.
3. Try a read: *"Show 5 products from myshop with price and availability."*

Run the server by hand to see its log (stop it with Ctrl+C):

```bash
HOROSHOP_STORES_FILE=/abs/path/to/stores.json node /abs/path/to/horoshop-mcp/dist/index.js
```

```powershell
$env:HOROSHOP_STORES_FILE = "C:\path\to\stores.json"; node C:\path\to\horoshop-mcp\dist\index.js
```

A healthy start prints a `[horoshop-mcp] ready` line with the tool count and the number of configured stores. Everything is logged to stderr, because stdout carries the MCP protocol.

To click through the tools without an AI client, open the MCP Inspector from a clone: `npm run inspect`.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| The server does not appear, or tools are missing after an update | Clients start the server once. Restart the client (reconnecting is not always enough). `horoshop_check_auth` reports `stale:true` when the build on disk is newer than the running process. |
| `spawn npx ENOENT` or `spawn horoshop-mcp ENOENT` on Windows | Use the `cmd /c` wrapper or way C. |
| `node: command not found` in a desktop app | Put the absolute path to the `node` binary into `command`. |
| `No stores configured` | `HOROSHOP_STORES_FILE` is not reaching the server: check the `env` block and use an absolute path. |
| `Authentication failed for store ...` | Wrong login or password, or API access is not enabled for the store. Log in to the control panel with the same pair to rule out a typo. |
| `Admin login failed ... credentials rejected` although the API works | The user's role may not be allowed into the control panel, or the password changed. Try the same login in a browser. |
| The first start times out with way A | The first `npx` start builds the package. Start the client again, or raise its startup timeout. |
| A long import is cut off | Raise the client's tool timeout, see [Timeouts](#timeouts). |
| `RESPONSE_TOO_LARGE` | Not an error: the answer was over 100 KB and was held back. Narrow the request as the message suggests, or pass `allowLarge:true`. |
