#!/usr/bin/env node
// Builds the project site (uk/ru/en) into site/_site. Section counts come from
// docs/tools.json, so the page cannot claim tools the server does not have.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(ROOT, "site");
const OUT = join(SITE, "_site");
const BASE = "https://igorshutko.github.io/horoshop-mcp";
const REPO = "https://github.com/IgorShutko/horoshop-mcp";

const tools = JSON.parse(readFileSync(join(ROOT, "docs", "tools.json"), "utf8"));
// style.min.css is the committed cssnano build; style.css is the readable source.
const cssFile = existsSync(join(SITE, "style.min.css")) ? "style.min.css" : "style.css";
const css = readFileSync(join(SITE, cssFile), "utf8");
const INSTALL = "npx -y github:IgorShutko/horoshop-mcp";

// Section titles are English in the generated reference; the site names them in
// each language, keyed by the generated title so a rename here fails loudly.
const SECTION_NAMES = {
  "Setup and diagnostics": ["Підключення і діагностика", "Подключение и диагностика", "Setup and diagnostics"],
  "Catalog (public API)": ["Каталог товарів", "Каталог товаров", "Catalog"],
  "Orders (public API)": ["Замовлення", "Заказы", "Orders"],
  "Categories, users, product sets (public API)": ["Категорії, покупці, комплекти", "Категории, покупатели, комплекты", "Categories, customers, product sets"],
  "Payment, delivery, currency (public API)": ["Оплата, доставка, валюти", "Оплата, доставка, валюты", "Payment, delivery, currency"],
  "B2B (public API)": ["B2B: групи і рівні цін", "B2B: группы и уровни цен", "B2B: groups and price levels"],
  "Webhooks (public API)": ["Вебхуки", "Вебхуки", "Webhooks"],
  "Storefront: cart and checkout": ["Вітрина: кошик і оформлення", "Витрина: корзина и оформление", "Storefront: cart and checkout"],
  "Admin panel: generic engine": ["Адмінка: універсальний рушій", "Админка: универсальный движок", "Admin: generic engine"],
  "Admin panel: orders and analytics": ["Адмінка: замовлення й аналітика", "Админка: заказы и аналитика", "Admin: orders and analytics"],
  "Admin panel: products, prices, images": ["Адмінка: товари, ціни, фото", "Админка: товары, цены, фото", "Admin: products, prices, images"],
  "Admin panel: characteristics and dictionaries": ["Адмінка: характеристики й довідники", "Админка: характеристики и справочники", "Admin: characteristics and dictionaries"],
  "Admin panel: categories, pages, blog, banners, filters": ["Адмінка: категорії, сторінки, блог, банери, фільтри", "Админка: категории, страницы, блог, баннеры, фильтры", "Admin: categories, pages, blog, banners, filters"],
  "Admin panel: SEO, sitemap, redirects": ["Адмінка: SEO, sitemap, редиректи", "Админка: SEO, sitemap, редиректы", "Admin: SEO, sitemap, redirects"],
  "Admin panel: marketplace feeds": ["Адмінка: фіди маркетплейсів", "Админка: фиды маркетплейсов", "Admin: marketplace feeds"],
  "Admin panel: design and localization": ["Адмінка: дизайн і мови", "Админка: дизайн и языки", "Admin: design and localization"],
  "Admin panel: store settings, marketing, fiscal receipts": ["Адмінка: налаштування, маркетинг, чеки", "Админка: настройки, маркетинг, чеки", "Admin: settings, marketing, fiscal receipts"],
};

