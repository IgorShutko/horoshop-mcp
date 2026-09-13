import { z } from "zod";
import { storeField, type ToolSpec } from "../register.js";
import { LANG_INDEX, fieldValue, type ParsedForm } from "../admin/form.js";

/**
 * Named tools over the general-settings singleton (`utils/site_settings.php`,
 * ~373 form fields). The generic record_get/record_save already reach every one
 * of them, but only if you already know the raw field name — `extra[order_
 * required_authorization]` and friends. These tools let a human say what they
 * mean ("require authorization at checkout", "turn on the tracking script") and
 * the tool knows the field.
 *
 * How the form stores things (verified on a test store):
 *  - Booleans are a hidden `<field>=0` plus, WHEN ON, a checkbox `<field>=1`.
 *    So the effective value is "1" when checked, "0" when not. `buildMultipart`
 *    already omits the checkbox part when turning a box off, and the paired
 *    hidden it still sends ("0") is exactly what a browser submits for an
 *    unchecked box — no special "omit the whole field" is needed. See the note
 *    on the checkout tool.
 *  - Text / textarea fields carry their value verbatim (HTML/JS allowed in the
 *    script and map fields).
 *  - Translatable fields live under `extra[i18n][<idx>][<name>]` where idx is the
 *    platform language index (ua=3, ru=1, en=4, pl=5, ro=6).
 *  - Enum <select>s on this page render WITH a selected option, so they are safe
 *    to resubmit and to override; the 11 dangerous `unselected` selects on this
 *    form (`names[parent]`, tax codes) are never touched by these tools.
 */

const SETTINGS_URL = "/adminLegacy/utils/site_settings.php?checkcode=yamete_kudasai";

type Kind = "bool" | "text" | "int" | "enum";

interface FieldDef {
  /** Raw field name, OR the i18n subfield name when `i18n` is set. */
  field: string;
  kind: Kind;
  /** Translatable field: real name is `extra[i18n][<idx>][field]`. */
  i18n?: boolean;
  /** Russian admin label, for the discovery catalog. */
  label: string;
}

/** Resolve the real submitted field name for a definition at a language index. */
function nameOf(def: FieldDef, idx: number): string {
  return def.i18n ? `extra[i18n][${idx}][${def.field}]` : def.field;
}

/** Read a definition's current value out of a parsed form, typed. */
function readValue(form: ParsedForm, def: FieldDef, idx: number): boolean | string {
  const raw = fieldValue(form, nameOf(def, idx));
  if (def.kind === "bool") return raw === "1";
  return raw;
}

/** Turn a typed input into the string override the form body expects. */
function toOverride(def: FieldDef, value: unknown): string {
  if (def.kind === "bool") return value ? "1" : "0";
  return String(value);
}

/**
 * The writable registry, grouped by the tool that owns each key. The key is the
 * human-facing parameter name; the value is how to reach the field.
 */
