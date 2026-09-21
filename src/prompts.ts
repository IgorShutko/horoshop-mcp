import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, type ZodRawShape } from "zod";

/**
 * Ready-made scenarios the client shows in its own menu (Claude Desktop: the
 * "+" attachment menu), so a shop owner picks a task instead of composing one.
 *
 * A prompt is not a tool: the server hands back TEXT that becomes the user's
 * message. So each one names the tools to call, the order to call them in, and
 * what not to do without a confirmation - the model still decides, but it
 * starts from the workflow this project knows is right for Horoshop, not from
 * a guess. MCP prompt arguments are always strings; there is no other type.
 *
 * Language: Ukrainian, because the reader is the shop owner. Tool descriptions
 * stay English for the model.
 */
export interface PromptSpec {
  name: string;
  title: string;
  description: string;
  args?: ZodRawShape;
  build: (args: Record<string, string | undefined>) => string;
}

const storeArg = {
  store: z
    .string()
    .optional()
    .describe("Назва магазину з вашої конфігурації. Пропустіть, якщо магазин один."),
};

/** "у магазині myshop" or "" - the phrase reads naturally either way. */
const inStore = (a: Record<string, string | undefined>) => (a.store ? ` у магазині ${a.store}` : "");

/** Every write scenario ends with the same rule, so it cannot drift between prompts. */
const SAFE_WRITE =
  "Спочатку покажи план змін (dryRun), поруч із поточними значеннями. Нічого не зберігай, поки я не відповім «застосовуй». " +
  "Після запису перечитай результат і покажи, що саме змінилось.";

