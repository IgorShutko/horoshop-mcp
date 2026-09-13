# Установка и подключение Хорошоп MCP

[Українська](INSTALL.uk.md) · **Русский** · [English](INSTALL.md)

Хорошоп MCP (`horoshop-mcp`) является неофициальным MCP-сервером для платформы Хорошоп и не связан с компанией Хорошоп. Сервер работает локально и общается с клиентом через **stdio**. Его может использовать любой клиент, который умеет запускать локальную команду и передавать ей переменные окружения. На этой странице: доступы, три способа запуска сервера и пошаговая настройка для 22 клиентов.

## Содержание

- [1. Получите доступы Хорошопа](#1-получите-доступы-хорошопа)
- [2. Создайте stores.json](#2-создайте-storesjson)
- [3. Выберите способ запуска сервера](#3-выберите-способ-запуска-сервера)
- [4. Подключите сервер в своём клиенте](#4-подключите-сервер-в-своём-клиенте)
- [Тайм-ауты](#тайм-ауты)
- [Особенности Windows](#особенности-windows)
- [Проверка работы](#проверка-работы)
- [Если что-то не работает](#если-что-то-не-работает)

## 1. Получите доступы Хорошопа

Сервер входит в магазин как **администратор** Хорошопа. Те же логин и пароль открывают публичный API (`POST /api/auth/`) и админку, с которой работают инструменты `horoshop_admin_*`.

1. В админке магазина откройте **Настройки → Админы** и нажмите **Добавить**. Создавать пользователей может только роль **Owner**.
2. Выберите роль. Инструменты админки действуют в пределах прав этой роли: например, у *Content-manager* нет доступа к заказам и покупателям, а *Owner* видит всё.
3. Сохраните логин и пароль.

Создайте для сервера отдельного пользователя вместо личного логина, чтобы в любой момент закрыть ему доступ и не заблокировать себя. API-токен живёт 600 секунд, сервер обновляет его сам.

Если `horoshop_check_auth` не принимает доступы, с которыми админка открывается, спросите в поддержке Хорошопа, включён ли доступ к API для вашего магазина.

## 2. Создайте stores.json

Один файл может содержать сколько угодно магазинов. Ключ задаёт короткое имя, которое вы (или ИИ-агент) передаёте как `store` в каждом вызове.

```json
{
  "myshop": { "baseUrl": "https://myshop.com.ua", "login": "api-user", "password": "REPLACE_ME" },
  "othershop": { "baseUrl": "othershop.ua", "login": "api-user", "password": "REPLACE_ME" }
}
```

- `baseUrl` можно задать свободно: просто домен, со слешем в конце или с `/api`.
- Если магазин один, он становится магазином по умолчанию. Если их несколько, задайте `HOROSHOP_DEFAULT_STORE` или явно передавайте `store`.
- Не держите файл в общих папках. На macOS и Linux выполните `chmod 600 stores.json`.
- Вместо файла тот же JSON можно положить в переменную окружения `HOROSHOP_STORES`. Файл надёжнее: конфиги клиентов копируют, синхронизируют, и они попадают на скриншоты.

Все переменные окружения описаны в [README](../README.ru.md#настройка).

## 3. Выберите способ запуска сервера

Для всех трёх способов нужны **Node.js 18 или новее** и **Git**.

| Способ | Команда запуска | Когда выбирать |
|---|---|---|
| **A. npx из GitHub** | `npx -y github:IgorShutko/horoshop-mcp` | Не нужно следить за клоном. Первый запуск скачивает и собирает пакет (около 20 секунд), следующие берут его из кеша npm. |
| **B. Глобальная установка** | `horoshop-mcp` | Установите один раз командой `npm install -g github:IgorShutko/horoshop-mcp`, для обновления выполните её ещё раз. |
| **C. Клонирование и сборка** | `node /abs/path/to/horoshop-mcp/dist/index.js` | Самый предсказуемый вариант: без промежуточных обёрток, привязан к коммиту, который вы скачали. Лучше всего подходит для Windows и разработки. |

Способ C:

```bash
git clone https://github.com/IgorShutko/horoshop-mcp.git
cd horoshop-mcp
npm install
```

`npm install` также компилирует TypeScript в `dist/` (скрипт `prepare`). Чтобы обновиться позже: `git pull && npm install`, затем перезапустите MCP-клиент.

**Все примеры ниже используют способ C.** Для A или B измените только `command` и `args`:

| Способ | macOS / Linux | Windows |
|---|---|---|
| A | `"command": "npx", "args": ["-y", "github:IgorShutko/horoshop-mcp"]` | `"command": "cmd", "args": ["/c", "npx", "-y", "github:IgorShutko/horoshop-mcp"]` |
| B | `"command": "horoshop-mcp", "args": []` | `"command": "cmd", "args": ["/c", "horoshop-mcp"]` |
| C | `"command": "node", "args": ["/abs/path/to/horoshop-mcp/dist/index.js"]` | `"command": "node", "args": ["C:/path/to/horoshop-mcp/dist/index.js"]` |

Для команд в терминале правило то же: всё, что стоит после `--` (или после имени сервера), и есть команда запуска.

## 4. Подключите сервер в своём клиенте

| Клиент | Где настройки | Перейти |
|---|---|---|
| Claude Code | `claude mcp add` или `.mcp.json` | [Claude Code](#claude-code) |
| Claude Desktop | `claude_desktop_config.json` | [Claude Desktop](#claude-desktop) |
| Cursor | `~/.cursor/mcp.json` | [Cursor](#cursor) |
| OpenAI Codex (CLI, IDE, приложение) | `codex mcp add` или `~/.codex/config.toml` | [Codex](#openai-codex) |
| Hermes Agent | `hermes mcp add` или `~/.hermes/config.yaml` | [Hermes Agent](#hermes-agent) |
| VS Code (GitHub Copilot) | `.vscode/mcp.json` | [VS Code](#vs-code-github-copilot) |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | [Windsurf](#windsurf) |
| Gemini CLI | `gemini mcp add` или `~/.gemini/settings.json` | [Gemini CLI](#gemini-cli) |
| Zed | `settings.json` → `context_servers` | [Zed](#zed) |
| Cline | `cline_mcp_settings.json` | [Cline](#cline) |
| Roo Code | `.roo/mcp.json` | [Roo Code](#roo-code) |
| Continue | `~/.continue/config.yaml` | [Continue](#continue) |
| OpenCode | `opencode.json` | [OpenCode](#opencode) |
| LM Studio | `~/.lmstudio/mcp.json` | [LM Studio](#lm-studio) |
| Goose | `goose configure` или `config.yaml` | [Goose](#goose) |
| Kiro | `~/.kiro/settings/mcp.json` | [Kiro](#kiro) |
| JetBrains IDEs (AI Assistant) | окно настроек | [JetBrains](#jetbrains-ides-ai-assistant) |
| GitHub Copilot CLI | `~/.copilot/mcp-config.json` | [Copilot CLI](#github-copilot-cli) |
| Amp | `amp mcp add` или `settings.json` | [Amp](#amp) |
| Warp | окно настроек | [Warp](#warp) |
| Qwen Code | `qwen mcp add` или `~/.qwen/settings.json` | [Qwen Code](#qwen-code) |
| Crush | `crush.json` | [Crush](#crush) |
| Любой другой | stdio-команда + переменные окружения | [Другие клиенты](#другие-клиенты) |

Замените `/abs/path/to/...` на настоящие абсолютные пути. Относительные пути не работают, потому что клиенты запускают серверы из своей рабочей папки.

### Claude Code

Одна команда, сервер будет доступен во всех ваших проектах (`-s user`):

```bash
claude mcp add horoshop -s user -e HOROSHOP_STORES_FILE=/abs/path/to/stores.json -- node /abs/path/to/horoshop-mcp/dist/index.js
```

Без клонирования:

```bash
claude mcp add horoshop -s user -e HOROSHOP_STORES_FILE=/abs/path/to/stores.json -- npx -y github:IgorShutko/horoshop-mcp
```

Области видимости: `local` (по умолчанию: этот проект, только вы), `project` (записывает `.mcp.json` в корень репозитория, общий через git), `user` (все проекты). Файл `.mcp.json`, написанный вручную, выглядит так:

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

Проверка: `claude mcp list` в терминале или `/mcp` внутри сессии. В Windows после `--` пишите `cmd /c npx -y github:IgorShutko/horoshop-mcp`.

### Claude Desktop

Откройте **Settings → Developer → Edit Config** из меню Claude или отредактируйте файл напрямую:

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

Полностью закройте Claude и запустите снова: закрыть окно недостаточно. Десктопные приложения не загружают профиль вашей оболочки, поэтому если Node установлен через nvm или похожий менеджер, укажите в `command` абсолютный путь к `node` (найти его поможет `which node` или `where node`). Логи: `~/Library/Logs/Claude/mcp*.log` на macOS, `%APPDATA%\Claude\logs` в Windows.

### Cursor

Глобально: `~/.cursor/mcp.json`. Для проекта: `.cursor/mcp.json`.

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

Для stdio-серверов Cursor также принимает `"envFile": "/abs/path/to/.env"`. Список серверов со статусом подключения находится в настройках Cursor в разделе MCP, логи сервера в панели Output, канал **MCP Logs**.

### OpenAI Codex

Codex CLI, расширение для IDE и десктопное приложение используют общую конфигурацию, поэтому сервер достаточно добавить один раз.

```bash
codex mcp add horoshop --env HOROSHOP_STORES_FILE=/abs/path/to/stores.json -- node /abs/path/to/horoshop-mcp/dist/index.js
```

Затем увеличьте тайм-ауты в `~/.codex/config.toml` (или в `.codex/config.toml` проекта). По умолчанию Codex ждёт вызов инструмента только 60 секунд, а массовые импорты могут длиться дольше:

```toml
[mcp_servers.horoshop]
command = "node"
args = ["/abs/path/to/horoshop-mcp/dist/index.js"]
env = { "HOROSHOP_STORES_FILE" = "/abs/path/to/stores.json" }
startup_timeout_sec = 60
tool_timeout_sec = 300
```

`startup_timeout_sec = 60` важен для способа A, где первый запуск собирает пакет. В Windows записывайте пути как литеральные строки TOML: `args = ['C:\path\to\horoshop-mcp\dist\index.js']`. Проверка: `codex mcp list` или `/mcp` в сессии.

### Hermes Agent

[Hermes Agent](https://github.com/NousResearch/hermes-agent) от Nous Research:

```bash
hermes mcp add horoshop --command node --env HOROSHOP_STORES_FILE=/abs/path/to/stores.json --args /abs/path/to/horoshop-mcp/dist/index.js
```

`--args` должен быть последним флагом. То же в `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  horoshop:
    command: "node"
    args: ["/abs/path/to/horoshop-mcp/dist/index.js"]
    env:
      HOROSHOP_STORES_FILE: "/abs/path/to/stores.json"
    timeout: 300
```

Проверка: `hermes mcp list`, `hermes mcp test horoshop` или `/reload-mcp` в чате.

### VS Code (GitHub Copilot)

Для рабочей области: `.vscode/mcp.json`. Для всех рабочих областей выполните **MCP: Open User Configuration** из Command Palette. Обратите внимание: ключ верхнего уровня `servers`, а не `mcpServers`:

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

Из терминала:

```bash
code --add-mcp '{"name":"horoshop","command":"node","args":["/abs/path/to/horoshop-mcp/dist/index.js"],"env":{"HOROSHOP_STORES_FILE":"/abs/path/to/stores.json"}}'
```

`${env:VAR}` внутри `mcp.json` не раскрывается, поэтому пишите пути полностью. Проверка: **MCP: List Servers** → выберите сервер → **Show Output**.

### Windsurf

`~/.codeium/windsurf/mcp_config.json` (Windows: `%USERPROFILE%\.codeium\windsurf\mcp_config.json`) или откройте файл из панели Cascade через значок MCP:

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

Windsurf раскрывает `${env:VAR}` в этом файле. Новые сборки с агентом Devin Local читают тот же формат из `~/.config/devin/mcp_config.json` (Windows: `%APPDATA%\devin\mcp_config.json`) или из `.devin/mcp_config.json` в проекте.

### Gemini CLI

```bash
gemini mcp add -s user -e HOROSHOP_STORES_FILE=/abs/path/to/stores.json horoshop node /abs/path/to/horoshop-mcp/dist/index.js
```

Или `~/.gemini/settings.json` (для проекта: `.gemini/settings.json`):

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

Тайм-аут вызова по умолчанию 10 минут, этого достаточно. Проверка: `gemini mcp list` или `/mcp list` в сессии.

### Zed

`~/.config/zed/settings.json` (Windows: `%APPDATA%\Zed\settings.json`) или **Settings → AI → MCP Servers → Add Server**:

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

Zed перестаёт ждать через 60 секунд, если `timeout` (в миллисекундах) не задаёт другое. В старых инструкциях встречается вложенный формат `"command": { "path": ... }`; актуален именно плоский формат выше. Зелёная точка рядом с сервером означает, что он работает.

### Cline

В панели Cline откройте **MCP Servers → Configure → Configure MCP Servers**. Откроется `cline_mcp_settings.json`:

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

`timeout` задаётся в секундах (по умолчанию 60). Оставьте `autoApprove` пустым или добавьте туда только инструменты чтения.

### Roo Code

Для проекта: `.roo/mcp.json`. Глобально: панель MCP → **Edit Global MCP**.

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

`timeout` задаётся в секундах (по умолчанию 60).

### Continue

Добавьте в `~/.continue/config.yaml` (для проекта: `.continue/config.yaml`):

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

`~/.config/opencode/opencode.json` или `opencode.json` в корне проекта:

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

**Program → Install → Edit mcp.json** или отредактируйте `~/.lmstudio/mcp.json` (Windows: `%USERPROFILE%\.lmstudio\mcp.json`):

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

Выполните `goose configure` → **Add Extension** → **Command-line Extension** и ответьте на вопросы (имя, команда, тайм-аут, переменные окружения). Результат в `~/.config/goose/config.yaml` (Windows: `%APPDATA%\Block\goose\config\config.yaml`):

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

Для пользователя: `~/.kiro/settings/mcp.json`. Для рабочей области: `.kiro/settings/mcp.json`.

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

Откройте **Settings → Tools → AI Assistant → Model Context Protocol (MCP) → Add**. Укажите команду (`node`), аргумент (`/abs/path/to/horoshop-mcp/dist/index.js`) и переменную окружения `HOROSHOP_STORES_FILE` или вставьте JSON и добавьте переменную в поле переменных окружения:

```json
{ "mcpServers": { "horoshop": { "command": "node", "args": ["/abs/path/to/horoshop-mcp/dist/index.js"] } } }
```

Если сервер уже настроен в Claude Desktop, его скопирует кнопка **Import from Claude**.

### GitHub Copilot CLI

Запустите `copilot`, введите `/mcp add`, заполните поля и сохраните через Ctrl+S. Или отредактируйте `~/.copilot/mcp-config.json`:

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

Затем добавьте переменную окружения в `~/.config/amp/settings.json` (для рабочей области: `.amp/settings.json`):

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

**Settings → AI → MCP Servers → Add MCP Server**, выберите тип stdio и вставьте:

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

Или `~/.qwen/settings.json` (для проекта: `.qwen/settings.json`) с тем же блоком `mcpServers`, что и в [Gemini CLI](#gemini-cli). Тайм-аут по умолчанию 10 минут.

### Crush

`crush.json` в проекте или `~/.config/crush/crush.json`:

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

### Другие клиенты

Найдите в документации своего клиента раздел о добавлении локального (stdio) MCP-сервера и укажите:

- **команда:** `node`
- **аргументы:** `/abs/path/to/horoshop-mcp/dist/index.js`
- **переменные окружения:** `HOROSHOP_STORES_FILE=/abs/path/to/stores.json`

Большинство клиентов используют JSON-формат `mcpServers`, как в разделе [Claude Desktop](#claude-desktop).

## Тайм-ауты

Большинство вызовов завершаются за несколько секунд, но массовый импорт каталога, импорт прайсов и загрузка изображений могут идти несколько минут (каждый HTTP-запрос к магазину может занимать до `HOROSHOP_TIMEOUT_MS`, по умолчанию 120 секунд). Увеличьте тайм-аут вызова там, где у клиента он короткий:

| Клиент | Параметр | По умолчанию | Рекомендуется |
|---|---|---|---|
| OpenAI Codex | `tool_timeout_sec` | 60 с | 300 |
| Zed | `timeout` (мс) | 60 с | 300000 |
| Cline | `timeout` (с) | 60 с | 300 |
| Roo Code | `timeout` (с) | 60 с | 300 |
| Goose | `timeout` (с) | спрашивается при добавлении | 300 |
| Hermes Agent | `timeout` (с) | 300 с | не менять |
| Gemini CLI, Qwen Code | `timeout` (мс) | 10 мин | не менять |

Остальные клиенты не описывают тайм-аут отдельного вызова.

## Особенности Windows

- `npx` и глобально установленные команды в Windows являются обёртками `.cmd`, и большинство клиентов не могут запустить их напрямую. Оберните их так: `"command": "cmd", "args": ["/c", "npx", "-y", "github:IgorShutko/horoshop-mcp"]`. Способ C (`node` плюс путь) обёртки не требует.
- В JSON либо экранируйте обратные слеши (`"C:\\Users\\me\\stores.json"`), либо пишите прямые (`"C:/Users/me/stores.json"`); Node понимает оба варианта.
- В TOML берите пути с обратными слешами в одинарные кавычки: `'C:\Users\me\stores.json'`.

## Проверка работы

1. Попросите агента: *«Покажи мои магазины на Хорошопе.»* Он должен вызвать `horoshop_list_stores` и показать имена магазинов (но никогда пароли).
2. Попросите: *«Проверь авторизацию для myshop, и в API, и в админке.»* Это запустит `horoshop_check_auth` и `horoshop_admin_login_check`.
3. Попробуйте чтение: *«Покажи 5 товаров из myshop с ценой и наличием.»*

Чтобы увидеть лог, запустите сервер вручную (остановка через Ctrl+C):

```bash
HOROSHOP_STORES_FILE=/abs/path/to/stores.json node /abs/path/to/horoshop-mcp/dist/index.js
```

```powershell
$env:HOROSHOP_STORES_FILE = "C:\path\to\stores.json"; node C:\path\to\horoshop-mcp\dist\index.js
```

При исправном запуске появляется строка `[horoshop-mcp] ready` с числом инструментов и настроенных магазинов. Все логи идут в stderr, потому что через stdout передаётся протокол MCP.

Чтобы перебрать инструменты без ИИ-клиента, откройте MCP Inspector из клона: `npm run inspect`.

## Если что-то не работает

| Симптом | Причина и решение |
|---|---|
| Сервер не появляется или после обновления не хватает инструментов | Клиенты запускают сервер один раз. Перезапустите клиент (переподключение помогает не всегда). `horoshop_check_auth` возвращает `stale:true`, если сборка на диске новее запущенного процесса. |
| `spawn npx ENOENT` или `spawn horoshop-mcp ENOENT` в Windows | Используйте обёртку `cmd /c` или способ C. |
| `node: command not found` в десктопном приложении | Укажите в `command` абсолютный путь к `node`. |
| `No stores configured` | `HOROSHOP_STORES_FILE` не доходит до сервера: проверьте блок `env` и укажите абсолютный путь. |
| `Authentication failed for store ...` | Неверный логин или пароль либо для магазина не включён доступ к API. Войдите в админку с той же парой, чтобы исключить опечатку. |
| `Admin login failed ... credentials rejected`, хотя API работает | У роли пользователя может не быть доступа к админке, или пароль сменился. Попробуйте тот же логин в браузере. |
| Первый запуск способом A обрывается по тайм-ауту | Первый запуск `npx` собирает пакет. Запустите клиент ещё раз или увеличьте тайм-аут запуска. |
| Долгий импорт обрывается | Увеличьте тайм-аут инструментов в клиенте, см. [тайм-ауты](#тайм-ауты). |
| `RESPONSE_TOO_LARGE` | Это не ошибка: ответ превысил 100 KB и не был возвращён. Сузьте запрос, как подсказывает сообщение, или передайте `allowLarge:true`. |