const SECTION_EXAMPLES = {
  "Setup and diagnostics": ["перелік магазинів, перевірка доступу", "список магазинов, проверка доступа", "store list, access check"],
  "Catalog (public API)": ["експорт та імпорт товарів, прив'язка фото", "экспорт и импорт товаров, привязка фото", "product export and import, image linking"],
  "Orders (public API)": ["замовлення з UTM, зміна статусу", "заказы с UTM, смена статуса", "orders with UTM, status changes"],
  "Categories, users, product sets (public API)": ["дерево категорій, покупці, комплекти", "дерево категорий, покупатели, комплекты", "category tree, customers, bundles"],
  "Payment, delivery, currency (public API)": ["способи оплати й доставки, курси", "способы оплаты и доставки, курсы", "payment and delivery methods, rates"],
  "B2B (public API)": ["групи покупців, рівні цін", "группы покупателей, уровни цен", "customer groups, price levels"],
  "Webhooks (public API)": ["підписки на події магазину", "подписки на события магазина", "store event subscriptions"],
  "Storefront: cart and checkout": ["справжній кошик покупця, купони", "настоящая корзина покупателя, купоны", "the buyer's real cart, coupons"],
  "Admin panel: generic engine": ["читання і збереження будь-якого запису", "чтение и сохранение любой записи", "read or save any admin record"],
  "Admin panel: orders and analytics": ["редагування замовлень, друк ТТН, дашборд", "редактирование заказов, печать ТТН, дашборд", "order editing, waybills, dashboard"],
  "Admin panel: products, prices, images": ["масова зміна цін з відкатом, залишки", "массовая смена цен с откатом, остатки", "bulk price changes with rollback, stock"],
  "Admin panel: characteristics and dictionaries": ["схеми характеристик, шаблони, переклади", "схемы характеристик, шаблоны, переводы", "characteristic schemas, templates, translations"],
  "Admin panel: categories, pages, blog, banners, filters": ["SEO-тексти категорій, статті, банери", "SEO-тексты категорий, статьи, баннеры", "category SEO text, articles, banners"],
  "Admin panel: SEO, sitemap, redirects": ["canonical, robots.txt, 301 з перевіркою циклів", "canonical, robots.txt, 301 с проверкой циклов", "canonical, robots.txt, 301s with loop checks"],
  "Admin panel: marketplace feeds": ["Rozetka, Hotline, Google, Facebook, Kasta", "Rozetka, Hotline, Google, Facebook, Kasta", "Rozetka, Hotline, Google, Facebook, Kasta"],
  "Admin panel: design and localization": ["тема, власний CSS, мови інтерфейсу", "тема, свой CSS, языки интерфейса", "theme, custom CSS, interface languages"],
  "Admin panel: store settings, marketing, fiscal receipts": ["контакти, GTM і Pixel, купони, Checkbox", "контакты, GTM и Pixel, купоны, Checkbox", "contacts, GTM and Pixel, coupons, Checkbox"],
};

const LANGS = [
  { code: "uk", i: 0, dir: "", locale: "uk_UA" },
  { code: "ru", i: 1, dir: "ru", locale: "ru_UA" },
  { code: "en", i: 2, dir: "en", locale: "en_US" },
];

