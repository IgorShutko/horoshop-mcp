/**
 * The Horoshop admin is one uniform machine keyed on `handler` (the entity-type
 * id): `data.php?handler=H` lists, `edit.php?id=X&handler=H&handlertable=T`
 * edits, `save.php` persists. This is the reverse-engineered registry of those
 * types — the backbone that lets the generic admin tools reach any of them.
 *
 * Dictionary source: the admin navigation plus a create-form probe.
 *
 * ⚠️ HANDLER IDS ARE *MOSTLY* STORE-INDEPENDENT — BUT NOT ALWAYS.
 * This header used to claim they are always the same across stores. A live
 * probe measured a counter-example and the claim is now corrected rather than
 * repeated: the menu item `settings_vchasno_payment_types` is
 * `data.php?handler=458` on one store and `handler=468` on two others, with
 * byte-identical grids (18 rows, same ids, same labels) behind each. Reading the
 * wrong number does NOT error — it renders an EMPTY grid and reports success,
 * which is this project's "false OK" defect class.
 *
 * So: an entity whose handler is known to move carries `navName`, the stable key
 * from `/core-api/admin/navigation` (`name`/`url` are identical across stores and
 * across interface languages; only `old_admin_url` moves). The admin client
 * resolves such entities per store from that store's own navigation and falls
 * back to the number below. Entities WITHOUT `navName` cost nothing extra and
 * behave exactly as before.
 *
 * Record ids under a handler are per-store in every case.
 */
export interface AdminEntity {
  handler: number;
  handlertable: string;
  /** Stable slug used as the tool-facing name. */
  slug: string;
  title: string;
  /** Sentinel that opens a blank create form (most accept "addnew"; some "0"). */
  createId: "addnew" | "0";
  /** Extra query flags the editor expects (e.g. pages needs showPages). */
  flags?: string[];
  /**
   * Editors that are NOT a plain save.php form and need special handling:
   *  - "heavy": returns 503 on id=0, needs a real record context (products, client cards)
   *  - "no-form": custom UI, no save.php form (product field templates)
   *  - "hub": redirects to a sub-picker (attribute-value lists)
   *  - "custom": managed outside generic edit.php (languages)
   */
  special?: "heavy" | "no-form" | "hub" | "custom";
  /**
   * How records are deleted:
   *  - "grid" (default): flat datagrid, `removeSelectedGrids` by id
   *  - "tree": per-node delete carrying &parent (pages tree) — not yet wired
   *  - "custom": entity-specific flow (order statuses → removeSelectedStatuses)
   *  - "none": not a deletable datagrid (special editors)
   */
  deleteMode?: "grid" | "tree" | "custom" | "none";
  /**
   * Singleton settings whose form is rendered by a utils page rather than
   * edit.php (the form still posts to save.php via its own hidden fields). When
   * set, the generic reader fetches the form from here and ignores the id arg.
   */
  formUrl?: string;
  /** Marks a single-record config entity (always id=1, no create/list/delete). */
  singleton?: boolean;
  /**
   * The grid is scoped by a page-tree parent (the record's rubric), so a row is
   * only visible — and only deletable — under its own parent. Blog/news articles
   * (h_news) are the case: `data.php?handler=172&parent=R` lists rubric R only.
   * When set, the generic delete resolves each id's parent from the page tree if
   * the caller didn't pass one, instead of failing to find the row.
   */
  parentTree?: boolean;
  /**
   * Stable `name` of this entity's leaf in `/core-api/admin/navigation`. Set it
   * ONLY for entities whose numeric handler was MEASURED to move between stores
   * (see the header). When present, the admin client resolves the real handler
   * from the target store's own navigation; `handler` above stays the fallback.
   * Never set this from a guess — a wrong nav key silently keeps the fallback.
   */
  navName?: string;
}

const E = (
  handler: number,
  handlertable: string,
  slug: string,
  title: string,
  extra: Partial<AdminEntity> = {},
): AdminEntity => ({ handler, handlertable, slug, title, createId: "addnew", ...extra });