const REGISTRY = {
  tracking: {
    scriptOnTop: { field: "extra[script_on_top]", kind: "text", label: "Скрипты после тега <body>" },
    scriptOnBottom: { field: "extra[script_on_bottom]", kind: "text", label: "Скрипты перед тегом </body>" },
    scriptInHead: { field: "extra[script_in_head]", kind: "text", label: "Скрипты внутри тега <head>" },
    ga4Id: { field: "extra[ga_auth_project_name]", kind: "text", label: "Аналитика: идентификатор ресурса GA4" },
  },
  checkout: {
    showEmail: { field: "extra[order_show_email]", kind: "bool", label: "Отображать поле «Эл. почта»" },
    requireEmail: { field: "extra[order_required_email]", kind: "bool", label: "Эл. почта обязательна" },
    requireAuthorization: {
      field: "extra[order_required_authorization]",
      kind: "bool",
      label: "Обязательная авторизация при известном email",
    },
    newsletterSubscription: {
      field: "extra[newsletter_subscription]",
      kind: "bool",
      label: "Согласие на получение рассылок (показывать опцию)",
    },
    newsletterSubscriptionDefault: {
      field: "extra[newsletter_subscription_default]",
      kind: "bool",
      label: "Согласие на рассылки — отмечено по умолчанию",
    },
    showCouponCode: { field: "extra[show_coupon_code]", kind: "bool", label: "Отображать поле для купонов" },
    showCountries: { field: "extra[show_countries]", kind: "bool", label: 'Отображать поле «Страна»' },
    phoneMask: {
      field: "extra[enable_phone_mask_on_input]",
      kind: "bool",
      label: "Маска ввода номера телефона (UA)",
    },
    orderWithoutCallback: {
      field: "extra[order_without_callback]",
      kind: "bool",
      label: "Опция «Не звонить для подтверждения заказа»",
    },
    orderWithoutCallbackDefault: {
      field: "extra[order_without_callback_default]",
      kind: "bool",
      label: "«Не звонить» — отмечено по умолчанию",
    },
    commentFieldExpanded: { field: "extra[comment_field_expanded]", kind: "bool", label: "Поле «Комментарий» развёрнуто" },
    quickOrderEnabled: { field: "extra[order_quick_enabled]", kind: "bool", label: "Быстрый заказ: включить" },
    quickOrderShowName: { field: "extra[order_quick_show_name]", kind: "bool", label: "Быстрый заказ: поле «Имя и фамилия»" },
    quickOrderShowEmail: { field: "extra[order_quick_show_email]", kind: "bool", label: "Быстрый заказ: поле «Эл. почта»" },
    quickOrderPriorityMobile: {
      field: "extra[order_quick_priority_mobile]",
      kind: "bool",
      label: "Быстрый заказ: приоритет в мобильной версии",
    },
  },
  catalog: {
    groupModifications: { field: "extra[group_modifications]", kind: "bool", label: "Группировать товары по модификациям" },
    useGeneratedTitle: { field: "extra[use_generated_title]", kind: "bool", label: "Генерировать названия для модификаций" },
    compareItems: { field: "extra[compare_items]", kind: "bool", label: "Сравнение товаров" },
    allowListView: { field: "extra[allow_list_view]", kind: "bool", label: "Отображение товаров списком" },
    currencyRoundTo: { field: "extra[currency_round_to]", kind: "int", label: "Округление цен (знаков после запятой)" },
    primarySort: { field: "extra[primary_sort]", kind: "enum", label: "Приоритетная сортировка товаров в каталоге" },
    newIconDaysDuration: { field: "extra[new_icon_days_duration]", kind: "int", label: "Новинка: кол-во дней" },
    accessMultiplicity: { field: "extra[access_multiplicity]", kind: "bool", label: "Кратность (шаг кол-ва в корзине)" },
    accessUnitsOfMeasurement: {
      field: "extra[access_units_of_measurement]",
      kind: "bool",
      label: "Единицы измерения товара",
    },
    accessWholesalePrices: { field: "extra[access_wholesale_prices]", kind: "bool", label: "Оптовые цены за количество" },
    accessMinOrder: { field: "extra[access_min_order]", kind: "bool", label: "Минимальный заказ" },
    useResiduesByStock: { field: "extra[catalog_use_residues_by_stock]", kind: "bool", label: "Учёт остатков" },
    productsSetEnabled: { field: "extra[products_set_enabled]", kind: "bool", label: "Комплекты товаров" },
    giftsEnabled: { field: "extra[gifts_enabled]", kind: "bool", label: "Подарки" },
    specifyPrice: { field: "extra[specify_price]", kind: "bool", label: "Функция «Узнать цену»" },
    digitalProductsEnabled: { field: "extra[digital_products_enabled]", kind: "bool", label: "Электронные товары" },
    cartAddOpen: { field: "extra[cart_add_open]", kind: "bool", label: "Открывать корзину при добавлении товара" },
    checkAllParams: {
      field: "extra[check_all_params]",
      kind: "bool",
      label: "Похожие товары по всем характеристикам",
    },
    hintType: { field: "extra[hint_type]", kind: "enum", label: "Подсказки для характеристик (вид)" },
    mobileCardView: { field: "extra[mobile_card_view]", kind: "bool", label: "Крупная плитка по умолчанию (мобайл)" },
    highlightUnavailableModifications: {
      field: "extra[highlight_unavailable_modifications]",
      kind: "bool",
      label: "Выделять товары не в наличии в переключателе модификаций",
    },
    highlightMissingModifications: {
      field: "extra[highlight_missing_modifications]",
      kind: "bool",
      label: "Выделять отсутствующие модификации в переключателе",
    },
    contentCopyProtection: { field: "extra[content_copy_protection]", kind: "bool", label: "Защита от копирования текста" },
    omnibusPrice: {
      field: "extra[enabled_omnibus_price]",
      kind: "bool",
      label: "Поле «Самая низкая цена за 30 дней до скидки» (Omnibus)",
    },
  },
  brand: {
    siteName: { field: "extra[site_name]", kind: "text", label: "Название магазина" },
    headerSite: { field: "header_site", kind: "text", i18n: true, label: "Общий title сайта" },
    siteDescription: { field: "site_description", kind: "text", i18n: true, label: "Описание сайта (для соцсетей)" },
    slogan: { field: "slogan", kind: "text", i18n: true, label: "Слоган (шапка сайта)" },
    copyright: { field: "copyright", kind: "text", i18n: true, label: "Копирайт (футер)" },
    aboutStore: { field: "seo_text", kind: "text", i18n: true, label: "О магазине (блок на Главной)" },
    timezone: { field: "extra[timezone]", kind: "enum", label: "Часовой пояс" },
    multicurrencyEnabled: { field: "extra[multicurrency_enabled]", kind: "bool", label: "Мультивалютность" },
    commentsModeration: { field: "extra[comments_moderation]", kind: "bool", label: "Модерация отзывов и комментариев" },
    onlinePaymentModeration: { field: "extra[online_payment_moderation]", kind: "bool", label: "Модерация онлайн-оплат" },
    gmapApiKey: { field: "extra[gmap_api_key]", kind: "text", label: "API-ключ Google карт" },
    mapCode: { field: "extra[map_code]", kind: "text", label: "HTML-код карты проезда" },
  },
  social: {
    facebookAuth: { field: "extra[facebook_auth_enabled]", kind: "bool", label: "Facebook: авторизация включена" },
    googleAuth: { field: "extra[google_auth_enabled]", kind: "bool", label: "Google: авторизация включена" },
    linkedInAuth: { field: "extra[linked_in_auth_enabled]", kind: "bool", label: "LinkedIn: авторизация включена" },
  },
} satisfies Record<string, Record<string, FieldDef>>;

type Section = keyof typeof REGISTRY;
const SECTIONS = Object.keys(REGISTRY) as Section[];