const T = {
  uk: {
    title: "Хорошоп MCP - ШІ-агент керує вашим магазином на Хорошопі",
    desc: "Відкритий MCP-сервер: підключає Claude, Cursor, Codex та інших ШІ-агентів до магазину на Хорошопі. 118 інструментів, запис лише після підтвердження.",
    nav: { docs: "Документація", tools: "Інструменти", github: "GitHub" },
    h1a: "Агент робить те,",
    h1b: "що ви б робили руками",
    lede: "<strong>Хорошоп MCP</strong> підключає Claude, Cursor, Codex та інших ШІ-агентів до вашого магазину на Хорошопі. Каталог, замовлення, SEO, редиректи, фіди маркетплейсів, налаштування. Сервер працює на вашому комп'ютері, доступи лишаються у вашому файлі.",
    facts: [
      ["118", "інструментів у трьох рівнях доступу"],
      ["57 із 71", "записів спершу показують план"],
      ["22", "ШІ-клієнти з готовим конфігом"],
    ],
    installLabel: "Один рядок у вашому ШІ-клієнті",
    copy: "Копіювати",
    copied: "Скопійовано",
    ask: "Постав SEO-заголовок і опис категорії «Кросівки» українською та російською. Спершу покажи план.",
    who: "запит людини до агента",
    stPlan: "План",
    stApplied: "Застосовано",
    thField: "Поле",
    thWas: "Зараз у магазині",
    thNow: "Стане",
    rows: [
      ["title, укр", "Кросівки", "Кросівки чоловічі та жіночі - купити в Дніпрі | REBUS+"],
      ["description, укр", "", "Кросівки для міста і залу. Розміри 36-46, приміряння при отриманні, доставка Новою поштою."],
      ["title, рос", "Кроссовки", "Кроссовки мужские и женские - купить в Днепре | REBUS+"],
      ["h1", "Кросівки", "без змін", true],
    ],
    planFoot: "Нічого не збережено. Щоб застосувати, агент має повторити виклик з <code>dryRun:false</code>.",
    appliedFoot: "Записано і перевірено повторним читанням картки категорії.",
    toolsH: "118 інструментів, згрупованих так, як влаштований магазин",
    toolsNote: "Повний перелік з усіма параметрами лежить у репозиторії: довідник для людей і той самий перелік у JSON для агентів.",
    thSection: "Розділ",
    thExamples: "Приклади",
    thCount: "Інструментів",
    guardsH: "Чому цьому можна давати доступ до робочого магазину",
    guards: [
      ["Спершу план, потім запис", "57 із 71 інструмента запису за замовчуванням лише показують, що саме зміниться. Виконання - окремий крок з <code>dryRun:false</code>."],
      ["Підтвердження для незворотного", "Видалення замовлень, зміна аліасу фіду, імпорт прайсу і масові зміни цін вимагають явного підтвердження, а зміна цін повертає параметри для відкату."],
      ["Перевірка іншим каналом", "Хорошоп інколи відповідає «збережено», нічого не зберігши. Тому інструменти перечитують результат, часто через інший канал."],
      ["Доступи не виходять назовні", "Сервер ходить лише на домен вашого магазину. Значення, схожі на ключі й токени, маскуються у відповідях."],
    ],
    stepsH: "Підключення за чотири кроки",
    steps: [
      ["Node.js 18 або новіший", "Перевірте у терміналі. Якщо команда нічого не показує, встановіть Node.", "node -v"],
      ["Окремий адміністратор у магазині", "В адмінці Хорошопу створіть окремого адміністратора для агента: та сама пара логін і пароль працює і для API, і для інструментів адмінки.", null],
      ["Файл з магазинами", "Збережіть <code>stores.json</code> там, куди не мають доступу сторонні.", '{\n  "myshop": { "baseUrl": "https://myshop.com.ua", "login": "api-user", "password": "REPLACE_ME" }\n}'],
      ["Рядок у вашому ШІ-клієнті", "Для Claude Code достатньо однієї команди. Для решти клієнтів готові конфіги лежать в інструкції.", "claude mcp add horoshop -s user -e HOROSHOP_STORES_FILE=/abs/path/to/stores.json -- npx -y github:IgorShutko/horoshop-mcp"],
    ],
    faqH: "Часті запитання",
    faq: [
      ["Що таке Хорошоп MCP?", "Це MCP-сервер з відкритим кодом, який дає ШІ-агенту доступ до вашого магазину на Хорошопі: каталог, замовлення, SEO, редиректи, фіди, дизайн і налаштування. Ви пишете агенту звичайною мовою, він викликає потрібні інструменти."],
      ["Це офіційний продукт Хорошопу?", "Ні. Проєкт неофіційний, не пов'язаний з компанією Хорошоп і нею не підтримується. Інструменти адмінки працюють через внутрішні недокументовані запити, які можуть змінитися без попередження."],
      ["Які ШІ-асистенти підтримуються?", "Claude Code, Claude Desktop, Cursor, Codex, Gemini CLI, VS Code, Windsurf, Zed, LM Studio, Hermes Agent, OpenCode, Goose та інші клієнти з підтримкою MCP: усього 22 готові конфіги в інструкції."],
      ["Чи безпечно давати агенту доступ до магазину?", "Сервер працює локально, доступи лежать у вашому файлі, телеметрії немає. Записи за замовчуванням лише показують план, незворотні дії вимагають підтвердження, а секрети маскуються у відповідях. Створіть для агента окремого адміністратора і спершу обкатайте сценарії на тестовому магазині."],
      ["Чи можна керувати кількома магазинами?", "Так. Кожен інструмент приймає аргумент store, тож агенція підключає магазини всіх клієнтів через один сервер."],
      ["Скільки це коштує?", "Нічого. Ліцензія MIT, код відкритий. Ви платите лише за свій тариф Хорошопу і за ШІ-клієнт, яким користуєтеся."],
    ],
    linksH: "Далі",
    links: [
      ["Репозиторій на GitHub", REPO],
      ["Інструкція зі встановлення", REPO + "/blob/main/docs/INSTALL.uk.md"],
      ["Довідник інструментів", REPO + "/blob/main/docs/TOOLS.md"],
      ["Модель безпеки", REPO + "/blob/main/SECURITY.md"],
    ],
    footL: "Хорошоп MCP - неофіційний проєкт. Ліцензія MIT.",
    footR: 'Ігор Шутко, агенція <a href="https://www.targetplus-agency.com/">Target+</a> · <a href="https://t.me/shutko_igor">Telegram</a>',
  },
  ru: {
    title: "Хорошоп MCP - ИИ-агент управляет вашим магазином на Хорошопе",
    desc: "Открытый MCP-сервер: подключает Claude, Cursor, Codex и других ИИ-агентов к магазину на Хорошопе. 118 инструментов, запись только после подтверждения.",
    nav: { docs: "Документация", tools: "Инструменты", github: "GitHub" },
    h1a: "Агент делает то,",
    h1b: "что вы делали бы руками",
    lede: "<strong>Хорошоп MCP</strong> подключает Claude, Cursor, Codex и других ИИ-агентов к вашему магазину на Хорошопе. Каталог, заказы, SEO, редиректы, фиды маркетплейсов, настройки. Сервер работает на вашем компьютере, доступы остаются в вашем файле.",
    facts: [
      ["118", "инструментов в трёх уровнях доступа"],
      ["57 из 71", "записей сначала показывают план"],
      ["22", "ИИ-клиента с готовым конфигом"],
    ],
    installLabel: "Одна строка в вашем ИИ-клиенте",
    copy: "Копировать",
    copied: "Скопировано",
    ask: "Задай SEO-заголовок и описание категории «Кроссовки» на украинском и русском. Сначала покажи план.",
    who: "запрос человека к агенту",
    stPlan: "План",
    stApplied: "Применено",
    thField: "Поле",
    thWas: "Сейчас в магазине",
    thNow: "Станет",
    rows: [
      ["title, укр", "Кросівки", "Кросівки чоловічі та жіночі - купити в Дніпрі | REBUS+"],
      ["description, укр", "", "Кросівки для міста і залу. Розміри 36-46, приміряння при отриманні, доставка Новою поштою."],
      ["title, рус", "Кроссовки", "Кроссовки мужские и женские - купить в Днепре | REBUS+"],
      ["h1", "Кросівки", "без изменений", true],
    ],
    planFoot: "Ничего не сохранено. Чтобы применить, агент должен повторить вызов с <code>dryRun:false</code>.",
    appliedFoot: "Записано и проверено повторным чтением карточки категории.",
    toolsH: "118 инструментов, сгруппированных так, как устроен магазин",
    toolsNote: "Полный перечень со всеми параметрами лежит в репозитории: справочник для людей и тот же перечень в JSON для агентов.",
    thSection: "Раздел",
    thExamples: "Примеры",
    thCount: "Инструментов",
    guardsH: "Почему этому можно дать доступ к рабочему магазину",
    guards: [
      ["Сначала план, потом запись", "57 из 71 инструмента записи по умолчанию только показывают, что именно изменится. Выполнение - отдельный шаг с <code>dryRun:false</code>."],
      ["Подтверждение для необратимого", "Удаление заказов, смена алиаса фида, импорт прайса и массовые изменения цен требуют явного подтверждения, а смена цен возвращает параметры для отката."],
      ["Проверка другим каналом", "Хорошоп иногда отвечает «сохранено», ничего не сохранив. Поэтому инструменты перечитывают результат, часто через другой канал."],
      ["Доступы не уходят наружу", "Сервер ходит только на домен вашего магазина. Значения, похожие на ключи и токены, маскируются в ответах."],
    ],
    stepsH: "Подключение за четыре шага",
    steps: [
      ["Node.js 18 или новее", "Проверьте в терминале. Если команда ничего не показывает, установите Node.", "node -v"],
      ["Отдельный администратор в магазине", "В админке Хорошопа создайте отдельного администратора для агента: та же пара логин и пароль работает и для API, и для инструментов админки.", null],
      ["Файл с магазинами", "Сохраните <code>stores.json</code> там, куда нет доступа посторонним.", '{\n  "myshop": { "baseUrl": "https://myshop.com.ua", "login": "api-user", "password": "REPLACE_ME" }\n}'],
      ["Строка в вашем ИИ-клиенте", "Для Claude Code достаточно одной команды. Для остальных клиентов готовые конфиги лежат в инструкции.", "claude mcp add horoshop -s user -e HOROSHOP_STORES_FILE=/abs/path/to/stores.json -- npx -y github:IgorShutko/horoshop-mcp"],
    ],
    faqH: "Частые вопросы",
    faq: [
      ["Что такое Хорошоп MCP?", "Это MCP-сервер с открытым кодом, который даёт ИИ-агенту доступ к вашему магазину на Хорошопе: каталог, заказы, SEO, редиректы, фиды, дизайн и настройки. Вы пишете агенту обычным языком, он вызывает нужные инструменты."],
      ["Это официальный продукт Хорошопа?", "Нет. Проект неофициальный, не связан с компанией Хорошоп и ею не поддерживается. Инструменты админки работают через внутренние недокументированные запросы, которые могут измениться без предупреждения."],
      ["Какие ИИ-ассистенты поддерживаются?", "Claude Code, Claude Desktop, Cursor, Codex, Gemini CLI, VS Code, Windsurf, Zed, LM Studio, Hermes Agent, OpenCode, Goose и другие клиенты с поддержкой MCP: всего 22 готовых конфига в инструкции."],
      ["Безопасно ли давать агенту доступ к магазину?", "Сервер работает локально, доступы лежат в вашем файле, телеметрии нет. Записи по умолчанию только показывают план, необратимые действия требуют подтверждения, а секреты маскируются в ответах. Создайте для агента отдельного администратора и сначала обкатайте сценарии на тестовом магазине."],
      ["Можно ли управлять несколькими магазинами?", "Да. Каждый инструмент принимает аргумент store, поэтому агентство подключает магазины всех клиентов через один сервер."],
      ["Сколько это стоит?", "Ничего. Лицензия MIT, код открыт. Вы платите только за свой тариф Хорошопа и за ИИ-клиент, которым пользуетесь."],
    ],
    linksH: "Дальше",
    links: [
      ["Репозиторий на GitHub", REPO],
      ["Инструкция по установке", REPO + "/blob/main/docs/INSTALL.ru.md"],
      ["Справочник инструментов", REPO + "/blob/main/docs/TOOLS.md"],
      ["Модель безопасности", REPO + "/blob/main/SECURITY.md"],
    ],
    footL: "Хорошоп MCP - неофициальный проект. Лицензия MIT.",
    footR: 'Игорь Шутко, агентство <a href="https://www.targetplus-agency.com/">Target+</a> · <a href="https://t.me/shutko_igor">Telegram</a>',
  },
  en: {
    title: "Horoshop MCP - let an AI agent run your Horoshop store",
    desc: "Open-source MCP server connecting Claude, Cursor, Codex and other AI agents to a Horoshop store. 118 tools, writes only after you confirm.",
    nav: { docs: "Docs", tools: "Tools", github: "GitHub" },
    h1a: "Your agent does the work",
    h1b: "you would do by hand",
    lede: "<strong>Horoshop MCP</strong> connects Claude, Cursor, Codex and other AI agents to your store on Horoshop, the Ukrainian e-commerce platform. Catalog, orders, SEO, redirects, marketplace feeds, settings. The server runs on your machine and your credentials stay in your own file.",
    facts: [
      ["118", "tools across three access levels"],
      ["57 of 71", "write tools preview before they write"],
      ["22", "AI clients with a ready config"],
    ],
    installLabel: "One line in your AI client",
    copy: "Copy",
    copied: "Copied",
    ask: "Set the SEO title and description for the Sneakers category in Ukrainian and Russian. Show me the plan first.",
    who: "what a person asks the agent",
    stPlan: "Plan",
    stApplied: "Applied",
    thField: "Field",
    thWas: "Currently in the store",
    thNow: "Will become",
    rows: [
      ["title, uk", "Кросівки", "Кросівки чоловічі та жіночі - купити в Дніпрі | REBUS+"],
      ["description, uk", "", "Кросівки для міста і залу. Розміри 36-46, приміряння при отриманні, доставка Новою поштою."],
      ["title, ru", "Кроссовки", "Кроссовки мужские и женские - купить в Днепре | REBUS+"],
      ["h1", "Кросівки", "unchanged", true],
    ],
    planFoot: "Nothing has been saved. To apply it the agent must repeat the call with <code>dryRun:false</code>.",
    appliedFoot: "Written, then verified by reading the category record back.",
    toolsH: "118 tools, grouped the way a store actually works",
    toolsNote: "The full list with every parameter lives in the repository: a reference for people, and the same list as JSON for agents.",
    thSection: "Section",
    thExamples: "Examples",
    thCount: "Tools",
    guardsH: "Why this can be pointed at a live store",
    guards: [
      ["Plan first, write second", "57 of the 71 write tools only show what would change. Applying it is a separate step with <code>dryRun:false</code>."],
      ["Confirmation for the irreversible", "Deleting orders, changing a feed alias, running a price import and bulk price edits all require an explicit confirmation, and price changes return rollback parameters."],
      ["Verified through a second channel", "Horoshop sometimes answers \"saved\" having saved nothing. Tools therefore read the result back, often through a different channel."],
      ["Credentials stay put", "The server only talks to your store's domain. Values that look like keys or tokens are masked in responses."],
    ],
    stepsH: "Four steps to connect",
    steps: [
      ["Node.js 18 or newer", "Check in a terminal. If the command prints nothing, install Node.", "node -v"],
      ["A dedicated store admin", "In the Horoshop control panel create a separate admin for the agent: the same login and password works for both the API and the admin tools.", null],
      ["A stores file", "Save <code>stores.json</code> somewhere only you can read.", '{\n  "myshop": { "baseUrl": "https://myshop.com.ua", "login": "api-user", "password": "REPLACE_ME" }\n}'],
      ["One line in your AI client", "Claude Code needs a single command. Ready-made configs for the other clients are in the install guide.", "claude mcp add horoshop -s user -e HOROSHOP_STORES_FILE=/abs/path/to/stores.json -- npx -y github:IgorShutko/horoshop-mcp"],
    ],
    faqH: "FAQ",
    faq: [
      ["What is Horoshop MCP?", "An open-source MCP server that gives an AI agent access to your Horoshop store: catalog, orders, SEO, redirects, feeds, design and settings. You ask in plain language and the agent calls the tools it needs."],
      ["Is it an official Horoshop product?", "No. The project is unofficial, not affiliated with Horoshop and not supported by them. The admin tools use internal, undocumented endpoints that can change without notice."],
      ["Which AI assistants are supported?", "Claude Code, Claude Desktop, Cursor, Codex, Gemini CLI, VS Code, Windsurf, Zed, LM Studio, Hermes Agent, OpenCode, Goose and other MCP-capable clients: 22 ready-made configs in the install guide."],
      ["Is it safe to give an agent access to a store?", "The server runs locally, credentials stay in your file, and there is no telemetry. Writes preview by default, irreversible actions need confirmation, and secrets are masked in responses. Create a dedicated admin for the agent and rehearse new scenarios on a test store first."],
      ["Can one server manage several stores?", "Yes. Every tool takes a store argument, so an agency can drive every client's shop through a single connection."],
      ["What does it cost?", "Nothing. MIT licensed, source open. You pay only for your Horoshop plan and for the AI client you use."],
    ],
    linksH: "Next",
    links: [
      ["Repository on GitHub", REPO],
      ["Install guide", REPO + "/blob/main/docs/INSTALL.md"],
      ["Tool reference", REPO + "/blob/main/docs/TOOLS.md"],
      ["Security model", REPO + "/blob/main/SECURITY.md"],
    ],
    footL: "Horoshop MCP is an unofficial project. MIT licensed.",
    footR: 'Igor Shutko, <a href="https://www.targetplus-agency.com/">Target+</a> agency · <a href="https://t.me/shutko_igor">Telegram</a>',
  },
};

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const href = (dir, path = "") => `${BASE}${dir ? "/" + dir : ""}/${path}`;

