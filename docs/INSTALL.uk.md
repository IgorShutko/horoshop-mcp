# Встановлення і підключення Хорошоп MCP

**Українська** · [Русский](INSTALL.ru.md) · [English](INSTALL.md)

Хорошоп MCP (`horoshop-mcp`) є неофіційним MCP-сервером для платформи Хорошоп і не пов'язаний з компанією Хорошоп. Сервер працює локально і спілкується з клієнтом через **stdio**. Його може використовувати будь-який клієнт, який уміє запускати локальну команду і передавати їй змінні середовища. На цій сторінці: доступи, три способи запуску сервера і покрокове налаштування для 22 клієнтів.

## Зміст

- [1. Отримайте доступи Хорошопу](#1-отримайте-доступи-хорошопу)
- [2. Створіть stores.json](#2-створіть-storesjson)
- [3. Оберіть спосіб запуску сервера](#3-оберіть-спосіб-запуску-сервера)
- [4. Підключіть сервер у своєму клієнті](#4-підключіть-сервер-у-своєму-клієнті)
- [Тайм-аути](#тайм-аути)
- [Особливості Windows](#особливості-windows)
- [Перевірка роботи](#перевірка-роботи)
- [Якщо щось не працює](#якщо-щось-не-працює)

## 1. Отримайте доступи Хорошопу

Сервер входить у магазин як **адміністратор** Хорошопу. Той самий логін і пароль відкривають публічний API (`POST /api/auth/`) і адмінку, з якою працюють інструменти `horoshop_admin_*`.

1. В адмінці магазину відкрийте розділ адміністраторів («Настройки → Админы» у російському інтерфейсі) і додайте нового користувача («Добавить»). Створювати користувачів може лише роль **Owner**.
2. Оберіть роль. Інструменти адмінки діють у межах прав цієї ролі: наприклад, *Content-manager* не має доступу до замовлень і покупців, а *Owner* бачить усе.
3. Збережіть логін і пароль.

Створіть для сервера окремого користувача замість особистого логіна, щоб будь-коли закрити йому доступ і не заблокувати себе. API-токен живе 600 секунд, сервер оновлює його сам.

Якщо `horoshop_check_auth` не приймає доступи, з якими адмінка відкривається, запитайте в підтримці Хорошопу, чи ввімкнено доступ до API для вашого магазину.

## 2. Створіть stores.json

Один файл може містити скільки завгодно магазинів. Ключ задає коротку назву, яку ви (або ШІ-агент) передаєте як `store` у кожному виклику.

```json
{
  "myshop": { "baseUrl": "https://myshop.com.ua", "login": "api-user", "password": "REPLACE_ME" },
  "othershop": { "baseUrl": "othershop.ua", "login": "api-user", "password": "REPLACE_ME" }
}
```

- `baseUrl` можна задати вільно: просто домен, зі слешем у кінці або з `/api`.
- Якщо магазин один, він стає магазином за замовчуванням. Якщо кілька, задайте `HOROSHOP_DEFAULT_STORE` або явно передавайте `store`.
- Не тримайте файл у спільних папках. На macOS і Linux виконайте `chmod 600 stores.json`.
- Замість файлу той самий JSON можна покласти у змінну середовища `HOROSHOP_STORES`. Файл надійніший: конфіги клієнтів копіюють, синхронізують, і вони потрапляють на скриншоти.

Усі змінні середовища описані в [README](../README.md#налаштування).

## 3. Оберіть спосіб запуску сервера

Для всіх трьох способів потрібні **Node.js 18 або новіший** і **Git**.

| Спосіб | Команда запуску | Коли обирати |
|---|---|---|
| **A. npx з GitHub** | `npx -y github:IgorShutko/horoshop-mcp` | Не треба стежити за клоном. Перший запуск завантажує і збирає пакет (близько 20 секунд), наступні беруть його з кешу npm. |
| **B. Глобальне встановлення** | `horoshop-mcp` | Встановіть один раз командою `npm install -g github:IgorShutko/horoshop-mcp`, для оновлення виконайте її ще раз. |
| **C. Клонування і збірка** | `node /abs/path/to/horoshop-mcp/dist/index.js` | Найпередбачуваніший варіант: без проміжних обгорток, прив'язаний до коміту, який ви завантажили. Найкраще підходить для Windows і розробки. |

Спосіб C:

```bash
git clone https://github.com/IgorShutko/horoshop-mcp.git
cd horoshop-mcp
npm install
```

`npm install` також компілює TypeScript у `dist/` (скрипт `prepare`). Щоб оновитися пізніше: `git pull && npm install`, потім перезапустіть MCP-клієнт.

**Усі приклади нижче використовують спосіб C.** Для A або B змініть лише `command` і `args`:

| Спосіб | macOS / Linux | Windows |
|---|---|---|
| A | `"command": "npx", "args": ["-y", "github:IgorShutko/horoshop-mcp"]` | `"command": "cmd", "args": ["/c", "npx", "-y", "github:IgorShutko/horoshop-mcp"]` |
| B | `"command": "horoshop-mcp", "args": []` | `"command": "cmd", "args": ["/c", "horoshop-mcp"]` |
| C | `"command": "node", "args": ["/abs/path/to/horoshop-mcp/dist/index.js"]` | `"command": "node", "args": ["C:/path/to/horoshop-mcp/dist/index.js"]` |

Для команд у терміналі правило те саме: усе, що стоїть після `--` (або після назви сервера), і є командою запуску.

## 4. Підключіть сервер у своєму клієнті

| Клієнт | Де налаштування | Перейти |
|---|---|---|
| Claude Code | `claude mcp add` або `.mcp.json` | [Claude Code](#claude-code) |
| Claude Desktop | `claude_desktop_config.json` | [Claude Desktop](#claude-desktop) |
| Cursor | `~/.cursor/mcp.json` | [Cursor](#cursor) |
| OpenAI Codex (CLI, IDE, застосунок) | `codex mcp add` або `~/.codex/config.toml` | [Codex](#openai-codex) |
| Hermes Agent | `hermes mcp add` або `~/.hermes/config.yaml` | [Hermes Agent](#hermes-agent) |
| VS Code (GitHub Copilot) | `.vscode/mcp.json` | [VS Code](#vs-code-github-copilot) |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | [Windsurf](#windsurf) |
| Gemini CLI | `gemini mcp add` або `~/.gemini/settings.json` | [Gemini CLI](#gemini-cli) |
| Zed | `settings.json` → `context_servers` | [Zed](#zed) |
| Cline | `cline_mcp_settings.json` | [Cline](#cline) |
| Roo Code | `.roo/mcp.json` | [Roo Code](#roo-code) |
| Continue | `~/.continue/config.yaml` | [Continue](#continue) |
| OpenCode | `opencode.json` | [OpenCode](#opencode) |
| LM Studio | `~/.lmstudio/mcp.json` | [LM Studio](#lm-studio) |
| Goose | `goose configure` або `config.yaml` | [Goose](#goose) |
| Kiro | `~/.kiro/settings/mcp.json` | [Kiro](#kiro) |
| JetBrains IDEs (AI Assistant) | вікно налаштувань | [JetBrains](#jetbrains-ides-ai-assistant) |
| GitHub Copilot CLI | `~/.copilot/mcp-config.json` | [Copilot CLI](#github-copilot-cli) |
| Amp | `amp mcp add` або `settings.json` | [Amp](#amp) |
| Warp | вікно налаштувань | [Warp](#warp) |
| Qwen Code | `qwen mcp add` або `~/.qwen/settings.json` | [Qwen Code](#qwen-code) |
| Crush | `crush.json` | [Crush](#crush) |
| Будь-який інший | stdio-команда + змінні середовища | [Інші клієнти](#інші-клієнти) |

Замініть `/abs/path/to/...` на справжні абсолютні шляхи. Відносні шляхи не працюють, бо клієнти запускають сервери зі своєї робочої папки.

### Claude Code

Одна команда, сервер буде доступний у всіх ваших проєктах (`-s user`):

```bash
claude mcp add horoshop -s user -e HOROSHOP_STORES_FILE=/abs/path/to/stores.json -- node /abs/path/to/horoshop-mcp/dist/index.js
```

Без клонування:

```bash
claude mcp add horoshop -s user -e HOROSHOP_STORES_FILE=/abs/path/to/stores.json -- npx -y github:IgorShutko/horoshop-mcp
```

Області видимості: `local` (за замовчуванням: цей проєкт, лише ви), `project` (записує `.mcp.json` у корінь репозиторію, спільний через git), `user` (усі проєкти). Файл `.mcp.json`, написаний вручну, виглядає так:

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

Перевірка: `claude mcp list` у терміналі або `/mcp` усередині сесії. У Windows після `--` пишіть `cmd /c npx -y github:IgorShutko/horoshop-mcp`.

### Claude Desktop

Відкрийте **Settings → Developer → Edit Config** з меню Claude або відредагуйте файл напряму:

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

Повністю закрийте Claude і запустіть знову: закрити вікно недостатньо. Настільні застосунки не завантажують профіль вашої оболонки, тож якщо Node встановлено через nvm чи схожий менеджер, вкажіть у `command` абсолютний шлях до `node` (знайти його допоможе `which node` або `where node`). Логи: `~/Library/Logs/Claude/mcp*.log` на macOS, `%APPDATA%\Claude\logs` у Windows.

### Cursor

Глобально: `~/.cursor/mcp.json`. Для проєкту: `.cursor/mcp.json`.

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

Для stdio-серверів Cursor також приймає `"envFile": "/abs/path/to/.env"`. Список серверів зі статусом підключення знаходиться в налаштуваннях Cursor у розділі MCP, логи сервера в панелі Output, канал **MCP Logs**.

### OpenAI Codex

Codex CLI, розширення для IDE і настільний застосунок використовують спільну конфігурацію, тож сервер достатньо додати один раз.

```bash
codex mcp add horoshop --env HOROSHOP_STORES_FILE=/abs/path/to/stores.json -- node /abs/path/to/horoshop-mcp/dist/index.js
```

Потім збільште тайм-аути в `~/.codex/config.toml` (або в `.codex/config.toml` проєкту). За замовчуванням Codex чекає на виклик інструмента лише 60 секунд, а масові імпорти можуть тривати довше:

```toml
[mcp_servers.horoshop]
command = "node"
args = ["/abs/path/to/horoshop-mcp/dist/index.js"]
env = { "HOROSHOP_STORES_FILE" = "/abs/path/to/stores.json" }
startup_timeout_sec = 60
tool_timeout_sec = 300
```

`startup_timeout_sec = 60` важливий для способу A, де перший запуск збирає пакет. У Windows записуйте шляхи як літеральні рядки TOML: `args = ['C:\path\to\horoshop-mcp\dist\index.js']`. Перевірка: `codex mcp list` або `/mcp` у сесії.

### Hermes Agent

[Hermes Agent](https://github.com/NousResearch/hermes-agent) від Nous Research:

```bash
hermes mcp add horoshop --command node --env HOROSHOP_STORES_FILE=/abs/path/to/stores.json --args /abs/path/to/horoshop-mcp/dist/index.js
```

`--args` має бути останнім прапорцем. Те саме у `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  horoshop:
    command: "node"
    args: ["/abs/path/to/horoshop-mcp/dist/index.js"]
    env:
      HOROSHOP_STORES_FILE: "/abs/path/to/stores.json"
    timeout: 300
```

Перевірка: `hermes mcp list`, `hermes mcp test horoshop` або `/reload-mcp` у чаті.

### VS Code (GitHub Copilot)

Для робочої області: `.vscode/mcp.json`. Для всіх робочих областей виконайте **MCP: Open User Configuration** з Command Palette. Зверніть увагу: ключ верхнього рівня `servers`, а не `mcpServers`:

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

З терміналу:

```bash
code --add-mcp '{"name":"horoshop","command":"node","args":["/abs/path/to/horoshop-mcp/dist/index.js"],"env":{"HOROSHOP_STORES_FILE":"/abs/path/to/stores.json"}}'
```

`${env:VAR}` усередині `mcp.json` не розгортається, тому пишіть шляхи повністю. Перевірка: **MCP: List Servers** → оберіть сервер → **Show Output**.

### Windsurf

`~/.codeium/windsurf/mcp_config.json` (Windows: `%USERPROFILE%\.codeium\windsurf\mcp_config.json`) або відкрийте файл з панелі Cascade через значок MCP:

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

Windsurf розгортає `${env:VAR}` у цьому файлі. Новіші збірки з агентом Devin Local читають той самий формат з `~/.config/devin/mcp_config.json` (Windows: `%APPDATA%\devin\mcp_config.json`) або з `.devin/mcp_config.json` у проєкті.

### Gemini CLI

```bash
gemini mcp add -s user -e HOROSHOP_STORES_FILE=/abs/path/to/stores.json horoshop node /abs/path/to/horoshop-mcp/dist/index.js
```

Або `~/.gemini/settings.json` (для проєкту: `.gemini/settings.json`):

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

Тайм-аут виклику за замовчуванням 10 хвилин, цього достатньо. Перевірка: `gemini mcp list` або `/mcp list` у сесії.

### Zed

`~/.config/zed/settings.json` (Windows: `%APPDATA%\Zed\settings.json`) або **Settings → AI → MCP Servers → Add Server**:

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

Zed перестає чекати через 60 секунд, якщо `timeout` (у мілісекундах) не задає інше. У старих інструкціях трапляється вкладений формат `"command": { "path": ... }`; актуальний саме плоский формат вище. Зелена крапка біля сервера означає, що він працює.

### Cline

У панелі Cline відкрийте **MCP Servers → Configure → Configure MCP Servers**. Відкриється `cline_mcp_settings.json`:

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

`timeout` задається в секундах (за замовчуванням 60). Залиште `autoApprove` порожнім або додайте туди лише інструменти читання.

### Roo Code

Для проєкту: `.roo/mcp.json`. Глобально: панель MCP → **Edit Global MCP**.

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

`timeout` задається в секундах (за замовчуванням 60).

### Continue

Додайте в `~/.continue/config.yaml` (для проєкту: `.continue/config.yaml`):

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

`~/.config/opencode/opencode.json` або `opencode.json` у корені проєкту:

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

**Program → Install → Edit mcp.json** або відредагуйте `~/.lmstudio/mcp.json` (Windows: `%USERPROFILE%\.lmstudio\mcp.json`):

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

Виконайте `goose configure` → **Add Extension** → **Command-line Extension** і дайте відповіді на запитання (назва, команда, тайм-аут, змінні середовища). Результат у `~/.config/goose/config.yaml` (Windows: `%APPDATA%\Block\goose\config\config.yaml`):

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

Для користувача: `~/.kiro/settings/mcp.json`. Для робочої області: `.kiro/settings/mcp.json`.

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

Відкрийте **Settings → Tools → AI Assistant → Model Context Protocol (MCP) → Add**. Вкажіть команду (`node`), аргумент (`/abs/path/to/horoshop-mcp/dist/index.js`) і змінну середовища `HOROSHOP_STORES_FILE` або вставте JSON і додайте змінну в поле змінних середовища:

```json
{ "mcpServers": { "horoshop": { "command": "node", "args": ["/abs/path/to/horoshop-mcp/dist/index.js"] } } }
```

Якщо сервер уже налаштований у Claude Desktop, його скопіює кнопка **Import from Claude**.

### GitHub Copilot CLI

Запустіть `copilot`, введіть `/mcp add`, заповніть поля і збережіть через Ctrl+S. Або відредагуйте `~/.copilot/mcp-config.json`:

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

Потім додайте змінну середовища в `~/.config/amp/settings.json` (для робочої області: `.amp/settings.json`):

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

**Settings → AI → MCP Servers → Add MCP Server**, оберіть тип stdio і вставте:

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

Або `~/.qwen/settings.json` (для проєкту: `.qwen/settings.json`) з тим самим блоком `mcpServers`, що і в [Gemini CLI](#gemini-cli). Тайм-аут за замовчуванням 10 хвилин.

### Crush

`crush.json` у проєкті або `~/.config/crush/crush.json`:

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

### Інші клієнти

Знайдіть у документації свого клієнта розділ про додавання локального (stdio) MCP-сервера і вкажіть:

- **команда:** `node`
- **аргументи:** `/abs/path/to/horoshop-mcp/dist/index.js`
- **змінні середовища:** `HOROSHOP_STORES_FILE=/abs/path/to/stores.json`

Більшість клієнтів використовують JSON-формат `mcpServers`, як у розділі [Claude Desktop](#claude-desktop).

## Тайм-аути

Більшість викликів завершуються за кілька секунд, але масові імпорти каталогу, імпорт прайсів і завантаження зображень можуть тривати кілька хвилин (кожен HTTP-запит до магазину може займати до `HOROSHOP_TIMEOUT_MS`, за замовчуванням 120 секунд). Збільште тайм-аут виклику там, де в клієнта він короткий:

| Клієнт | Параметр | За замовчуванням | Рекомендовано |
|---|---|---|---|
| OpenAI Codex | `tool_timeout_sec` | 60 с | 300 |
| Zed | `timeout` (мс) | 60 с | 300000 |
| Cline | `timeout` (с) | 60 с | 300 |
| Roo Code | `timeout` (с) | 60 с | 300 |
| Goose | `timeout` (с) | запитується під час додавання | 300 |
| Hermes Agent | `timeout` (с) | 300 с | не змінювати |
| Gemini CLI, Qwen Code | `timeout` (мс) | 10 хв | не змінювати |

Інші клієнти не описують тайм-аут окремого виклику.

## Особливості Windows

- `npx` і глобально встановлені команди у Windows є обгортками `.cmd`, і більшість клієнтів не можуть запустити їх напряму. Загорніть їх так: `"command": "cmd", "args": ["/c", "npx", "-y", "github:IgorShutko/horoshop-mcp"]`. Спосіб C (`node` плюс шлях) обгортки не потребує.
- У JSON або екрануйте зворотні слеші (`"C:\\Users\\me\\stores.json"`), або пишіть прямі (`"C:/Users/me/stores.json"`); Node розуміє обидва варіанти.
- У TOML беріть шляхи зі зворотними слешами в одинарні лапки: `'C:\Users\me\stores.json'`.

## Перевірка роботи

1. Попросіть агента: *«Покажи мої магазини на Хорошопі.»* Він має викликати `horoshop_list_stores` і показати назви магазинів (але ніколи паролі).
2. Попросіть: *«Перевір авторизацію для myshop, і в API, і в адмінці.»* Це запустить `horoshop_check_auth` і `horoshop_admin_login_check`.
3. Спробуйте читання: *«Покажи 5 товарів з myshop з ціною і наявністю.»*

Щоб побачити лог, запустіть сервер вручну (зупинка через Ctrl+C):

```bash
HOROSHOP_STORES_FILE=/abs/path/to/stores.json node /abs/path/to/horoshop-mcp/dist/index.js
```

```powershell
$env:HOROSHOP_STORES_FILE = "C:\path\to\stores.json"; node C:\path\to\horoshop-mcp\dist\index.js
```

Під час справного запуску з'являється рядок `[horoshop-mcp] ready` з кількістю інструментів і налаштованих магазинів. Усі логи йдуть у stderr, бо через stdout передається протокол MCP.

Щоб перебрати інструменти без ШІ-клієнта, відкрийте MCP Inspector з клону: `npm run inspect`.

## Якщо щось не працює

| Симптом | Причина і рішення |
|---|---|
| Сервер не з'являється або після оновлення бракує інструментів | Клієнти запускають сервер один раз. Перезапустіть клієнт (перепідключення допомагає не завжди). `horoshop_check_auth` повертає `stale:true`, якщо збірка на диску новіша за запущений процес. |
| `spawn npx ENOENT` або `spawn horoshop-mcp ENOENT` у Windows | Використайте обгортку `cmd /c` або спосіб C. |
| `node: command not found` у настільному застосунку | Вкажіть у `command` абсолютний шлях до `node`. |
| `No stores configured` | `HOROSHOP_STORES_FILE` не доходить до сервера: перевірте блок `env` і вкажіть абсолютний шлях. |
| `Authentication failed for store ...` | Неправильний логін чи пароль або для магазину не ввімкнено доступ до API. Увійдіть в адмінку з тією самою парою, щоб виключити помилку в написанні. |
| `Admin login failed ... credentials rejected`, хоча API працює | Роль користувача може не мати доступу до адмінки, або пароль змінився. Спробуйте той самий логін у браузері. |
| Перший запуск способом A обривається по тайм-ауту | Перший запуск `npx` збирає пакет. Запустіть клієнт ще раз або збільште тайм-аут запуску. |
| Довгий імпорт обривається | Збільште тайм-аут інструментів у клієнті, див. [тайм-аути](#тайм-аути). |
| `RESPONSE_TOO_LARGE` | Це не помилка: відповідь перевищила 100 KB і її не повернули. Звузьте запит, як підказує повідомлення, або передайте `allowLarge:true`. |