export const ADMIN_ENTITIES: AdminEntity[] = [
  E(4, "pages", "pages", "Страницы и категории", { flags: ["showPages"], deleteMode: "tree" }),
  E(7, "admins", "admins", "Админы"),
  /**
   * Блог / Новости — статьи под узлом «Блог» дерева структуры (extra_handler=172).
   * Сама статья — самостоятельная сущность h_news с редактором
   * `edit.php?id=<id>&handler=172&handlertable=h_news&showPages`; создание —
   * `id=addnew&parent=<blogNodeId>`. Поля целиком в `names[...]`
   * (i18n title/announce/text/h1_title/seo_*, date, name[slug], cover/img,
   * promo, disallow_comments, act). Обычный save.php-грид: RMW пишет текст/SEO,
   * а обложка `names[cover][file]` / картинка `names[img][file]` персистят прямым
   * multipart (проверено на тестовом магазине — cover[value] уходит в CDN и рендерится на
   * витрине; никакой отдельный «cloud_upload» не нужен). Удаление — grid
   * removeSelectedGrids с parent узла блога. Named-обёртки: blog_post_create/update.
   */
  E(172, "h_news", "blog_posts", "Блог / Новости (статьи)", { flags: ["showPages"], parentTree: true }),
  E(32, "h_users", "customers", "Клиенты"),
  E(229, "h_comments", "reviews", "Комментарии и отзывы"),
  E(234, "h_payment_type", "payment_methods", "Варианты оплаты"),
  E(235, "h_delivery", "delivery_methods", "Варианты доставки"),
  E(244, "h_call_me", "callbacks", "Обратный звонок"),
  E(261, "h_export_files", "export_templates", "Экспорт (шаблоны для маркетплейсов)"),
  E(262, "h_currency", "currencies", "Курсы валют"),
  E(263, "h_coupon", "coupons", "Сертификаты и купоны"),
  E(264, "h_discount_card_settings", "cumulative_discounts", "Накопительные скидки"),
  E(278, "h_favorites", "back_in_stock", "Сообщить когда появится"),
  E(293, "h_hints", "attribute_tooltips", "Подсказки для параметров"),
  E(340, "l10n", "interface_translation", "Перевод интерфейса"),
  E(346, "h_colors", "colors", "Цвета"),
  E(349, "h_brands", "brands", "Бренды"),
  E(351, "h_colors_simple", "filter_colors", "Цвета для фильтра"),
  E(363, "h_sms_templates", "sms_templates", "Шаблоны СМС"),
  E(364, "h_presets", "filter_presets", "Пресеты фильтров (SEO)"),
  E(373, "h_icons", "stickers", "Стикеры для товаров"),
  E(378, "h_benefits", "benefits", "Преимущества магазина"),
  E(380, "h_socials", "social_networks", "Соцсети"),
  E(391, "h_seo_handlers", "seo_templates", "SEO шаблоны"),
  E(394, "h_banners_improved", "banners", "Баннеры"),
  E(407, "h_marketing_system", "marketing_services", "Маркетинговые сервисы"),
  E(422, "h_indexed_filters", "indexed_filters", "Индексируемые фильтры"),
  E(425, "h_validation_files", "external_service_files", "Файлы для внешних сервисов"),
  E(427, "h_marketplaces_presence_settings", "marketplace_availability", "Статусы наличия для площадок"),
  E(429, "h_marketplace_templates", "marketplaces", "Маркетплейсы"),
  E(436, "h_order_statuses", "order_statuses", "Статусы заказа", { deleteMode: "custom" }),
  /**
   * Заказы. Зарегистрированы РАДИ СПИСКА (`admin_list` → id строк грида): по ним
   * адресуются все админские order-тулы. Редактор у заказа НЕ обычный —
   * `edit.php` без `action=edit` рисует пустой «Новый заказ» И плодит в гриде
   * строку-пустышку на 0.00, а форма постит не в `save.php`, а в `/order/submit/`.
   * Поэтому `special:"no-form"` + `deleteMode:"none"`, а generic record_get /
   * record_save / record_delete на handler 443 отказывают и отправляют в
   * horoshop_admin_order_get / _status_change / _delete (см. ORDER_HANDLER-гард
   * в adminGeneric.ts).
   */
  E(443, "h_carts", "orders", "Заказы", { special: "no-form", deleteMode: "none" }),
  E(439, "h_price_levels", "price_levels", "Типы цен"),
  E(440, "h_customer_groups", "customer_groups", "Группы покупателей"),
  E(449, "h_checkbox_taxes", "checkbox_taxes", "Checkbox: налоговые ставки"),
  E(454, "h_suppliers", "suppliers", "Поставщики"),
  // 458 on one store, 468 on two others, measured. The grid
  // behind both is identical (18 rows, ids 0..17, same labels), so this is one
  // entity with a per-store number, not two entities.
  E(458, "h_vchasno_payment_types", "vchasno_payment", "Вчасно.Каса: способы оплаты", {
    navName: "settings_vchasno_payment_types",
  }),
  /**
   * ── Разделы БЕЗ пункта в React-меню ───────────────────────────────────────
   * Все восемь отвечают живым гридом на `data.php?handler=N`, у всех обычная
   * форма `edit.php?id=addnew&handler=N` → `save.php` с собственным
   * `handlertable`, но НИ ОДНОГО нет в `/core-api/admin/navigation`: меню тестового магазина —
   * 61 лист, из них 40 ведут на `data.php?handler=…` (39 разных хендлеров), и
   * все 39 уже были в реестре. Поэтому свип по меню их не видел,
   * а свип по хендлерам видел, но не мог назвать. Достижимы они из UI вложенными
   * блоками соседних разделов и прямыми legacy-ссылками.
   *
   * КАЖДАЯ прошла круговой прогон на тестовом магазине (68/68):
   * выравнивание (id из `admin_list` открывает ТУ ЖЕ строку, а не соседнюю
   * таблицу) → создать → перечитать → найти в списке → изменить → удалить →
   * гейт net-zero. Обычного грид-удаления хватает всем восьми, поэтому ни
   * `special`, ни `deleteMode` им не нужны.
   */
  E(321, "h_residues", "stock_residues", "Остатки товаров на складе"),
  E(341, "h_currency_rates", "currency_rates", "Валюты: курс (кросс-курсы пар)"),
  E(387, "h_np_senders", "novapost_senders", "Новая почта: отправители"),
  /**
   * Тот же список, что пишет публичный `hooks/subscribe`: подписка, заведённая
   * через API, появляется В ЭТОМ гриде с тем же `target_url`, а `hooks/unSubscribe`
   * убирает строку (проверено вторым каналом в круговом прогоне). Реестр
   * добавляет то, чего у API нет: ПЕРЕЧИСЛИТЬ подписки и отредактировать их.
   */
  E(412, "h_hook_subscriber", "webhook_subscribers", "Web-Hooks: подписчики"),
  E(428, "h_conditions", "product_conditions", "Состояние товара (новый / б-у / восстановленный)"),
  E(438, "h_installments_payment", "installment_terms", "Оплата частями: сроки"),
  /**
   * Контактное лицо живёт ПОД отправителем: создание без `names[sender]`
   * отвечает HTTP 503 и строка не появляется (замерено на стенде с нулём
   * отправителей). Сперва заводится `novapost_senders`, его id идёт в
   * `names[sender]` — тогда создание проходит.
   */
  E(441, "h_np_contact_persons", "novapost_contacts", "Новая почта: контактные лица"),
  E(447, "h_monobank_installments_payment", "monobank_installment_terms", "monobank: Покупка частями — сроки"),
  /**
   * ── ЧТО РЯДОМ ЖИВОЕ, НО СУЩНОСТЬЮ НЕ ЯВЛЯЕТСЯ (замерено) ──────────────────
   * Свип нашёл на тестовом магазине 54 отвечающих грида и назвал 16 «вне реестра».
   * Восемь выше — настоящие сущности. Остальные восемь НЕ регистрируются, и вот
   * почему — чтобы вопрос не открывали заново:
   *
   * · 271 «Варианты доставки» — ЛОВУШКА, а не сущность. Его грид отдаёт те же
   *   26 строк, что handler 235 (id-в-id, метки совпадают, `parent` игнорируется),
   *   а его редактор по тому же id открывает строку СОСЕДНЕЙ таблицы
   *   `h_delivery_settings` — пространства id разные: строка настроек 21 несёт
   *   `names[delivery]=8`, то есть принадлежит способу 8, а грид под номером 8
   *   показывает сам способ. `admin_list` и `record_get` смотрели бы в разные
   *   таблицы. Сами тарифы (min / price / by_carrier) читаются публичным
   *   `delivery/export` в `price_options`.
   * · 381, 460, 461 — не разделы, а СТРОКИ реестра шаблонов товаров (handler 1):
   *   их номера буквально лежат в его гриде, `forms/handlers.php?edit=N` рисует
   *   «Свойства шаблона» («КАТАЛОГ: Товар», «Стікери», «Футболки»), а
   *   `data.php?handler=381` — это товары шаблона (24 строки = весь каталог,
   *   id-в-id с handler 17) с `handlertable=h_catalog_stkeri`.
   * · 287 «Корзина: товары» (46 строк) и 444 «Заказ: товары» — дочерние строки,
   *   редактора нет вовсе. Замер на тестовом магазине: оформление одного заказа с витрины
   *   даёт 444: 0 → 1 и 456: 0 → 1, а удаление заказа возвращает обе в 0;
   *   287 при этом не меняется (это содержимое корзин, не заказов).
   * · 456 «UTM заказа» (h_orders_analytics) — то же поле в поле, что блок
   *   `analytics` у `orders/get` (utm_source/medium/campaign/term/content +
   *   google_client_id), и наполняется заказом (см. выше). Данные уже покрыты.
   * · 457 «Детали транзакции» (h_payment_transaction_details) — пусто на всех
   *   доступных стендах, наложенным платежом не наполняется; порождается
   *   платёжным шлюзом. Контракт проверить нечем — не заводим.
   */
  // Singletons — always record id=1, no create/delete (edit-only config records).
  E(437, "h_payment_integration_settings_extra", "payment_settings", "Настройки платёжных систем (мерчант-ключи)", {
    deleteMode: "none",
    singleton: true,
    formUrl: "/adminLegacy/utils/payment_settings.php",
  }),
  /**
   * Общие настройки магазина. Not its own handler: the page is the editor for
   * page id=1 ("Головна") — its hidden fields are literally id=1, handler=4,
   * handlertable=pages — with a ~324-field `extra[...]` block rendered on top.
   * That is why it never appeared as a separate entity, and why the store's
   * phone, e-mail, address, timetable, tracking markers and the product-card
   * info tabs (extra[i18n][L][info_delivery|info_payment|info_return|
   * info_warranty|info_consult]) had no path through this server at all.
   * Addressed by slug: handler 4 belongs to `pages` (first registration wins).
   */
  E(4, "pages", "site_settings", "Общие настройки магазина (контакты, тексты карточки, трекинг)", {
    deleteMode: "none",
    singleton: true,
    formUrl: "/adminLegacy/utils/site_settings.php",
  }),
  // Non-standard editors — reachable but not via the plain save.php form.
  /**
   * Товары. `deleteMode` стоял "none" из осторожности, а не из-за неизвестного
   * контракта — и это читалось как «товар удалить нельзя ничем», хотя админка
   * удаляет их обычным гридом. Проверено вживую на тестовом магазине: тот же
   * `ajax.datagrid.php?load=removeSelectedGrids` сносит товар (536 исчез,
   * каталог 26 → 25), а вариант `removeSelectedGridsAndMods` — товар вместе с
   * его модификациями (иначе модификация остаётся сиротой, как 537 после 536).
   * Существование id проверяется не гридом, а открытием редактора
   * (`recordExists`): 503 = записи нет.
   */
  E(17, "h_products", "products", "Товары", { special: "heavy", deleteMode: "grid" }),
  E(259, "h_discount_card", "client_cards", "Карта клиента"),
  E(1, "h_data_templates", "data_templates", "Шаблоны товаров", { special: "no-form", deleteMode: "none" }),
  E(207, "h_attribute_lists", "attribute_lists", "Справочники", { special: "hub", deleteMode: "none" }),
  E(339, "h_languages", "languages", "Языки", { special: "custom", deleteMode: "none" }),
];

// One handler can back more than one entity (site_settings is a second view of
// handler 4), so the first registration wins the numeric lookup and the extra
// views are addressed by their slug.
const BY_HANDLER = new Map<number, AdminEntity>();
for (const e of ADMIN_ENTITIES) if (!BY_HANDLER.has(e.handler)) BY_HANDLER.set(e.handler, e);
const BY_SLUG = new Map<string, AdminEntity>(ADMIN_ENTITIES.map((e) => [e.slug, e]));

/** Resolve an entity by numeric handler or by slug. Returns undefined if unknown. */
export function resolveEntity(key: number | string): AdminEntity | undefined {
  if (typeof key === "number") return BY_HANDLER.get(key);
  const asNum = Number(key);
  if (Number.isInteger(asNum) && BY_HANDLER.has(asNum)) return BY_HANDLER.get(asNum);
  return BY_SLUG.get(key);
}

export function listEntities(): Array<{ slug: string; handler: number; title: string; special?: string }> {
  return ADMIN_ENTITIES.map((e) => ({ slug: e.slug, handler: e.handler, title: e.title, special: e.special }));
}