function page(lang) {
  const t = T[lang.code];
  const i = lang.i;
  const url = href(lang.dir);
  const root = lang.dir ? "../" : "";

  const sectionRows = tools.sections
    .map(
      (s) => `<tr><td>${esc(SECTION_NAMES[s.title][i])}</td><td>${esc(SECTION_EXAMPLES[s.title][i])}</td><td class="count">${s.tools}</td></tr>`,
    )
    .join("\n          ");

  const diffRows = t.rows
    .map(
      ([field, was, now, keep]) =>
        `<tr><td>${esc(field)}</td><td>${was ? `<span class="${keep ? "kept" : "was"}">${esc(was)}</span>` : `<span class="empty">${i === 2 ? "empty" : i === 1 ? "пусто" : "порожньо"}</span>`}</td><td class="${keep ? "same" : "now"}">${esc(now)}</td></tr>`,
    )
    .join("\n              ");

  const steps = t.steps
    .map(
      ([h, p, cmd]) =>
        `<li><div><h3>${esc(h)}</h3><p>${p}</p>${cmd ? `<div class="cmd"><code>${esc(cmd)}</code></div>` : ""}</div></li>`,
    )
    .join("\n            ");

  const guards = t.guards.map(([h, p]) => `<article class="guard"><h3>${esc(h)}</h3><p>${p}</p></article>`).join("\n          ");
  const faq = t.faq.map(([q, a]) => `<dt>${esc(q)}</dt><dd>${esc(a)}</dd>`).join("\n          ");
  const links = t.links.map(([label, u]) => `<li><a href="${u}">${esc(label)}</a></li>`).join("\n          ");

  const jsonld = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "SoftwareApplication",
        name: "Horoshop MCP",
        alternateName: ["Хорошоп MCP", "horoshop-mcp"],
        applicationCategory: "DeveloperApplication",
        applicationSubCategory: "MCP server",
        operatingSystem: "macOS, Windows, Linux",
        url,
        downloadUrl: REPO,
        softwareVersion: tools.tool_count ? "0.1.0" : "0.1.0",
        description: t.desc,
        license: "https://opensource.org/licenses/MIT",
        isAccessibleForFree: true,
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
        author: { "@type": "Person", name: "Igor Shutko", url: "https://www.targetplus-agency.com/" },
        featureList: tools.sections.map((s) => SECTION_NAMES[s.title][i]),
      },
      {
        "@type": "FAQPage",
        inLanguage: lang.code,
        mainEntity: t.faq.map(([q, a]) => ({
          "@type": "Question",
          name: q,
          acceptedAnswer: { "@type": "Answer", text: a },
        })),
      },
    ],
  };

  const alts = LANGS.map(
    (l) => `<link rel="alternate" hreflang="${l.code}" href="${href(l.dir)}">`,
  ).join("\n  ");

  return `<!doctype html>
<html lang="${lang.code}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(t.title)}</title>
<meta name="description" content="${esc(t.desc)}">
<link rel="canonical" href="${url}">
${alts}
<link rel="alternate" hreflang="x-default" href="${href("")}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Horoshop MCP">
<meta property="og:locale" content="${lang.locale}">
<meta property="og:title" content="${esc(t.title)}">
<meta property="og:description" content="${esc(t.desc)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${BASE}/og.png">
<meta property="og:image:width" content="1280">
<meta property="og:image:height" content="640">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#0c0e0c">
<link rel="icon" href="${root}favicon.svg" type="image/svg+xml">
<link rel="preload" href="${root}fonts/geist.woff2" as="font" type="font/woff2" crossorigin>
<style>
@font-face{font-family:Geist;src:url("${root}fonts/geist.woff2") format("woff2");font-weight:100 900;font-display:swap}
__CSS__
</style>
<script type="application/ld+json">${JSON.stringify(jsonld)}</script>
</head>
<body>
<div class="wrap">
  <header class="masthead">
    <a class="mark" href="${href(lang.dir)}">horoshop<span>-mcp</span></a>
    <nav>
      ${LANGS.map((l) => `<a href="${href(l.dir)}" hreflang="${l.code}"${l.code === lang.code ? ' aria-current="true"' : ""}>${l.code === "uk" ? "UA" : l.code.toUpperCase()}</a>`).join("\n      ")}
      <a href="${REPO}">${esc(t.nav.github)}</a>
    </nav>
  </header>

  <div class="opening">
    <h1>${esc(t.h1a)} <em>${esc(t.h1b)}</em></h1>
    <p class="lede">${t.lede}</p>
    <ul class="facts">
      ${t.facts.map(([n, s]) => `<li><b>${esc(n)}</b> <span>${esc(s)}</span></li>`).join("\n      ")}
    </ul>
    <div class="install">
      <span class="install-label">${esc(t.installLabel)}</span>
      <div class="cmd">
        <code id="cmd">${esc(INSTALL)}</code>
        <button class="copy" type="button" data-copy="${esc(INSTALL)}" data-done-label="${esc(t.copied)}">${esc(t.copy)}</button>
      </div>
    </div>
  </div>

  <div class="plan" data-state="plan">
    <div class="plan-head">
      <div>
        <p class="ask">${esc(t.ask)}</p>
        <p class="who">${esc(t.who)}</p>
      </div>
      <div class="states" role="group">
        <button type="button" data-state-btn="plan" aria-pressed="true">${esc(t.stPlan)}</button>
        <button type="button" data-state-btn="applied" aria-pressed="false">${esc(t.stApplied)}</button>
      </div>
    </div>
    <div class="scroller">
    <table class="diff">
      <thead><tr><th>${esc(t.thField)}</th><th>${esc(t.thWas)}</th><th>${esc(t.thNow)}</th></tr></thead>
      <tbody>
              ${diffRows}
      </tbody>
    </table>
    </div>
    <p class="plan-foot"><span class="pip"></span><span data-foot data-plan="${esc(t.planFoot.replace(/<\/?code>/g, ""))}" data-applied="${esc(t.appliedFoot)}">${t.planFoot}</span></p>
  </div>

  <section id="tools">
    <h2>${esc(t.toolsH)}</h2>
    <div class="scroller">
    <table class="tools">
      <thead><tr><th>${esc(t.thSection)}</th><th>${esc(t.thExamples)}</th><th>${esc(t.thCount)}</th></tr></thead>
      <tbody>
          ${sectionRows}
      </tbody>
    </table>
    </div>
    <p class="note" style="margin-top:22px">${esc(t.toolsNote)}</p>
  </section>

  <section>
    <h2>${esc(t.guardsH)}</h2>
    <div class="guards">
          ${guards}
    </div>
  </section>

  <section id="install">
    <h2>${esc(t.stepsH)}</h2>
    <ol class="steps">
            ${steps}
    </ol>
  </section>

  <section id="faq">
    <h2>${esc(t.faqH)}</h2>
    <dl class="faq">
          ${faq}
    </dl>
  </section>

  <section>
    <h2>${esc(t.linksH)}</h2>
    <ul class="links">
          ${links}
    </ul>
  </section>

  <footer>
    <span>${esc(t.footL)}</span>
    <span class="sig">${t.footR}</span>
  </footer>
</div>
<script>
(function () {
  var copy = document.querySelector(".copy");
  if (copy) {
    var idle = copy.textContent;
    var flash = function () {
      copy.textContent = copy.dataset.doneLabel;
      copy.dataset.done = "1";
      setTimeout(function () { copy.textContent = idle; copy.removeAttribute("data-done"); }, 1600);
    };
    // The clipboard API is refused in some contexts; select the command instead
    // of leaving a button that looks like it worked and did nothing.
    var selectCommand = function () {
      var code = document.getElementById("cmd");
      if (!code) return;
      var range = document.createRange();
      range.selectNodeContents(code);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    };
    copy.addEventListener("click", function () {
      var text = copy.dataset.copy;
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(flash, selectCommand);
      } else {
        selectCommand();
      }
    });
  }
  var plan = document.querySelector(".plan");
  if (!plan) return;
  var foot = plan.querySelector("[data-foot]");
  var applied = plan.querySelectorAll(".now");
  var was = plan.querySelectorAll(".was, .empty");
  plan.querySelectorAll("[data-state-btn]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var state = btn.dataset.stateBtn;
      plan.dataset.state = state;
      plan.querySelectorAll("[data-state-btn]").forEach(function (b) {
        b.setAttribute("aria-pressed", String(b === btn));
      });
      foot.textContent = state === "applied" ? foot.dataset.applied : foot.dataset.plan;
      was.forEach(function (el) { el.style.textDecoration = state === "applied" ? "line-through" : ""; });
      applied.forEach(function (el) { el.style.opacity = state === "applied" ? "1" : "0.85"; });
    });
  });
})();
</script>
</body>
</html>
`;
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