/** Every key -> its definition + owning section, for the universal reader/lookup. */
const ALL_DEFS: Record<string, FieldDef & { section: Section }> = {};
for (const section of SECTIONS) {
  for (const [key, def] of Object.entries(REGISTRY[section])) {
    ALL_DEFS[key] = { ...(def as FieldDef), section };
  }
}
/** Raw field name -> human key, so the reader accepts either. */
const FIELD_TO_KEY: Record<string, string> = {};
for (const [key, def] of Object.entries(ALL_DEFS)) {
  if (!def.i18n) FIELD_TO_KEY[def.field] = key;
}

const LANGS = ["ua", "ru", "en", "pl", "ro"] as const;
const langField = z
  .enum(LANGS)
  .optional()
  .describe("Language for translatable fields. Default ua.");

/** Read the whole registry (or one section) as {key: value} for a language. */
function snapshot(form: ParsedForm, idx: number, only?: Section): Record<string, Record<string, boolean | string>> {
  const out: Record<string, Record<string, boolean | string>> = {};
  for (const section of only ? [only] : SECTIONS) {
    out[section] = {};
    for (const [key, def] of Object.entries(REGISTRY[section])) {
      out[section][key] = readValue(form, def as FieldDef, idx);
    }
  }
  return out;
}

/**
 * The core read-modify-write for a section tool: given the section, the args and
 * the language, build the override set from any provided keys, then either
 * preview (dryRun / read-only) or save and verify by re-reading the form.
 */
async function runSection(
  client: any,
  section: Section,
  args: any,
): Promise<unknown> {
  const idx = LANG_INDEX[args.lang ?? "ua"] ?? 3;
  const defs = REGISTRY[section] as Record<string, FieldDef>;
  const form = await client.admin.getFormFromUrl(args.store, SETTINGS_URL);

  // Collect the keys the caller actually passed a value for.
  const set: Record<string, string> = {};
  const touched: string[] = [];
  for (const [key, def] of Object.entries(defs)) {
    if (args[key] === undefined) continue;
    const name = nameOf(def, idx);
    // Enum sanity: reject a value that is not one of the live <select> options,
    // and say what is valid — a bad option id would silently no-op otherwise.
    if (def.kind === "enum") {
      const sel = form.selects[name];
      const opts: Array<{ value: string; label: string }> = sel?.options ?? [];
      const val = String(args[key]);
      if (opts.length && !opts.some((o) => o.value === val)) {
        throw new Error(
          `Invalid value "${val}" for ${key}. Valid options: ${opts
            .map((o) => `${o.value}=${o.label}`)
            .join(", ")}.`,
        );
      }
    }
    set[name] = toOverride(def, args[key]);
    touched.push(key);
  }

  // No write params -> this is a read. Return current values for the section.
  if (touched.length === 0) {
    return { store: args.store, section, lang: args.lang ?? "ua", read: true, values: snapshot(form, idx, section)[section] };
  }

  const planned = touched.map((key) => {
    const def = defs[key];
    const name = nameOf(def, idx);
    return { key, field: name, from: readValue(form, def, idx), to: def.kind === "bool" ? set[name] === "1" : set[name] };
  });

  if (args.dryRun !== false) {
    return { store: args.store, section, lang: args.lang ?? "ua", dryRun: true, willChange: planned };
  }

  const res = await client.admin.save(args.store, form, set);
  const after = await client.admin.getFormFromUrl(args.store, SETTINGS_URL);
  const changes = planned.map((p) => {
    const def = defs[p.key];
    const now = readValue(after, def, idx);
    return { key: p.key, field: p.field, from: p.from, to: p.to, now, persisted: now === p.to };
  });
  const ok = changes.every((c) => c.persisted);
  return {
    store: args.store,
    section,
    lang: args.lang ?? "ua",
    dryRun: false,
    saved: ok,
    httpStatus: res.httpStatus,
    changes,
    note: ok ? "Saved and verified by re-reading the form." : "Some fields did not persist — see `changes`.",
  };
}

/** Build the zod input schema for a section from its registry entries. */
function schemaFor(section: Section, withLang: boolean): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = { ...storeField };
  for (const [key, def] of Object.entries(REGISTRY[section] as Record<string, FieldDef>)) {
    let field: z.ZodTypeAny;
    if (def.kind === "bool") field = z.boolean();
    else if (def.kind === "int") field = z.union([z.number().int(), z.string()]);
    else field = z.string();
    shape[key] = field.optional().describe(def.label);
  }
  if (withLang) shape.lang = langField;
  shape.dryRun = z.boolean().optional().describe("Default true: preview the change. Set false to apply.");
  return shape;
}

/**
 * Every settings_* writer goes through runSection → a full resubmit of the
 * shared general-settings form. Said once, appended to all five, so no section
 * quietly implies it only touches its own fields.
 */
const SETTINGS_WRITE_DOC =
  "HOW THE SAVE WORKS — IT IS NOT A PATCH. All settings_* writers share ONE form (utils/site_settings.php, ~370 fields covering every section, not just this one). Saving re-posts that whole form with your fields overridden, and Horoshop offers no version/ETag to detect a conflict. So if a colleague is editing anything on the store's settings page in a browser while you save, their change is overwritten without a warning on either side. On a live store, save when nobody else is in there.";