export const prompts: PromptSpec[] = [
  {
    name: "store_health",
    title: "Перевірка магазину",
    description:
      "Доступи, індексація, фіди маркетплейсів і продажі: коротка діагностика магазину без жодних змін.",
    args: { ...storeArg },
    build: (a) =>
      `Перевір стан магазину${inStore(a)} і дай короткий звіт. Нічого не змінюй: це тільки читання.

1. Доступи: horoshop_check_auth і horoshop_admin_login_check.
2. Індексація: horoshop_admin_sitemap_status (коли згенеровано, скільки адрес), horoshop_admin_robots_get (чи не закрито зайве), horoshop_admin_seo_settings_get (canonical і noindex для пагінації).
3. Фіди маркетплейсів: horoshop_admin_feed_list - які увімкнені та чи живі їхні публічні адреси.
4. Продажі: horoshop_admin_reports_dashboard за доступний період.

У звіті: що в порядку, що зламано, що чинити першим. Пиши коротко, без переліку всіх полів.`,
  },
  {
    name: "category_seo",
    title: "SEO категорії",
    description:
      "Заголовок, опис і SEO-текст для категорії двома мовами: спершу план змін, запис лише після підтвердження.",
    args: {
      ...storeArg,
      category: z
        .string()
        .describe("Назва категорії або її адреса, напр. «Кросівки» або /krosivky/."),
      keywords: z
        .string()
        .optional()
        .describe("Ключові запити через кому, якщо вони вже відомі."),
    },
    build: (a) =>
      `Підготуй SEO для категорії «${a.category}»${inStore(a)}.

1. Знайди категорію через horoshop_pages_export і прочитай її поточні значення.
2. Запропонуй title, description і h1 українською та російською${a.keywords ? `, спираючись на запити: ${a.keywords}` : ""}. Title до 60 символів, description до 160, у тексті назва міста або бренду, якщо це доречно.
3. Порівняй із тим, що стоїть зараз, і покажи таблицею: поле, було, стане.
4. Зміни вноситимеш через horoshop_admin_category_update.

${SAFE_WRITE}`,
  },
  {
    name: "products_without_photos",
    title: "Товари без фото",
    description:
      "Список товарів, у яких немає зображень: артикул, назва, ціна, наявність. Тільки читання.",
    args: {
      ...storeArg,
      limit: z.string().optional().describe("Скільки товарів перевірити. За замовчуванням 500."),
    },
    build: (a) =>
      `Знайди товари без фото${inStore(a)}.

1. Вивантаж каталог через horoshop_catalog_export порціями (limit 100, далі offset), усього до ${a.limit ?? "500"} товарів. Бери лише потрібні поля: article, title, price, presence, images.
2. Відбери ті, у яких немає жодного зображення.
3. Покажи таблицею: артикул, назва, ціна, наявність. Спершу ті, що в наявності: вони втрачають продажі просто зараз.
4. У кінці: скільки таких товарів і яка їхня частка від перевірених.

Нічого не змінюй.`,
  },
  {
    name: "orders_digest",
    title: "Зведення замовлень",
    description:
      "Замовлення за період: сума, статуси, джерела трафіку за UTM і найчастіші товари.",
    args: {
      ...storeArg,
      period: z
        .string()
        .optional()
        .describe("Період, напр. «за тиждень», «вересень», «01.09-15.09». За замовчуванням 7 днів."),
    },
    build: (a) =>
      `Зроби зведення замовлень${inStore(a)} ${a.period ?? "за останні 7 днів"}.

1. Візьми замовлення через horoshop_orders_get за цей період.
2. Порахуй: кількість, сума, середній чек, розподіл за статусами.
3. Джерела: згрупуй за utm_source і utm_campaign, покажи, звідки приходять гроші, а не лише заявки.
4. Товари: 5 найчастіших позицій.
5. Одним абзацом: що змінилось проти попереднього такого ж періоду, якщо дані дозволяють порівняти.

Рахуй сам, не покладайся на око: спершу витягни дані, потім рахуй. Нічого не змінюй.`,
  },
  {
    name: "feeds_check",
    title: "Фіди маркетплейсів",
    description:
      "Rozetka, Hotline, Google, Facebook, Kasta: що увімкнено, чи живі адреси, що не зіставлено.",
    args: { ...storeArg },
    build: (a) =>
      `Перевір фіди маркетплейсів${inStore(a)}.

1. horoshop_admin_feed_list - які фіди є, які увімкнені, їхні публічні адреси і коли востаннє генерувались.
2. Для кожного увімкненого: horoshop_admin_feed_params_get - чи зіставлені наявність і ціна, чи немає порожніх значень.
3. Для Rozetka і Hotline додатково horoshop_admin_feed_categories_get - чи всі категорії зіставлені з категоріями майданчика.
4. Звіт: що готове до вивантаження, що зіпсується на боці майданчика і чому.

Нічого не змінюй: генерацію і правки зробимо окремо, коли подивимось на список.`,
  },
  {
    name: "redirects_from_list",
    title: "301 редиректи списком",
    description:
      "Пачка старих адрес на нові: перевірка циклів і дублів, план змін, запис після підтвердження.",
    args: {
      ...storeArg,
      pairs: z
        .string()
        .describe("Пари адрес, по одній на рядок: стара адреса, пробіл або кома, нова адреса."),
    },
    build: (a) =>
      `Заведи 301 редиректи${inStore(a)} за цим списком:

${a.pairs}

1. Прочитай наявні редиректи через horoshop_admin_redirect_list.
2. Для кожної пари перевір: чи немає вже такого правила, чи не виникне ланцюжка або циклу, чи не суперечить наявному.
3. Покажи, що буде створено, що пропущено і чому.
4. Створюй через horoshop_admin_redirect_bulk_create.

${SAFE_WRITE}`,
  },
  {
    name: "price_change",
    title: "Зміна цін з відкатом",
    description:
      "Масова зміна цін за списком артикулів або категорією: межі, підтвердження і готові параметри відкату.",
    args: {
      ...storeArg,
      scope: z
        .string()
        .describe("Кого змінюємо: список артикулів через кому або назва категорії."),
      change: z
        .string()
        .describe("Що робимо з ціною, напр. «+10%», «-50 грн», «ціна 899»."),
    },
    build: (a) =>
      `Зміни ціни${inStore(a)}: ${a.scope} → ${a.change}.

1. Знайди ці товари (horoshop_catalog_export) і покажи поточні ціни: артикул, назва, ціна зараз, ціна після зміни, різниця у відсотках.
2. Одразу назви: скільки товарів у вибірці і яка найбільша зміна у відсотках. Якщо товарів більше 50 або зміна перевищує 50%, скажи про це окремим рядком перед тим, як щось робити.
3. Зміну вноситимеш через horoshop_admin_products_price_set - інструмент вимагає точної кількості товарів і повертає параметри для відкату.
4. Після запису збережи параметри відкату у відповіді, щоб я міг повернути ціни однією командою.

${SAFE_WRITE} Нульових і від'ємних цін не став.`,
  },
];

export function registerPrompts(server: McpServer, specs: PromptSpec[] = prompts): void {
  for (const spec of specs) {
    server.registerPrompt(
      spec.name,
      { title: spec.title, description: spec.description, argsSchema: spec.args ?? {} },
      (args: Record<string, string | undefined> = {}) => ({
        messages: [{ role: "user" as const, content: { type: "text" as const, text: spec.build(args) } }],
      }),
    );
  }
}