for (const lang of LANGS) {
  const dir = lang.dir ? join(OUT, lang.dir) : OUT;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), page(lang).replace("__CSS__", css));
}

cpSync(join(SITE, "fonts"), join(OUT, "fonts"), { recursive: true });
cpSync(join(ROOT, "llms.txt"), join(OUT, "llms.txt"));
if (process.env.SKIP_OG !== "1") cpSync(join(SITE, "og.png"), join(OUT, "og.png"));
cpSync(join(SITE, "favicon.svg"), join(OUT, "favicon.svg"));

writeFileSync(
  join(OUT, "robots.txt"),
  `User-agent: *\nAllow: /\n\nSitemap: ${BASE}/sitemap.xml\n`,
);

const today = new Date().toISOString().slice(0, 10);
writeFileSync(
  join(OUT, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n` +
    LANGS.map(
      (l) =>
        `  <url>\n    <loc>${href(l.dir)}</loc>\n    <lastmod>${today}</lastmod>\n` +
        LANGS.map((a) => `    <xhtml:link rel="alternate" hreflang="${a.code}" href="${href(a.dir)}"/>`).join("\n") +
        `\n  </url>`,
    ).join("\n") +
    `\n</urlset>\n`,
);

console.error(`[site] built ${LANGS.length} pages into ${OUT} (css: ${cssFile})`);