export const adminSettingsTools: ToolSpec[] = [
  {
    name: "horoshop_admin_settings_tracking",
    title: "Read or set the store's tracking / analytics scripts",
    description:
      "Read or set the site-wide tracking scripts injected into every storefront page: `scriptOnTop` (right after <body>), `scriptOnBottom` (before </body>), `scriptInHead` (inside <head>), and `ga4Id` (the GA4 measurement/resource id). This is where GTM, Meta Pixel, GA and any custom JS live — HTML/JS is allowed verbatim. Call with no script args to just read the current values. DRY RUN BY DEFAULT. " +
      SETTINGS_WRITE_DOC,
    inputSchema: schemaFor("tracking", false),
    annotations: { readOnlyHint: false, idempotentHint: true },
    handler: (client, args) => runSection(client, "tracking", args),
  },
  {
    name: "horoshop_admin_settings_checkout",
    title: "Read or set checkout / order-form options",
    description:
      "Read or set the checkout form's behaviour: the e-mail fields (`showEmail`, `requireEmail`), `requireAuthorization`, the newsletter opt-in (`newsletterSubscription` + `newsletterSubscriptionDefault`), `showCouponCode`, `showCountries`, `phoneMask`, the 'do not call' option (`orderWithoutCallback` + `orderWithoutCallbackDefault`), `commentFieldExpanded`, and the quick-order block (`quickOrderEnabled`, `quickOrderShowName`, `quickOrderShowEmail`, `quickOrderPriorityMobile`). All are booleans (true=on). Booleans are stored as a hidden 0 plus a checkbox 1, so turning one off sends the hidden 0 exactly like a browser would. Call with no args to read. DRY RUN BY DEFAULT. " +
      SETTINGS_WRITE_DOC,
    inputSchema: schemaFor("checkout", false),
    annotations: { readOnlyHint: false, idempotentHint: true },
    handler: (client, args) => runSection(client, "checkout", args),
  },
  {
    name: "horoshop_admin_settings_catalog",
    title: "Read or set catalog behaviour options",
    description:
      "Read or set how the catalog behaves: modification grouping (`groupModifications`, `useGeneratedTitle`, `highlightUnavailableModifications`, `highlightMissingModifications`), `compareItems`, `allowListView`, price rounding (`currencyRoundTo`), `primarySort` (enum), `newIconDaysDuration`, the B2B toggles (`accessMultiplicity`, `accessUnitsOfMeasurement`, `accessWholesalePrices`, `accessMinOrder`), stock accounting (`useResiduesByStock`), `productsSetEnabled`, `giftsEnabled`, `specifyPrice`, `digitalProductsEnabled`, `cartAddOpen`, `checkAllParams`, `hintType` (enum), `mobileCardView`, `contentCopyProtection`, and `omnibusPrice` (EU 30-day-low law). Booleans are true/false; enums reject unknown values and list the valid ones. Call with no args to read. DRY RUN BY DEFAULT. " +
      SETTINGS_WRITE_DOC,
    inputSchema: schemaFor("catalog", false),
    annotations: { readOnlyHint: false, idempotentHint: true },
    handler: (client, args) => runSection(client, "catalog", args),
  },
  {
    name: "horoshop_admin_settings_brand",
    title: "Read or set brand texts, timezone, map and moderation",
    description:
      "Read or set the store's brand-level settings: the display `siteName`, and the translatable `headerSite` (common title), `siteDescription`, `slogan`, `copyright`, `aboutStore` (the 'О магазине' block on the home page). Plus `timezone` (enum), `multicurrencyEnabled`, `commentsModeration`, `onlinePaymentModeration`, `gmapApiKey` and `mapCode` (HTML). Translatable fields use `lang` (default ua). Call with no field args to read. DRY RUN BY DEFAULT. " +
      SETTINGS_WRITE_DOC,
    inputSchema: schemaFor("brand", true),
    annotations: { readOnlyHint: false, idempotentHint: true },
    handler: (client, args) => runSection(client, "brand", args),
  },
  {
    name: "horoshop_admin_settings_social_auth",
    title: "Read or set social login providers",
    description:
      "Read or set which social-login buttons the storefront offers: `facebookAuth`, `googleAuth`, `linkedInAuth` (all booleans, true=enabled). Enabling here shows the provider; the client_id/secret are configured separately. Call with no args to read. DRY RUN BY DEFAULT. " +
      SETTINGS_WRITE_DOC,
    inputSchema: schemaFor("social", false),
    annotations: { readOnlyHint: false, idempotentHint: true },
    handler: (client, args) => runSection(client, "social", args),
  },
  {
    name: "horoshop_admin_settings_get",
    title: "Read any general setting, or list what settings exist",
    description:
      "The read/discovery companion to the settings_* writers. With no filters it returns the current value of every named setting, grouped by section. Narrow it with `section`, with `keys` (human keys like 'showCouponCode'), or with `fields` (raw names like 'extra[show_coupon_code]'). `lang` (default ua) selects the language of translatable values. Set `catalog:true` to get the map of every writable key -> raw field + section (the 'what can I change' reference), or `index:true` for the raw label->field index of the general-settings page — including entries without a named tool yet: SMTP, fiscal/Checkbox, reCAPTCHA, marketplaces, cookies/age gates. " +
      "THE INDEX NOW ALSO LISTS THE FORM'S HIDDEN FIELDS, which is where a whole class of \"unreachable\" settings was hiding: 12 `extra[np_*]` (Nova Poshta), 4 legacy `extra[sms_fly_*]`, 3 GA4 service-account fields, `extra[domain_address]`, `extra[inpost_map_points_enabled]`. They are `<input type=hidden>` on the settings page, so nothing that maps the visible form ever saw them. ⚠ `np_*` IS A LEGACY MIRROR, NOT THE SOURCE OF TRUTH — the real Nova Poshta editor is the delivery method (handler 235) under `Delivery[delivery_method][serviceSettings.<dotted.path>]`, and the two have already drifted (`serviceSettings.byDefault.description` = «Товари» vs `extra[np_native_description]` = «Товары»). Read NP from 235, write NP in 235; the mirror is listed here only so a read-modify-write passes it through knowingly. The GA4 fields and `domain_address` are CONDITIONAL — the page renders them only where the integration exists, so reading them on a store without it returns nothing, which is \"not configured\", not a failure. " +
      "THE INDEX IS STILL NOT THE WHOLE FORM. What it does not list is what other tools already own — logos, favicon, og:image, watermark, the contacts table, the names[…] cluster. Missing from `index` therefore means \"reached elsewhere\" (horoshop_admin_upload_image, horoshop_admin_store_contacts, the category tools), not \"unreachable\". " +
      "DO NOT reach for horoshop_admin_record_get entity=site_settings just to browse: that form is 374 fields / ~98 KB and will eat the answer budget in one call. Use this tool's filters instead, and go to record_get only for a field you have already named.",
    inputSchema: {
      ...storeField,
      section: z.enum(SECTIONS as [Section, ...Section[]]).optional().describe("Limit to one section."),
      keys: z.array(z.string()).optional().describe("Specific human keys to read, e.g. [\"siteName\",\"showCouponCode\"]."),
      fields: z.array(z.string()).optional().describe("Specific raw field names to read, e.g. [\"extra[timezone]\"]."),
      lang: langField,
      catalog: z.boolean().optional().describe("Return the key -> field/section map instead of values."),
      index: z.boolean().optional().describe("Return the full raw label->field index of all general-settings fields."),
    },
    annotations: { readOnlyHint: true },
    handler: async (client, args) => {
      if (args.catalog) {
        const cat: Record<string, { field: string; section: Section; kind: Kind; i18n: boolean; label: string }> = {};
        for (const [key, def] of Object.entries(ALL_DEFS)) {
          cat[key] = { field: def.i18n ? `extra[i18n][*][${def.field}]` : def.field, section: def.section, kind: def.kind, i18n: !!def.i18n, label: def.label };
        }
        return { catalog: cat, count: Object.keys(cat).length };
      }
      if (args.index) {
        return {
          note: "Raw label -> field index of the general-settings page. `[i18n][*]` = translatable; * is the language index (ua=3, ru=1, en=4, pl=5, ro=6). Fields without a named tool are reachable via horoshop_admin_record_get/record_save (formUrl utils/site_settings.php).",
          fields: SETTINGS_FIELD_INDEX.map(([label, field]) => ({ label, field })),
          count: SETTINGS_FIELD_INDEX.length,
        };
      }

      const idx = LANG_INDEX[args.lang ?? "ua"] ?? 3;
      const form = await client.admin.getFormFromUrl(args.store, SETTINGS_URL);

      // Specific keys / raw fields requested.
      if ((args.keys && args.keys.length) || (args.fields && args.fields.length)) {
        const wanted = new Set<string>();
        for (const k of args.keys ?? []) wanted.add(k);
        for (const f of args.fields ?? []) {
          const key = FIELD_TO_KEY[f];
          if (key) wanted.add(key);
        }
        const values: Record<string, { section: Section; field: string; value: boolean | string }> = {};
        const unknown: string[] = [];
        for (const k of wanted) {
          const def = ALL_DEFS[k];
          if (!def) {
            unknown.push(k);
            continue;
          }
          values[k] = { section: def.section, field: nameOf(def, idx), value: readValue(form, def, idx) };
        }
        // Raw fields with no named key: read them straight off the form.
        const rawOnly: Record<string, string> = {};
        for (const f of args.fields ?? []) {
          if (!FIELD_TO_KEY[f]) rawOnly[f] = fieldValue(form, f);
        }
        return {
          store: args.store,
          lang: args.lang ?? "ua",
          values,
          ...(Object.keys(rawOnly).length ? { rawFields: rawOnly } : {}),
          ...(unknown.length ? { unknownKeys: unknown } : {}),
        };
      }

      // Default: everything (optionally one section).
      return { store: args.store, lang: args.lang ?? "ua", values: snapshot(form, idx, args.section) };
    },
  },
];

