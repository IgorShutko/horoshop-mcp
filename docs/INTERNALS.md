# Internals

How horoshop-mcp is built, how it reaches the parts of Horoshop that the public API does not cover, and what the platform does that you should plan around. Everything under [Platform notes](#platform-notes) was measured on live stores rather than taken from documentation.

## Contents

- [Architecture](#architecture)
- [Project layout](#project-layout)
- [The control panel engine](#the-control-panel-engine)
- [The storefront channel](#the-storefront-channel)
- [Bulk product operations and prices](#bulk-product-operations-and-prices)
- [Characteristics and dictionaries](#characteristics-and-dictionaries)
- [Coverage](#coverage)
- [Platform notes](#platform-notes)
- [Adding a tool](#adding-a-tool)

## Architecture

```
MCP client ──stdio──> horoshop-mcp
                        ├── public API client    ──> https://<store>/api/<function>/
                        ├── control panel client ──> https://<store>/core-api/... and the legacy admin
                        └── storefront client    ──> https://<store>/_widget/ajax_cart/...
```

- One process serves every configured store. Each call resolves `store` (or the default store) to its URL and credentials.
- **Public API client** (`src/client.ts`) sends JSON POST requests to `<baseUrl>/api/<function>/`. Tokens live 600 seconds; they are cached per store, renewed shortly before expiry and once more if a token expires mid-call. `OK`, `EMPTY` and `WARNING` count as success, every other status raises an error.
- **Control panel client** (`src/admin/session.ts`) logs in with `POST /core-api/admin/security/login` using the same login and password, keeps the `API_SESSION_ID` cookie and drives the legacy admin screens behind the React panel.
- **Storefront client** (`src/admin/storefront.ts`) holds a buyer session against the shop's own cart widget.
- **Registration** (`src/register.ts`): every tool is a `ToolSpec` with a name, title, description, zod input schema, MCP annotations and a handler. Registration adds error mapping and the response size gate for read-only tools.
- All logging goes to stderr, because stdout carries the MCP protocol.

## Project layout

| Path | Contents |
|---|---|
| `src/index.ts` | Entry point: loads the configuration, registers all tool groups, starts the stdio transport. |
| `src/config.ts` | Store configuration from `HOROSHOP_STORES` or `HOROSHOP_STORES_FILE`, URL normalization, default store. |
| `src/client.ts` | Public API client with the token cache and status handling. |
| `src/register.ts` | `ToolSpec`, the shared `store` field and MCP registration. |
| `src/sizeGate.ts` | Response size gate for read tools. |
| `src/buildInfo.ts` | Detects a stale build: `dist/` newer than the running process. |
| `src/tools/*.ts` | Tool groups, one file per area: catalog, orders, feeds, redirects, settings and so on. |
| `src/admin/session.ts` | Control panel client: login, datagrid lists, forms, widgets, retries. |
| `src/admin/entities.ts` | Registry of control panel entity types keyed by `handler`. |
| `src/admin/form.ts` | Parsing and replaying legacy admin forms. |
| `src/admin/changes.ts` | Compact diffs and append or prepend for long text fields. |
| `src/admin/placeholders.ts` | Guard against overwriting storefront template tokens. |
| `src/admin/templateGuard.ts` | Pre-flight check that imported characteristics exist in the category template. |
| `src/admin/redact.ts` | Masks payment credentials in design configuration output. |
| `src/admin/redirects.ts` | Duplicate, loop and collision checks for 301 redirects. |
| `src/admin/orders.ts` | The order editor, which works differently from other admin screens. |
| `src/admin/newsTree.ts` | Blog and news rubric handling. |
| `src/admin/languageState.ts` | Which store languages are enabled and which language admin lists render in. |
| `src/admin/payloadFile.ts` | Loading large write payloads from a file instead of a tool argument. |
| `src/admin/retry.ts` | Retry of transient network failures in long request sequences. |
| `src/admin/storefront.ts` | Buyer cart and checkout. |
| `src/admin/ua.ts` | The browser User-Agent sent with every store request. |
| `scripts/tools-doc.mjs` | Generates [TOOLS.md](TOOLS.md) from the running server. |
| `evaluation/horoshop_eval.xml` | Read-only questions for evaluating a model working through the server. |

## The control panel engine

The admin-panel tools reach the control panel for what the documented `/api/` cannot do: SEO and body texts for pages and categories, coupons, banners, redirects, settings, custom CSS and more. They use a control panel session, separate from the API token, and read-modify-write: read the whole edit form, change only the requested fields, submit everything else as it was. Writes are previews by default and are verified by reading the record back.

The legacy admin is one uniform machine keyed on `handler`, the entity-type id: `data.php?handler=H` lists records, `edit.php?id=X&handler=H` opens one, `save.php` persists it. `src/admin/entities.ts` registers these types, so a small generic core (`horoshop_admin_list`, `horoshop_admin_record_get`, `horoshop_admin_record_save`, `horoshop_admin_record_delete`) reaches almost every section, and named tools add ergonomics for the common ones.

Covered generically: pages and categories, coupons, brands, colors, stickers, benefits, socials, customer groups, price levels, currencies, SMS and SEO templates, order statuses, payment and delivery methods, marketplaces, filters, client cards, and two settings singletons: `payment_settings` (merchant keys) and `site_settings`.

**`site_settings`** holds the store's general settings: name, contacts, address, timetable, tracking markers, and the product-card info tabs (`extra[i18n][<lang>][info_delivery|info_payment|info_return|info_warranty|info_consult]`) that the design configuration only references as `{"source":"db"}`. It is not a handler of its own: the page is the editor for page 1 with a block of about 345 `extra[...]` fields, so address it by slug. Phones and messengers live in a table the admin builds in JavaScript, so writing them needs `allowNewFields:true`: send `extra[contacts_data][common][<n>][{id:"NEW",i18n_language:"3",type:"phone|viber|telegram|whatsapp|email|raw",value,display_value,icon:"auto",sort_order}]`.

**Handler numbers are mostly, not always, the same across stores.** The menu item `settings_vchasno_payment_types` is handler 458 on one store and 468 on others, with identical grids behind both. Reading the wrong number returns an empty grid and no error. Entities known to move carry a `navName`, and the server resolves the real number from the store's own `/core-api/admin/navigation`; for all other entities this costs no request.

**A live grid is not automatically an entity.** `data.php?handler=271` renders the delivery-methods list (row for row identical to handler 235), while `edit.php?...&handler=271` opens a row of the neighbouring `h_delivery_settings` table in an unrelated id space. Listing and reading would address different tables, so it is deliberately not registered; its tariffs are available through `delivery/export` → `price_options`. Handlers 381, 460 and 461 are rows of the product-template registry, so their grid is the catalog. Handlers 287, 444, 456 and 457 are child rows of carts and orders that the platform fills on its own: placing one storefront order moves 444 and 456 from 0 to 1, deleting it moves them back.

**Lists say when they are incomplete.** A big grid pages on a sort column with duplicates and no stable tiebreaker, so rows move across page boundaries between renders and some are served on no page at all. Measured on a 523-product grid: 1 row lost at `perPage:160`, 7 to 10 rows at `perPage:20`. `horoshop_admin_list` re-reads the drifting pages with a different window size and reports what it recovered in `driftRepair`; if rows are still missing, `count` is less than `total` and the answer carries `truncated:true` with a warning. The list is returned once, in `records`; `rows` is a small guard object that points there, so code reading `.rows` fails loudly instead of seeing an empty grid. The answer also carries `labelLang`: the admin renders multilingual columns in its interface language, which is not necessarily the store's first language, so a Russian label does not mean the Ukrainian text is missing.

## The storefront channel

The documented API has no cart (it answers `UNDEFINED_FUNCTION`), so it cannot tell whether a customer is able to reach checkout. The `horoshop_cart_*` tools speak the shop's own cart widget: `POST /_widget/ajax_cart/<action>/` with the actions `init`, `appendProduct` (`product[id]`, `product[type]="product"`, `product[quantity]`), `setProductQuantityByHash`, `removeProductByHash` and `setCouponCode`.

Two gates apply. The `GLOBAL_CSRF_TOKEN` from any storefront page must be sent in the **`X-CSRF-Token` header**; as a form field it answers `BAD_CSRF`. A proof-of-work anti-bot page serves a 518-byte challenge, so **HTTP 200 alone proves nothing**; the client solves the challenge and keeps the session. `horoshop_checkout_inspect` then reads what checkout offers, which is the most direct proof that an option enabled in the admin reached the place where money changes hands. `CART_EXCEPTION` usually means the product has no stock, not that the cart is broken.

## Bulk product operations and prices

Ticking rows in the products grid reveals a toolbar of nine mass actions, and they do **not** share one endpoint:

- availability, stickers, countdown and marketplace go to `group_products_edit/doEdit/`;
- "change display" is the grid's inline cell editor (`ajax.datagrid.php load=dataGridUpdateValues`), the third product write surface after `save.php` and `catalog/import`;
- delete is `removeSelectedGrids`, copy is `projectAjax.php`, merge is a two-step form that posts back to `data.php`;
- «Внести/Вынести» is the warehouse ledger, used by `horoshop_admin_product_stock_set`.

`horoshop_admin_products_group_edit` addresses products by **article** and resolves them to internal ids in one grid walk. Stickers, statuses and marketplaces may be named by title and are validated against the store's own list, because Horoshop answers `OK` for an id that means nothing and changes nothing. Articles are matched exactly, never as substrings.

**Prices have their own tool.** The grid's editable cells are `price`, `price_old` and `display_in_showcase`, but price is the one field where a wrong value is charged to real customers the moment it lands. `horoshop_admin_products_price_set` is built on the assumption that an argument will eventually be wrong:

- it previews the arithmetic per product (`was → becomes · delta`), so a `-90` typed instead of `-9` is visible before anything is written;
- it refuses a price of zero or below, with no override;
- above 50 products it demands `confirmProductCount` with the exact number, and above a 50% change it demands `confirmBigChange`, naming the products; these thresholds can be lowered but not raised;
- it writes only the cells it was asked to change, verifies the result through the public `catalog/export` API (a different transport and credential than the session that wrote) and returns a `rollback` block with the complete arguments that restore every previous price.

Modifications are ordinary rows and are priced individually: repricing a parent does not move its children. A product with a non-zero `discount` is flagged, because the storefront recalculates its shelf price from the price you set.

**Stock.** `catalog_import` accepts a `quantity` field, answers «Товар обновлен» and leaves the warehouse unchanged. `horoshop_admin_product_stock_set` is the write path measured to move stock, and it verifies the result.

## Characteristics and dictionaries

**Category characteristics.** `catalog_import` silently drops a characteristic that the product's category template does not define, and still answers «Товар обновлен». A pre-flight guard checks import payloads against the template before writing. `horoshop_admin_template_schema` lists the field names a category accepts, and `horoshop_admin_template_param_add` creates a new one. A dictionary-backed select must reference its dictionary as `book_<id>`: a bare id binds the field to a template instead, and values never land. Field names differ per category, so export one product first to learn a store's names.

**Attribute dictionaries** («Справочники») hold the value lists behind characteristics: materials, sizes, colors, units.

- **Creating a value:** the catalog API creates it as a side effect the moment a product uses it as a characteristic. `horoshop_admin_dictionary_add_value` relies on exactly that, so it writes to a product, not to the dictionary.
- **Translating or renaming a value:** the admin editor is an AJAX popup (`js/lookup.php?load=loadBookValueForm`), and saving takes two posts: `lookup.php?load=saveBookValue` validates, then `savers/books.php` persists. Sending only the second one looks like a blocked endpoint. `horoshop_admin_dictionary_value_set` and `horoshop_admin_dictionary_value_delete` implement the full sequence.
- **Whole dictionaries:** creation lives outside the legacy admin (`POST /book/createBook` with an `X-CSRF-Token` header), renaming goes through `savers/books.php`, and deletion goes through the grid route and removes every value with the container. `horoshop_admin_dictionary_delete` cannot tell a system dictionary from a user-made one, so it needs `dryRun:false` together with `confirm`. Do not delete a dictionary that product characteristics still use.

## Coverage

Every CRUD section reachable in the control panels of the stores tested is either wrapped by a tool or available through the public API: orders, customers, products and templates, site, discount, marketing, SEO and settings entities, the design editor (read, write, SCSS recompile), languages, custom CSS, redirects and dictionaries. The analytics dashboard, sitemap and image import have dedicated tools. Screens that are embeds rather than data (theme gallery, Zapier, promo) are out of scope by nature. The Bots, Security and Modules sections were absent from every store tested, so they have no tools yet; the generic engine should reach them where they exist.

Coverage was measured against the admin's own menu rather than guessed: `GET /core-api/admin/navigation` lists 61 leaf items, identical by `name` on three stores. 40 of them point at `data.php?handler=…` (39 distinct handlers, all registered), 13 are other legacy pages (each covered by a named tool, or a dashboard or embed by nature), and 8 are React-only analytics dashboards. Eight more entity types answer as live grids with **no menu item at all** and are registered as well: warehouse residues, currency cross-rates, Nova Poshta senders and contact persons, webhook subscribers, product conditions, and the two instalment-term tables (generic and monobank). Each passed a full create, read, list, update and delete round trip.

## Platform notes

### Public API

- **Tokens live 600 seconds.** The server caches them per store and renews them transparently, including a one-shot retry when a token expires mid-call.
- **Import only, no delete.** Products (`catalog_import`) and users (`users_import`) are added or overwritten, matched by `article` and `email`. Categories are read-only. Only product sets can be deleted.
- **Catalog export returns at most 500 products per call,** without a warning (`limit:523` returns exactly 500). Walk the catalog with `offset` and `limit`; 100 per page is a comfortable size. `limit:0` means zero products, not "all".
- **Images are fetched by URL.** Pass links in `images.links[]` or `gallery_common.links[]` and Horoshop downloads them, or upload files over FTP and call `catalog_process_images`. To send files from your own machine use `horoshop_admin_import_images`, which matches them to products by file name. None of the three can delete a single photo from a gallery: Horoshop exposes no such route.
- **Availability is not quantity.** `quantity` is usually `0`; the real stock status is in `presence`.
- **`WARNING` is not a failure.** Imports return `WARNING` with a per-record `response.log`; inspect the codes.
- **Anything other than `OK`, `EMPTY` or `WARNING` raises.** Horoshop answers an unimplemented method with HTTP 200 and `{"status":"UNDEFINED_FUNCTION","response":[]}`, which would otherwise look like an empty result. The server turns every non-success status into an error naming the method and the store. Tools that use the public API only to double-check an admin write, like `horoshop_admin_order_status_set`, report `verified:false` instead of failing.
- **The export field is `characteristics`, not `char`.** It is one object per product, keyed by the category's own API field names. Horoshop silently ignores an unknown `includedParams` entry, so `catalog_export` rewrites `char`, `chars` and `characteristic` to `characteristics`, reports the rename, and flags any requested field that came back on no product.
- **Characteristics are normalized on export, and `id` is usually absent.** The API returns a value in four shapes within one response (`{id,value:{ua,ru}}`, a bare `{ua,ru}`, a list of either, or a scalar). `catalog_export` always returns a list `[{id?, value:{ua,ru}}]`. The `id` exists only on dictionary-backed values and was missing on all of 400 values sampled on two live stores, so match by text, not by id. Fields that are present but empty are dropped, and `characteristicsShape` reports what actually arrived. Imports still take plain values.
- **Order totals.** `total_sum` is the sum of the order lines and excludes delivery. `total_default` is the amount before order-level discounts (coupon, manager) but after product-level ones. Sales reports should use `total_sum`.

### Control panel

- **Widget writes are occasionally lost.** The same POST to `/_widget/p_url_history/update/` sometimes returns **HTTP 400 with the storefront HTML page**: the admin route did not resolve, nothing was written, and nothing was rejected either. The rate is not constant: about 6% in a quiet hour and up to 46% during bursts. Idempotent routes (update, delete) are retried up to five times, which brings a burst down to about 3%. Creation is never retried, because a create that landed with a lost answer would be duplicated. Misses are reported in `diag.write.missed` and `diag.defect`; `HOROSHOP_WIDGET_RETRY=off` turns the retry off.
- **`OK` does not mean saved.** Several admin routes answer `OK` while doing nothing. Writers verify by reading back, through a different channel than the one that wrote where one exists.
- **Order line items cannot be edited.** Cart rows in the order editor have no `name` attribute, so the form cannot submit them, and the component routes either return 404 or answer `OK` without changing price or quantity. Recipient, city, address, payment and the manager comment are editable with `horoshop_admin_order_update`, which submits the whole form through `/order/submit/`.
- **Opening an order editor touches its row.** Horoshop stamps a record's date every time its editor opens, and the admin orders grid is sorted by that date, so orders the tools read move to the top of the store's own list. The order itself is not changed. `horoshop_admin_order_resolve` maps an order number to its admin record id in about two editor reads on any store size (measured on stores with 40 702 and 52 437 orders: 2.1 to 2.9 seconds), and a number the public API does not know costs no editor reads.
- **The order number is not the admin record id.** They are separate autoincrements, and draft rows consume record ids without creating orders.
- **Cancelling an order is final.** Status 4 makes the order permanently read-only, so `horoshop_admin_order_status_change` requires `confirm` for it.
- **The analytics dashboard has a fixed window.** `GET /reports/dashboard/data` ignored all 15 date-range variants tried. `horoshop_admin_reports_dashboard` returns the default period and says so; for custom ranges aggregate `horoshop_orders_get`.
- **A Nova Poshta contact person needs a sender first.** Creating a contact without an existing sender returns HTTP 503.
- **Coupons can be created through two admin routes, and one of them fails with HTTP 503.** The server uses the route that works. Horoshop generates the codes itself.
- **A freshly uploaded logo can show a placeholder.** Each upload gets a new file name, and the new address may serve a small generated placeholder instead of the real image for tens of seconds. Verification re-reads instead of trusting the first answer.
- **Custom CSS may be unreadable, which is not the same as empty.** The CSS editor is a per-store module; where it is off, `horoshop_admin_css_get` returns `available:false`. `horoshop_admin_css_set` posts desktop and mobile CSS together, so it refuses to write when the current CSS could not be read, unless you pass `force:true`.
- **Payment credentials never leave `design_get`.** The design "application JSON" carries live LiqPay and PayPal keys. The `payment` section is withheld and secret-looking values elsewhere are masked as `•••• (N chars)`. Redaction applies only to output: `horoshop_admin_design_set` merges into the real configuration, so editing a design section cannot overwrite a credential with a mask.
- **Templates are protected.** Storefront values are often templates: a sticker reading `−{DISCOUNT_PERCENT}%`, an SEO template `{parent} {title} - купити в {site}`, a theme string `Отзывы {COMMENTS}`. Replacing one with plain text freezes the substitution everywhere it renders, and nothing looks broken. The guarded writers (`record_save`, `page_seo_set`, `category_update`, `blog_post_update`, `filter_preset_update`, `interface_translation_set`) compare the tokens of the stored and the new value: a dry run reports `placeholderWarnings`, and a real write is refused until you pass `allowPlaceholderLoss:true`. Keeping the tokens, the normal case when translating the words around them, passes silently.
- **Writers answer compactly and can splice.** A long value that persisted comes back as `{length, tail, sha256}` instead of three full copies, while a value that did not persist still reports expected and actual previews with the first differing offset. `verbose:true` restores the full diff. The same writers accept `append` and `prepend`, which add to the stored value without resending it.
- **No read tool can bury the conversation.** Every read-only tool measures its answer. Over the limit (100 KB by default) it returns `error:"RESPONSE_TOO_LARGE"` with the measured size and a narrowing hint computed from that measurement, for example a `limit` that fits. When reference data makes a record too large, `horoshop_admin_record_get` trims dropdown option lists first (`selectsOptionsTruncated`) and never the record's own `fields`. Override with `allowLarge:true` or `HOROSHOP_MAX_RESPONSE_BYTES`.
- **Some stores require a browser User-Agent.** A bot filter on some stores answers a login without one with HTTP 200 and no session, which is indistinguishable from a wrong password. The server always sends a full browser User-Agent.

## Adding a tool

1. Pick the file in `src/tools/` for the area, or create a new one and add its array to `allTools` in `src/index.ts`.
2. Describe the tool as a `ToolSpec`: `name` (prefix `horoshop_`, or `horoshop_admin_` for control panel tools), `title`, `description`, a zod `inputSchema` that spreads `storeField` from `src/register.ts`, `annotations`, and `handler(client, args)`.
3. Follow the conventions that keep the server safe:
   - writes take `dryRun`, defaulting to `true`, and return a plan in preview mode;
   - irreversible actions also require an explicit `confirm`;
   - verify every write by reading the result back, through a different channel when one exists;
   - set `readOnlyHint`, `destructiveHint` and `idempotentHint` honestly;
   - put only measured behaviour into descriptions: models trust descriptions, so a wrong claim there repeats itself in every session.
4. Run `npm run build`, restart your MCP client, try the tool on a test store, then run `npm run docs:tools`.