/**
 * Raw label -> field index of the general-settings page (utils/site_settings.php),
 * for discovery. `[i18n][*]` marks a translatable field (replace * with the
 * language index). Fields here that lack a dedicated tool are still writable via
 * horoshop_admin_record_get / record_save against the same form URL.
 */
const SETTINGS_FIELD_INDEX: Array<[string, string]> = [
  ["Общий title сайта Используется как часть title для всех страниц", "extra[i18n][*][header_site]"],
  ["Название магазина Используется в главном меню мобильной версии и в загол", "extra[site_name]"],
  ["Описание сайта Используется для публикации в соцсетях", "extra[i18n][*][site_description]"],
  ["О магазине Блок отображается на Главной странице", "extra[i18n][*][seo_text]"],
  ["Слоган Короткий текст в шапке сайта", "extra[i18n][*][slogan]"],
  ["Копирайт Короткий текст в футере сайта", "extra[i18n][*][copyright]"],
  ["Реквизиты для счета Будет отображаться в графе Поставщик в счете", "extra[provider_print_documents]"],
  ["Часовой пояс", "extra[timezone]"],
  ["Мультивалютность", "extra[multicurrency_enabled]"],
  ["Аналитика: Идентификатор ресурса GA4 Инструкция", "extra[ga_auth_project_name]"],
  ["Модерация отзывов и комментариев", "extra[comments_moderation]"],
  ["Включить модерацию онлайн-оплат Режимы онлайн-оплат", "extra[online_payment_moderation]"],
  ["Расширенная форма регистрации Только для B2B тарифа", "extra[extended_registration_form]"],
  ["Включить поле «Самая низкая цена за 30 дней до скидки»", "extra[enabled_omnibus_price]"],
  ["Адрес", "extra[i18n][*][address]"],
  ["График работы Отображается в шапке сайта", "extra[i18n][*][timetable]"],
  ["API ключ для Google карт", "extra[gmap_api_key]"],
  ["Адрес магазина При использовании API ключа", "extra[i18n][*][gmap_api_address]"],
  ["HTML код карты проезда", "extra[map_code]"],
  ["Facebook: включить", "extra[facebook_auth_enabled]"],
  ["Google: включить", "extra[google_auth_enabled]"],
  ["LinkedIn: включить", "extra[linked_in_auth_enabled]"],
  ["Скрипты после тега <body>", "extra[script_on_top]"],
  ["Скрипты перед тегом </body>", "extra[script_on_bottom]"],
  ["Скрипты внутри тега <head>", "extra[script_in_head]"],
  ["Показывать накопительную скидку в корзине", "extra[cart_show_used_discount]"],
  ["Оптовые цены за количество в корзине", "extra[cart_show_wholesale_discount]"],
  ["Товары в блоке «Рекомендуем приобрести»", "extra[cart_associated_products][]"],
  ["Отображать поле «Эл. почта»", "extra[order_show_email]"],
  ["Эл. почта обязательна", "extra[order_required_email]"],
  ["Обязательная авторизация при известном email", "extra[order_required_authorization]"],
  ["Пользовательское соглашение", "extra[user_agreement]"],
  ["Не звонить для подтверждения заказа", "extra[order_without_callback]"],
  ["«Не звонить» активна по умолчанию", "extra[order_without_callback_default]"],
  ["Подсказка для опции «Не звонить»", "extra[i18n][*][order_without_callback_tooltip]"],
  ["Согласие на получение рассылок", "extra[newsletter_subscription]"],
  ["Согласие на рассылки активно по умолчанию", "extra[newsletter_subscription_default]"],
  ["Подсказка для опции «Согласие на рассылки»", "extra[i18n][*][newsletter_subscription_text]"],
  ['Отображать поле «Страна»', "extra[show_countries]"],
  ["Поле Комментарий развернуто", "extra[comment_field_expanded]"],
  ["Включить маску ввода номера телефона (UA)", "extra[enable_phone_mask_on_input]"],
  ["Отображать поле для купонов", "extra[show_coupon_code]"],
  ["Быстрый заказ: включить", "extra[order_quick_enabled]"],
  ["Быстрый заказ: поле «Имя и фамилия»", "extra[order_quick_show_name]"],
  ["Быстрый заказ: поле «Эл. почта»", "extra[order_quick_show_email]"],
  ["Быстрый заказ: приоритет в мобильной версии", "extra[order_quick_priority_mobile]"],
  ["Инфо-таб товара: Доставка", "extra[i18n][*][info_delivery]"],
  ["Инфо-таб товара: Оплата", "extra[i18n][*][info_payment]"],
  ["Инфо-таб товара: Гарантия", "extra[i18n][*][info_warranty]"],
  ["Инфо-таб товара: Возврат", "extra[i18n][*][info_return]"],
  ["Инфо-таб товара: Консультация", "extra[i18n][*][info_consult]"],
  ["Включить учёт остатков", "extra[catalog_use_residues_by_stock]"],
  ["Приоритетная сортировка товаров в каталоге", "extra[primary_sort]"],
  ["Кратность (шаг кол-ва в корзине)", "extra[access_multiplicity]"],
  ["Единицы измерения товара", "extra[access_units_of_measurement]"],
  ["Оптовые цены за количество", "extra[access_wholesale_prices]"],
  ["Группировать товары по модификациям", "extra[group_modifications]"],
  ["Генерировать названия для модификаций", "extra[use_generated_title]"],
  ["Сравнение товаров", "extra[compare_items]"],
  ["Отображение товаров списком", "extra[allow_list_view]"],
  ["Минимальный заказ", "extra[access_min_order]"],
  ["Выделять товары не в наличии в переключателе модификаций", "extra[highlight_unavailable_modifications]"],
  ["Выделять отсутствующие модификации в переключателе", "extra[highlight_missing_modifications]"],
  ["Округление цен (знаков после запятой)", "extra[currency_round_to]"],
  ["Новинка: кол-во дней", "extra[new_icon_days_duration]"],
  ["Крупная плитка по умолчанию (мобайл)", "extra[mobile_card_view]"],
  ["Комплекты товаров", "extra[products_set_enabled]"],
  ["Подарки", "extra[gifts_enabled]"],
  ["Функция «Узнать цену»", "extra[specify_price]"],
  ["Подсказки для характеристик (вид)", "extra[hint_type]"],
  ["Открывать корзину при добавлении товара", "extra[cart_add_open]"],
  ["Похожие товары по всем характеристикам", "extra[check_all_params]"],
  ["Электронные товары", "extra[digital_products_enabled]"],
  ["Водяной знак: расположение", "extra[watermark_position]"],
  ["Водяной знак: масштаб", "extra[watermark_scale]"],
  ["Защита от копирования текста", "extra[content_copy_protection]"],
  ["Checkbox ПРРО: включить", "extra[checkbox_is_enabled]"],
  ["Checkbox ПРРО: логин кассира", "extra[checkbox_login]"],
  ["Checkbox ПРРО: пароль кассира", "extra[checkbox_password]"],
  ["Checkbox ПРРО: ключ лицензии кассы", "extra[checkbox_cashbox_license_key]"],
  ["Checkbox ПРРО: автосоздание чеков", "extra[checkbox_automatic_receipts]"],
  ["Checkbox ПРРО: чек на email", "extra[checkbox_send_check_on_email]"],
  ["Checkbox ПРРО: чек по SMS", "extra[checkbox_send_check_via_sms]"],
  ["Checkbox ПРРО: передавать налоги", "extra[checkbox_use_tax]"],
  ["Checkbox ПРРО: доп. информация в чеке", "extra[checkbox_footer]"],
  ["Checkbox ПРРО: название доставки в чеке", "extra[checkbox_delivery_title]"],
  ["Checkbox ПРРО: название наценки на оплату", "extra[checkbox_payment_title]"],
  ["Checkbox ПРРО: доставка как товар в чеке", "extra[checkbox_delivery_as_product]"],
  ["Checkbox ПРРО: артикул доставки", "extra[checkbox_delivery_article]"],
  ["Checkbox ПРРО: код налога для доставки", "extra[checkbox_delivery_tax_code]"],
  ["Checkbox ПРРО: комиссия как товар в чеке", "extra[checkbox_payment_as_product]"],
  ["Checkbox ПРРО: артикул комиссии", "extra[checkbox_payment_article]"],
  ["Checkbox ПРРО: код налога комиссии", "extra[checkbox_payment_tax_code]"],
  ["Вчасно ПРРО: включить", "extra[vchasno_is_enabled]"],
  ["Вчасно ПРРО: токен кассы", "extra[vchasno_cashbox_token]"],
  ["Вчасно ПРРО: автосоздание чеков", "extra[vchasno_automatic_receipts]"],
  ["Вчасно ПРРО: чек на email", "extra[vchasno_send_check_on_email]"],
  ["Вчасно ПРРО: чек по SMS", "extra[vchasno_send_check_via_sms]"],
  ["Вчасно ПРРО: код налоговой группы по умолчанию", "extra[vchasno_default_tax_code]"],
  ["Вчасно ПРРО: доп. информация в чеке", "extra[vchasno_footer]"],
  ["Вчасно ПРРО: название доставки", "extra[vchasno_delivery_title]"],
  ["Вчасно ПРРО: название наценки на оплату", "extra[vchasno_payment_title]"],
  ["Вчасно ПРРО: артикул доставки", "extra[vchasno_delivery_article]"],
  ["Вчасно ПРРО: код налога для доставки", "extra[vchasno_delivery_tax_code]"],
  ["Вчасно ПРРО: артикул комиссии", "extra[vchasno_payment_article]"],
  ["Вчасно ПРРО: код налога комиссии", "extra[vchasno_payment_tax_code]"],
  ["Вчасно ПРРО: название наценки менеджера", "extra[vchasno_markup_title]"],
  ["Вчасно ПРРО: артикул наценки менеджера", "extra[vchasno_markup_article]"],
  ["Вчасно ПРРО: код налога наценки менеджера", "extra[vchasno_markup_tax_code]"],
  ["SMS Fly: включить", "extra[sms_fly_rest_enabled]"],
  ["SMS Fly: имя отправителя", "extra[sms_fly_rest_sender]"],
  ["SMS Fly: ключ API", "extra[sms_fly_rest_api_key]"],
  ["Email отправителя", "extra[email_address]"],
  ["Email: имя отправителя", "extra[email_sender]"],
  ["Использовать SMTP", "extra[smtp]"],
  ["Использовать SSL для SMTP", "extra[smtp_ssl]"],
  ["SMTP сервер", "extra[smtp_server]"],
  ["SMTP порт", "extra[smtp_port]"],
  ["SMTP имя пользователя", "extra[smtp_username]"],
  ["SMTP пароль", "extra[smtp_password]"],
  ["Email reply-to для заказов", "extra[email_reply_to]"],
  ["Массовая отправка: макс. писем в час", "extra[email_max_per_hour]"],
  ["Canonical на первую страницу пагинации", "extra[pagination_canonical_on_first_page]"],
  ["Не индексировать страницы пагинации", "extra[pagination_noindex]"],
  ["Отображать seo-текст при get-параметрах", "extra[enabled_seo_text_with_get_params]"],
  ["Отображать страницу Каталог в хлебных крошках", "extra[show_catalog_in_breadcrumbs]"],
  ["Ссылка на Бренд в хлебных крошках товара", "extra[show_brand_in_breadcrumbs]"],
  ["Facebook Conversion API: активировать", "extra[facebook_conversion_enabled]"],
  ["Facebook Conversion API: маркер доступа", "extra[facebook_conversion_marker]"],
  ["reCAPTCHA: включить", "extra[google_recaptcha_enable]"],
  ["reCAPTCHA: на все формы сайта", "extra[google_recaptcha_allow_use_in_all_forms]"],
  ["reCAPTCHA: Site key", "extra[google_recaptcha_site_key]"],
  ["reCAPTCHA: Secret key", "extra[google_recaptcha_secret_key]"],
  ["Rozetka: логин", "extra[rozetka_login]"],
  ["Rozetka: пароль", "extra[rozetka_password]"],
  ["Rozetka: короткое название магазина", "extra[rozetka_shop_name]"],
  ["Rozetka: полное наименование компании", "extra[rozetka_company_name]"],
  ["Заброшенные корзины: включить письма", "extra[abandoned_cart_enabled]"],
  ["Заброшенные корзины: тема письма", "extra[i18n][*][abandoned_cart_title]"],
  ["Заброшенные корзины: сообщение письма", "extra[i18n][*][abandoned_cart_text]"],
  ["Kasta: токен", "extra[kasta_token]"],
  ["Kasta: автообновление цен и остатков", "extra[kasta_is_update]"],
  ["Cookies: окно согласия на языковых версиях", "extra[cookies_languages][]"],
  ["Cookies: текст", "extra[i18n][*][cookies_text]"],
  ["Возрастной гейт: включить", "extra[age_confirmation_enabled]"],
  ["Возрастной гейт: возраст", "extra[age_confirmation_age]"],
  ["Возрастной гейт: заголовок окна", "extra[i18n][*][age_confirmation_title]"],
  ["Возрастной гейт: текст", "extra[i18n][*][age_confirmation_text]"],
  ["Возрастной гейт: текст кнопки подтверждения", "extra[i18n][*][age_confirmation_confirm_text]"],
  ["Возрастной гейт: текст кнопки отказа", "extra[i18n][*][age_confirmation_decline_text]"],
  ["Возрастной гейт: редирект после отказа", "extra[age_confirmation_redirect]"],
  ["Страна магазина", "extra[country_id]"],

  // ── Поля, которые форма рендерит СКРЫТЫМИ (input type=hidden) ────────────
  // Их не видно на экране настроек, поэтому все прошлые карты страницы их
  // пропускали и каждая следующая сессия объявляла «дырой». Они настоящие
  // поля формы: read-modify-write через record_get/record_save по
  // utils/site_settings.php их читает и пересылает.
  //
  // ⚠️ np_* — ЛЕГАСИ-ЗЕРКАЛО, НЕ ИСТОЧНИК ПРАВДЫ. Настоящий редактор Новой
  // Почты живёт в варианте доставки (handler 235, записи 3/16/17) под четвёртым
  // префиксом имён `Delivery[delivery_method][serviceSettings.<dotted.path>]`.
  // Числа там и тут совпадают, а тексты уже разошлись (замерено:
  // serviceSettings.byDefault.description = «Товари» против
  // extra[np_native_description] = «Товары»). Читать np_* как настройку НП
  // нельзя, писать НП надо в 235; здесь они перечислены, чтобы их было видно
  // и чтобы RMW пересылал их как есть.
  ["Новая Почта (ЛЕГАСИ-ЗЕРКАЛО, правится в варианте доставки 235): ключ API", "extra[np_api_key]"],
  ["Новая Почта (легаси-зеркало): телефон отправителя", "extra[np_phone]"],
  ["Новая Почта (легаси-зеркало): вес по умолчанию", "extra[np_weight]"],
  ["Новая Почта (легаси-зеркало): габарит ширина", "extra[np_g_width]"],
  ["Новая Почта (легаси-зеркало): габарит длина", "extra[np_g_length]"],
  ["Новая Почта (легаси-зеркало): габарит высота", "extra[np_g_height]"],
  ["Новая Почта (легаси-зеркало): плательщик доставки", "extra[np_delivery_payer]"],
  ["Новая Почта (легаси-зеркало): форма оплаты", "extra[np_payment_form]"],
  ["Новая Почта (легаси-зеркало): плательщик обратной доставки", "extra[np_reverse_delivery_payer]"],
  ["Новая Почта (легаси-зеркало): показывать описание", "extra[np_show_description]"],
  ["Новая Почта (легаси-зеркало): описание на языке магазина", "extra[np_native_description]"],
  ["Новая Почта (легаси-зеркало): описание отправления", "extra[np_description]"],

  // SMS Fly, СТАРАЯ интеграция (у новой REST-версии свои три поля выше).
  ["SMS Fly (легаси, не REST): включить", "extra[sms_fly_enabled]"],
  ["SMS Fly (легаси, не REST): альфа-имя", "extra[sms_fly_alfaname]"],
  ["SMS Fly (легаси, не REST): логин", "extra[sms_fly_login]"],
  ["SMS Fly (легаси, не REST): пароль", "extra[sms_fly_password]"],

  // GA4 сервис-аккаунт. УСЛОВНЫЕ поля: JS дорисовывает их только на магазинах с
  // настроенной интеграцией — на тестовом магазине этих инпутов в форме нет вовсе, и чтение
  // вернёт пусто. Это не поломка, это «интеграция не подключена».
  ["Аналитика GA4: использовать API Хорошопа (блокирует два поля ниже)", "extra[ga_auth_use_horoshop_api]"],
  ["Аналитика GA4: id сервис-аккаунта (условное поле)", "extra[ga_auth_service_id]"],
  ["Аналитика GA4: e-mail сервис-аккаунта (условное поле)", "extra[ga_service_email]"],

  // Прочее скрытое/условное.
  ["Домен магазина (условное поле; валидируется projectAjax load=validate-domain)", "extra[domain_address]"],
  ["InPost: выбор отделения на карте (нужен ключ Google Maps)", "extra[inpost_map_points_enabled]"],
];
