# Tool reference

Generated from the server's own `tools/list` answer: **118 tools**. Do not edit by hand; run `npm run docs:tools` after changing a tool.

Every tool accepts an optional `store` argument (the store name from your configuration). Access labels come from the MCP tool annotations: **read-only** tools never change the store; **destructive** tools can delete or overwrite data and usually require `dryRun:false` plus an explicit confirmation.

## Contents

- [Setup and diagnostics](#setup-and-diagnostics) (2)
- [Catalog (public API)](#catalog-public-api) (4)
- [Orders (public API)](#orders-public-api) (3)
- [Categories, users, product sets (public API)](#categories-users-product-sets-public-api) (5)
- [Payment, delivery, currency (public API)](#payment-delivery-currency-public-api) (5)
- [B2B (public API)](#b2b-public-api) (2)
- [Webhooks (public API)](#webhooks-public-api) (2)
- [Storefront: cart and checkout](#storefront-cart-and-checkout) (6)
- [Admin panel: generic engine](#admin-panel-generic-engine) (6)
- [Admin panel: orders and analytics](#admin-panel-orders-and-analytics) (8)
- [Admin panel: products, prices, images](#admin-panel-products-prices-images) (9)
- [Admin panel: characteristics and dictionaries](#admin-panel-characteristics-and-dictionaries) (15)
- [Admin panel: categories, pages, blog, banners, filters](#admin-panel-categories-pages-blog-banners-filters) (12)
- [Admin panel: SEO, sitemap, redirects](#admin-panel-seo-sitemap-redirects) (11)
- [Admin panel: marketplace feeds](#admin-panel-marketplace-feeds) (6)
- [Admin panel: design and localization](#admin-panel-design-and-localization) (8)
- [Admin panel: store settings, marketing, fiscal receipts](#admin-panel-store-settings-marketing-fiscal-receipts) (14)

## Setup and diagnostics

| Tool | Access | Summary |
|---|---|---|
| [`horoshop_list_stores`](#horoshop_list_stores) | read-only | List configured stores |
| [`horoshop_check_auth`](#horoshop_check_auth) | read-only | Check store authentication |

### horoshop_list_stores

**List configured stores** · read-only

List the Horoshop stores this server is configured for - names and base URLs only, never credentials. Use a returned name as the `store` argument on any other tool. The store marked isDefault is used when `store` is omitted. Also returns `serverBuild` - the build this running process is executing, with `stale:true` when dist/ on disk is newer (someone rebuilt but did not restart the MCP process).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `allowLarge` | boolean | no | Default false. The answer is MEASURED before it is returned, and a payload over the size limit (default 100 KB, override with HOROSHOP_MAX_RESPONSE_BYTES) is REFUSED with its measured size and how to narrow it, instead of overflowing the conversation. Set true to get the whole thing anyway. |

### horoshop_check_auth

**Check store authentication** · read-only

Verify that the configured credentials authenticate against a store, without exposing the token. Run this first when other calls return UNAUTHORIZED. Horoshop tokens live 600 s and are refreshed by the server automatically. Returns `serverBuild`: the build id + timestamp of the code THIS process is running, with `stale:true` (and a restart note) when dist/ on disk is newer - i.e. the server was rebuilt but not restarted, so it is still serving old tool schemas/behaviour.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `allowLarge` | boolean | no | Default false. The answer is MEASURED before it is returned, and a payload over the size limit (default 100 KB, override with HOROSHOP_MAX_RESPONSE_BYTES) is REFUSED with its measured size and how to narrow it, instead of overflowing the conversation. Set true to get the whole thing anyway. |
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |

## Catalog (public API)

| Tool | Access | Summary |
|---|---|---|
| [`horoshop_catalog_export`](#horoshop_catalog_export) | read-only | Export catalog products |
| [`horoshop_catalog_import`](#horoshop_catalog_import) | destructive write, idempotent | Import / update catalog products |
| [`horoshop_catalog_process_images`](#horoshop_catalog_process_images) | destructive write | Process FTP-uploaded images |
| [`horoshop_icons_export`](#horoshop_icons_export) | read-only | Export stickers / icons |

### horoshop_catalog_export

**Export catalog products** · read-only

Read products from a store's catalog. Filter by category (path or id), article, or showcase visibility, and paginate with offset/limit. SIZE FIRST, AND IT IS ENFORCED - this export is HEAVY BY DEFAULT: it returns the full `description` / `marketplace_description` (inline HTML + CSS) on every row, so a 142-SKU catalog at limit:200 is ~4.7 MB / 33k lines and overflows the token limit. Measured per 100 products: ~75 KB scoped to four fields, ~1.3 MB with lite:true, ~6.9 MB raw. The answer is therefore MEASURED before it is returned and a payload over ~100 KB is REFUSED (`error:"RESPONSE_TOO_LARGE"`) with its size, the fields it would have contained and the limit that fits - nothing is dumped, so a mis-scoped call costs one short answer instead of the whole conversation. Scope it: `lite:true` (drops description + marketplace_description), `includedParams:[…]` (e.g. ["article","price","presence","title"]), `excludedParams:[…]`, or a smaller `limit` + `offset`. `allowLarge:true` forces the full payload; HOROSHOP_EXPORT_MAX_BYTES moves the limit. Working page size is 100. WHEN YOU SLICE `includedParams`, CHECK YOUR JOIN KEY CAME BACK. Horoshop normally answers with `article`, `parent_article` and `parent` on every row whatever you ask for - but that is the platform's habit, not something this tool adds, and nothing here re-injects them. If a scoped export ever comes back without `article`, you are holding rows you cannot match to anything; ask for it explicitly rather than assuming. PAGINATION: there is no "give me everything" call - `limit:0` returns ZERO products, not all of them, and the platform CAPS one call at 500 whatever you ask (measured: limit:523 on a 523-SKU catalog returned exactly 500, with no warning - asking for the whole catalog in one call therefore loses the tail silently). Walk it with offset + limit. `quantity` IS NOT STOCK: it reads 0 on every row of stores that do not run warehouse tracking (1725 of 1725 on one store while 714 products were actually in stock), so never compute availability from it - `presence` is the only trustworthy source. COLOR ID CAVEAT (do not cross-reference with filter presets): a product's `color` here carries the PRODUCT-colour id (h_colors dictionary, 346-space), e.g. Фіолетовий reads back as color.id=21. That is a DIFFERENT id space from the `color=N` used in filter-preset `params` (the filter-group id, filter_colors 351-space, where Фіолетовий=10). Never decide a preset is empty by matching its `color=N` against this `color.id` - they will not line up (a live `color=10` preset returns products that export under color.id=21). To learn how many products a filter serves, read the storefront listing, not an id match. CHARACTERISTICS - THE FIELD IS CALLED `characteristics`. It is one object per product, keyed by the per-category API field names: characteristics: {"materal": [{value:{ua,ru}}], "color": […]}. To fetch it with includedParams ask for "characteristics"; "char" is NOT a field (it only ever stood for one characteristic's key in an example) and Horoshop drops an unknown includedParam silently, so asking for it returns products with no characteristics and no error - this tool now rewrites char/chars/characteristic to `characteristics` and says so, and flags any requested field that came back on no product. The values are NORMALISED here: the API returns a characteristic in four different shapes in one response ({id,value:{ua,ru}}, a bare {ua,ru}, a list of either, or a scalar), which makes `.value.ua` silently empty for about a third of them. This tool always returns a LIST of refs instead - [{id?, value:{ua,ru}}] - and iterating it while reading `entry.value.ua` is the one correct way to read a characteristic. ⚠ `id` IS OPTIONAL AND USUALLY ABSENT - do not key on it. It is a dictionary ref that only exists when the field is dictionary-backed: measured on two live stores, 0 of 400 values carried one (an earlier store had 2000 that did). Every answer reports what actually arrived under `characteristicsShape` (`values`, `valuesWithId`), so match characteristics by TEXT. ⚠ A FIELD CAN BE PRESENT AND EMPTY. Live products carry keys holding an empty list (every product on both stores had `title: []`), on which the documented read `v[0].value.ua` THROWS. Those keys are dropped from the answer and counted in `characteristicsShape.emptyFieldsDropped`, so what you iterate is only real values. A language switched off on the store comes back as "" (both stores measured: `ru` empty, `ua` filled) - read `value.ua` ?? `value.ru`, never `ru` alone. A scalar value is mirrored into both languages, and any extra keys the API sends alongside `id` are preserved. Characteristic field names differ per category - export one article of the category to learn them.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `allowLarge` | boolean | no | Default false. The answer is measured before it is returned and a payload over the size limit (default 100 KB, override with HOROSHOP_EXPORT_MAX_BYTES) is REFUSED with the measured size and a concrete suggestion instead of overflowing the conversation. Set true to get it anyway. |
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `expr` | object | no | Selection filter. Omit to export everything (use limit). |
| `offset` | integer | no |  |
| `limit` | integer | no | Page size; pair with offset to walk large catalogs. 100 is the working size. NOT a max: limit:0 returns zero products, it does not mean "all". |
| `includedParams` | string[] | no | Return only these fields. Use the API's own names - characteristics live under `characteristics` (NOT "char": that is the placeholder for one characteristic's key inside it). An unknown name is silently ignored by Horoshop, so the answer reports any requested field that came back on no product. |
| `excludedParams` | string[] | no | Drop these fields from the export. |
| `lite` | boolean | no | Default false. When true, drops the heavy HTML fields (description, marketplace_description) to keep the payload small - the usual cause of a token overflow. Ignored if you pass includedParams (you have already scoped the fields). Merges with any excludedParams you also pass. |

### horoshop_catalog_import

**Import / update catalog products** · destructive write, idempotent

Upsert products into the catalog, matched by `article`. This is the BULK write path for products - the fastest way to move many SKUs - but it is NOT the only one, and reading it as "the only one" costs real work: fields that live in the admin product editor and have no import key (per-product SEO, video, the alt text of a single image - 110-234 fields in all) are written with horoshop_admin_record_save entity=products (mind its product-guard: it drops [presence]/[countdown_end_time] unless you name them), stock is written with horoshop_admin_product_stock_set, and products ARE deletable - not through the public /api/, but through horoshop_admin_record_delete entity=products (pass withModifications:true to take the whole modification group). Because it writes in BULK, DRY RUN IS THE DEFAULT - exactly like every admin_* writer. dryRun:true (the default) writes NOTHING: it exports the current values for your payload's articles and returns `willChange` (per-article from→to for the fields you set) plus a `summary` (products, changed, new, fieldChanges). Review it, then pass dryRun:false to actually import. The preview is CLIENT-SIDE (Horoshop has no validateOnly): scalar and i18n fields (price, title{ua,ru}, presence, brand…) show a real from→to; structural fields (images, characteristics, gallery_common, gallery_360, icons, residues, price_levels) are shown as `opaque` "will write" entries, not a precise diff, because their import shape is unlike the export shape. An article not found in the catalog is flagged `isNew:true` (all fields new). Images are fetched by URL (images.links[] for a modification, gallery_common.links[] for shared galleries). `presence` text can only be set when warehouse stock tracking is OFF. `parent` (or parent.id) is required for NEW products. RESPONSE (dryRun:false): summarised by default to `{updated, warnings, errors}` - the per-article "Товар обновлен" line for hundreds of SKUs is dropped and only NON-OK items are itemised; pass `verbose:true` for the raw per-article Horoshop response (response.log with a code per article). Status WARNING is normal. SIX TRAPS, all of which answer "Товар обновлен" while doing the wrong thing: (1) `icons[]` matches stickers BY NAME, not by id - passing ids creates junk stickers literally named "3"/"12" and hangs them on the product; pass the sticker's title (see horoshop_icons_export). (2) A NEW product is created HIDDEN - set `display_in_showcase:1` and a `presence`, or it appears nowhere on the storefront. (3) A characteristic that the product's category template does not define is dropped by Horoshop with status:OK - and the name may be perfectly real elsewhere in the store, because templates differ per category (measured: `materal` is valid on two of one store's three templates and silently dropped on the third). THIS TOOL NOW CHECKS IT BEFORE WRITING: every payload characteristic name is verified against the data template of that product's OWN category, and any name that would be dropped comes back as `characteristicSchemaWarnings` (with the full list the template does accept) in both the dry run and the real import. Articles whose category could not be resolved are listed separately under `characteristicSchemaUnverified` - not counted as passing. The check needs the admin session; where it is unavailable the import still runs and says so. (4) images.override defaults to true (replaces existing images) and gallery_360.removeAll:true wipes that gallery. (5) `quantity` IS NOT WRITABLE HERE - the field is accepted, the log says «Товар обновлен», and the stock does not move (measured: import quantity:5 → export still 0). Stock lives in the warehouse ledger; use horoshop_admin_product_stock_set (it posts the same income/expense document the admin's «Склад» column does and verifies the new number). This tool now flags a `quantity` in the payload instead of letting it pass silently. (6) THE EXPENSIVE ONE: a product can stay OUT of its category's storefront listing while every source you would check says it is live. Measured on a real store: after the import, catalog_export gives display_in_showcase:1, presence «Є в наявності» and the right parent.id, the admin grid says «Отображать: Да», the product page returns 200 and the article is in catalog-sitemap.xml - and 25+ minutes later the category page still says «Немає товарів». The storefront listing is served by a SEARCH INDEX that an /api/ import does not rebuild, and no tool in this server can see or trigger that rebuild. What it CAN do, and now does, is stop reporting "updated 500/500, no warnings" over it: an import that creates NEW articles returns `newProducts` plus a `categoryListingWarning` saying to verify by the product's own page and catalog-sitemap.xml rather than by the category listing. An edit to an existing product does not raise it (it cannot move a product in or out of a listing). If the listing must be populated, the fix is a reindex on Horoshop's side, not another import. TIMER: to CLEAR a countdown, pass `countdown_end_time:""` (an empty string) - it is stored as "0000-00-00 00:00:00" (the zero date), which reads back as "no timer"; it is not null. Also: the generated `slug` is unpredictable - take the product URL from the `link` field of an export, never guess it. CHARACTERISTICS - SHAPES ACCEPTED: Horoshop itself reads a characteristic ONLY as a plain value per field (`characteristics: {"color":"Червоний"}`, or an array of plain strings for a multi-value field). Any other shape is answered `status:OK` / «Товар обновлен» and written NOWHERE - which is exactly what an export→import round-trip used to do, because catalog_export returns a normalised REF LIST ([{id?,value:{ua,ru}}]) for reliable reading. This tool now NORMALISES on the way in, so all of these work and mean the same thing: "380 г" · ["а","б"] · {ua:"380 г",ru:"380 г"} · {id:7,value:{ua:"380 г"}} · [{id:7,value:{ua:"380 г",ru:"380 г"}}]. The dry run prints the exact block that will be POSTed under `characteristics[].write` (plus `reshaped` / `skippedEmpty`). Two things are still refused OUT LOUD instead of being half-written: a ref whose per-language values DIFFER (import carries one value mirrored across languages - it cannot write ua≠ru; translate via horoshop_admin_dictionary_value_set), and a bare {id:N} with no text (import matches dictionary values by TEXT, not by id). An empty ref from an export ([{value:{ua:"",ru:""}}]) is skipped, not sent; an explicit "" you pass yourself is still sent as a clear. CHARACTERISTICS ARE PER MODIFICATION GROUP, NOT PER SKU: writing one on a single modification writes it for the whole group. Measured - a characteristic set on ZZTEST-CAP-001-B reads back on ZZTEST-CAP-001 too. So there is no way to give the red variant a different material from the blue one through this field, and looping over every SKU of a group just rewrites the same value N times. Anything that genuinely differs per variant belongs in the modification's own fields, not in `characteristics`. BULK PAYLOAD (from disk): when the content is too large for a tool argument (142 products × ~26 KB HTML will not fit), pass `productsFile` - an ABSOLUTE path to a JSON file that is `{products:[…]}` or a bare `[…]` - instead of `products`. The two are mutually exclusive. INACTIVE LANGUAGE (silent drop): writing an i18n cell (title/short_description/description/seo…) to a language that is OFF on the store (is_displayed_in_admin=0) returns OK but Horoshop SILENTLY DROPS the cell - export will not return it until you enable the language via horoshop_admin_language_set. This tool reads the store's active languages and returns a `languageWarnings` list (and marks those fields in the dry-run) so the loss is visible before you write. WHITESPACE: Horoshop normalises whitespace in text nodes on import, so a saved `description` can read back ~1-2% SHORTER than what you sent - that is only collapsed spaces/newlines; tags, inline styles and HTML entities are preserved 1:1. Do not be alarmed by the length delta when verifying. POST SIZE / RELIABILITY: a single import POST past ~130 KB of JSON (≈15 heavy-HTML descriptions, ~400 KB drops the connection) can fail as a NETWORK ABORT (not an HTTP error). On a real write (dryRun:false) this tool AUTO-CHUNKS the payload by size (~120 KB per POST), retries a dropped connection, paces the chunks, and aggregates the per-chunk results into one {updated, warnings, errors} summary (`chunks:N` reports how many POSTs it took). Dry-run never chunks.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `products` | object[] | no | Product objects (inline). MUTUALLY EXCLUSIVE with productsFile - pass exactly one. Common keys: article, parent_article, title{ru,ua}, description, short_description, price, price_old, discount, currency, presence, color, brand, mpn, gtin, parent \| parent.id, alt_parent[], characteristics{...} (per-category field names), icons[], images{override,links[]}, gallery_common{override,links[]}, residues[], price_levels[] (B2B). |
| `productsFile` | string | no | Absolute path to a JSON file holding the payload - use this for BULK/HEAVY content that will not fit in a tool argument (e.g. 142 products × ~26 KB HTML). The file is `{"products":[…]}` or a bare `[…]`. MUTUALLY EXCLUSIVE with `products`. Honours dryRun (default true) and the auto-chunking below. |
| `dryRun` | boolean | no | Default TRUE (safety-first, like admin_* writers): preview from→to per article without writing. Set false to actually import. |
| `verbose` | boolean | no | Default false: on a real import (dryRun:false) return the summarised {updated, warnings, errors}. Set true for the raw per-article Horoshop response (needed if you read response.log per item). |

### horoshop_catalog_process_images

**Process FTP-uploaded images** · destructive write

Attach images that were uploaded over FTP to /content/import_images/. File names bind to products by article: `<article>@<n>.jpg` for the main gallery, `<article>@gallery_common@<n>.jpg` or `<article>@gallery_360@<n>.jpg` for the others. Only jpeg/gif/png are accepted. DESTRUCTIVE OPTION: `removePrevImages:true` deletes each touched product's existing images before attaching the new ones. There is no dry run and no undo here - the originals are gone from the store and can only be restored by re-uploading them. It defaults to false; leave it false unless you are deliberately replacing galleries wholesale.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `removePrevImages` | boolean | no | Default false. TRUE deletes a product's previous images before attaching the new ones - irreversible, no dry run, no undo. |

### horoshop_icons_export

**Export stickers / icons** · read-only

List product stickers/icons (id, title, enabled). Horoshop v4 only. Use the titles when setting `icons` on catalog_import; reference existing stickers rather than inventing names.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `allowLarge` | boolean | no | Default false. The answer is MEASURED before it is returned, and a payload over the size limit (default 100 KB, override with HOROSHOP_MAX_RESPONSE_BYTES) is REFUSED with its measured size and how to narrow it, instead of overflowing the conversation. Set true to get the whole thing anyway. |
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |

## Orders (public API)

| Tool | Access | Summary |
|---|---|---|
| [`horoshop_orders_get`](#horoshop_orders_get) | read-only | Get orders |
| [`horoshop_orders_update`](#horoshop_orders_update) | destructive write, idempotent | Update orders |
| [`horoshop_orders_get_statuses`](#horoshop_orders_get_statuses) | read-only | Get available order statuses |

### horoshop_orders_get

**Get orders** · read-only

Fetch orders, optionally filtered by date range, ids, or status, and paginated with offset/limit. MEASURED on 264 live orders across two stores: the Nova Poshta block `delivery_data` (deliveryOperatorType, tnNumber, tnId, tnStatusName, tnTrackingUpdateDate, estimatedDeliveryDate, ownTTNPicked, departure, destination) arrives WITHOUT additionalData - what the flag adds is one extra key, `additional_data.recipient_warehouse_ref` (the branch GUID), for +2.7% of payload - NOT the doubling this description used to claim (measured 89.2 KB -> 91.6 KB over the same 22 orders). On an unprocessed order `tnNumber` is null: the block exists, the waybill does not yet. `total_sum` is the sum of the LINES and excludes delivery (matched Σ products[].total_price on 264/264). The two totals split discounts by KIND, which is why they so often look identical: a PRODUCT discount is already baked into the line `price` (`discount_marker:"PRICE_OLD"`) so BOTH totals carry it - hence `total_default` equalled `total_sum` on 264/264 live orders. An ORDER-LEVEL discount (coupon / manager) is what separates them: MEASURED on a test-store order, a 799 item with a 25% coupon gave `total_default` 799, `total_sum` 599, `coupon_percent` 25, `coupon_discount_value` 200, with the line `price` untouched at 799 (`discount_marker:"NONE"`). So `total_default` is the total BEFORE ORDER-LEVEL discounts, not before all discounts, and `total_default - total_sum` is exactly the order-level discount. Use `total_sum` for revenue; to size a PRODUCT discount go per line, the difference is 0. `delivery_price` was only ever -1 or 0 there (-1 = not calculated), so never add it blindly. Every line carries `type`, and on all 415 lines measured its value was `"product"` - `gift`/`gift_parent`/`set_main`/`set_item` are the documented values for gift and bundle rows, which that sample did not contain. `analytics` (utm_source/medium/campaign/term/content + google_client_id) is present on 264/264. Three traps there, all measured: (1) `utm_campaign` CAN BE A NUMBER, not a string (seen: 23964436493 on Google Ads orders) - coerce with String() before any string operation or the report throws; (2) direct traffic arrives in THREE forms in one and the same sample - `(direct)`, `(none)` and an empty string - consolidate all three or the channel split double-counts; (3) EMPTY UTM DOES NOT MEAN DIRECT: the tags are read by storefront JS, so an order placed without JS (raw HTTP) arrives with empty tags even though all five were on the landing URL. Attribute empty as UNKNOWN, not as direct. B2B stores add customer_details / dropshipping_details. `user` IS NOT A CUSTOMER ID - do not group by it. Most orders on a Horoshop store are placed without an account, so the field is close to unique per order (5369 distinct values across 5408 orders on one store) and counting it reports almost every order as a new customer. Group by PHONE NUMBER for anything about customers, repeat purchases, LTV or retention (the same store: 4416 real customers, 695 of them repeat). What this does NOT return: the buyer's and the manager's comments, the per-line editing view, and the admin's own status-button state - those live in the admin editor (horoshop_admin_order_get). The `order_id` here is the order NUMBER; every admin route addresses a different record id (horoshop_admin_order_resolve bridges them).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `allowLarge` | boolean | no | Default false. The answer is MEASURED before it is returned, and a payload over the size limit (default 100 KB, override with HOROSHOP_MAX_RESPONSE_BYTES) is REFUSED with its measured size and how to narrow it, instead of overflowing the conversation. Set true to get the whole thing anyway. |
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `from` | string | no | From date (inclusive): YYYY-MM-DD or DD.MM.YYYY, optional HH:mm:ss. |
| `to` | string | no | To date (inclusive), same formats as `from`. |
| `ids` | integer[] | no | Specific order numbers. |
| `status` | integer \| integer[] | no | Filter by status. 1 new, 2 processing, 3 delivered, 4 not delivered, 6 shipping. |
| `additionalData` | boolean | no | Adds ONE key: `additional_data.recipient_warehouse_ref` (the Nova Poshta branch GUID). It does NOT gate the TTN - measured, `delivery_data` (tnNumber, tnStatusName, estimatedDeliveryDate, …) arrives with the flag off. Costs +2.7% of payload, so leaving it off will not shrink an oversized answer. |
| `offset` | integer | no |  |
| `limit` | integer | no |  |

### horoshop_orders_update

**Update orders** · destructive write, idempotent

Update order status, payment flag and/or tracking code, in a batch. 1 new, 2 processing, 3 delivered, 4 not delivered, 6 shipping. The response log reports per-order success/failure. ⚠️ CANCELLING (status 4) THROUGH THE API ONLY DOES HALF THE JOB. It sets the status and leaves the goods deducted from stock - measured: 3 → 3 through this API, 3 → 4 through the admin's own cancel with return_quantity=1. Nothing in the public API can return them. So this tool now demands a decision whenever status 4 is in the batch: pass `returnStock:true` and those orders are cancelled through the ADMIN path instead (stock goes back on sale, verified before/after), `returnStock:false` to keep the API behaviour deliberately, or omit it and the answer carries a loud `stockWarning` telling you the goods are still counted as sold. THE STOCK DECISION IS ONE-SHOT AND THIS TOOL HAS NO DRY RUN - it writes the moment you call it. Once an order is cancelled its editor is locked forever, so nothing brings the goods back afterwards: not a second call with returnStock:true, not order_status_change, not deleting the order. Decide before you send, not after you read the warning. Stock only means anything when warehouse accounting is on (`extra[catalog_use_residues_by_stock]`); with it off, availability is the manual `presence` field.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `orders` | object[] | yes |  |
| `returnStock` | boolean | no | Only meaningful when the batch contains a cancellation (status 4). true → those orders are cancelled through the ADMIN editor with return_quantity=1, so the ordered quantities go back on sale (this is the ONLY way; the public API cannot do it). false → keep the plain API cancel, which leaves them deducted. Omit and you get the API behaviour plus an explicit warning. |

### horoshop_orders_get_statuses

**Get available order statuses** · read-only

List all order statuses configured on the store (id, multilingual title, is_successful). Horoshop v4+. Use to resolve the numeric statuses returned by orders_get. Note the admin's status switcher labels these differently - status 6 reads «Отправлен» there but is titled «Доставляется», and status 4 is «Отменен» in the editor and «Не доставлен» here; these API names are the ones to report.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `allowLarge` | boolean | no | Default false. The answer is MEASURED before it is returned, and a payload over the size limit (default 100 KB, override with HOROSHOP_MAX_RESPONSE_BYTES) is REFUSED with its measured size and how to narrow it, instead of overflowing the conversation. Set true to get the whole thing anyway. |
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |

## Categories, users, product sets (public API)

| Tool | Access | Summary |
|---|---|---|
| [`horoshop_pages_export`](#horoshop_pages_export) | read-only | Export categories |
| [`horoshop_users_export`](#horoshop_users_export) | read-only | Export users |
| [`horoshop_users_import`](#horoshop_users_import) | write, idempotent | Import / update users |
| [`horoshop_product_set_import`](#horoshop_product_set_import) | write, idempotent | Import / update product sets |
| [`horoshop_product_set_remove`](#horoshop_product_set_remove) | destructive write, idempotent | Remove product sets |

### horoshop_pages_export

**Export categories** · read-only

List catalog categories/pages under a parent (id, parent, multilingual title, discount). Use the returned ids as parent.id when importing products. READ-ONLY HERE ONLY: categories cannot be written through the PUBLIC /api/ layer - but they are fully writable through the admin layer this server also speaks. Use horoshop_admin_category_update (title, SEO meta, seo_text, cover, flags), horoshop_admin_category_create, or horoshop_admin_page_seo_set. Do not conclude from this endpoint that categories are immutable.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `allowLarge` | boolean | no | Default false. The answer is MEASURED before it is returned, and a payload over the size limit (default 100 KB, override with HOROSHOP_MAX_RESPONSE_BYTES) is REFUSED with its measured size and how to narrow it, instead of overflowing the conversation. Set true to get the whole thing anyway. |
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `parent` | integer | no | Parent category id to list under. Default 0 (root). |

### horoshop_users_export

**Export users** · read-only

Export registered site users, optionally by registration date range, paginated with offset/limit. B2B stores additionally return customer_group_id, balance, manager, company and role.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `allowLarge` | boolean | no | Default false. The answer is MEASURED before it is returned, and a payload over the size limit (default 100 KB, override with HOROSHOP_MAX_RESPONSE_BYTES) is REFUSED with its measured size and how to narrow it, instead of overflowing the conversation. Set true to get the whole thing anyway. |
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `from` | string | no | Registered from (inclusive): YYYY-MM-DD or DD.MM.YYYY, optional HH:mm:ss. |
| `to` | string | no | Registered up to (inclusive). |
| `offset` | integer | no |  |
| `limit` | integer | no |  |

### horoshop_users_import

**Import / update users** · write, idempotent

Upsert users, matched by the unique `email`. `title` (full name) and `email` are required. The response log reports per-user codes (0 ok, 1 missing required, 2 validation, 3 error).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `users` | object[] | yes | User objects. Required: title, email. Optional: phone, country, city, address, newsletter_subscription (0/1), discount_card{discount,active,date_limit,status}, note. B2B: customer_group_id, balance, balance_currency, manager_id, site_link, company, role. |

### horoshop_product_set_import

**Import / update product sets** · write, idempotent

Upsert "bought together" product sets, matched by the set `article` (which must not clash with a real product article). A set holds 2..N member product articles. Price is either discountPercent off the summed member prices, or an explicit discountedPrice.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `items` | object[] | yes |  |

### horoshop_product_set_remove

**Remove product sets** · destructive write, idempotent

Delete product sets by their set articles. Destructive but scoped to sets only - it never touches real products. Removing a non-existent set returns a WARNING, not an error.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `articles` | string[] | yes | Set articles to delete. |

## Payment, delivery, currency (public API)

| Tool | Access | Summary |
|---|---|---|
| [`horoshop_payment_export`](#horoshop_payment_export) | read-only | Export payment options |
| [`horoshop_payment_methods`](#horoshop_payment_methods) | read-only | Export payment methods |
| [`horoshop_delivery_export`](#horoshop_delivery_export) | read-only | Export delivery options |
| [`horoshop_delivery_types`](#horoshop_delivery_types) | read-only | Export delivery types |
| [`horoshop_currency_export`](#horoshop_currency_export) | read-only | Export currencies and rates |

### horoshop_payment_export

**Export payment options** · read-only

List the store's payment options (id, multilingual title/description, payment_method, enabled, gateway link). The ids appear on orders as payment_type.id.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `allowLarge` | boolean | no | Default false. The answer is MEASURED before it is returned, and a payload over the size limit (default 100 KB, override with HOROSHOP_MAX_RESPONSE_BYTES) is REFUSED with its measured size and how to narrow it, instead of overflowing the conversation. Set true to get the whole thing anyway. |
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |

### horoshop_payment_methods

**Export payment methods** · read-only

List payment methods (id, title, is_simple). is_simple=false means the buyer is sent to a payment gateway after checkout. Referenced by payment options' payment_method.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `allowLarge` | boolean | no | Default false. The answer is MEASURED before it is returned, and a payload over the size limit (default 100 KB, override with HOROSHOP_MAX_RESPONSE_BYTES) is REFUSED with its measured size and how to narrow it, instead of overflowing the conversation. Set true to get the whole thing anyway. |
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |

### horoshop_delivery_export

**Export delivery options** · read-only

List delivery options (id, multilingual title, type, enabled, allowed payment ids, price_options). The ids appear on orders as delivery_type.id and differ per store.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `allowLarge` | boolean | no | Default false. The answer is MEASURED before it is returned, and a payload over the size limit (default 100 KB, override with HOROSHOP_MAX_RESPONSE_BYTES) is REFUSED with its measured size and how to narrow it, instead of overflowing the conversation. Set true to get the whole thing anyway. |
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |

### horoshop_delivery_types

**Export delivery types** · read-only

List delivery type categories (id, multilingual title), e.g. courier, warehouse pickup, Ukrposhta. Referenced by delivery options' type.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `allowLarge` | boolean | no | Default false. The answer is MEASURED before it is returned, and a payload over the size limit (default 100 KB, override with HOROSHOP_MAX_RESPONSE_BYTES) is REFUSED with its measured size and how to narrow it, instead of overflowing the conversation. Set true to get the whole thing anyway. |
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |

### horoshop_currency_export

**Export currencies and rates** · read-only

Export currencies and exchange rates. By default only front-enabled currencies are returned; filter by ISO codes or ids. enabledOnly, when set, ignores the iso filter.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `allowLarge` | boolean | no | Default false. The answer is MEASURED before it is returned, and a payload over the size limit (default 100 KB, override with HOROSHOP_MAX_RESPONSE_BYTES) is REFUSED with its measured size and how to narrow it, instead of overflowing the conversation. Set true to get the whole thing anyway. |
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `iso` | string[] | no | ISO codes to export, e.g. ['UAH','USD']. |
| `ids` | integer[] | no | Currency ids to export (sent as `id`). |
| `enabledOnly` | boolean | no | Only front-enabled currencies (default true). Ignores `iso` when set. |

## B2B (public API)

| Tool | Access | Summary |
|---|---|---|
| [`horoshop_customer_groups_export`](#horoshop_customer_groups_export) | read-only | Export customer groups (B2B) |
| [`horoshop_price_levels_export`](#horoshop_price_levels_export) | read-only | Export price levels (B2B) |

### horoshop_customer_groups_export

**Export customer groups (B2B)** · read-only

List B2B customer groups (id, title, visible price level, product visibility, dropshipping flag, allowed payment/delivery methods). Use customer_group_id from here when importing users. NEEDS THE B2B MODULE: on a store that does not have it, this endpoint answers `FORBIDDEN: Use of the method is not allowed` - that is the plan talking, not a broken call, and no argument fixes it. The groups still exist in the admin and are reachable the other way: horoshop_admin_record_get / horoshop_admin_record_save on entity `customer_groups` (handler 440).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `allowLarge` | boolean | no | Default false. The answer is MEASURED before it is returned, and a payload over the size limit (default 100 KB, override with HOROSHOP_MAX_RESPONSE_BYTES) is REFUSED with its measured size and how to narrow it, instead of overflowing the conversation. Set true to get the whole thing anyway. |
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |

### horoshop_price_levels_export

**Export price levels (B2B)** · read-only

List configured price levels/types (id, title). Use these level_id values in catalog_import's price_levels[]. The retail price is still set via the plain `price` field, not here. NEEDS THE B2B MODULE: without it the endpoint answers `FORBIDDEN: Use of the method is not allowed` - a plan restriction, not a bad request. Read the levels through the admin instead: horoshop_admin_record_get / horoshop_admin_record_save on entity `price_levels` (handler 439).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `allowLarge` | boolean | no | Default false. The answer is MEASURED before it is returned, and a payload over the size limit (default 100 KB, override with HOROSHOP_MAX_RESPONSE_BYTES) is REFUSED with its measured size and how to narrow it, instead of overflowing the conversation. Set true to get the whole thing anyway. |
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |

## Webhooks (public API)

| Tool | Access | Summary |
|---|---|---|
| [`horoshop_hooks_subscribe`](#horoshop_hooks_subscribe) | write | Subscribe to a webhook |
| [`horoshop_hooks_unsubscribe`](#horoshop_hooks_unsubscribe) | destructive write, idempotent | Unsubscribe from a webhook |

### horoshop_hooks_subscribe

**Subscribe to a webhook** · write

Register a target URL to receive JSON (PUT) when a store event fires. Events: order_created, user_signup, request_call_me, order_paid, user_update, order_update, comments_created. Max 5 subscribers per event. The queue is flushed by cron ~every 5 min, so delivery is not instant. Returns the subscription id - keep it to unsubscribe. TARIFF: Horoshop's own docs put webhook delivery on the Pro plan. On a lower plan the subscription can register and then simply never fire, which looks like a broken integration rather than a billing line - confirm the store's plan before building anything on top of this.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `event` | "order_created" \| "user_signup" \| "request_call_me" \| "order_paid" \| "user_update" \| "order_update" \| "comments_created" | yes | Event to subscribe to. |
| `target_url` | string | yes | URL that will receive the event payload. |

### horoshop_hooks_unsubscribe

**Unsubscribe from a webhook** · destructive write, idempotent

Stop delivering an event to a target URL. Needs the subscription id returned by subscribe plus the same target_url.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `id` | integer | yes | Subscription id returned by subscribe. |
| `target_url` | string | yes | The target URL the subscription delivers to. |

## Storefront: cart and checkout

| Tool | Access | Summary |
|---|---|---|
| [`horoshop_cart_get`](#horoshop_cart_get) | read-only | Read the buyer's cart |
| [`horoshop_cart_add`](#horoshop_cart_add) | write | Add a product to the cart |
| [`horoshop_cart_set_quantity`](#horoshop_cart_set_quantity) | write | Change a cart line's quantity |
| [`horoshop_cart_remove`](#horoshop_cart_remove) | write | Remove a cart line |
| [`horoshop_cart_apply_coupon`](#horoshop_cart_apply_coupon) | write | Apply a coupon to the cart |
| [`horoshop_checkout_inspect`](#horoshop_checkout_inspect) | read-only | Inspect the checkout page |

### horoshop_cart_get

**Read the buyer's cart** · read-only

Read the current cart for this store's buyer session - lines (with their hash), quantities and totals. The session is kept per store, so add/remove/get see the same cart. Use it to test the funnel: what a real customer would have before checkout.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `allowLarge` | boolean | no | Default false. The answer is MEASURED before it is returned, and a payload over the size limit (default 100 KB, override with HOROSHOP_MAX_RESPONSE_BYTES) is REFUSED with its measured size and how to narrow it, instead of overflowing the conversation. Set true to get the whole thing anyway. |
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |

### horoshop_cart_add

**Add a product to the cart** · write

Add a product to the buyer's cart by its internal product id (NOT the article - take `id` from the storefront's data-id, or the record id in horoshop_admin_redirect_list where handler 17 = products). Returns the updated cart. This exercises the real widget the shop's JS uses, so a SUCCESSFUL add proves the product is genuinely buyable. READ `CART_EXCEPTION` CAREFULLY - it has two very different causes, and the common one is the boring one. FIRST check whether the product is actually buyable right now: with stock accounting ON (horoshop_admin_settings_catalog useResiduesByStock) a product whose quantity is 0, or whose presence is "not in stock", is refused with exactly this status, and so is a hidden product (display_in_showcase:0). That is the shop working correctly, not a broken cart. Confirm with horoshop_cart_get: if the session returns a cart at all (status OK), the anti-bot has been cleared and the session is fine - the refusal is about the product. ONLY THEN suspect the transport: the buyer session sends a fixed non-browser User-Agent, so a store behind a strict proof-of-work / bot filter can bounce every request and answer `CART_EXCEPTION` for EVERY product. The two are told apart by horoshop_cart_get, so check it before telling anyone their catalogue is broken.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `product` | integer \| string | yes | Internal product id (e.g. 515). |
| `quantity` | integer | no | Default 1. |
| `type` | string | no | Cart item type; default "product". The server rejects unregistered types by name. |

### horoshop_cart_set_quantity

**Change a cart line's quantity** · write

Set the quantity of one cart line, addressed by its `hash` (from horoshop_cart_get). Returns the updated cart.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `hash` | string | yes | Line hash from horoshop_cart_get. |
| `quantity` | integer | yes | New quantity. |

### horoshop_cart_remove

**Remove a cart line** · write

Remove one line from the cart by its `hash` (from horoshop_cart_get).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `hash` | string | yes | Line hash from horoshop_cart_get. |

### horoshop_cart_apply_coupon

**Apply a coupon to the cart** · write

Apply a coupon/certificate code to the buyer's cart and report what the cart says - the honest way to check that a code (from horoshop_admin_coupons_generate, or an existing record in entity "coupons") actually discounts anything. Measured end to end on a live store: cart 799 → 599 with a 25 % coupon, so the discount really is observable from here. The cart must have a line first - a coupon on an empty cart proves nothing, and horoshop_cart_add refuses products that are out of stock (see its note). Pass an empty code to clear the coupon. Same transport caveat as horoshop_cart_add: on a store with a strict bot filter every code comes back rejected, so a "not accepted" is only evidence when the same session can add to the cart at all.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `code` | string | yes | Coupon or certificate code. |

### horoshop_checkout_inspect

**Inspect the checkout page** · read-only

Fetch the checkout page as the buyer with the current cart and report what it offers: which delivery and payment options are actually rendered, and the cart lines it shows. An empty cart redirects to the home page - add something first. This is how to verify that enabling/disabling a payment or delivery option in the admin reached the place where money changes hands. Caveat as in horoshop_cart_add: the buyer session's User-Agent is a fixed non-browser string, so a store with a strict bot filter can answer the challenge page instead of the checkout and the option list comes back empty - that is the filter talking, not the checkout configuration.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `allowLarge` | boolean | no | Default false. The answer is MEASURED before it is returned, and a payload over the size limit (default 100 KB, override with HOROSHOP_MAX_RESPONSE_BYTES) is REFUSED with its measured size and how to narrow it, instead of overflowing the conversation. Set true to get the whole thing anyway. |
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |

## Admin panel: generic engine

| Tool | Access | Summary |
|---|---|---|
| [`horoshop_admin_login_check`](#horoshop_admin_login_check) | read-only | Check admin session |
| [`horoshop_admin_entities`](#horoshop_admin_entities) | read-only | List admin entity types |
| [`horoshop_admin_record_get`](#horoshop_admin_record_get) | read-only | Read any admin record |
| [`horoshop_admin_list`](#horoshop_admin_list) | read-only | List admin records |
| [`horoshop_admin_record_delete`](#horoshop_admin_record_delete) | destructive write, idempotent | Delete admin records |
| [`horoshop_admin_record_save`](#horoshop_admin_record_save) | write, idempotent | Write any admin record |

### horoshop_admin_login_check

**Check admin session** · read-only

Verify the admin-panel session for a store (separate from the /api/ token - this logs into the control panel with the store credentials). Returns who is authenticated. Use before admin write tools to confirm access.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `allowLarge` | boolean | no | Default false. The answer is MEASURED before it is returned, and a payload over the size limit (default 100 KB, override with HOROSHOP_MAX_RESPONSE_BYTES) is REFUSED with its measured size and how to narrow it, instead of overflowing the conversation. Set true to get the whole thing anyway. |
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |

### horoshop_admin_entities

**List admin entity types** · read-only

List the reverse-engineered admin entity types the generic admin tools can reach (slug, handler id, title, and whether it needs special handling). Use to discover what horoshop_admin_record_get / _save / _list / _delete can target.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `allowLarge` | boolean | no | Default false. The answer is MEASURED before it is returned, and a payload over the size limit (default 100 KB, override with HOROSHOP_MAX_RESPONSE_BYTES) is REFUSED with its measured size and how to narrow it, instead of overflowing the conversation. Set true to get the whole thing anyway. |

### horoshop_admin_record_get

**Read any admin record** · read-only

Read ANY admin record (any entity type) into its complete field set: every input/textarea value, every dropdown with its options (dictionaries), and the hidden service fields. This is the universal reader behind the admin panel - pass an entity slug/handler and a record id. For create-form inspection use id "addnew". Note: a few entities (products, client cards) are heavy special editors and may not open with a blank id. SIZE: some forms are enormous - site_settings measures 364–374 fields / 100–211 KB on live stores. The record's own values are never what gets dropped: when the answer is over the response size limit the DROPDOWN OPTION lists are cut first (`selectsOptionsTruncated:true`, each select keeping `optionsTotal`), because 47 KB of that payload is option lists - one timezone select alone carries 412. Only if the FIELDS themselves still overflow is the answer refused, and then `fields:["seo","delivery"]` returns just the ones whose name matches (reported as `fieldsFilter` / `fieldsReturned`, so a partial read is never mistaken for a whole one). WHERE THE VALUE IS: `fields` is the authority for every field. A boolean (names[enabled], names[act]…) is rendered as a hidden 0-default PLUS a checkbox, and the checkbox wins - those hidden defaults are therefore reported separately under `hiddenDefaults` (with the checkbox names listed in `checkboxFields`), NOT mixed into `hidden`, because seeing the same name as "1" in fields and "0" in hidden once led a reader to declare a set of live, enabled records switched off. `hidden` now holds only genuine hidden service values. ⚠ NOT EVERY FORM FIELD REFLECTS STORAGE. For blog_posts (h_news, handler 172) the `names[parent]` select - the article's rubric - is re-seeded to a DEFAULT, not to the stored value: do not trust it, and never feed it back through a raw read-modify-write (that is what once moved 10 published articles into a foreign rubric). Asymmetry worth remembering: on pages (handler 4) raw RMW is safe and the tree parent survives; on h_news it is not. Use horoshop_admin_blog_post_update for articles - it preserves or moves the rubric deliberately and verifies the result against the grid.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `allowLarge` | boolean | no | Default false. The answer is MEASURED before it is returned, and a payload over the size limit (default 100 KB, override with HOROSHOP_MAX_RESPONSE_BYTES) is REFUSED with its measured size and how to narrow it, instead of overflowing the conversation. Set true to get the whole thing anyway. |
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `entity` | integer \| string | yes | Entity to target: a slug (e.g. "coupons", "brands", "benefits") or its numeric handler (e.g. 263). See horoshop_admin_entities. |
| `id` | integer \| string | yes | Record id, or "addnew" to inspect a blank create form. |
| `parent` | integer | no | Parent id (context for tree entities like pages). |
| `fields` | string[] | no | Return only the fields whose NAME contains one of these substrings (case-insensitive) - how to read ONE section of a giant form instead of all of it (site_settings is 339 fields / 187 KB). Applies to `fields`, `selects`, `hidden` and `hiddenDefaults` alike. `fieldCount` still reports the form's true size and `fieldsFilter` reports what was applied, so a filtered read can never be mistaken for the whole record. |

### horoshop_admin_list

**List admin records** · read-only

List the records of an admin entity (id + a human label from the grid cells). By default returns ALL records across every grid page (the admin datagrid caps a page at 20/40/…/160, so a single fetch is not the whole list). Use to discover record ids for horoshop_admin_record_get / _save / _delete. For tree entities like pages pass a parent id to list under it. `count` is what was returned; `total` is the grid's declared grand total. WHEN `count` < `total` THE LIST IS NOT EVERYTHING, and the answer always says so: `truncated:true` plus `incomplete` (with `missing`, and the same text repeated as `warning`). Two causes, both reported: the safety cap (`maxRows`), or GRID DRIFT - big grids page on a sort column with duplicates and no stable tiebreaker, so rows move across page boundaries between renders and a few end up served on no page at all (measured on a 523-product grid: 1 row lost at perPage 160, 8 at perPage 20). A repair pass re-reads the pages and normally recovers them; if it cannot, the shortfall is stated instead of hidden. Never count, diff or conclude "not there" from a list carrying `incomplete`. A SMALLER perPage makes drift WORSE (more boundaries) - prefer `search`, or the entity's own API export (products: horoshop_catalog_export). THE LIST IS IN `records`, AND ONLY THERE - an array of {id, label} (plus `code`, the grid's own key column, where the grid has one: on products that is the ARTICLE). `rows` is NOT the list and is not an array: it is a one-line guard object naming `records`, kept because reading the answer as `rows` and getting `undefined` reads exactly like "this entity is empty" (a cleanup script did that here, saw nothing to clean at count:25, and nearly left a live product in the catalog). It used to be a full second COPY of the array, which doubled every listing - measured on a 349 KB answer, 174 KB of it was the duplicate - so the copy is gone and the guard stays: iterating or mapping `rows` now throws instead of quietly yielding nothing. `count` is the number to trust; count>0 with no rows in hand means you read the wrong key, not that the grid is empty. ⚠ `label` IS ONE LANGUAGE, NOT A TRANSLATION STATUS. The grid renders every multilingual column in a single language (the admin panel's UI language, reported as `labelLang`, which is NOT necessarily the store's first language), so a record whose other languages are already written looks exactly like an untranslated one. Two live records were overwritten on that assumption - one of them holding the storefront template «−{DISCOUNT_PERCENT}%». Pass langStatus:true for per-record `langsFilled`/`langsEmpty` (one extra form read per record, capped), or read the record with horoshop_admin_record_get. HUGE GRIDS - USE `search`, NOT A FULL WALK. interface_translation (l10n, handler 340) holds 4000+ rows; listing it whole means dozens of round-trips and used to die outright with "Network error … fetch failed" (lowering `perPage` makes it WORSE - a smaller window means more pages). `search` applies the admin's own server-side column filter (a substring match) and returns only the matching rows, so finding one theme string costs a single request. `searchColumn` picks the column by label or id (default: the first text-filterable one) - e.g. searchColumn:"Ключ" to match the translation key, "Значение" to match the translated text. The filter is cleared afterwards, so later listings are unaffected. For the interface-translation layer specifically prefer horoshop_admin_interface_translation_get / _set, which wrap this and know the key/lang/value shape.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `allowLarge` | boolean | no | Default false. The answer is MEASURED before it is returned, and a payload over the size limit (default 100 KB, override with HOROSHOP_MAX_RESPONSE_BYTES) is REFUSED with its measured size and how to narrow it, instead of overflowing the conversation. Set true to get the whole thing anyway. |
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `entity` | integer \| string | yes | Entity to target: a slug (e.g. "coupons", "brands", "benefits") or its numeric handler (e.g. 263). See horoshop_admin_entities. |
| `parent` | integer | no | Parent id (for tree entities like pages). |
| `search` | string | no | Server-side substring filter - returns only matching rows instead of walking the whole grid. Essential for 4000-row grids like interface_translation. |
| `searchColumn` | integer \| string | no | Which column `search` filters on: a header label ("Ключ", "Значение") or its numeric column id. Omit for the first text-filterable column. The answer lists the available columns. |
| `page` | integer | no | Fetch only this one grid page instead of all pages. |
| `perPage` | integer | no | Grid window size (max 160). Omit to page at the native size; setting it widens the window so most entities return in a single fetch. NOTE: this does NOT cap how many rows are fetched - a smaller window just means more pages. To bound a huge grid use `search` or `maxRows`. |
| `maxRows` | integer | no | Safety cap on how many rows the walk collects (default 5000, or 500 with `search`). `truncated:true` says the cap was hit. |
| `langStatus` | boolean | no | Default false. True: also report, per record, which languages actually hold text (`langsFilled` / `langsEmpty`) - the answer `label` alone cannot give, since the grid shows ONE language. Costs one extra form read PER RECORD (capped at 30), so narrow the list with `search`/`page` first on big grids. |

### horoshop_admin_record_delete

**Delete admin records** · destructive write, idempotent

Delete one or more records of an admin entity by id. Covers flat-grid entities (coupons, banners, brands, stickers, benefits, reviews…), PRODUCTS, the pages/categories tree, and order statuses - each uses its own delete route, picked automatically. For tree-parented grids (blog/news articles) a row is only visible under its own rubric, so if you don't pass `parent` the delete auto-resolves each id's rubric from the page tree instead of failing to find it. DRY RUN BY DEFAULT: previews which ids exist and would be removed (with the resolved parent). Pass dryRun:false to delete; it then re-checks to confirm they are gone. Special editors that have no delete route report an explanation instead. IDS THAT ARE ALREADY GONE ARE NOT AN ERROR - they come back in `notFound`, and when NONE of the given ids exist the answer carries `alreadyGone:true`. A delete whose target is missing has reached the state it was asked for, so a repeat run is a no-op success; `deleted` (what THIS call removed) stays separate from `notFound` (what was never there), so the two can never be confused. The same `deleted` / `notFound` / `alreadyGone` contract holds across horoshop_admin_order_delete, horoshop_admin_redirect_delete, horoshop_admin_dictionary_value_delete and horoshop_admin_template_param_delete. ⚠ PRODUCTS (entity=products) - deletion is PERMANENT and there is no undo, so treat the dry run as the safety step and delete by id, never by a guessed range. A product and its modifications are separate grid rows: by default only the rows you list are deleted, so removing a parent SKU leaves its modifications behind as orphans (measured live). Pass `withModifications:true` to delete each listed product WITH its modifications - the admin's own «delete selected goods with modifications». Existence is verified by opening each product's editor (a deleted/unknown product answers 503), not by walking the catalog grid, so this costs one request per id instead of one per 20 SKUs of the whole catalog.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `entity` | integer \| string | yes | Entity to target: a slug (e.g. "coupons", "brands", "benefits") or its numeric handler (e.g. 263). See horoshop_admin_entities. |
| `ids` | integer \| string[] | yes | Record ids to delete (from horoshop_admin_list). |
| `parent` | integer | no | Parent id (context for tree entities). For blog/news it auto-resolves if omitted. |
| `withModifications` | boolean | no | Products only: also delete each listed product's modifications (removeSelectedGridsAndMods). Default false - only the listed rows go. |
| `dryRun` | boolean | no | Default true: preview without deleting. Set false to delete. |

### horoshop_admin_record_save

**Write any admin record** · write, idempotent

Set ANY field(s) on ANY admin record - the universal writer. Pass `set` as a map of exact form field names (get them from horoshop_admin_record_get) to new string values. Read-modify-write: every field you don't list is preserved. DRY RUN BY DEFAULT - pass dryRun:false to persist; after saving it re-reads the record and reports which fields verified. To CREATE a record, use id "addnew" and set the required fields - the new id is returned as `newId`. Field names not present on the form are rejected as typos unless you pass allowNewFields:true (needed for rows the admin builds in JS, e.g. the contacts table in site_settings). EVERY FIELD YOU SET IS ACCOUNTED FOR, INCLUDING THE ONES THAT NEEDED NOTHING: `setFields` are the ones actually rewritten, `unknownFields` the ones not on the form, and `unchangedFields` the ones that ALREADY held the exact value you asked for. That last list exists because it used to be no list at all - a field that matched the form default simply disappeared from the answer, which reads as "silently dropped" (measured on a coupon's names[type], whose blank create form already carries "1"). It is still submitted; the save replays the whole form. If a name you passed is in none of the three, that IS a bug - say so. ADD TEXT WITHOUT RESENDING IT: `append` / `prepend` take the same field→text map but splice your delta onto the STORED value instead of replacing it - the way to add one block to a 4 KB seo_text without retyping the 4 KB (and without risking a mangled copy of someone else's content on a live store). The same field in `set` AND `append`/`prepend` is an error, never a silent winner. ANSWER SIZE: on success a long field is reported as {length, tail, sha256} rather than echoed three times as from+to+now (that triple echo was ~12 KB per 4 KB field, ~400 KB across a 15-record rollout); a field that did NOT persist still reports expected vs actual previews and the first differing offset. Pass verbose:true for the full diff. TEMPLATE TOKENS ARE PROTECTED: if the stored value contains a storefront placeholder ({DISCOUNT_PERCENT}, {COUNTDOWN_INFO}, {title}, {price}…) and your new value does not, dryRun reports `placeholderWarnings` and a real write is REFUSED until you pass allowPlaceholderLoss:true - overwriting such a value with a constant freezes the substitution for every product/page that uses it, with nothing erroring and nothing looking broken. Keeping the token (the normal case when translating) passes silently. ⚠ "EVERY FIELD YOU DON'T LIST IS PRESERVED" HAS EXCEPTIONS, AND THEY DIFFER PER ENTITY. Some admin forms re-render a field as a DEFAULT instead of as storage, so sending the form back field-for-field overwrites a value nobody meant to touch. Three entities behave differently - do not generalise from one to another. • blog_posts (h_news, handler 172) RUBRIC TRAP: that entity's form re-seeds `names[parent]` - the rubric the article lists under - to a DEFAULT rather than to storage, so a field-for-field read-modify-write silently RELOCATES the article (this moved 10 published posts out of «Блог» once). This tool therefore DROPS `names[parent]` from the save unless you list it in `set` yourself, and says so in the answer; pass it explicitly to move an article on purpose. For articles prefer horoshop_admin_blog_post_update, which preserves or moves the rubric deliberately and verifies the move against the grid. • products (h_products, handler 17) PRESENCE / COUNTDOWN TRAP - the same class of mine, on the entity you are most likely to touch: the product form re-seeds `…[presence]` (a custom status id 9 «Є в наявності» renders as id 1 «В наявності») and `…[countdown_end_time]` (seeded "now + ~5h" on a product that has no timer at all). Measured: saving one unrelated field (`mpn`) rewrote availability AND switched a promo countdown on for real shoppers. This tool DROPS both from the POST unless you list them yourself, and reports `productGuard` when it does. Set them explicitly and the write IS sent - but verification then comes back `persisted:null, unverifiable:true`, because the form re-reads its own seed rather than storage and this tool will not claim a result it cannot see. Availability is authoritatively read with horoshop_catalog_export (`presence`) and set with horoshop_catalog_import. • pages (handler 4): raw RMW is safe and the tree parent survives - with one exception, the slug. `names[name][slug]` persists only when `names[name][parent]` carries the URL-node id of the parent; sent alone it is accepted, stored nowhere, and the page 404s while every later read agrees it saved. This tool resolves that parent for you, and refuses the save outright if it cannot, rather than storing a slug that does not exist.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `entity` | integer \| string | yes | Entity to target: a slug (e.g. "coupons", "brands", "benefits") or its numeric handler (e.g. 263). See horoshop_admin_entities. |
| `id` | integer \| string | yes | Record id to edit, or "addnew" to create. |
| `set` | object | no | Map of exact form field name → new value (REPLACES it), e.g. {"names[i18n][3][seo_title]":"…"}. Optional when you pass `append`/`prepend`. |
| `append` | object | no | APPEND to the end of the STORED value instead of replacing it: a map of exact form field name → the text to glue onto the END of its stored value, e.g. {"names[i18n][3][seo_text]":"<h3>Доставка</h3>…"}. The tool already read-modify-writes, so it reads the current value, glues your delta onto it verbatim (no separator, no trimming) and writes the result - you never have to resend the existing text (a 4 KB seo_text stays where it is, untouched and unrecoded). Mutually exclusive with the replacing field for the SAME field (both = error, never a silent winner). Works with dryRun: the preview shows length before → after plus a head/tail window of the result. |
| `prepend` | object | no | PREPEND to the START of the STORED value instead of replacing it: a map of exact form field name → the text to glue onto the START of its stored value. Same mechanics and the same mutual exclusion as `append`. |
| `verbose` | boolean | no | Default false: long field values (>200 chars, e.g. a 4 KB seo_text) are summarised in the answer - on success as {length, tail, sha256} instead of the same string echoed as from+to+now, on failure as expected/actual previews plus the first differing offset. Set true to get the full from→to→now diff for every field (heavy: ~3× the field size per field). |
| `allowPlaceholderLoss` | boolean | no | Default false. A write whose NEW value drops a storefront template token that the STORED value had ({DISCOUNT_PERCENT}, {PRICE}, {title}…) is REFUSED, because that silently turns a per-product substitution into frozen text. Set true only when losing the token is intended. |
| `parent` | integer | no | Parent id (context for tree entities). |
| `allowNewFields` | boolean | no | Default false: names that aren't on the form are refused as typos. Set true to send them anyway - required for JS-generated rows such as extra[contacts_data][common][0][value] in site_settings. |
| `dryRun` | boolean | no | Default true: preview the field changes without saving. Set false to persist. |

## Admin panel: orders and analytics

| Tool | Access | Summary |
|---|---|---|
| [`horoshop_admin_order_resolve`](#horoshop_admin_order_resolve) | read-only | Resolve an order number to its admin record id |
| [`horoshop_admin_order_get`](#horoshop_admin_order_get) | read-only | Read one order from the admin editor |
| [`horoshop_admin_order_update`](#horoshop_admin_order_update) | write, idempotent | Edit an order's recipient, delivery and payment |
| [`horoshop_admin_order_status_change`](#horoshop_admin_order_status_change) | destructive write, idempotent | Change an order's status (and return stock on cancel) |
| [`horoshop_admin_order_delete`](#horoshop_admin_order_delete) | destructive write, idempotent | Delete an order (both halves) |
| [`horoshop_admin_order_print_url`](#horoshop_admin_order_print_url) | read-only | Build the delivery-note print URL |
| [`horoshop_admin_order_status_set`](#horoshop_admin_order_status_set) | write, idempotent | Create or edit an order status |
| [`horoshop_admin_reports_dashboard`](#horoshop_admin_reports_dashboard) | read-only | Read the store analytics dashboard (Аналитика) |

### horoshop_admin_order_resolve

**Resolve an order number to its admin record id** · read-only

Bridge between the two ids an order has. `orders/get` reports an order NUMBER; the admin editor, the status switcher, the delete routes and the waybill printer all address an admin RECORD id - and they are two independent autoincrements (empty draft rows consume record ids without creating orders, so on the test store order #7 lived at record id 9). There is no order-number column in the grid to filter on - measured: the column labelled «Заказ» holds the order TOTAL, and filtering it for 26 returns nothing while order #26 sits right there - so the only bridge is each editor's own heading «Редактирование заказа #N», one HTTP read per row. Pass `orderId` to go number → record id, or `adminId` to go the other way (one request). TWO SEARCH STRATEGIES, PICKED BY GRID SIZE, and `scan.strategy` says which ran. A grid that fits `maxRows` (default 5000) is LISTED first, then binary-searched over the listed ids - that is the path that can answer `exhaustive:true`. A bigger grid is NOT listed at all (`id-range`): listing 40 699 orders costs 255 page reads / 159 s and the default cap left the oldest 88 % unreachable by number. Instead the record-id SPACE is walked directly - record id ≥ order number always (both autoincrements, drafts only widen the gap), and the gap is nearly constant, so an interpolation from `orderId` lands the answer in TWO editor reads at any age: measured on 40 699 orders, the newest, the middle and the oldest order all resolved in 2 reads / ~2 s each, where before they took 24 s, failed, and failed. A NUMBER THAT DOES NOT EXIST COSTS ZERO EDITOR READS on the id-range path: `orders/get` is the authority on order numbers, so it is asked first and a "no" is returned as a complete answer. WHEN IT SAYS NOT FOUND, READ WHICH KIND OF NOT FOUND. Every answer carries `scan` (`gridRows`, `rowsListed`, `probes`, `strategy`, `exhaustive`): `exhaustive:true` (listing path only) means every row really was listed and read back. On the id-range path `exhaustive` is always false - nothing was listed - and a miss is instead qualified by `bracket`: the two records that straddle the number were read, and `gap:1` means they are ADJACENT ids with nothing in between, which is proof for that number. Anything weaker says so and points at `maxRows:<gridRows+1>` for the listing-complete answer or at `maxProbes` when the budget ran out. A CANCELLED ORDER CANNOT BE RESOLVED BY NUMBER AT ALL: its editor 302-redirects, so it has no readable number and the call ERRORS. On the id-range path the error is sharper - if the public API still knows the number while no editor shows it, the answer says the row exists and is cancelled, and names the unreadable record ids in the bracket. `locked:true` is reported only on the `adminId` branch. ⚠ READING AN ORDER EDITOR TOUCHES ITS ROW. Horoshop stamps the record's date on every editor open (measured: 10:06:23 → 10:09:46 on a re-read), and the admin orders grid is sorted by that date - so the orders this tool reads jump to the top of the store's list. Nothing about the order changes (creation date, status, totals and cart are untouched - verified against the API), but it is why this tool is built to spend as few editor reads as possible: 2 on a hit, 0 on a number the API says does not exist.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `allowLarge` | boolean | no | Default false. The answer is MEASURED before it is returned, and a payload over the size limit (default 100 KB, override with HOROSHOP_MAX_RESPONSE_BYTES) is REFUSED with its measured size and how to narrow it, instead of overflowing the conversation. Set true to get the whole thing anyway. |
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `orderId` | integer | no | Order NUMBER as horoshop_orders_get reports it. Resolved to the admin record id via the editor heading. |
| `adminId` | integer \| string | no | Admin RECORD id (the `id` in the editor URL / the orders grid). NOT the order number. |
| `maxProbes` | integer | no | Editor reads the number→record-id search may spend (default 40). The search is a binary walk over the whole grid, so it normally costs 2–15 reads even on thousands of orders; raise this only if an answer comes back saying the probe budget ran out. |
| `maxRows` | integer | no | Cap on how many grid rows the candidate listing collects (default 5000). `scan.limitedBy` says when it bit. |

### horoshop_admin_order_get

**Read one order from the admin editor** · read-only

Read an order as the admin panel sees it: recipient (name/phone/e-mail/city), delivery type and its method fields (including a Nova Poshta external waybill number), payment type and the paid flag, the manager's and the BUYER'S comment, every cart line (article, title, price, quantity, sum) with the order totals, and the status switcher with the currently active status. This is richer than horoshop_orders_get, which has no comments, no per-line editing view and no status-button state. Address it with `orderId` (the order number) or `adminId` (the record id). ⚠️ The editor is opened with `action=edit` - that is mandatory: without it Horoshop renders a blank «Новый заказ» form AND materialises an empty 0.00 row in the orders grid, which is exactly how a recon wave once littered the grid and mistook a draft for a real order. A CANCELLED order redirects instead of opening. Addressed by `adminId` that comes back as `locked:true`; addressed by `orderId` it cannot be resolved at all and the call ERRORS instead - same cause, two different shapes. After cancelling there is nothing left to read or edit, only to delete. Addressing by `orderId` runs horoshop_admin_order_resolve first (a listed-grid binary search, or a listing-free walk of the record-id space on a grid over `maxRows`); if it reports a number missing, read its `scan` - `exhaustive:true` or `bracket.gap:1` are proof, anything else is not. ⚠ READING AN ORDER EDITOR TOUCHES ITS ROW. Horoshop stamps the record's date on every editor open (measured: 10:06:23 → 10:09:46 on a re-read), and the admin orders grid is sorted by that date - so the orders this tool reads jump to the top of the store's list. Nothing about the order changes (creation date, status, totals and cart are untouched - verified against the API), but it is why this tool is built to spend as few editor reads as possible: 2 on a hit, 0 on a number the API says does not exist.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `allowLarge` | boolean | no | Default false. The answer is MEASURED before it is returned, and a payload over the size limit (default 100 KB, override with HOROSHOP_MAX_RESPONSE_BYTES) is REFUSED with its measured size and how to narrow it, instead of overflowing the conversation. Set true to get the whole thing anyway. |
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `orderId` | integer | no | Order NUMBER as horoshop_orders_get reports it. Resolved to the admin record id via the editor heading. |
| `adminId` | integer \| string | no | Admin RECORD id (the `id` in the editor URL / the orders grid). NOT the order number. |
| `maxProbes` | integer | no | Editor reads the number→record-id search may spend (default 40). The search is a binary walk over the whole grid, so it normally costs 2–15 reads even on thousands of orders; raise this only if an answer comes back saying the probe budget ran out. |
| `maxRows` | integer | no | Cap on how many grid rows the candidate listing collects (default 5000). `scan.limitedBy` says when it bit. |

### horoshop_admin_order_update

**Edit an order's recipient, delivery and payment** · write, idempotent

Edit a LIVE order card - the recipient's name/phone/email/city, the delivery address, the manager's comment, and the paid flag. This is the part of the order the public API cannot touch: `horoshop_orders_update` moves the status and nothing else. WHY IT WORKS THE WAY IT DOES, because the platform hides it: the order card is the storefront CHECKOUT rendered with `configPresetName=admin_order`, and `/order/setAttributes/` - the call the panel makes as you type - answers OK and SAVES NOTHING (measured). The only persist is `/order/submit/`, and it needs the WHOLE form re-serialised, including the fields the panel's own script skips. This tool reads the card, applies your patch, re-sends everything, and then confirms through the public API - a different read path from the form it just posted. WHAT IT CANNOT DO: change what is IN the order. Line quantity, line removal and manual line price carry no form name at all (they are `j-ignore` inputs driven by `/order/component/AdminCart/*`), and the admin's product search for adding a line answers `{"products":[],"enabled":false}` on this platform. Those are measured platform limits, not omissions - see horoshop_admin_order_get for what a line exposes. ⚠ A digit in the recipient's name is refused by the platform's `safe` validator («ZZТест2» → «Поле заповнено некоректно»). Cancelled orders (status 4) are un-editable - the editor redirects away. DRY RUN BY DEFAULT.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `adminId` | integer \| string | yes | Admin record id of the order (from horoshop_admin_order_resolve / _get). NOT the order number. |
| `name` | string | no | Recipient's full name. Digits are refused by the platform's validator. |
| `phone` | string | no | Recipient's phone, e.g. "+38 (067) 000-00-00". |
| `email` | string | no | Recipient's email. |
| `city` | string | no | Delivery city as text. Pair with `cityId` when you have it - the platform keys the city by id. |
| `cityId` | integer \| string | no | Platform city id (the value already on the card, unless you are moving the order to another city). |
| `address` | string | no | Delivery address / warehouse line. |
| `managerComment` | string | no | The MANAGER's comment (`Recipient[admin_comment]`, surfaces as `manager_comment` in orders/get). The buyer's own comment is read-only. |
| `payed` | boolean | no | Mark the order paid (true) or unpaid (false). |
| `dryRun` | boolean | no | Default true: show the current values and the patch without writing. Set false to apply. |

### horoshop_admin_order_status_change

**Change an order's status (and return stock on cancel)** · destructive write, idempotent

Move ONE order to another status through the admin editor - the only path that can also PUT THE GOODS BACK ON THE SHELF. Measured: cancelling through the public API (horoshop_orders_update status:4) sets the status and leaves the stock deducted (3 → 3); this tool with `returnStock:true` posts the admin's own `return_quantity=1` and the stock comes back (3 → 4). `returnStock` is REQUIRED when status is 4 and has no default on purpose: it is the difference between «the goods are back on sale» and «they stay sold», and only the caller knows which - and it is the LAST chance to decide, because deleting the order afterwards does not return anything either (measured). It is refused for any other status (the server ignores `return_quantity` there). Cancelling also needs `confirm:true`, because after status 4 the order is permanently un-editable - the editor redirects away. Stock accounting must be ON (`extra[catalog_use_residues_by_stock]`) for a return to mean anything: with it off, quantity is not what drives availability and the tool says so instead of pretending. By default it VERIFIES the return by reading warehouse stock before and after (`stockCheck` with before/after/delta per article), and confirms the new status through the public API - an independent read path from the admin form it just posted. THE PROOF IS BOUNDED, AND IT SAYS SO: each line costs several admin requests, so `stockCheckLimit` (default 20) caps how many are read back, and `stockCheckCoverage` reports `checked` of `withArticle` plus `truncated` on every answer. A short `stockCheck` is therefore never ambiguous - it either says it covered every line or says exactly how many it did not. DRY RUN BY DEFAULT. NOT this tool: creating or renaming the status LABELS themselves - that is horoshop_admin_order_status_set (entity «Статусы заказа», handler 436).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `orderId` | integer | no | Order NUMBER as horoshop_orders_get reports it. Resolved to the admin record id via the editor heading. |
| `adminId` | integer \| string | no | Admin RECORD id (the `id` in the editor URL / the orders grid). NOT the order number. |
| `status` | integer | yes | Target status: 1 new, 2 processing, 6 shipped, 3 delivered, 4 cancelled/not delivered. (Status 8 «paid» exists in the API but has no button in the editor - use horoshop_orders_update for it.) |
| `returnStock` | boolean | no | REQUIRED when status is 4. true → the ordered quantities go back on sale (return_quantity=1); false → they stay deducted. No default: choose deliberately. Rejected for any other status. |
| `confirm` | boolean | no | REQUIRED when status is 4: cancelling is irreversible - the order becomes permanently un-editable. |
| `verifyStock` | boolean | no | Default true: read each ordered product's warehouse stock before and after so the answer carries real numbers instead of a claim. Set false to skip (saves ~5 requests per line). |
| `stockCheckLimit` | integer | no | How many cart lines the stock proof covers (default 20, max 100). Whatever it is, `stockCheckCoverage.truncated` says whether anything was left unread - the cap is never silent. |
| `maxProbes` | integer | no | Editor reads the number→record-id search may spend (default 40). The search is a binary walk over the whole grid, so it normally costs 2–15 reads even on thousands of orders; raise this only if an answer comes back saying the probe budget ran out. |
| `maxRows` | integer | no | Cap on how many grid rows the candidate listing collects (default 5000). `scan.limitedBy` says when it bit. |
| `dryRun` | boolean | no | Default true: preview without changing anything. Set false to apply. |

### horoshop_admin_order_delete

**Delete an order (both halves)** · destructive write, idempotent

Delete ONE order completely. Two different routes are needed and the admin's own warning about them is wrong: the grid's «Удалить» promises «Остатки товара будут возвращены на склад», but the URL it navigates to (`edit.php?del=1`) removes the row WITHOUT returning any stock, while the AJAX call it fires (`deleteOrderCart`) returns the stock but leaves an empty 0.00 row behind in the grid. Measured on both. So a clean delete is both, in order - that is what this tool does: `deleteOrderCart` first (order disappears from the API, stock comes back), then `del=1` (the row goes). ⚠️ The stock half only works on a LIVE order. Deleting an order that was ALREADY cancelled brings nothing back (measured: live order 4 → 5, already-cancelled order 5 → 5) - once it is cancelled with return_quantity=0 the goods are written off for good, so decide at cancel time, not at delete time. By default it proves the stock half with real numbers (`stockCheck`: before/after per ordered article) and confirms the row is gone from the grid - with two limits worth knowing. The stock proof is capped by `stockCheckLimit` (default 20 lines) because each line costs several admin requests, but the cap is NOT silent: `stockCheckCoverage` reports `checked` of `withArticle` and sets `truncated` when anything was left unread. And on an ALREADY-CANCELLED order there is no readable editor, so there is no `stockCheck` at all and `apiGone` stays null: the only thing actually verified is that the grid row disappeared. The grid checks (`existsInGrid` before, `rowGone` after) read EVERY page of the grid, not just the one the session was on. DRY RUN BY DEFAULT and `confirm:true` required - deletion is permanent. Also the right tool for the empty draft rows an `action=edit`-less editor open leaves behind (they have no order number; address them by `adminId`). REPEATING THE DELETE IS SAFE AND DOES NOT ERROR. Addressed by `adminId`, a row that is no longer in the grid answers `{deleted:false, alreadyGone:true, rowGone:true}` and sends nothing - "already gone" is the outcome a delete wants, so an idempotent cleanup can call this twice without string-matching an error message. The two cases stay distinguishable: `deleted:true` means THIS call removed the row, `alreadyGone:true` means it was not there. Addressed by `orderId` it still errors, and deliberately: a number that no longer resolves is genuinely ambiguous - a CANCELLED order looks exactly the same as a deleted one from the outside - so silence there would be a guess. Cancelled rows are deletable by `adminId`.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `orderId` | integer | no | Order NUMBER as horoshop_orders_get reports it. Resolved to the admin record id via the editor heading. |
| `adminId` | integer \| string | no | Admin RECORD id (the `id` in the editor URL / the orders grid). NOT the order number. |
| `verifyStock` | boolean | no | Default true: read each ordered product's stock before and after, so the answer carries numbers. |
| `stockCheckLimit` | integer | no | How many cart lines the stock proof covers (default 20, max 100). `stockCheckCoverage.truncated` always says whether the cap bit. |
| `maxProbes` | integer | no | Editor reads the number→record-id search may spend (default 40). The search is a binary walk over the whole grid, so it normally costs 2–15 reads even on thousands of orders; raise this only if an answer comes back saying the probe budget ran out. |
| `maxRows` | integer | no | Cap on how many grid rows the candidate listing collects (default 5000). `scan.limitedBy` says when it bit. |
| `confirm` | boolean | no | REQUIRED with dryRun:false - deletion is permanent. |
| `dryRun` | boolean | no | Default true: preview what would be deleted. Set false to delete. |

### horoshop_admin_order_print_url

**Build the delivery-note print URL** · read-only

Build the admin URL that prints an existing Nova Poshta waybill for one or more orders. It only assembles the address - nothing is requested, and the endpoint itself cannot create a waybill (with no Nova Poshta credentials it answers «Дані авторизації не заповнені»; creating a real TTN is a different call this server deliberately does not expose). `format` is mandatory (the endpoint answers HTTP 400 without it). The ids are ADMIN RECORD ids, not order numbers - resolve them with horoshop_admin_order_resolve; an order with no Nova Poshta delivery prints an empty document.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `allowLarge` | boolean | no | Default false. The answer is MEASURED before it is returned, and a payload over the size limit (default 100 KB, override with HOROSHOP_MAX_RESPONSE_BYTES) is REFUSED with its measured size and how to narrow it, instead of overflowing the conversation. Set true to get the whole thing anyway. |
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `adminIds` | integer \| string[] | yes | Admin record ids (from horoshop_admin_order_resolve / horoshop_admin_list entity=orders). |
| `format` | "marking" \| "marking100x100" \| "html" | yes | Print format. Mandatory - the endpoint 400s without it. |

### horoshop_admin_order_status_set

**Create or edit an order status** · write, idempotent

Create or edit an order status - the labels your orders move through, in every language. Omit `id` to create. `successful` marks the status that counts as a completed sale (it drives reporting), `inReports` includes it in report totals. Read the current list with horoshop_orders_get_statuses. DRY RUN BY DEFAULT. `titles` IS REQUIRED even when you only want to flip a flag on an existing status - the schema has no optional marker on it, so a call carrying just `id` and `successful` is rejected by validation before it ever reaches the store. Pass `titles:{}` to change flags only.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `id` | integer \| string | no | Status id to edit; omit to create a new one. |
| `titles` | object | yes | Per-language title, e.g. {"ua":"Оплачено","ru":"Оплачен","en":"Paid"}. |
| `successful` | boolean | no | Counts as a successful sale. |
| `inReports` | boolean | no | Include in report totals. |
| `sortOrder` | integer | no | Position in the list. |
| `dryRun` | boolean | no | Default true: preview. Set false to apply. |

### horoshop_admin_reports_dashboard

**Read the store analytics dashboard (Аналитика)** · read-only

Read the admin «Аналитика» dashboard in one call - no order pagination. Returns, for the store's default reporting window: `currentPeriod` and `previousPeriod`, each with `orders` (totalOrders, ordersPerDay, totalSum, averageCheck), `conversion` (totalVisitors, visitorsPerDay, cnvCreated/Started/Completed/Delivered and their sums), `topProducts`, `topFavorites`, and a DAILY series (`ordersDaily`: per-day sum/quantity/averageCheck) for charting the trend - plus `currency`, `actualDateOfReports`, `startedReportingDate`. MEASURED LIMIT: the endpoint returns a FIXED default window and ignores date-range parameters (15 GET/POST shapes measured), so there is no from/to argument - for an arbitrary date range, aggregate `horoshop_orders_get` instead. Read-only; safe on any store.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `allowLarge` | boolean | no | Default false. The answer is MEASURED before it is returned, and a payload over the size limit (default 100 KB, override with HOROSHOP_MAX_RESPONSE_BYTES) is REFUSED with its measured size and how to narrow it, instead of overflowing the conversation. Set true to get the whole thing anyway. |
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |

## Admin panel: products, prices, images

| Tool | Access | Summary |
|---|---|---|
| [`horoshop_admin_product_stock_set`](#horoshop_admin_product_stock_set) | write | Set a product's warehouse stock |
| [`horoshop_admin_upload_image`](#horoshop_admin_upload_image) | write | Upload a file into any admin media field (logos, favicon, covers, brand/benefit/colour/payment images, avatars) |
| [`horoshop_admin_export_characteristics`](#horoshop_admin_export_characteristics) | write | Export a product template's characteristics to Excel |
| [`horoshop_admin_products_group_edit`](#horoshop_admin_products_group_edit) | write, idempotent | Bulk-edit products (grid group operations) |
| [`horoshop_admin_products_merge`](#horoshop_admin_products_merge) | destructive write | Merge products into one modification group |
| [`horoshop_admin_products_price_set`](#horoshop_admin_products_price_set) | destructive write, idempotent | Bulk-set product prices (by article, with guards and rollback) |
| [`horoshop_admin_price_import_parse`](#horoshop_admin_price_import_parse) | read-only | Parse a supplier price list from a URL (read-only) and propose a column mapping |
| [`horoshop_admin_price_import_run`](#horoshop_admin_price_import_run) | destructive write | Dry-run or execute a supplier price-list import |
| [`horoshop_admin_import_images`](#horoshop_admin_import_images) | write | Bulk-import local images by file name |

### horoshop_admin_product_stock_set

**Set a product's warehouse stock** · write

Set (or nudge) how many units of a product the warehouse holds - the only write path MEASURED to move stock, and the only one that verifies the result. `horoshop_catalog_import` accepts a `quantity` field, answers «Товар обновлен», and writes nothing: measured on the test store, an import of quantity:5 left the export at 0. (Horoshop also documents a bulk stock path, `catalog_import` → `residues[]` per warehouse; this server passes it through untouched but nobody has measured it, so if you use it for a mass load, spot-check the result against horoshop_catalog_export rather than trusting the log.) Stock lives in the warehouse ledger, and this tool posts the same income/expense document the admin's «Склад» column does (`lookup.php load=transfer_inout_save`). Address the product by `article` (resolved against the ledger's own echo, exact match) or by `productId`. Pass `quantity` for an absolute target (the delta is computed for you) or `delta` for a relative move. ⚠ ONLY `quantity` IS SAFE TO RETRY: it recomputes the move from whatever the stock is now, so sending it twice lands on the same number. `delta` is applied to the CURRENT stock every time - a repeated `delta:+10` after a timeout posts a second warehouse document and the stock ends up 20 higher, with nothing in the ledger to say it was an accident. When in doubt re-read the stock and send an absolute `quantity`. It reads the current stock first, so the dry run shows current → target, and after the write it re-reads the ledger and reports the real before/after. Note: with stock accounting OFF (`extra[catalog_use_residues_by_stock]`), quantity is stored but availability on the storefront is whatever `presence` says - the tool reports the flag so the number is not mistaken for «now it is in stock». DRY RUN BY DEFAULT.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `article` | string | no | Product article (exact match). Either this or productId. |
| `productId` | integer \| string | no | Internal product id (e.g. 535). Either this or article. |
| `quantity` | integer | no | Absolute target stock. Mutually exclusive with `delta`. |
| `delta` | integer | no | Relative change (+N income, −N expense). Mutually exclusive with `quantity`. |
| `warehouse` | integer \| string | no | Warehouse id; defaults to the one the transfer form pre-selects (most stores have exactly one). |
| `dryRun` | boolean | no | Default true: report current → target without writing. Set false to apply. |

### horoshop_admin_upload_image

**Upload a file into any admin media field (logos, favicon, covers, brand/benefit/colour/payment images, avatars)** · write

Upload a real file into the admin panel through the same multipart save.php the browser uses - there is no separate upload endpoint. Two ways to address the destination.

1) `target` - a named field:
• general settings: header_logo, footer_logo, print_logo, mobile_logo, og_image, favicon, watermark
• category_cover (needs `id` = the category; the namespace - `extra[image]` on a default-template category, `extra_parent[image]` on a custom-template one - is resolved from the form, and an unknown id reports "category not found")
• per-record media (needs `id` = that record's id, from horoshop_admin_list): brand_logo (brands), benefit_image (benefits), color_icon (colors), filter_color_icon (filter_colors), payment_icon (payment_methods), admin_avatar (admins), customer_avatar (customers), service_file (external_service_files - a verification .txt/.html, not an image, so any bytes are accepted).

2) `entity` + `id` + `field` - ANY `<input type=file>` on that record's form, for fields whose name is per-record and cannot be named in advance. The classic case is a product image slot: `entity:"products", id:515, field:"modifications[0][images][old_images][149956][img]"` REPLACES the picture in that slot. Read the exact names from horoshop_admin_record_get (`fileFields`); the field is validated against the form's real file inputs, so a typo is refused instead of silently uploading nowhere.

Provide the bytes as `url` (fetched server-side), `base64`, or a data: URI. Read-modify-write: every other field on the form is preserved. Success is verified TWICE: the field's stored path (`[value]`) must go from empty to a `/content/…` path (`changed:true`), AND that file is then fetched from the storefront (`asset.ok`) - because Horoshop registers the path independently of storing the image, so a source it cannot process (a corrupt PNG, some WEBPs) produces a green `changed:true` pointing at a 404. Fields that have no `[value]` sibling (service_file, a product image slot) report `verifiedBy:"transport"` and must be checked on the storefront yourself. DRY RUN BY DEFAULT - pass dryRun:false to actually upload.

Net-zero / revert, and the two cases are NOT the same. Into an EMPTY field: `remove:true` (same target/field, no source) clears it via the admin's removeImage flow and the field is unset again - a clean round trip. The `[id]` is a stable field id (it does not change on upload), so the picture is cleared by removeImage, not by re-pointing an id. (favicon uses [helper], not [id]; a field with no `[id]` sibling cannot be removed this way.)

Over a FILLED field, replacing DESTROYS the previous image and `remove:true` is NOT a revert - it unsets the field instead of restoring the old picture. Measured on the test store: the old file is overwritten in place (the previous path then serves the REPLACEMENT), `[value]` is not writable (a record_save that sets it answers `saved:false`), and the freshly reported path can 404 until the save settles. So nothing recovers the old image after the fact - "just download the previous URL later" fetches the replacement. Because of that this tool captures it BEFORE writing: when the target already holds an image, the answer carries `previousImage` {value, bytes, sha256, contentType, base64} - on the DRY RUN as well, so the preview hands you the only copy that will exist before you commit. Restore by re-uploading `previousImage.base64` into the same target. The IMAGE comes back byte-for-byte; the URL does not - Horoshop names every upload afresh, so the restored file lands at a new /content/… path. Images over 256 KB are not embedded: you get the sha256 and an explicit warning that the replace is not revertible, and you must save the file yourself first.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `target` | "header_logo" \| "footer_logo" \| "print_logo" \| "mobile_logo" \| "og_image" \| "favicon" \| "watermark" \| "category_cover" \| "brand_logo" \| "benefit_image" \| "color_icon" \| "filter_color_icon" \| "payment_icon" \| "admin_avatar" \| "customer_avatar" \| "service_file" | no | Named destination field. See the list in the description. Mutually exclusive with `field`. |
| `entity` | integer \| string | no | Entity slug/handler for the free-form path (used with `field`), e.g. "products", "brands". |
| `field` | string | no | Exact file-input name to upload into, e.g. "modifications[0][images][old_images][149956][img]". Requires `entity` + `id`. Validated against the form's real file inputs. |
| `id` | integer \| string | no | Record id - required for category_cover, every per-record target, and the free-form path. |
| `url` | string | no | File URL to fetch server-side (or a data: URI). |
| `base64` | string | no | File bytes as base64 (or a data: URI). |
| `filename` | string | no | Override the sent filename (default derived from target + detected type). |
| `contentType` | string | no | Override the sent MIME type (default detected from bytes). |
| `remove` | boolean | no | Revert: clear the target's image (removeImage) instead of uploading. Returns the field to unset. Ignores any source. |
| `dryRun` | boolean | no | Default true: preview without uploading. Set false to apply. |

### horoshop_admin_export_characteristics

**Export a product template's characteristics to Excel** · write

Generate the «Экспорт характеристик» spreadsheet for ONE product template and return its download link - the .xlsx that lists the template's characteristic fields, which is the practical way to see (and hand to a client) what a category's product form actually asks for. `templateId` is a PRODUCT TEMPLATE id, not a category id: get them from horoshop_admin_product_templates (on the test store 381 / 460 / 461). The answer is `{link}` to a file named `hid_specifications_<templateId>.<timestamp>.xlsx`, so every call writes a new file rather than replacing the previous one. Reading only - nothing in the catalog or the template changes. ⚠ THE ENDPOINT DOES NOT CHECK THAT THE TEMPLATE EXISTS - measured: `hid=999999` answers `status:OK` with a link to a real, downloadable 3 KB spreadsheet that describes nothing. A non-existent id therefore looks exactly like a successful export. This tool refuses instead: the id is checked against the store's template list first, and an unknown one is an error naming the ids that do exist. (A non-numeric id is the platform's own 503 TypeError.)

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `templateId` | integer \| string | yes | Product template id (horoshop_admin_product_templates). NOT a category id. |

### horoshop_admin_products_group_edit

**Bulk-edit products (grid group operations)** · write, idempotent

Apply ONE change to MANY products at once - the admin's own bulk toolbar, the one that appears under the products grid when you tick rows. Address products by `article` (exact match, resolved to internal ids for you) or by `productIds`. Operations: `display` (show/hide on the storefront - the most-used one), `presence` (availability status), `icons` (hang or remove a sticker), `countdown` (the promo timer + its offer message), `marketplace` (include/exclude from a marketplace feed), `copy` (duplicate the products). DRY RUN BY DEFAULT: it resolves every article, reports HOW MANY products would be touched and, per product, the CURRENT value → the NEW value, plus which articles it could not find. Pass dryRun:false to apply; it then re-reads the touched articles from catalog/export and reports the real before/after per product, so a silent no-op cannot pass for success. Name resolution is done against the STORE's own lists, read from the admin modal: pass a sticker/presence/marketplace by TITLE ("Хит", "Нет в наличии") or by id - either way it is validated against what this store actually offers, because Horoshop answers «OK» for an id that means nothing and changes nothing. ⚠ `copy` CREATES products: each copy's article is the source's prefixed with `copy_`, so copying the same product twice collides on article. ⚠ A large selection is handed to a BACKGROUND QUEUE (`queued:true` in the answer) - the values then change a moment later, and an immediate re-read can still show the old ones. Not here: deleting (horoshop_admin_record_delete entity=products), warehouse stock (horoshop_admin_product_stock_set - the grid's «Внести»/«Вынести»), and merging (horoshop_admin_products_merge).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `articles` | string[] | no | Articles (SKUs) to act on, matched EXACTLY. Either this or productIds (or both). |
| `productIds` | integer \| string[] | no | Internal grid product ids (from horoshop_admin_list entity=products). Either this or articles. |
| `operation` | "display" \| "presence" \| "icons" \| "countdown" \| "marketplace" \| "copy" | yes | display = show/hide in the showcase · presence = availability status · icons = sticker on/off · countdown = promo timer · marketplace = feed membership on/off · copy = duplicate products. |
| `value` | boolean | no | display: true = shown, false = hidden. icons/marketplace: true = attach, false = remove. Ignored by the others. |
| `presence` | string \| integer | no | operation=presence: the availability status by title ("Нет в наличии", "Є в наявності") or id. |
| `icon` | string \| integer | no | operation=icons: the sticker by title ("Хит", "Новинка") or id. Combine with `value` to attach or remove it. |
| `marketplace` | string \| integer | no | operation=marketplace: the marketplace/feed by title ("Multisearch Feed") or id. Combine with `value`. |
| `endTime` | string | no | operation=countdown: when the timer ends - "YYYY-MM-DD HH:MM[:SS]" (store-local) or a zoned ISO instant ("2026-08-15T12:00:00Z"). |
| `utcOffsetMinutes` | integer | no | operation=countdown: the store's UTC offset in minutes for a bare local endTime. Default 180 (Kyiv summer time). Ignored for a zoned ISO instant. |
| `message` | object | no | operation=countdown: the offer message per language, e.g. {"ua":"Знижка діє до","ru":"Скидка действует до"}. Pass "" to clear a language. |
| `copyImages` | boolean | no | operation=copy: also duplicate the image files. Default false (much cheaper; the copy then has no images of its own). |
| `maxProducts` | integer | no | Safety cap on how many products one call may touch. Default 500. |
| `dryRun` | boolean | no | Default true: resolve and preview, write nothing. Set false to apply. |

### horoshop_admin_products_merge

**Merge products into one modification group** · destructive write

Merge several products into ONE - the grid's «Соединить». The product you name as `main` stays a top-level product; every other one becomes a MODIFICATION of it (its `parent_article` flips to the main product's), which is how a store turns four separately-loaded size SKUs into one product with a size selector. ⚠ THERE IS NO UNDO. Nothing in the admin re-splits a merged group - separating them again is per-product editor work. Treat the dry run as the safety step. DRY RUN BY DEFAULT: resolves the articles and shows which product stays main and which get absorbed. Pass dryRun:false to merge; it then re-reads the catalog and reports each product's resulting parent_article, so a merge that did not take is visible.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `articles` | string[] | no | Articles (SKUs) to act on, matched EXACTLY. Either this or productIds (or both). |
| `productIds` | integer \| string[] | no | Internal grid product ids (from horoshop_admin_list entity=products). Either this or articles. |
| `main` | string \| integer | yes | The product that stays top-level and receives the others as modifications - its article or its internal id. Must be one of the products being merged. |
| `dryRun` | boolean | no | Default true: preview without merging. Set false to merge (irreversible). |

### horoshop_admin_products_price_set

**Bulk-set product prices (by article, with guards and rollback)** · destructive write, idempotent

Change the PRICE of many products at once, addressed by ARTICLE. Three modes: `absolute` (set the price outright), `percent` (move it by a signed percentage: -10 means 10% CHEAPER, not 'price becomes 10% of itself') and `amount` (move it by a signed sum in the store's currency). Optionally writes `price_old` too - the struck-through 'old price' - either as a value you give, or, with `setPriceOldFromCurrent:true`, by copying each product's CURRENT price there, which is how a sale is normally staged. DRY RUN BY DEFAULT and the preview is the point: it shows, per product, `was → becomes` with the delta in both currency and %, plus a summary (how many products, the summed shift). Read it before you set dryRun:false - the arithmetic is the only thing that catches -90 typed for -9, or a percentage meant as a fixed sum. GUARDS. (1) A price that would land at zero or below is REFUSED, always, with no override. (2) Touching more than 50 products requires `confirmProductCount` set to the exact number resolved - a bare 'true' would not have caught the article list being longer than you thought. (3) Any product moving more than 50% requires `confirmBigChange:true`, and the refusal names the offenders. (4) An article that does not resolve is refused rather than silently skipped (`allowMissing:true` to proceed without it) - a mistyped SKU quietly missing its own sale is the failure nobody notices. (5) `price_old` at or below the new price is reported as a warning (an 'old price' that is lower than the new one shows the storefront a discount running the wrong way). Thresholds may be LOWERED via `scaleThreshold` / `changeThresholdPercent`, never raised. VERIFICATION AND ROLLBACK. After writing, every touched article is re-read through the public catalog/export API - a different transport with different credentials from the admin session that wrote - and any product whose price is not what was asked for is listed explicitly; `saved:true` on its own is never the answer. The response also carries a `rollback` block: a complete, ready-to-run argument set for this same tool that puts every price back exactly as it was, pre-armed with whatever confirmations it will itself need. ⚠ A product with a non-zero `discount` shows the storefront a recalculated price, so the number set here is not the number on the shelf - those products are flagged. ⚠ Modifications (size/colour children) are ordinary rows here and are priced individually; setting the parent does NOT move its children. Not here: quantities and stock (horoshop_admin_product_stock_set), price levels / wholesale tiers (horoshop_price_levels_export), and everything else about a product (horoshop_catalog_import).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `articles` | string[] | no | Articles (SKUs) to reprice, matched EXACTLY. Use with `mode` + price/percent/amount. Mutually exclusive with `items`. |
| `items` | object[] | no | Per-product ABSOLUTE prices - the shape a `rollback` block comes back in, so restoring is a copy-paste. Mutually exclusive with `articles`/`mode`/`percent`/`amount`. |
| `mode` | "absolute" \| "percent" \| "amount" | no | absolute = set `price` to a fixed value · percent = move it by a signed % (-10 = 10% cheaper) · amount = move it by a signed sum. Required with `articles`; implied by `items`. |
| `price` | number | no | mode=absolute: the new price for every article listed. Must be > 0 and have at most 2 decimals. |
| `percent` | number | no | mode=percent: the signed change, e.g. -15 for 15% off, 10 for 10% dearer. |
| `amount` | number | no | mode=amount: the signed change in store currency, e.g. -50 or 120. |
| `priceOld` | number | no | Also write this struck-through old price to every article listed. 0 clears it. Mutually exclusive with setPriceOldFromCurrent. |
| `setPriceOldFromCurrent` | boolean | no | Also copy each product's CURRENT price into its price_old, so the storefront strikes through what it used to cost. The normal way to stage a sale; pointless (and flagged) if the new price is higher. |
| `roundTo` | number | no | Rounding step for COMPUTED prices only - 0.01 cents (default), 1 whole units, 10 nearest ten, 0.5, etc. Never applied in absolute mode: a price you stated is written exactly as stated. |
| `scaleThreshold` | integer | no | Lower the 50-product confirmation threshold for this call. Values above 50 are clamped - the guard cannot be loosened. |
| `changeThresholdPercent` | number | no | Lower the 50% per-product confirmation threshold for this call. Values above 50 are clamped. |
| `confirmProductCount` | integer | no | The number of products you believe this call touches. Required above the scale threshold, and whenever given it must match exactly - if it does not, the call is refused even under the threshold. |
| `confirmBigChange` | boolean | no | Acknowledge that some product's price moves more than the change threshold. The refusal lists which ones and by how much. |
| `allowMissing` | boolean | no | Proceed even though some articles did not resolve. Default false: an unresolved article refuses the whole call. |
| `dryRun` | boolean | no | Default true: resolve, compute and preview, write nothing. Set false to apply. |

### horoshop_admin_price_import_parse

**Parse a supplier price list from a URL (read-only) and propose a column mapping** · read-only

Step one of the price-list import: hand the store a URL, get back what the platform sees in that file - the column headers, the first rows, the total row count - plus an import TOKEN, the list of fields those columns can be mapped onto, and the four import policies with their allowed values. The store fetches the URL itself, so it must be reachable from the public internet (a localhost or intranet link fails), and it must be a real price list: xlsx / xls / csv / xml are what the parser accepts. A missing file answers `VALIDATION_ERROR` («Файл не найден: …»), an HTML page answers `EXCEPTION` («Невозможно обработать загруженный файл») - both arrive as HTTP 200, which is why the status is reported here explicitly. NOTHING IS WRITTEN by this tool: the file is parsed and parked against the token, and the catalog is untouched until horoshop_admin_price_import_run is called with confirm. The proposed mapping uses WHOLE-LABEL matching only - a column called «Цена» maps, a column called «Название» does not (the store has «Название (UA)», «Название (RU)» …), and nothing is guessed by prefix, because guessing here writes supplier prices into the wrong field. `targetSearch` filters the (200+) mappable fields by substring so you can find the exact label to use; without it only the proposal and a per-group count come back.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `allowLarge` | boolean | no | Default false. The answer is MEASURED before it is returned, and a payload over the size limit (default 100 KB, override with HOROSHOP_MAX_RESPONSE_BYTES) is REFUSED with its measured size and how to narrow it, instead of overflowing the conversation. Set true to get the whole thing anyway. |
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `url` | string | yes | Public URL of the price file (xlsx / xls / csv / xml). Fetched BY THE STORE, so it must be reachable from the internet. |
| `targetSearch` | string | no | Substring filter over the mappable field labels (e.g. "цена", "наличие") - use it to find the exact label/index for the mapping. |
| `sampleRows` | integer | no | How many data rows to show. Default 5. |

### horoshop_admin_price_import_run

**Dry-run or execute a supplier price-list import** · destructive write

Step two: give the same file URL you inspected with horoshop_admin_price_import_parse, state the column mapping and the four import policies, and either SHOW what would happen (default) or actually import. The file is parsed again here on purpose, so the plan printed and the plan executed come from ONE read of the file (the platform's `parseUploadedFile` cannot re-open a remote parse - measured - and a stale plan against a changed file would shift the positional mapping silently). The dry run reports the literal `columnSettings` array that would go on the wire, column by column with the field each one writes into, the number of data rows, the resolved policies, and every risk it can see. Nothing is sent to the platform in dry-run mode - not even `process/begin`. THE POLICIES ARE THE DANGEROUS PART, not the mapping. `exist:doNothing` means «update existing products» - that is what overwrites current prices in bulk. `missed` decides what happens to products that are ON THE SITE BUT NOT IN THE FILE, and every value other than `doNothing` (hide them, or force a presence status) rewrites products the file never mentioned: that needs its own `confirmCatalogWide:true` on top of `confirm:true`. `images:imageOverride` replaces galleries rather than adding to them. Executing needs `dryRun:false` AND `confirm:true`. There is no undo: the import writes through the platform's own engine, and this server cannot restore the previous prices. The run polls `process/importProducts` until the platform stops reporting work in progress, then returns the per-row log and the link to the platform's own XLSX report.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `url` | string | yes | Public URL of the price file - the same one horoshop_admin_price_import_parse showed you. Fetched by the store, and parsed again here. |
| `columns` | string \| integer \| null[] | no | One entry PER COLUMN of the file, in file order: a field label, a field index, or null to skip. Omit to use the parse tool's exact-label proposal (unmatched columns are skipped). |
| `settings` | object | no | Import policies by systemName: {new, exist, missed, images}. Omit any to take the platform's default (`doNothing` / `imageOverride`). |
| `supplierId` | integer \| string | no | Supplier to attribute the import to. Default: the store's first supplier. |
| `includeFirstRow` | boolean | no | Treat row 1 as DATA rather than a header. Default false. |
| `dryRun` | boolean | no | Default true - report the plan without touching the catalog. |
| `confirm` | boolean | no | Required together with dryRun:false. Prices and product fields are rewritten in bulk and cannot be restored by this server. |
| `confirmCatalogWide` | boolean | no | Additionally required when `missed` is not `doNothing`, i.e. when the run also rewrites products that are NOT in the file. |
| `maxSteps` | integer | no | Safety cap on import polling iterations. Default 60. |

### horoshop_admin_import_images

**Bulk-import local images by file name** · write

Upload LOCAL image files to the catalog the way the admin's «Імпорт зображень» screen does: each file is matched to a product BY ITS FILE NAME. Pass `files` (absolute paths) and/or `dir` (an absolute folder, non-recursive). NAMING CONVENTION: `<ARTICLE>.jpg` is the product's main photo; `<ARTICLE>@1.jpg`, `<ARTICLE>@2.jpg` … are further photos of the same product; `<ARTICLE>@gallery_common@1.jpg` goes to the gallery SHARED by all of that product's modifications. The article is the product's article EXACTLY as the catalog stores it - the match is CASE-SENSITIVE and literal (measured: `tee-warrior.png` finds nothing where `TEE-WARRIOR.png` matches, and a space is not a hyphen). A camera's `IMG_0431.jpg` matches nothing at all; rename before importing. THE MATCHING IS THE PLATFORM'S, NOT THIS TOOL'S. Every run first posts the bare file names to Horoshop's own matcher, which answers, per file, which product it lands on (`article`, `product` title, the internal record id) or that there is no product with that article. So the DRY RUN - the default - is a real answer, not a local guess: it lists `matched` (file → article → product, and which gallery slot), `unmatched` (no such article - these files would be silently ignored by the admin screen) and `rejected` (wrong extension, over 5 MB, not actually an image, duplicate name, over the batch ceilings). Running the dry run before touching the admin screen by hand is worth it on its own: it tells you which photos will find no product BEFORE you spend an hour dragging 400 files into a browser. ⚠ THE ADMIN SCREEN'S DEFAULT DELETES GALLERIES - THIS TOOL'S DOES NOT. That screen's «Сохранить уже имеющиеся фото в галерее» checkbox ships UNCHECKED, and it sends `cleanGallery:true`, which REMOVES every existing photo of every product it touches before attaching the new ones. Here the safe direction is the default: `keepExistingGallery` is TRUE, new photos are added alongside the existing ones. Pass keepExistingGallery:false only when you deliberately want each touched product's gallery replaced - that deletion has no undo, and the photos it removes are not recoverable from this server. LIMITS (the platform's, enforced before anything is sent): jpg/jpeg/png/gif only · 5 MB per file · 500 files per run · 256 MB in total. Files that break a limit are reported in `rejected` and the rest still run. WHAT IT PROVES WHEN IT SAYS IT WORKED: after assigning, it re-reads the touched articles through the PUBLIC catalog export (a different channel from the one that wrote) and reports each product's image count before and after, plus an HTTP fetch of one newly stored image showing it really is served as an image. `verified:false` with the counts unchanged means the bind did not take, whatever the upload said. NO UNDO, AND NO PER-IMAGE DELETE ANYWHERE IN THIS SERVER: Horoshop exposes no route that removes ONE photo from a product's gallery (measured - `catalog_import` with `images.links:[]` reports OK and changes nothing). An added photo can only be removed by a human in the admin, and a gallery wiped by keepExistingGallery:false is gone. Treat every non-dry run as one-way. ANSWER SHAPE - the same on every path, including the ones where nothing happens: `counts{matched,uploaded,assigned,unmatched,rejected}`, `matched[]` / `unmatched[]` / `rejected[]`, and on a real run `verified`, `perArticle[{article,imagesBefore,imagesAfter}]`, `assetCheck` and `files[]`. There is no second shape to check for the empty case. Related but different: horoshop_catalog_process_images attaches files ALREADY uploaded to the store's FTP; this tool sends local files from this machine. horoshop_catalog_import attaches images by URL.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `files` | string[] | no | ABSOLUTE paths of the image files to import. Combine with `dir` or use either alone. |
| `dir` | string | no | ABSOLUTE path of a folder whose image files are imported (non-recursive; sub-folders are ignored). |
| `keepExistingGallery` | boolean | no | Default TRUE - new photos are ADDED and the product's existing gallery is preserved. FALSE sends the admin screen's own `cleanGallery`, which DELETES every existing photo of every touched product first. Irreversible. |
| `dryRun` | boolean | no | Default true: match the file names against the catalog and report, without uploading anything. |

## Admin panel: characteristics and dictionaries

| Tool | Access | Summary |
|---|---|---|
| [`horoshop_admin_dictionaries`](#horoshop_admin_dictionaries) | read-only | List attribute dictionaries |
| [`horoshop_admin_dictionary_create`](#horoshop_admin_dictionary_create) | write | Create a new attribute dictionary |
| [`horoshop_admin_dictionary_rename`](#horoshop_admin_dictionary_rename) | write, idempotent | Rename an attribute dictionary |
| [`horoshop_admin_dictionary_delete`](#horoshop_admin_dictionary_delete) | destructive write, idempotent | Delete an attribute dictionary |
| [`horoshop_admin_dictionary_values`](#horoshop_admin_dictionary_values) | read-only | List dictionary values |
| [`horoshop_admin_dictionary_value_delete`](#horoshop_admin_dictionary_value_delete) | destructive write, idempotent | Delete a dictionary value |
| [`horoshop_admin_dictionary_value_set`](#horoshop_admin_dictionary_value_set) | write, idempotent | Translate / rename a dictionary value |
| [`horoshop_admin_dictionary_add_value`](#horoshop_admin_dictionary_add_value) | write, idempotent | Create a dictionary value (via a product's characteristic) |
| [`horoshop_admin_product_templates`](#horoshop_admin_product_templates) | read-only | List product templates |
| [`horoshop_admin_product_template_get`](#horoshop_admin_product_template_get) | read-only | Read a product template |
| [`horoshop_admin_product_template_set`](#horoshop_admin_product_template_set) | write, idempotent | Edit a product template |
| [`horoshop_admin_template_schema`](#horoshop_admin_template_schema) | read-only | Read a category's characteristic schema |
| [`horoshop_admin_template_param_add`](#horoshop_admin_template_param_add) | write, idempotent | Add a characteristic to a category |
| [`horoshop_admin_template_param_books`](#horoshop_admin_template_param_books) | read-only | List dictionaries a characteristic can use |
| [`horoshop_admin_template_param_delete`](#horoshop_admin_template_param_delete) | destructive write | Delete a characteristic from a category |

### horoshop_admin_dictionaries

**List attribute dictionaries** · read-only

List the store's attribute-value dictionaries (Справочники / books) - id and name (e.g. Матеріал, Единицы измерения, Розмір футболки). Use the id with horoshop_admin_dictionary_values (as `book` or `id`, both accepted).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `allowLarge` | boolean | no | Default false. The answer is MEASURED before it is returned, and a payload over the size limit (default 100 KB, override with HOROSHOP_MAX_RESPONSE_BYTES) is REFUSED with its measured size and how to narrow it, instead of overflowing the conversation. Set true to get the whole thing anyway. |
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |

### horoshop_admin_dictionary_create

**Create a new attribute dictionary** · write

Create a NEW attribute dictionary (справочник / book) - the value list a product characteristic points at. This is the container, not its values: fill it afterwards with horoshop_admin_dictionary_value_set / _add_value. The name is validated by the admin BEFORE anything is written (empty or colliding names are refused), and the created dictionary is confirmed by re-reading the dictionaries list, not by trusting the answer. Reversible: horoshop_admin_dictionary_delete removes it again. DRY RUN BY DEFAULT.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `title` | string | yes | Name of the new dictionary, e.g. «Тип тканини». Shown in the admin's Справочники list. |
| `dryRun` | boolean | no | Default true: validate the name without creating. Set false to create. |

### horoshop_admin_dictionary_rename

**Rename an attribute dictionary** · write, idempotent

Rename an existing dictionary (справочник / book). Renames the CONTAINER only - its values keep their own titles (those are horoshop_admin_dictionary_value_set). The platform's saver answers with a bare redirect and says nothing, so the new name is confirmed by re-reading the list. DRY RUN BY DEFAULT.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `book` | integer \| string | no | Dictionary (book) id - as returned by horoshop_admin_dictionaries. Alias: `id`. |
| `id` | integer \| string | no | Alias of `book` (horoshop_admin_dictionaries returns the field as `id`, so both are accepted). |
| `title` | string | yes | The new name. |
| `dryRun` | boolean | no | Default true: preview without writing. Set false to apply. |

### horoshop_admin_dictionary_delete

**Delete an attribute dictionary** · destructive write, idempotent

Delete a whole dictionary (справочник / book) - the container AND every value in it. WHY THIS IS A SEPARATE TOOL AND NOT horoshop_admin_record_delete: the generic deleter refuses handler 207 (it is a hub), yet the grid's own bulk-remove does work on it - measured on the test store after twelve other candidate routes did nothing. DANGEROUS ON A LIVE STORE: a dictionary that product characteristics point at takes its values with it. Delete what you created, not what the store runs on. DRY RUN BY DEFAULT and `confirm` is required on top.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `book` | integer \| string | no | Dictionary (book) id - as returned by horoshop_admin_dictionaries. Alias: `id`. |
| `id` | integer \| string | no | Alias of `book` (horoshop_admin_dictionaries returns the field as `id`, so both are accepted). |
| `confirm` | boolean | no | Must be true together with dryRun:false. Deleting a dictionary cannot be undone. |
| `dryRun` | boolean | no | Default true: show what would go without deleting. Set false to delete. |

### horoshop_admin_dictionary_values

**List dictionary values** · read-only

List the values of an attribute dictionary by id (from horoshop_admin_dictionaries) - value id + text. Read-only, headless. The id may be passed as `book` or as `id` (that tool returns it as `id`); both work. The text shown here is the ADMIN's display language only. To see or change a value's other languages use horoshop_admin_dictionary_value_set (dryRun) - that is where the ru/ua split of «Євро» or «Білий» lives.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `allowLarge` | boolean | no | Default false. The answer is MEASURED before it is returned, and a payload over the size limit (default 100 KB, override with HOROSHOP_MAX_RESPONSE_BYTES) is REFUSED with its measured size and how to narrow it, instead of overflowing the conversation. Set true to get the whole thing anyway. |
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `book` | integer \| string | no | Dictionary (book) id - as returned by horoshop_admin_dictionaries. Alias: `id`. |
| `id` | integer \| string | no | Alias of `book` (horoshop_admin_dictionaries returns the field as `id`, so both are accepted). |

### horoshop_admin_dictionary_value_delete

**Delete a dictionary value** · destructive write, idempotent

Delete ONE value from an attribute dictionary - the tool for clearing a typo or a test value out of Матеріал / Розмір / Колір. Identify it by dictionary (`book`/`id`) + `valueId` from horoshop_admin_dictionary_values. IN-USE VALUES ARE REFUSED, not force-deleted: the admin renders no trash icon for a value products still carry (`deletable:false` in the listing), and this tool honours that instead of overriding it - the fix there is to change those products' characteristic first. DRY RUN BY DEFAULT - but note the order of checks: the in-use guard runs BEFORE the preview, so a dry run on a value products still carry ERRORS instead of answering "deletable:false". Asking "can I delete this?" safely means reading `deletable` from horoshop_admin_dictionary_values first. A dry run that returns normally is therefore always deletable:true. Pass dryRun:false to remove it, after which the dictionary is re-read and the answer confirms it is gone. Deletion is permanent. A VALUE THAT IS ALREADY GONE IS NOT AN ERROR: it answers `{deleted:false, alreadyGone:true}` and sends nothing, so a repeat run or an idempotent cleanup can call this twice. That is deliberately NOT the same as the in-use refusal above, which still throws - "nothing left to do" and "not allowed to do it" are opposite outcomes and must never share a shape. Mechanism (reverse-engineered): the books screen is not a datagrid - its trash icon is a GET to savers/books.php?id=<value>&delvalue=<book>.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `book` | integer \| string | no | Dictionary (book) id - as returned by horoshop_admin_dictionaries. Alias: `id`. |
| `id` | integer \| string | no | Alias of `book` (horoshop_admin_dictionaries returns the field as `id`, so both are accepted). |
| `valueId` | integer \| string | yes | Value id inside that dictionary (from horoshop_admin_dictionary_values). |
| `dryRun` | boolean | no | Default true: preview without deleting. Set false to delete. |

### horoshop_admin_dictionary_value_set

**Translate / rename a dictionary value** · write, idempotent

Set an existing dictionary value's text PER LANGUAGE - the tool that finishes a multilingual storefront. Size and colour labels («2-х спальний», «Євро», «Сімейний», «Білий»…) come from these dictionaries, so until they are translated a ru version keeps showing the first language's words no matter how well the catalog itself is translated. Identify the value by dictionary (`book`/`id`) + `valueId` (from horoshop_admin_dictionary_values), and pass `titles` as {ru, ua, en, pl, ro} - only the languages you list change, the rest are re-sent exactly as stored (every language must stay non-empty, which the admin enforces). A LANGUAGE THIS STORE'S EDITOR DOES NOT RENDER IS SKIPPED, NOT WRITTEN - and the call still succeeds. It shows up in `skipped`, and if every language you asked for was skipped the answer is the "nothing to change" shape with NO `saved` key, whose note covers two opposite cases at once ("already match, or none of them apply"). Judge the result by `changes[].persisted` and `skipped`, never by the absence of an error. DRY RUN BY DEFAULT: it reads the value's current per-language titles and shows the before/after - the only way to see the per-language text of ANY value, including ones no product uses. (For a value products already carry, horoshop_catalog_export shows the same {ua,ru} split inside its characteristic refs.) After a real save it re-reads and verifies. Mechanism (reverse-engineered, not documented): the admin's own popup editor - lookup.php loadBookValueForm to read, then saveBookValue to validate and savers/books.php to persist. Renaming is not admin-panel-only, contrary to what horoshop_admin_dictionary_add_value used to claim.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `book` | integer \| string | no | Dictionary (book) id - as returned by horoshop_admin_dictionaries. Alias: `id`. |
| `id` | integer \| string | no | Alias of `book` (horoshop_admin_dictionaries returns the field as `id`, so both are accepted). |
| `valueId` | integer \| string | yes | Value id inside that dictionary (from horoshop_admin_dictionary_values). |
| `titles` | object | yes | New text per language, e.g. {"ru":"Евро","ua":"Євро"}. Languages you omit keep their stored text. |
| `dryRun` | boolean | no | Default true: show the value's current per-language titles and the planned change without saving. Set false to persist. |

### horoshop_admin_dictionary_add_value

**Create a dictionary value (via a product's characteristic)** · write, idempotent

CREATE a new value in an attribute dictionary. Read the mechanism before using it: this tool writes to a PRODUCT, not to the dictionary. Horoshop auto-creates a dictionary value the moment a product carries it as a characteristic, and that is the reliable headless way to add one - so `article` is a product that will actually receive the value, and the value then exists in the shared dictionary for every other product to reuse. It does NOT edit a dictionary: it cannot rename, translate or delete an existing value. For translating/renaming use horoshop_admin_dictionary_value_set. A TYPO IS NOT A ONE-STEP UNDO. Because the value is created BY PUTTING IT ON A PRODUCT, it is in use from the moment it exists - and horoshop_admin_dictionary_value_delete refuses in-use values, exactly like the admin does. Cleaning up a mistyped value is therefore two steps: first change that product's characteristic (horoshop_catalog_import) so nothing carries the value, then delete it. Until you do, the typo sits in a dictionary every other product in the store picks from. Check the spelling in the dry run. `characteristic` is the characteristic's API field name (from horoshop_catalog_export, e.g. "materal"); `value` is the new text. IMPORTANT: the characteristic must exist in THAT product's category template - Horoshop silently drops an unknown characteristic and still answers "Товар обновлен", so pick an article whose export already lists the field. This tool re-reads the product afterwards and reports saved:false if the value did not land. DRY RUN BY DEFAULT.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `characteristic` | string | yes | Characteristic API field name (e.g. "materal") - see horoshop_catalog_export. |
| `value` | string | yes | New dictionary value text to add. |
| `article` | string | yes | Article of a product that will carry the characteristic (the value is created in the shared dictionary as a side effect). |
| `dryRun` | boolean | no | Default true: preview without importing. Set false to apply. |

### horoshop_admin_product_templates

**List product templates** · read-only

List product/data templates (Шаблоны товаров) - the characteristic schemas categories use (id + name, e.g. "КАТАЛОГ: Товар"). Use an id with the get/set tools.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `allowLarge` | boolean | no | Default false. The answer is MEASURED before it is returned, and a payload over the size limit (default 100 KB, override with HOROSHOP_MAX_RESPONSE_BYTES) is REFUSED with its measured size and how to narrow it, instead of overflowing the conversation. Set true to get the whole thing anyway. |
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |

### horoshop_admin_product_template_get

**Read a product template** · read-only

Read a product template by id: its title and internal name/table. Read-only. Use before horoshop_admin_product_template_set. LIMITATION: this returns only the template's identity (6 meta fields) - the characteristic schema itself (which fields a category's products get) is NOT exposed by this editor, so you cannot see or change a category's characteristic list from here.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `allowLarge` | boolean | no | Default false. The answer is MEASURED before it is returned, and a payload over the size limit (default 100 KB, override with HOROSHOP_MAX_RESPONSE_BYTES) is REFUSED with its measured size and how to narrow it, instead of overflowing the conversation. Set true to get the whole thing anyway. |
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `id` | integer \| string | yes | Template id (from horoshop_admin_product_templates). |

### horoshop_admin_product_template_set

**Edit a product template** · write, idempotent

Edit a product template's fields by id. Pass `set` as a map of exact form field names → values (get them from horoshop_admin_product_template_get) - most commonly {"handler[title]":"New name"}. Read-modify-write: the rest of the schema is preserved. DRY RUN BY DEFAULT. Editing the characteristic schema (field arrays) is advanced - change what you understand.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `id` | integer \| string | yes | Template id. |
| `set` | object | yes | Map of form field name → new value (e.g. {"handler[title]":"…"}). |
| `dryRun` | boolean | no | Default true: preview without saving. Set false to save. |

### horoshop_admin_template_schema

**Read a category's characteristic schema** · read-only

Read which characteristics a data template defines - grouped as the admin shows them (e.g. "Модификации" vs "Характеристики"), each with its param id, label, API field name, type, and the dictionary it draws values from. THIS IS THE FIELD LIST catalog_import/export accepts for products in that category: a name that is not here is silently dropped by the API. Get template ids from horoshop_admin_product_templates, or from a category via horoshop_admin_page_get (template.id).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `allowLarge` | boolean | no | Default false. The answer is MEASURED before it is returned, and a payload over the size limit (default 100 KB, override with HOROSHOP_MAX_RESPONSE_BYTES) is REFUSED with its measured size and how to narrow it, instead of overflowing the conversation. Set true to get the whole thing anyway. |
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `template` | integer \| string | yes | Data template id (e.g. 461). See horoshop_admin_product_templates. |

### horoshop_admin_template_param_add

**Add a characteristic to a category** · write, idempotent

Add (or edit) one characteristic on a data template - this is how you make a new field exist for a category's products so catalog_import will accept it. `group` is a group id from horoshop_admin_template_schema. For a dictionary-backed dropdown pass type "select" plus `book` - the dictionary id (382) or its `book_382` form; list the choices with horoshop_admin_template_param_books. Passing a bare number as the raw table value binds the field to a TEMPLATE instead of a dictionary and the values then never land, so use `book`. DRY RUN BY DEFAULT. Editing an existing field: pass its `paramId` - but read the next sentence first, because "edit" here is not what it sounds like. ⚠ EDITING IS A FULL OVERWRITE, NOT A READ-MODIFY-WRITE. Unlike its neighbours, this tool does not read the characteristic's current values before saving: it rebuilds the whole param record from your arguments and sends every attribute explicitly, so the server has nothing to merge. Five attributes are always sent as constants - `localize:"0"`, `editable:"1"`, `inputlength:"255"`, `mask:""`, `comment:""`. Change only a `title` or a `book` on an existing paramId and you silently also turn OFF multilingual values (localize 1→0), UNLOCK a field that was protected from editing (editable 0→1) and ERASE a custom validation mask and comment. No error, no warning. Check the current state with horoshop_admin_template_schema before editing, and expect to restore those attributes by hand afterwards. NO PER-LANGUAGE TITLE HERE: `title` is a single, language-less string - the admin's own param editor renders exactly one title input and the saveParam contract has no title[lang] variant. So a characteristic whose HEADING must read differently in another language («Розмір постільної білизни» → Russian) is not translated on the template; its label is translated in the interface-translation table with horoshop_admin_interface_translation_set (key = the heading text, one row per language).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `template` | integer \| string | yes | Data template id to add the field to. |
| `group` | integer \| string | yes | Group id within the template (from horoshop_admin_template_schema). |
| `title` | string | yes | Human label, e.g. "Матеріал". |
| `name` | string | yes | API field name for catalog_import/export, e.g. "materal" (latin, digits, underscore). |
| `type` | "input" \| "select" \| "checkbox" \| "number" \| "textarea" \| "htmlarea" | yes | Field type. "select" needs `book`. |
| `book` | integer \| string | no | Dictionary for a select: id (382) or "book_382". See horoshop_admin_template_param_books. |
| `multi` | boolean | no | Allow several values (select only). |
| `inGrid` | boolean | no | Show the field as a column in the admin product grid. |
| `paramId` | integer \| string | no | Existing param id to edit; omit to create a new field. |
| `dryRun` | boolean | no | Default true: preview without writing. Set false to apply. |

### horoshop_admin_template_param_books

**List dictionaries a characteristic can use** · read-only

List the dictionaries a select-type characteristic can bind to, in the exact `book_<id>` form the admin expects, with their names. Use before horoshop_admin_template_param_add.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `allowLarge` | boolean | no | Default false. The answer is MEASURED before it is returned, and a payload over the size limit (default 100 KB, override with HOROSHOP_MAX_RESPONSE_BYTES) is REFUSED with its measured size and how to narrow it, instead of overflowing the conversation. Set true to get the whole thing anyway. |
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `template` | integer \| string | yes | Data template id (context for the param form). |

### horoshop_admin_template_param_delete

**Delete a characteristic from a category** · destructive write

Remove a characteristic from a data template by its param id (from horoshop_admin_template_schema). DESTRUCTIVE: products in that category lose the field and its stored values. DRY RUN BY DEFAULT. A param that is not on the template answers `{deleted:false, alreadyGone:true}` rather than erroring - a repeat delete is a no-op success, and `deleted` is always present so it can be read instead of the note.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `template` | integer \| string | yes | Data template the field belongs to (used to verify). |
| `paramId` | integer \| string | yes | Param id to delete. |
| `dryRun` | boolean | no | Default true: preview without deleting. Set false to delete. |

## Admin panel: categories, pages, blog, banners, filters

| Tool | Access | Summary |
|---|---|---|
| [`horoshop_admin_page_get`](#horoshop_admin_page_get) | read-only | Read page/category (admin) |
| [`horoshop_admin_page_seo_set`](#horoshop_admin_page_seo_set) | write, idempotent | Set page/category SEO (admin) |
| [`horoshop_admin_banner_create`](#horoshop_admin_banner_create) | write | Create a banner with its image (homepage / above-header / contacts lines) |
| [`horoshop_admin_blog_post_create`](#horoshop_admin_blog_post_create) | write | Create a blog / news article (with optional cover) |
| [`horoshop_admin_blog_post_update`](#horoshop_admin_blog_post_update) | write, idempotent | Update a blog / news article (text, SEO, cover) |
| [`horoshop_admin_page_create`](#horoshop_admin_page_create) | write | Create an info/text page that actually opens on the storefront |
| [`horoshop_admin_category_create`](#horoshop_admin_category_create) | write | Create a catalog category (SEO + SEO-text + cover) in one call |
| [`horoshop_admin_category_update`](#horoshop_admin_category_update) | write, idempotent | Update a catalog category (title, SEO, SEO-text, flags, cover) |
| [`horoshop_admin_indexed_filter_create`](#horoshop_admin_indexed_filter_create) | write | Create an indexed (SEO) filter with several conditions |
| [`horoshop_admin_indexed_filter_update`](#horoshop_admin_indexed_filter_update) | write, idempotent | Update an indexed (SEO) filter (title, page, conditions) |
| [`horoshop_admin_filter_preset_create`](#horoshop_admin_filter_preset_create) | write | Create an SEO filter preset (custom slug + SEO block) in one call |
| [`horoshop_admin_filter_preset_update`](#horoshop_admin_filter_preset_update) | write | Update an SEO filter preset (page, params, slug, SEO block) |

### horoshop_admin_page_get

**Read page/category (admin)** · read-only

Read a site page or catalog category from the admin panel into structured JSON: slug, template, per-language title/H1/SEO title/keywords/description and body text. Covers fields the public /api/ exposes as read-only or not at all. `id` is the page/category id (from horoshop_pages_export or the admin URL). This is the read half of horoshop_admin_page_seo_set. DISABLED-LANGUAGE FLAG: `languageStatus` reports each language's on/off state and `disabledLanguages` lists the OFF ones. A disabled language's title/text is usually Horoshop platform DEMO content ("This is demo store", "Clothing and Shoes"), not real content - when a disabled language still carries text, a `note` warns you so you do not mistake the demo default for working data.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `allowLarge` | boolean | no | Default false. The answer is MEASURED before it is returned, and a payload over the size limit (default 100 KB, override with HOROSHOP_MAX_RESPONSE_BYTES) is REFUSED with its measured size and how to narrow it, instead of overflowing the conversation. Set true to get the whole thing anyway. |
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `id` | integer \| string | yes | Page/category id to read (e.g. 927). Use "addnew" for a blank create form. |
| `parent` | integer | no | Parent id (needed only for create/context). |

### horoshop_admin_page_seo_set

**Set page/category SEO (admin)** · write, idempotent

Set SEO and content fields on a site page or catalog category via the admin panel - the multilingual title, H1, SEO title, meta keywords, meta description, and body text that the public /api/ cannot write. Read-modify-write: untouched fields are preserved. Languages: ua, ru, en, pl, ro. DRY RUN BY DEFAULT - pass dryRun:false to actually save; after saving it re-reads the record and reports the verified values. WHAT "VERIFIED" MEANS HERE: the field was read back out of the ADMIN FORM. That is proof the value is stored - it is NOT proof the page exists for a shopper. A page created with record_save entity=pages can answer 404 on the storefront in every language while this tool reports saved:true and persisted:true on every field (seen live). If the page is new, fetch its URL yourself, or create it with horoshop_admin_page_create / horoshop_admin_category_create, which resolve the URL node so the address actually exists. ADD TEXT WITHOUT RESENDING IT: `append` / `prepend` take the same per-language shape as `langs` but splice onto the STORED text instead of replacing it - the way to add one block to a 20 KB body without sending the 20 KB back (and without risking a mangled copy of live content). Same cell in `langs` AND `append`/`prepend` is an error, not a silent winner. ANSWER SIZE: a persisted long value comes back as {length, tail, sha256}, not echoed as from+to+now; a field that did NOT persist still reports expected/actual previews and the first differing offset. verbose:true restores the full diff. TEMPLATE TOKENS ARE PROTECTED: if the stored value contains a storefront placeholder ({DISCOUNT_PERCENT}, {COUNTDOWN_INFO}, {title}, {price}…) and your new value does not, dryRun reports `placeholderWarnings` and a real write is REFUSED until you pass allowPlaceholderLoss:true - overwriting such a value with a constant freezes the substitution for every product/page that uses it, with nothing erroring and nothing looking broken. Keeping the token (the normal case when translating) passes silently. BULK PAYLOAD FROM DISK: a page body is routinely 20+ KB and will not fit in a tool argument. Do NOT fall back to a hand-rolled getEditForm+save for that - pass `payloadFile`, an ABSOLUTE path to a JSON file holding the same arguments (e.g. {"langs":{"ru":{"text":"<22 KB of HTML>"}}}). It is mutually exclusive with the inline `langs` and behaves identically, dryRun included.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `id` | integer \| string | yes | Page/category id to edit (e.g. 927). |
| `parent` | integer | no | Parent id (context; usually optional for edits). |
| `langs` | object | no | Per-language patch that REPLACES the value. Each language (ua/ru/en/pl/ro) may set any of: title, h1, seo_title, seo_keywords, seo_description, text. Omitted fields are left unchanged. Required unless `append`/`prepend` or `payloadFile` carries the content. |
| `append` | any | no | APPEND to the end of the STORED value instead of replacing it: the same per-language shape as `langs` (e.g. {"ua":{"text":"<h3>Доставка</h3>…"}}), whose values are glued onto the END of the stored text. The tool already read-modify-writes, so it reads the current value, glues your delta onto it verbatim (no separator, no trimming) and writes the result - you never have to resend the existing text (a 4 KB seo_text stays where it is, untouched and unrecoded). Mutually exclusive with the replacing field for the SAME field (both = error, never a silent winner). Works with dryRun: the preview shows length before → after plus a head/tail window of the result. |
| `prepend` | any | no | PREPEND to the START of the STORED value instead of replacing it: the same per-language shape as `langs`. Same mechanics and the same mutual exclusion as `append`. |
| `verbose` | boolean | no | Default false: long field values (>200 chars, e.g. a 4 KB seo_text) are summarised in the answer - on success as {length, tail, sha256} instead of the same string echoed as from+to+now, on failure as expected/actual previews plus the first differing offset. Set true to get the full from→to→now diff for every field (heavy: ~3× the field size per field). |
| `allowPlaceholderLoss` | boolean | no | Default false. A write whose NEW value drops a storefront template token that the STORED value had ({DISCOUNT_PERCENT}, {PRICE}, {title}…) is REFUSED, because that silently turns a per-product substitution into frozen text. Set true only when losing the token is intended. |
| `payloadFile` | string | no | ABSOLUTE path to a JSON file holding this tool's content arguments (same key names, e.g. {"text":"<15 KB of HTML>","ru":{"text":"…"}}). Use it when the content is too large for a tool argument - article bodies (15–19 KB), page bodies (22 KB), category SEO text (16 KB). MUTUALLY EXCLUSIVE with the inline content fields: a key passed both ways is an error. store/dryRun/payloadFile stay inline. Works with dryRun (default true) exactly like horoshop_admin_page_seo_set inline. |
| `dryRun` | boolean | no | Default true: preview the exact field changes without saving. Set false to persist. |

### horoshop_admin_banner_create

**Create a banner with its image (homepage / above-header / contacts lines)** · write

Create a Horoshop banner (entity 394) AND upload its picture in one multipart save.php POST - the image is a real file part `settings[<lang>][image]`, there is no separate upload step. Pick `section` (placement: banner_line_1/2/3, top, banner_line_top/bottom) and `template` (kind: image, image_3x, image_wide, product…); not every template/section combo exists in a given theme - the tool reads the widget spec for the combo (always against page "1") to find the image field + its target size, and fails clearly if the theme does not offer it. Provide the image as `url` (fetched server-side), `base64`, or a data: URI. `title` names the banner; `page` = the page id to show it on ("1" = Головна, default; "" = all pages, or any category/page id, e.g. 1082). Optional: `alt`, `imageTitle`, `borderColor` (#hex), `link` (own URL), `enabled` (default true). Banners are shared by desktop AND mobile - there is no image-template way to target only mobile. DRY RUN BY DEFAULT - pass dryRun:false to actually create.

SECTION MUST BE DRAWN, NOT JUST ENABLED. A banner line renders only where a PAGE LAYOUT places it (`<page>.sections.*.blocks` = `banners.<section>` in the design JSON); the `enabled` flag on the section is not the deciding one. Measured live: a theme defined and enabled banner_line_1/2/3 but its homepage layout placed only lines 1 and 2 - a banner created in line 3 stored perfectly (section, page, image, enabled) and appeared on no page, while the same banner in line 1 was on the homepage at once. So the layout is checked BEFORE creating: an unplaced section is refused with the list of sections this theme does render (override with allowInvisibleSection:true).

VERIFIED ON THE STOREFRONT, not just in the admin: after creating, the page the banner is bound to is fetched as a buyer and the answer reports `storefrontVisible` - true only when the stored image is actually in that page's HTML. `sectionPersisted` separately confirms the section came back as the one you asked for.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `section` | "banner_line_1" \| "banner_line_2" \| "banner_line_3" \| "top" \| "banner_line_top" \| "banner_line_bottom" | yes | Placement. image → banner_line_1/3, banner_line_top/bottom; image_3x → banner_line_2. Not every template/section combo exists in every theme; the tool validates the combo against its widget spec. |
| `template` | "image" \| "image_2x" \| "image_3x" \| "image_big" \| "image_column" \| "image_cover" \| "image_small" \| "image_wide" \| "image_wide2x" \| "image_wide3x" \| "image_wideblock" \| "product" \| "product_big" \| "product_column" \| "product_cover" \| "product_small" \| "product_wide" | yes | Banner kind. Use `image` for a plain picture banner (e.g. a homepage background). |
| `title` | string | yes | Banner name (admin label), set on the primary language. |
| `url` | string | no | Image URL to fetch server-side (or a data: URI). |
| `base64` | string | no | Image bytes as base64 (or a data: URI). |
| `page` | string \| number | no | Page id to show the banner on. "1"=Головна (default). "" = all pages. |
| `lang` | integer | no | Language index for the image/title. Default: the store's primary language. |
| `alt` | string | no | Alt text for the image (settings image_alt). |
| `imageTitle` | string | no | Title attribute for the image (settings image_title). |
| `borderColor` | string | no | Border colour #hex (settings border_color, a global param). |
| `link` | string | no | Own link URL the banner points to (settings link → own link). |
| `enabled` | boolean | no | Whether the banner is active. Default true. |
| `allowInvisibleSection` | boolean | no | Create even when the theme places no page layout on this section (the banner would be stored but drawn nowhere). Default false - the call is refused with the list of sections this theme does render. |
| `filename` | string | no | Override the sent filename (default banner.<ext>). |
| `contentType` | string | no | Override the sent MIME (default detected from bytes). |
| `dryRun` | boolean | no | Default true: preview without creating. Set false to apply. |

### horoshop_admin_blog_post_create

**Create a blog / news article (with optional cover)** · write

Create a blog/news article (handler 172, h_news) in the store's «Блог» rubric. The rubric (which section the article lists under - its h_news.parent) is set explicitly and defaults to the «Блог» node discovered by title (per-store; not a hardcoded id), so a new post no longer lands in whatever section id happens to be the platform default. Pass `rubric` to file it elsewhere. Writes title/announce/body/H1 and full SEO (title/keywords/description) per language - top-level fields are Ukrainian (primary), an optional `ru` object adds Russian - plus slug, publish date, and the act/promo/disallow-comments flags. A `cover` (recommended 1200×400) and/or `image` (1200×800) are uploaded as real files through the same multipart save.php the admin uses; the article is created first, then the cover is attached to the new record and VERIFIED by re-reading it (names[cover][value] must become a /content/… path). Provide each image as `url` (fetched server-side), `base64`, or a data: URI. Returns the new article id and confirms it landed in the chosen rubric. DRY RUN BY DEFAULT - pass dryRun:false to actually create. To remove a test article afterwards use horoshop_admin_record_delete entity=blog_posts (parent auto-resolves). ⚠ NOT FULLY ATOMIC, AND THE ARTICLE IS LIVE THE MOMENT IT EXISTS. `active` defaults to TRUE, so the record is created PUBLISHED before the cover is attached. If the image then fails to resolve (a 404 on the URL is enough) this call throws and all you see is the fetch error - while a published, cover-less article is already sitting on /blog/. Retrying blind gives you two of them in front of readers. If you are creating from an image URL you do not fully trust, pass `active:false` and publish after the cover verified; if it did throw, check horoshop_admin_list entity=blog_posts parent=<rubric> before you retry. IMAGE FORMAT: WEBP is refused up front (by URL extension, data-URI prefix or content-type) - Horoshop registers a webp path and then serves a broken file, which is worse than a clear refusal. Send JPEG or PNG. BULK PAYLOAD FROM DISK: article bodies are 15–19 KB and do not fit in a tool argument. Pass `payloadFile` - an ABSOLUTE path to a JSON file carrying the same argument names (e.g. {"title":"…","text":"<18 KB of HTML>","ru":{"text":"…"}}) - instead of hand-rolling a raw getEditForm+save, which is what relocated 10 live articles into the wrong rubric once. Mutually exclusive with the inline content fields; dryRun unchanged.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `title` | string | yes | Article title (Ukrainian / primary language). Required. |
| `announce` | string | no | Short announce / preview text (UA). |
| `text` | string | no | Article body HTML (UA). |
| `h1` | string | no | H1 heading (UA); defaults to the title on the storefront if empty. |
| `seoTitle` | string | no | SEO <title> (UA). |
| `seoKeywords` | string | no | SEO keywords (UA). |
| `seoDescription` | string | no | SEO meta description (UA). |
| `ru` | object | no | Russian (i18n index 1) block: title/announce/text/h1/seoTitle/seoKeywords/seoDescription. |
| `slug` | string | no | URL slug (names[name][slug]). Blog URLs are id-based, so this is optional. |
| `date` | string | no | Publish date YYYY-MM-DD (names[date]); defaults to the form's prefilled today. |
| `active` | boolean | no | Publish the article (names[act]). Default: published (true). |
| `promo` | boolean | no | Promo flag (names[promo]). |
| `disallowComments` | boolean | no | Disable comments (names[disallow_comments]). |
| `cover` | object | no | Cover image (names[cover][file]) - recommended 1200×400. Uploaded via direct multipart. |
| `image` | any | no | Inline/preview image (names[img][file]) - recommended 1200×800, min 200×200. |
| `rubric` | integer | no | Rubric / listing node id - the real h_news.parent the article lists under (its section: «Блог», a news rubric…). Discover ids with horoshop_admin_list pages. Default: the store's «Блог» node, found by title (per-store; do NOT assume a fixed id). |
| `parent` | integer | no | Deprecated alias of `rubric` (kept for back-compat). |
| `payloadFile` | string | no | ABSOLUTE path to a JSON file holding this tool's content arguments (same key names, e.g. {"text":"<15 KB of HTML>","ru":{"text":"…"}}). Use it when the content is too large for a tool argument - article bodies (15–19 KB), page bodies (22 KB), category SEO text (16 KB). MUTUALLY EXCLUSIVE with the inline content fields: a key passed both ways is an error. store/dryRun/payloadFile stay inline. Works with dryRun (default true) exactly like horoshop_admin_blog_post_create inline. |
| `dryRun` | boolean | no | Default true: preview the plan without creating. Set false to create. |

### horoshop_admin_blog_post_update

**Update a blog / news article (text, SEO, cover)** · write, idempotent

Update an existing blog/news article (handler 172, h_news) by id. Read-modify-write: only the fields you pass change, everything else (including an existing cover AND the current rubric) is preserved. Sets title/announce/body/H1 and SEO per language (top-level = Ukrainian, optional `ru` object = Russian), plus slug/date and the act/promo/disallow-comments flags. Pass `rubric` to MOVE the article to another listing node (writes h_news.parent) - omit it and the rubric is left untouched (a plain edit never moves the article, which the old read-modify-write did by accident). Pass `cover` and/or `image` (as url/base64/data URI) to replace those pictures via direct multipart. Verifies by re-reading the article (text fields must read back, a replaced cover's path must change) and, for a move, by confirming the article now appears in the target rubric's grid. DRY RUN BY DEFAULT - pass dryRun:false to persist. BULK PAYLOAD FROM DISK: an article body is 15–19 KB and will not fit in a tool argument - that size limit is exactly why an operator once bypassed this tool for a raw read-modify-write and moved 10 published articles into the wrong rubric. Pass `payloadFile`, an ABSOLUTE path to a JSON file with the same argument names (e.g. {"ru":{"title":"…","text":"<18 KB>"}}); the rubric stays protected exactly as it does inline. Mutually exclusive with the inline content fields. ADD TO THE BODY WITHOUT RESENDING IT: `append` / `prepend` splice a delta onto the STORED text/announce ({"text":"…"} for UA, {"ru":{"text":"…"}} for RU) - no 18 KB round-trip, no risk of re-typing the existing article wrong. Conflicts with the replacing field for the same cell are an error. ANSWER SIZE: a persisted long field is reported as {length, tail, sha256} rather than echoed as from+to+now; a failure keeps expected/actual previews and the first differing offset. verbose:true restores the full diff. TEMPLATE TOKENS ARE PROTECTED: if the stored value contains a storefront placeholder ({DISCOUNT_PERCENT}, {COUNTDOWN_INFO}, {title}, {price}…) and your new value does not, dryRun reports `placeholderWarnings` and a real write is REFUSED until you pass allowPlaceholderLoss:true - overwriting such a value with a constant freezes the substitution for every product/page that uses it, with nothing erroring and nothing looking broken. Keeping the token (the normal case when translating) passes silently.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `id` | integer \| string | yes | Article id to update (from horoshop_admin_list blog_posts). |
| `title` | string | no | New title (UA). |
| `announce` | string | no | New announce (UA). |
| `text` | string | no | New body HTML (UA). |
| `h1` | string | no | New H1 (UA). |
| `seoTitle` | string | no | New SEO title (UA). |
| `seoKeywords` | string | no | New SEO keywords (UA). |
| `seoDescription` | string | no | New SEO meta description (UA). |
| `ru` | object | no | Russian (index 1) block to update. |
| `slug` | string | no | New URL slug. |
| `date` | string | no | New publish date YYYY-MM-DD. |
| `active` | boolean | no | Publish/unpublish (names[act]). |
| `promo` | boolean | no | Promo flag. |
| `disallowComments` | boolean | no | Disable comments. |
| `cover` | object | no | Replace the cover image (names[cover][file]), direct multipart. |
| `image` | any | no | Replace the inline image (names[img][file]). |
| `rubric` | integer | no | MOVE the article to this rubric / listing node id (writes h_news.parent). Omit to KEEP the current rubric - a plain update never moves it. Find node ids with horoshop_admin_list pages. |
| `parent` | integer | no | Deprecated alias of `rubric` (kept for back-compat). |
| `append` | object | no | APPEND to the end of the STORED value instead of replacing it: {"text":"<p>…</p>"} / {"announce":"…"} for Ukrainian and/or {"ru":{"text":"…"}} for Russian, glued onto the END of the stored body. The tool already read-modify-writes, so it reads the current value, glues your delta onto it verbatim (no separator, no trimming) and writes the result - you never have to resend the existing text (a 4 KB seo_text stays where it is, untouched and unrecoded). Mutually exclusive with the replacing field for the SAME field (both = error, never a silent winner). Works with dryRun: the preview shows length before → after plus a head/tail window of the result. |
| `prepend` | any | no | PREPEND to the START of the STORED value instead of replacing it: the same {text, announce, ru:{…}} shape as `append`. Same mechanics and the same mutual exclusion as `append`. |
| `verbose` | boolean | no | Default false: long field values (>200 chars, e.g. a 4 KB seo_text) are summarised in the answer - on success as {length, tail, sha256} instead of the same string echoed as from+to+now, on failure as expected/actual previews plus the first differing offset. Set true to get the full from→to→now diff for every field (heavy: ~3× the field size per field). |
| `allowPlaceholderLoss` | boolean | no | Default false. A write whose NEW value drops a storefront template token that the STORED value had ({DISCOUNT_PERCENT}, {PRICE}, {title}…) is REFUSED, because that silently turns a per-product substitution into frozen text. Set true only when losing the token is intended. |
| `payloadFile` | string | no | ABSOLUTE path to a JSON file holding this tool's content arguments (same key names, e.g. {"text":"<15 KB of HTML>","ru":{"text":"…"}}). Use it when the content is too large for a tool argument - article bodies (15–19 KB), page bodies (22 KB), category SEO text (16 KB). MUTUALLY EXCLUSIVE with the inline content fields: a key passed both ways is an error. store/dryRun/payloadFile stay inline. Works with dryRun (default true) exactly like horoshop_admin_blog_post_update inline. |
| `dryRun` | boolean | no | Default true: preview the changes without saving. Set false to persist. |

### horoshop_admin_page_create

**Create an info/text page that actually opens on the storefront** · write

Create a text/info page (Доставка, Оплата, Про нас, Гарантія…) under `parent` in one call, WITH a working URL. Writes the title and full SEO meta per language (top-level fields = Ukrainian, an optional `ru` object = Russian), persists the URL slug, and writes the page BODY. Returns the new id, the slug, the link and a REAL storefront HTTP status for it. WHERE THE BODY LANDS IS RESOLVED, NOT FIXED: the text goes into `<ns>[i18n][L][text]` when the chosen template renders that field, and FALLS BACK to `<ns>[i18n][L][seo_text]` when it does not. Both report success, so on a non-default template your page body can end up in the SEO-text block instead of the body - read the field names in `bodyPersisted` to see which one actually took it. `bodySkipped` appears only when the form has neither. USE THIS INSTEAD OF horoshop_admin_record_save entity=pages id=addnew: a page's slug is not a plain field but is owned by the `zteel.params.url` widget, and writing names[name][slug] persists ONLY when names[name][parent] carries the resolved p_name-row id. Without it the slug is dropped in silence - the record is created, the admin form reads back fine, page_seo_set reports "all changes verified", and the storefront answers 404 in every language. Measured live: created that way /zz2a-testpage/ → 404; the same record with the resolved parent → 200. Two steps internally (the blank create form does not render the extra block): the node is created, then the body is written to its extra block and verified by re-reading. The display template (names[handler]) auto-picks the store's «Текстовая страница» unless you pass `template`. DRY RUN BY DEFAULT - pass dryRun:false to create. Remove a page with horoshop_admin_record_delete entity=pages.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `parent` | integer | no | Parent page id to create the page under. Default 1 («Головна») - the level the store's info pages live on. |
| `title` | string | yes | Page title (Ukrainian / primary language). Required. |
| `slug` | string | no | URL slug (latin). Omit to auto-transliterate from the title. |
| `seoTitle` | string | no | SEO <title> (UA). |
| `seoKeywords` | string | no | SEO keywords (UA). |
| `seoDescription` | string | no | SEO meta description (UA). |
| `h1` | string | no | H1 heading (UA). |
| `text` | string | no | Page BODY HTML (UA) - extra[i18n][L][text], the visible content of the page. |
| `ru` | object | no | Russian (i18n index 1) block: title / seoTitle / seoKeywords / seoDescription / h1 / text. |
| `inMenu` | boolean | no | Show the page in the site menu (names[inmenu]). Default: leave the form's default. |
| `template` | integer \| string | no | Display template id (names[handler]). Omit to auto-pick the store's «Текстовая страница» template. |
| `dryRun` | boolean | no | Default true: preview the plan without creating. Set false to create. |

### horoshop_admin_category_create

**Create a catalog category (SEO + SEO-text + cover) in one call** · write

Create a catalog category under `parent` in one call - the tool the «semantic core → structure» pipeline uses to build a category tree. Writes the title and full SEO meta (title/keywords/description/H1) per language (top-level fields = Ukrainian, an optional `ru` object = Russian), attempts the URL slug (auto-transliterated from the title unless you pass `slug`), and sets the category SEO-text (extra[i18n][L][seo_text] - NOT the page body), the discount and the in-popular-menu / show-nav / show-pages-only / list-view flags. A `cover` image (url / base64 / data URI) is uploaded as a real file through the same multipart save.php. Two-step internally: the node is created, then its extra block + cover are written and VERIFIED by re-reading (seo_text reads back, cover's [value] becomes a /content/… path). The display template (names[handler]) auto-picks the store's «КАТАЛОГ: Товар» template unless you pass `template`. Returns the new category id, slug and storefront link. DRY RUN BY DEFAULT - pass dryRun:false to create. Remove a test category with horoshop_admin_record_delete entity=pages (parent = the same parent). ⚠ THE SLUG IS NOT GUARANTEED. Horoshop accepts it only when the title/slug is unique in that URL sub-tree; on a collision it stores the category WITHOUT a public URL and reports nothing. The category then exists, reads back fine and carries all its SEO - and simply is not on the storefront (seen live: category 1085). READ THE `slug` / `link` FIELDS OF THE ANSWER, not the note: `slug:null` means the category has no address. Fix it by giving the category a distinct title, or set the slug afterwards on a unique name. ⚠ NOT ATOMIC, BUT NO LONGER SILENT ABOUT IT - the two steps can still fail apart, and when step 2 fails the answer now tells you so instead of throwing. A cover that will not download (a 404 on the image URL is enough) no longer costs you `newId` and no longer voids the SEO block: the cover part is skipped, the SEO-text and flags are still written, and you get `created:true` + `newId` + `partialFailure:{cover:"…", categoryExists:true, cleanup:"…"}` with a note naming the exact reason. So a step-2 failure is never mistaken for "nothing was created" - the earlier behaviour left an orphan in the tree that the caller had no id for (measured live: orphans 1084 and 1094) and a blind retry then made a second one. Rollback is deliberately NOT done: deleting a node that already holds your title and SEO is a destructive act to take on your behalf, and a failed rollback would leave the orphan anyway. On a partialFailure, either finish the category with horoshop_admin_category_update or delete it with horoshop_admin_record_delete entity=pages id=<newId> parent=<parent> - the answer prints that exact command.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `parent` | integer | yes | Parent page id to create the category under (e.g. the «Каталог» root). |
| `title` | string | yes | Category title (Ukrainian / primary language). Required. |
| `slug` | string | no | URL slug (latin). Omit to auto-transliterate from the title. |
| `seoTitle` | string | no | SEO <title> (UA). |
| `seoKeywords` | string | no | SEO keywords (UA). |
| `seoDescription` | string | no | SEO meta description (UA). |
| `h1` | string | no | H1 heading (UA). |
| `seoText` | string | no | Category SEO-text HTML (UA) - the extra[i18n][L][seo_text] block, NOT the page body. |
| `ru` | object | no | Russian (i18n index 1) block: title / seoTitle / seoKeywords / seoDescription / h1 / seoText. |
| `discount` | number \| string | no | Category-wide discount %, extra[discount]. |
| `inPopularMenu` | boolean | no | Show in the popular menu (extra[in_popular_menu]). |
| `showNav` | boolean | no | Show the filter/nav sidebar (extra[show_nav]). |
| `showPagesOnly` | boolean | no | Show subcategories only, no products (extra[show_pages_only]). |
| `listView` | number \| string | no | Product list view mode (extra[list_view]). |
| `inMenu` | boolean | no | Show the category in the main menu (names[inmenu]). |
| `template` | integer \| string | no | Display template id (names[handler]). Omit to auto-pick the store's «КАТАЛОГ: Товар» template. |
| `cover` | object | no | Category cover image (<base>[image][file]) - uploaded via direct multipart. url / base64 / data URI. |
| `dryRun` | boolean | no | Default true: preview the plan without creating. Set false to create. |

### horoshop_admin_category_update

**Update a catalog category (title, SEO, SEO-text, flags, cover)** · write, idempotent

Update an existing catalog category by id. Read-modify-write: only the fields you pass change. Sets title + SEO meta per language (top-level = Ukrainian, `ru` object = Russian), the category SEO-text (extra[i18n][L][seo_text], namespace resolved automatically), the discount and menu/nav/list-view flags, and replaces the cover (url / base64 / data URI) via direct multipart. To change the slug pass `slug` AND `parent` (the URL tree parent is re-resolved - this is what makes a rename persist; see below). Verifies by re-reading: SEO-text must read back and a replaced cover's [value] path must change. DRY RUN BY DEFAULT - pass dryRun:false to persist. RENAMING THE URL OF AN EXISTING CATEGORY WORKS, and `parent` is what makes it work. Re-measured live end to end: a category created at /zzw13-slug-before/ was updated with slug+parent; the form field `names[name][slug]` read back as the new value, the NEW address then answered HTTP 200 and the OLD one HTTP 301 - Horoshop lays that redirect itself, you do not have to add one. This REPLACES an earlier note claiming the rename does not persist: that was measured before the URL-tree parent was re-resolved on update, and it is no longer true. The old behaviour is still what you get if you omit `parent` - the save is accepted and the old address stays - so pass both. Creating the category at the wanted address (horoshop_admin_category_create) remains the cheaper route when it does not exist yet. BULK PAYLOAD FROM DISK: a category's SEO text runs to 16 KB and will not fit in a tool argument - do NOT hand-roll a getEditForm+save for it. Pass `payloadFile`, an ABSOLUTE path to a JSON file with the same argument names (e.g. {"seoText":"…","ru":{"seoText":"<16 KB>"}}). Mutually exclusive with the inline content fields; dryRun works the same. ADD A BLOCK WITHOUT RESENDING THE TEXT: to extend an existing SEO-text rather than rewrite it, pass `append` (or `prepend`) - {"seoText":"…"} for Ukrainian, {"ru":{"seoText":"…"}} for Russian. The stored 16 KB is read, the delta is glued on, and the result is written; the existing copy never travels through the conversation and cannot be corrupted in transit. Conflicts with `seoText` for the same language are an error. ANSWER SIZE: a persisted long value is reported as {length, tail, sha256}, not echoed as from+to+now; a failed one keeps expected/actual previews and the first differing offset. verbose:true restores the full diff. TEMPLATE TOKENS ARE PROTECTED: if the stored value contains a storefront placeholder ({DISCOUNT_PERCENT}, {COUNTDOWN_INFO}, {title}, {price}…) and your new value does not, dryRun reports `placeholderWarnings` and a real write is REFUSED until you pass allowPlaceholderLoss:true - overwriting such a value with a constant freezes the substitution for every product/page that uses it, with nothing erroring and nothing looking broken. Keeping the token (the normal case when translating) passes silently.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `id` | integer \| string | yes | Category (page) id to update. |
| `parent` | integer | no | Parent page id (needed to resolve the slug tree when changing the slug). |
| `title` | string | no | New title (UA). |
| `slug` | string | no | New URL slug (latin) - requires `parent` to resolve the URL tree. |
| `seoTitle` | string | no | New SEO title (UA). |
| `seoKeywords` | string | no | New SEO keywords (UA). |
| `seoDescription` | string | no | New SEO meta description (UA). |
| `h1` | string | no | New H1 (UA). |
| `seoText` | string | no | New category SEO-text HTML (UA). |
| `ru` | object | no | Russian (index 1) block to update. |
| `discount` | number \| string | no | Category discount % (extra[discount]). |
| `inPopularMenu` | boolean | no | Show in popular menu. |
| `showNav` | boolean | no | Show the filter/nav sidebar. |
| `showPagesOnly` | boolean | no | Show subcategories only. |
| `listView` | number \| string | no | Product list view mode. |
| `inMenu` | boolean | no | Show in the main menu (names[inmenu]). |
| `cover` | object | no | Replace the cover image (<base>[image][file]), direct multipart. |
| `append` | object | no | APPEND to the end of the STORED value instead of replacing it: {"seoText":"<h3>Доставка</h3>…"} for Ukrainian and/or {"ru":{"seoText":"…"}} for Russian, glued onto the END of the stored category SEO-text. The tool already read-modify-writes, so it reads the current value, glues your delta onto it verbatim (no separator, no trimming) and writes the result - you never have to resend the existing text (a 4 KB seo_text stays where it is, untouched and unrecoded). Mutually exclusive with the replacing field for the SAME field (both = error, never a silent winner). Works with dryRun: the preview shows length before → after plus a head/tail window of the result. |
| `prepend` | any | no | PREPEND to the START of the STORED value instead of replacing it: the same {seoText, ru:{seoText}} shape as `append`. Same mechanics and the same mutual exclusion as `append`. |
| `verbose` | boolean | no | Default false: long field values (>200 chars, e.g. a 4 KB seo_text) are summarised in the answer - on success as {length, tail, sha256} instead of the same string echoed as from+to+now, on failure as expected/actual previews plus the first differing offset. Set true to get the full from→to→now diff for every field (heavy: ~3× the field size per field). |
| `allowPlaceholderLoss` | boolean | no | Default false. A write whose NEW value drops a storefront template token that the STORED value had ({DISCOUNT_PERCENT}, {PRICE}, {title}…) is REFUSED, because that silently turns a per-product substitution into frozen text. Set true only when losing the token is intended. |
| `payloadFile` | string | no | ABSOLUTE path to a JSON file holding this tool's content arguments (same key names, e.g. {"text":"<15 KB of HTML>","ru":{"text":"…"}}). Use it when the content is too large for a tool argument - article bodies (15–19 KB), page bodies (22 KB), category SEO text (16 KB). MUTUALLY EXCLUSIVE with the inline content fields: a key passed both ways is an error. store/dryRun/payloadFile stay inline. Works with dryRun (default true) exactly like horoshop_admin_category_update inline. |
| `dryRun` | boolean | no | Default true: preview the changes without saving. Set false to persist. |

### horoshop_admin_indexed_filter_create

**Create an indexed (SEO) filter with several conditions** · write

Create an indexed/SEO filter (handler 422) that binds a COMBINATION of filter characteristics to one category so the filtered URL becomes an indexable landing. `page` = the category/page id; `filters` = an ARRAY of filter-characteristic ids (one per condition, e.g. Бренд + Ціна). Unlike generic record_save - which can only ever set ONE filter because a JSON patch cannot repeat a key - this submits every condition as a repeated names[filters][] part, so all of them persist. Discover the valid ids with horoshop_admin_record_get entity=indexed_filters id=addnew (the names[filters][] and names[page] options); the tool also lists them in a dry run and rejects ids not offered. WHAT RE-READING CAN AND CANNOT PROVE: only `page` and `enabled` are verifiable. The stored CONDITIONS are not readable back through any interface this server has - the legacy edit view always draws the same fixed pair of empty «Фильтр» selects whether the record holds one condition or five, and neither the datagrid nor projectAjax exposes the saved set (loadAvailableFiltersByPageId returns what is AVAILABLE, not what is chosen). The answer says so in `conditionReadBack` instead of inventing a count. The conditions are proven only at the wire level (they are POSTed as repeated names[filters][] parts and the save is accepted) - to confirm the result for real, open the filtered category URL on the storefront and see whether it lists the products you expect. TWO ID SPACES, ONE NUMBER: the ids in `filters` come from this form's own registry (the filter groups, e.g. filter_colors 351) and are NOT the dictionary value ids a product carries in horoshop_catalog_export (`color.id`, h_colors 346). They overlap numerically and mean different things, so do not judge an "empty" filter by matching ids across the two - judge it by the storefront listing. Ids not offered by the form are refused here rather than saved as junk. `enabled` defaults true. DRY RUN BY DEFAULT - pass dryRun:false to create. Remove a test filter with horoshop_admin_record_delete entity=indexed_filters.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `title` | string | yes | Filter name (admin label), e.g. «Футболки: бренд + ціна». |
| `page` | integer \| string | yes | Page/category id the filter binds to (names[page]). |
| `filters` | integer \| string[] | yes | Filter-characteristic ids to combine (one per condition). From horoshop_admin_record_get entity=indexed_filters id=addnew, the names[filters][] options (e.g. Бренд, Ціна). |
| `enabled` | boolean | no | Whether the indexed filter is active (names[enabled]). Default true. |
| `dryRun` | boolean | no | Default true: preview the plan without creating. Set false to create. |

### horoshop_admin_indexed_filter_update

**Update an indexed (SEO) filter (title, page, conditions)** · write, idempotent

Update an existing indexed/SEO filter (handler 422) by id. Read-modify-write for the scalar fields (title/page/enabled); pass `filters` (an array of characteristic ids) to REPLACE the whole condition set - again submitted as repeated names[filters][] parts so all conditions persist, not just one. Omit `filters` to leave the conditions unchanged. WHAT IS VERIFIED: `page` and `enabled` only - those re-read from the record. The condition set does NOT read back: the legacy edit view renders a fixed empty «Фильтр» template regardless of what is stored, so replacing five conditions with one looks identical on a re-read. The answer reports `conditionReadBack: "n/a"` rather than claiming a count. Confirm a condition change by opening the filtered category URL on the storefront. Note also that a `filters` id belongs to the admin's filter-group registry (filter_colors 351 and kin), not to the product-side dictionary ids in horoshop_catalog_export (`color.id`, h_colors 346) - the numbers overlap and mean different things. DRY RUN BY DEFAULT - pass dryRun:false to persist.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `id` | integer \| string | yes | Indexed-filter id to update. |
| `title` | string | no | New filter name. |
| `page` | integer \| string | no | New page/category id (names[page]). |
| `filters` | integer \| string[] | no | Replace the condition set (one id per condition). Omit to keep the current conditions. |
| `enabled` | boolean | no | Enable/disable the filter (names[enabled]). |
| `dryRun` | boolean | no | Default true: preview without saving. Set false to persist. |

### horoshop_admin_filter_preset_create

**Create an SEO filter preset (custom slug + SEO block) in one call** · write

Create a filter PRESET (handler 364, h_presets) - a fixed filter condition on one category turned into an indexable landing at a custom slug, the thing the public REST API cannot create. `page` = the category/page id it binds to; `params` = the RAW filter condition string in `/filter/` shape (e.g. "color=8"); `slug` = the custom URL slug; `title.ua` (required) + optional `title.ru`; a per-language `seo` block (seoTitle/seoKeywords/seoDescription/seoText/h1). seo_text is written as RAW HTML verbatim (never double-encoded, so <h3>/<ul> render as markup, not literal &lt;h3&gt;). ⚠️ COLOR ID SPACE - the `color=N` in `params` is the FILTER-GROUP id (filter_colors, 351-space), NOT the product `color.id` from catalog_export (h_colors, 346-space): the two DO NOT line up, so never judge a preset "empty" by matching its color=N against exported product color.ids (a live color=10 preset returns products that export under color.id=21 - that mismatch nearly got a working colour landing disabled). To check how many products a preset actually serves, read the storefront listing, not an id match. Filter-group ids (params color=N → name): Чорний=1, Білий=2, Сірий=3, Червоний=4, Жовтий=6, Зелений=7, Блакитний=8, Синій=9, Фіолетовий=10, Коричневий=11, Рожевий=12. The slug PERSISTS only with its URL-tree parent, resolved via the preset's alias widget (param_id 5537, then the category default) - or pass `aliasParent` to set the known shared node explicitly. `enabled` defaults true. DRY RUN BY DEFAULT - pass dryRun:false to create. Remove a test preset with horoshop_admin_record_delete entity=filter_presets. HOW THE VERIFY IS GATED - READ `persisted`, NOT THE NOTE. All six fields are re-read and reported in `persisted` (slug, page, params, enabled, seoText, aliasParent), but the cheerful note is gated on FOUR of them: slug, page, params, enabled. A preset whose `seo_text` did not land therefore still reports as created and fine - and an SEO landing with no text on it is the whole point missed. Check `persisted.seoText` explicitly (and `persisted.aliasParent`, which the note only mentions when it is false).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `page` | integer \| string | yes | Page/category id the preset binds to (names[page]). Must be one of the addnew form's page options. |
| `params` | string | yes | Filter condition, a RAW string in `/filter/` query shape, e.g. "color=8" or "parent=1021;price=100-289". |
| `slug` | string | yes | Custom URL slug (latin), e.g. "postilna-bilyzna-blakytnoho-koloru". |
| `title` | object | yes | Preset title per language. The store convention fills only `ua`. |
| `seo` | object | no | Per-language SEO blocks (ua = index 3, ru = index 1). seo_text is RAW HTML sent verbatim. |
| `enabled` | boolean | no | Whether the preset is active (names[enabled]). Default true. |
| `sortorder` | integer \| string | no | Sort order (names[sortorder]). |
| `aliasParent` | integer \| string | no | Override the URL-tree parent (names[alias][parent]) instead of resolving it. Use when you know the shared node (e.g. 569 for page 1058 on one store). |
| `dryRun` | boolean | no | Default true: preview the plan without creating. Set false to create. |

### horoshop_admin_filter_preset_update

**Update an SEO filter preset (page, params, slug, SEO block)** · write

Update an existing filter preset (handler 364) by id. Read-modify-write: only the fields you pass change. Sets page / params / title / per-language SEO (raw-HTML seo_text) / enabled / sortorder. To change the slug pass `slug` (its alias parent is re-resolved via the preset widget, or pass `aliasParent`). Verifies by re-reading (slug, page, params, enabled, seo_text). ADD A BLOCK WITHOUT RESENDING THE TEXT: `append` / `prepend` take the same per-language SEO shape as `seo` but splice onto the STORED seo_text instead of replacing it. That is the bulk case - one extra block across 15 presets costs 15 short deltas instead of 15 × 4 KB of re-typed Ukrainian HTML, and the existing copy is never re-encoded (so it cannot be corrupted). The same cell in `seo` AND `append`/`prepend` is an error, never a silent winner. ANSWER SIZE: a persisted seo_text comes back as {length, tail, sha256}, not echoed as from+to+now (which is what made a 15-preset rollout unreadable); a field that did NOT persist still reports expected/actual previews plus the first differing offset. verbose:true restores the full diff. ⚠️ COLOR ID SPACE - the `color=N` in `params` is the FILTER-GROUP id (filter_colors, 351-space), NOT the product `color.id` from catalog_export (h_colors, 346-space); they do not line up. Never disable a preset because its color=N does not match exported product color.ids (a live color=10 preset serves products that export under color.id=21). Judge coverage from the storefront listing, not an id match. Filter-group ids (color=N → name): Чорний=1, Білий=2, Сірий=3, Червоний=4, Жовтий=6, Зелений=7, Блакитний=8, Синій=9, Фіолетовий=10, Коричневий=11, Рожевий=12. NOT IDEMPOTENT WHEN YOU SPLICE: `set`-style fields can be re-sent safely, but `append`/`prepend` concatenate unconditionally. If a call times out and you retry it blind, the block lands TWICE in the live seo_text. Re-read the record before repeating a splice. DRY RUN BY DEFAULT - pass dryRun:false to persist. TEMPLATE TOKENS ARE PROTECTED: if the stored value contains a storefront placeholder ({DISCOUNT_PERCENT}, {COUNTDOWN_INFO}, {title}, {price}…) and your new value does not, dryRun reports `placeholderWarnings` and a real write is REFUSED until you pass allowPlaceholderLoss:true - overwriting such a value with a constant freezes the substitution for every product/page that uses it, with nothing erroring and nothing looking broken. Keeping the token (the normal case when translating) passes silently.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `id` | integer \| string | yes | Preset id to update. |
| `page` | integer \| string | no | New page/category id (names[page]). |
| `params` | string | no | New filter condition (raw string). |
| `slug` | string | no | New slug - its alias parent is re-resolved (or pass aliasParent). |
| `title` | object | no | Title per language. |
| `seo` | object | no | Per-language SEO blocks (raw HTML seo_text) - REPLACES the stored value. |
| `append` | object | no | APPEND to the end of the STORED value instead of replacing it: the same per-language SEO shape as `seo` (e.g. {"ua":{"seoText":"<h3>Доставка</h3>…"}}), glued onto the END of the stored seo_text - the way to add one block across N presets without resending each preset's 4 KB of author HTML. The tool already read-modify-writes, so it reads the current value, glues your delta onto it verbatim (no separator, no trimming) and writes the result - you never have to resend the existing text (a 4 KB seo_text stays where it is, untouched and unrecoded). Mutually exclusive with the replacing field for the SAME field (both = error, never a silent winner). Works with dryRun: the preview shows length before → after plus a head/tail window of the result. |
| `prepend` | object | no | PREPEND to the START of the STORED value instead of replacing it: the same per-language SEO shape as `seo`. Same mechanics and the same mutual exclusion as `append`. |
| `verbose` | boolean | no | Default false: long field values (>200 chars, e.g. a 4 KB seo_text) are summarised in the answer - on success as {length, tail, sha256} instead of the same string echoed as from+to+now, on failure as expected/actual previews plus the first differing offset. Set true to get the full from→to→now diff for every field (heavy: ~3× the field size per field). |
| `allowPlaceholderLoss` | boolean | no | Default false. A write whose NEW value drops a storefront template token that the STORED value had ({DISCOUNT_PERCENT}, {PRICE}, {title}…) is REFUSED, because that silently turns a per-product substitution into frozen text. Set true only when losing the token is intended. |
| `enabled` | boolean | no | Enable/disable (names[enabled]). |
| `sortorder` | integer \| string | no | Sort order. |
| `aliasParent` | integer \| string | no | Override names[alias][parent] instead of resolving it. |
| `dryRun` | boolean | no | Default true: preview without saving. Set false to persist. |

## Admin panel: SEO, sitemap, redirects

| Tool | Access | Summary |
|---|---|---|
| [`horoshop_admin_redirect_list`](#horoshop_admin_redirect_list) | read-only | List URL redirects |
| [`horoshop_admin_redirect_create`](#horoshop_admin_redirect_create) | write | Create URL redirect |
| [`horoshop_admin_redirect_update`](#horoshop_admin_redirect_update) | write, idempotent | Update an existing URL redirect |
| [`horoshop_admin_redirect_bulk_create`](#horoshop_admin_redirect_bulk_create) | write | Create URL redirects in bulk (list or file) |
| [`horoshop_admin_redirect_generate_slashes`](#horoshop_admin_redirect_generate_slashes) | write | Mass-generate trailing-slash redirects |
| [`horoshop_admin_redirect_delete`](#horoshop_admin_redirect_delete) | destructive write, idempotent | Delete URL redirect |
| [`horoshop_admin_seo_settings_get`](#horoshop_admin_seo_settings_get) | read-only | Read the additional SEO settings (pagination canonical/noindex, breadcrumbs) |
| [`horoshop_admin_seo_settings_set`](#horoshop_admin_seo_settings_set) | write, idempotent | Set the additional SEO settings (self-POST screen) |
| [`horoshop_admin_robots_get`](#horoshop_admin_robots_get) | read-only | Read the store's live robots.txt |
| [`horoshop_admin_sitemap_regenerate`](#horoshop_admin_sitemap_regenerate) | write, idempotent | Regenerate the store's XML sitemap |
| [`horoshop_admin_sitemap_status`](#horoshop_admin_sitemap_status) | read-only | Read the store's XML sitemap (index + child URL counts) |

### horoshop_admin_redirect_list

**List URL redirects** · read-only

List EVERY 301 redirect in the store, with the target record each one points to (`history_id` is the handle update/delete take). Reads the whole redirects grid, not just its first page - the screen renders 20 target rows at a time, and a plain page read used to report 16 of a store's 35 redirects. Pass includeTargets:true to also get every record the screen lists WITH ITS CANONICAL URL (including records that have no redirect yet) - that table is what turns "/old should go to /new" into the handler+record a redirect actually needs. SEO/link-equity management.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `allowLarge` | boolean | no | Default false. The answer is MEASURED before it is returned, and a payload over the size limit (default 100 KB, override with HOROSHOP_MAX_RESPONSE_BYTES) is REFUSED with its measured size and how to narrow it, instead of overflowing the conversation. Set true to get the whole thing anyway. |
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `includeTargets` | boolean | no | Default false. True: also return every target record (handler, record, title, canonical URL, how many redirects point at it) - the address book for creating new redirects. |

### horoshop_admin_redirect_create

**Create URL redirect** · write

Create a 301 redirect from an old URI to an existing record. Give it either `to` (the destination URL - resolved to the record that owns it) or `handler`+`record` directly. Handler dict, as seen on a live store: **4 = pages AND catalog categories**, **17 = products**, 172 = news, 349 = brands, 364 = filter presets, 425 = external-service files. The old URI is matched EXACTLY: a redirect stored as "/foo" does not fire for "/foo/" - create both if the old links used a trailing slash (or use horoshop_admin_redirect_generate_slashes for a whole section). REFUSES DUPLICATES AND LOOPS BEFORE WRITING. Horoshop does not: creating a second redirect from a uri that already redirects answers OK and leaves two contradictory rows live, with no defined winner (measured). A loop closing back on itself is refused too. Pass force:true to override deliberately. DRY RUN BY DEFAULT - pass dryRun:false to create; returns the new history_id.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `uri` | string | yes | Old URI to redirect FROM (e.g. "/old-category"). A full https://… URL is reduced to its path. |
| `to` | string | no | Destination URL - must be an existing record's canonical URL (see horoshop_admin_redirect_list includeTargets:true). Alternative to handler+record. |
| `handler` | integer \| string | no | Target entity type (4=pages/categories, 17=products, 172=news, 349=brands…). Use with `record`. |
| `record` | integer \| string | no | Target record id the redirect points TO. |
| `force` | boolean | no | Default false. True: create even if it duplicates an existing redirect or closes a loop (the conflict is still reported). |
| `dryRun` | boolean | no | Default true: preview without creating. Set false to create. |

### horoshop_admin_redirect_update

**Update an existing URL redirect** · write, idempotent

Edit a redirect that already exists, addressed by its `history_id` (from horoshop_admin_redirect_list). Change the old URI with `from`, and/or the destination with `to` (or `handler`+`record`). HOW THE TWO DIFFER, because the platform hides it: changing `from` is a real in-place edit (one widget call, the history_id survives). Changing the DESTINATION is not editable at all - `update` accepts handler/record and silently ignores them (measured: the row stayed on its old target while the call answered OK), so this tool performs the move as delete+create, which mints a NEW history_id and is reported as such. If the re-create fails the original is restored and the answer says so. Duplicates and loops are refused before the write, same as create (`force:true` overrides). DRY RUN BY DEFAULT.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `id` | integer \| string | yes | history_id of the redirect to edit (from horoshop_admin_redirect_list). |
| `from` | string | no | New OLD uri for this redirect (what visitors request). Omit to keep it. |
| `to` | string | no | New destination URL - resolved to the record that owns it. Omit to keep the current target. Triggers a delete+create (new history_id). |
| `handler` | integer \| string | no | New target entity type (use with `record`, instead of `to`). |
| `record` | integer \| string | no | New target record id (use with `handler`, instead of `to`). |
| `force` | boolean | no | Default false. True: apply even if the result duplicates another redirect or closes a loop. |
| `dryRun` | boolean | no | Default true: preview without writing. Set false to apply. |

### horoshop_admin_redirect_bulk_create

**Create URL redirects in bulk (list or file)** · write

Create many 301 redirects in one call - the migration workhorse. Three ways in: `redirects` as a list of {from, to} pairs (or {from, handler, record}); `csvFile`, the path to a CSV/TSV redirect map with one `old,new` pair per line (tab, ";" or ",", header row skipped) - the format a client's redirect list actually arrives in; or `payloadFile`, a JSON file holding {"redirects":[…]}. The last two are how you import a 300-line map without pasting it into the conversation. `to` is resolved to the record that owns that URL, so you can think in URLs; unresolvable destinations are reported per row instead of guessed. DRY RUN BY DEFAULT and the dry run is the point: it reports exactly how many would be created, and which rows CONFLICT - a `from` that already redirects somewhere (Horoshop would happily add a contradictory second row), a duplicate inside the batch itself, a redirect onto its own target, or one that closes a loop with existing redirects. On a live run any conflict ABORTS the whole batch before a single write; pass skipConflicts:true to create the clean rows and skip the rest, or force:true to write everything anyway. Created rows are verified by re-reading the store.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `redirects` | object[] | no | The redirects to create. Each needs `from` plus either `to` or handler+record. |
| `csvFile` | string | no | ABSOLUTE path to a CSV/TSV redirect map: one "old,new" pair per line (delimiter tab, ";" or ","; a header row and #-comments are skipped). Same shape Horoshop's own «Импорт редиректов» expects - but routed through the duplicate/loop guards, which the platform's importer has none of. |
| `payloadFile` | string | no | ABSOLUTE path to a JSON file holding this tool's content arguments (same key names, e.g. {"text":"<15 KB of HTML>","ru":{"text":"…"}}). Use it when the content is too large for a tool argument - article bodies (15–19 KB), page bodies (22 KB), category SEO text (16 KB). MUTUALLY EXCLUSIVE with the inline content fields: a key passed both ways is an error. store/dryRun/payloadFile stay inline. Works with dryRun (default true) exactly like horoshop_admin_redirect_bulk_create inline. |
| `skipConflicts` | boolean | no | Default false (a conflict aborts the batch). True: create the non-conflicting rows and report the skipped ones. |
| `force` | boolean | no | Default false. True: create every row even where it duplicates an existing redirect or closes a loop. |
| `dryRun` | boolean | no | Default true: preview and validate without creating. Set false to create. |

### horoshop_admin_redirect_generate_slashes

**Mass-generate trailing-slash redirects** · write

Run the admin's own «Генератор редиректов»: create slash/no-slash 301s for whole sections at once - the standard migration chore when a site changes its URL suffix. `type` 1 = links WITH a trailing slash redirect to links WITHOUT; 2 = links WITHOUT redirect to links WITH (the usual direction on Horoshop, whose canonical URLs carry the suffix). `handlers` picks the sections: 4 = site structure (pages & categories), 17 = catalog, 172 = news, 349 = brands, 364 = filter presets, 425 = external-service files. ⚠ THE GENERATOR IS NOT ADDITIVE-ONLY, and it tells you nothing - it answers `OK` with an empty body whatever it did. Measured on a live store: one run over handler 4 created 13 rows, of which 6 REPLACED existing redirects (same uri, brand-new history_id) and one had an EMPTY uri. So this tool diffs the full redirect set around the run and reports `added` / `reissued` (same redirect, new id) / `removed`, and refuses to guess. It also deletes the junk empty-uri rows the generator leaves behind unless you pass keepEmpty:true. DRY RUN BY DEFAULT: the dry run cannot predict the platform's output, so it reports the current coverage per section (how many records already have a slash-variant redirect) and what the run would touch.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `handlers` | integer \| string[] | yes | Sections to generate for: 4 (pages+categories), 17 (catalog), 172 (news), 349 (brands), 364 (filter presets), 425 (external-service files). |
| `type` | 1 \| 2 | yes | 1 = with-slash → without-slash. 2 = without-slash → with-slash (the usual direction for Horoshop canonical URLs). |
| `keepEmpty` | boolean | no | Default false: empty-uri rows the generator creates are deleted afterwards (they are junk - a blank old-uri is not a redirect). True: leave them. |
| `dryRun` | boolean | no | Default true: report current coverage without generating. Set false to run the generator. |

### horoshop_admin_redirect_delete

**Delete URL redirect** · destructive write, idempotent

Delete one or more 301 redirects by history_id (from horoshop_admin_redirect_list). DRY RUN BY DEFAULT - the dry run shows what each id currently redirects, so you can see what you are about to switch off. Pass dryRun:false to delete; deletion is verified by re-reading the store. Ids that are already gone are listed in `notFound` and are not an error; when NONE of them are in the store the answer carries `alreadyGone:true`, so a repeat delete is a no-op success.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `id` | integer \| string | no | history_id of the redirect to delete. |
| `ids` | integer \| string[] | no | Several history_ids to delete in one call. |
| `dryRun` | boolean | no | Default true: preview without deleting. Set false to delete. |

### horoshop_admin_seo_settings_get

**Read the additional SEO settings (pagination canonical/noindex, breadcrumbs)** · read-only

Read the five booleans on the store's 'Дополнительные SEO настройки' screen: `paginationCanonicalFirstPage` (canonical → first pagination page), `paginationNoindex` (noindex the pagination pages), `seoTextWithGetParams` (show the SEO text on URLs that carry GET params), `catalogInBreadcrumbs` (add the 'Каталог' level to breadcrumbs), and `brandInBreadcrumbs` (add the brand link to a product's breadcrumbs). Read-only. Write them with horoshop_admin_seo_settings_set.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `allowLarge` | boolean | no | Default false. The answer is MEASURED before it is returned, and a payload over the size limit (default 100 KB, override with HOROSHOP_MAX_RESPONSE_BYTES) is REFUSED with its measured size and how to narrow it, instead of overflowing the conversation. Set true to get the whole thing anyway. |
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |

### horoshop_admin_seo_settings_set

**Set the additional SEO settings (self-POST screen)** · write, idempotent

Turn any of the five 'Дополнительные SEO настройки' booleans on or off: `paginationCanonicalFirstPage`, `paginationNoindex`, `seoTextWithGetParams`, `catalogInBreadcrumbs`, `brandInBreadcrumbs` (all true=on). This screen is a self-POST singleton (it posts back to itself, not save.php); the tool does a read-modify-write and verifies by re-reading the form. `paginationNoindex` and the canonical flag steer how search engines treat pagination - change them deliberately. Call horoshop_admin_seo_settings_get first to see the current state. DRY RUN BY DEFAULT.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `paginationCanonicalFirstPage` | boolean | no | Canonical на первую страницу пагинации |
| `paginationNoindex` | boolean | no | Не индексировать страницы пагинации (noindex) |
| `seoTextWithGetParams` | boolean | no | Показывать SEO-текст на URL с GET-параметрами |
| `catalogInBreadcrumbs` | boolean | no | Страница «Каталог» в хлебных крошках |
| `brandInBreadcrumbs` | boolean | no | Ссылка на Бренд в хлебных крошках товара |
| `dryRun` | boolean | no | Default true: preview the change. Set false to apply. |

### horoshop_admin_robots_get

**Read the store's live robots.txt** · read-only

Fetch the store's live `/robots.txt` from the storefront (through the anti-bot). READ-ONLY: Horoshop generates robots.txt on the platform side - there is no admin editor for it (the 'save-robots' button on the SEO screen is just the mis-named submit for the SEO flags, and no robots textarea exists), so there is no supported write path from here. Use this to audit what crawlers are told, and to confirm the Sitemap: line points at the right URL.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `allowLarge` | boolean | no | Default false. The answer is MEASURED before it is returned, and a payload over the size limit (default 100 KB, override with HOROSHOP_MAX_RESPONSE_BYTES) is REFUSED with its measured size and how to narrow it, instead of overflowing the conversation. Set true to get the whole thing anyway. |
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |

### horoshop_admin_sitemap_regenerate

**Regenerate the store's XML sitemap** · write, idempotent

Rebuild the store's sitemap via the admin's `utils/sitemap.php?create`. The public `/sitemap.xml` may be a `<sitemapindex>` pointing at generated children (pages / catalog) or a single flat `<urlset>`; either way this refreshes it to reflect the current catalog. Non-destructive and idempotent - the map just mirrors reality, so there is nothing to undo. Worth calling after a catalog import or a batch of URL/redirect changes. Returns two distinct signals: `accepted` (the endpoint ran) and `contentChanged` (the URL counts actually moved). NOTE: `lastmod` is bumped on every rebuild, so it is NOT used as the change signal - `regenerated` means 'the rebuild ran', not 'the URL set changed'; watch `contentChanged` for the latter.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |

### horoshop_admin_sitemap_status

**Read the store's XML sitemap (index + child URL counts)** · read-only

Read the store's public `/sitemap.xml` without touching anything. Handles BOTH flavours: a `<sitemapindex>` (reports each child sitemap, its `lastmod`, and how many `<url>` entries it holds) and a flat `<urlset>` (reports the single sitemap's own `<url>` count, no recursion). Use it to check the sitemap's health, or to capture a 'before' snapshot around a horoshop_admin_sitemap_regenerate call.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `allowLarge` | boolean | no | Default false. The answer is MEASURED before it is returned, and a payload over the size limit (default 100 KB, override with HOROSHOP_MAX_RESPONSE_BYTES) is REFUSED with its measured size and how to narrow it, instead of overflowing the conversation. Set true to get the whole thing anyway. |
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |

## Admin panel: marketplace feeds

| Tool | Access | Summary |
|---|---|---|
| [`horoshop_admin_feed_list`](#horoshop_admin_feed_list) | read-only | List marketplace feeds with their public URLs and live status |
| [`horoshop_admin_feed_set`](#horoshop_admin_feed_set) | write, idempotent | Switch a marketplace feed on/off, or change its alias |
| [`horoshop_admin_feed_generate`](#horoshop_admin_feed_generate) | write | Generate a marketplace feed file and verify the public URL serves it |
| [`horoshop_admin_feed_params_get`](#horoshop_admin_feed_params_get) | read-only | Read one feed's parameter mapping (availability / product condition) |
| [`horoshop_admin_feed_params_set`](#horoshop_admin_feed_params_set) | write, idempotent | Map / unmap a feed parameter value, or flip its two feed-level flags |
| [`horoshop_admin_feed_categories_get`](#horoshop_admin_feed_categories_get) | read-only | Read a feed's category screen: local tree, marketplace tree, mapping |

### horoshop_admin_feed_list

**List marketplace feeds with their public URLs and live status** · read-only

Every marketplace feed the store has (Rozetka / Hotline / Google Merchant / Facebook / Kasta / Google reviews - entity 429), each with its id, `system_name`, title, on/off state, alias and - the part that exists nowhere in the admin as a copyable string - the PUBLIC URL a marketplace pulls: `<base>/marketplace-integration/<system_name>/<alias>`. For every ENABLED feed it also fetches that URL and reports what actually comes back, because `enabled=1` is NOT evidence a feed is being served: the file is 404 until «Сгенерировать feed» has been pressed at least once (horoshop_admin_feed_generate), and 404 again the moment the feed is switched off. `live:true` means a real `text/xml` document answered. Disabled feeds are not fetched (they 404 by definition) - pass `probe:false` to skip the fetch entirely. Read-only. Generic `horoshop_admin_list entity:marketplaces` shows the same six rows but only their titles: no alias (it lives in the edit form, not the grid), no URL, no proof anything is served.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `allowLarge` | boolean | no | Default false. The answer is MEASURED before it is returned, and a payload over the size limit (default 100 KB, override with HOROSHOP_MAX_RESPONSE_BYTES) is REFUSED with its measured size and how to narrow it, instead of overflowing the conversation. Set true to get the whole thing anyway. |
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `probe` | boolean | no | Fetch each enabled feed's public URL to check it really serves XML. Default true. |

### horoshop_admin_feed_set

**Switch a marketplace feed on/off, or change its alias** · write, idempotent

Enable or disable one feed (entity 429) and/or replace the secret `marketplace_alias` segment of its public URL. Takes the feed by id, `system_name` or exact title. Dry-run by default: pass `dryRun:false` to write. TWO TRAPS THIS HANDLES. (1) `names[enabled]` is present TWICE in the form - a hidden `0` plus a checkbox `1` sharing one name, and PHP keeps the LAST one; the read-modify-write here reproduces exactly what a browser submits, which is why the state is verified by re-reading the record rather than trusting the 302. (2) The alias IS the URL: `…/marketplace-integration/<system_name>/<alias>`. Changing it silently breaks the link every marketplace already has on file, so an alias change needs `confirm:true` and the tool reports both the old and the new URL. Switching a feed ON also makes its sub-screens («Настроить категории», «Настройка параметров», «Сгенерировать feed») exist at all. Switching it OFF makes the public XML 404 immediately, even if the file was generated. Nothing here regenerates the file - that is horoshop_admin_feed_generate.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `feed` | integer \| string | yes | Feed id, system_name (e.g. "rozetka-feed") or exact title. |
| `enabled` | boolean | no | Switch the feed on (true) or off (false). Omit to leave as is. |
| `alias` | string | no | New marketplace_alias - the secret segment of the public URL. Requires confirm:true; breaks the existing link. |
| `confirm` | boolean | no | Required to change the alias (an existing marketplace link stops working). |
| `dryRun` | boolean | no | Default true - report the change without writing. |

### horoshop_admin_feed_generate

**Generate a marketplace feed file and verify the public URL serves it** · write

Press «Сгенерировать feed» for one feed and then CHECK the result: the platform's own answer is a 24-byte sentence («Файл успешно сформирован») that says nothing about the document, so this tool fetches the public URL afterwards and reports the real content type, size and the number of `<offer>` entries in it. Generation is local - the platform renders XML from the store's own catalog and sends nothing outward - but it is NOT idempotent and not instant on a large catalog: each call rewrites the file. Refuses on a disabled feed (the endpoint would answer, and the URL would still 404). A feed that generates an EMPTY document - `<categories/><offers/>` - is the normal result when no category is marked for upload: that mapping lives in the feed's category screen, which needs the marketplace taxonomy synced from the marketplace's own servers first (a destructive, non-reversible step deliberately left to the admin panel - see horoshop_admin_feed_categories_get).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `feed` | integer \| string | yes | Feed id, system_name or exact title. |
| `dryRun` | boolean | no | Default false - this is the one action that has no read-only form. Pass true to see what would run. |

### horoshop_admin_feed_params_get

**Read one feed's parameter mapping (availability / product condition)** · read-only

The feed's own «Настройка параметров»: which of the STORE's values for 374 «Наличие товаров: статус» and 428 «Состояние товара» are sent as which MARKETPLACE value. Returns the marketplace's own vocabulary for this feed (`in stock` / `out of stock` / `preorder` for Google, `true` / `false` for Rozetka…), the store's local values, and the current correlation between them - plus the two feed-level flags `multipleLang` and `useSharedPhotosGallery`. ⚠ THIS IS NOT ENTITY 427. The admin calls two different screens «Настройка параметров». 427 «Статусы наличия для площадок» belongs to the EXPORT FILE FORMATS (Excel / Hotline / YML / Prom / Google CSV - Rozetka and Facebook are not in its enum at all) and maps only `presence`; generic `record_save entity:marketplace_availability` is the tool for that one. This tool is the per-FEED mapping, which also covers product condition. Reads fine on a DISABLED feed - unlike the category screen, this endpoint does not check the switch. Read-only.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `allowLarge` | boolean | no | Default false. The answer is MEASURED before it is returned, and a payload over the size limit (default 100 KB, override with HOROSHOP_MAX_RESPONSE_BYTES) is REFUSED with its measured size and how to narrow it, instead of overflowing the conversation. Set true to get the whole thing anyway. |
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `feed` | integer \| string | yes | Feed id, system_name or exact title. |

### horoshop_admin_feed_params_set

**Map / unmap a feed parameter value, or flip its two feed-level flags** · write, idempotent

Write half of the feed's «Настройка параметров»: point one of the store's local values (374 «Наличие товаров: статус», 428 «Состояние товара») at one of the marketplace's own values, drop such a mapping, or set the feed flags `multipleLang` and `useSharedPhotosGallery`. Dry-run by default. Identify the local value by its id (as listed by horoshop_admin_feed_params_get) and the marketplace value either by its `marketplaceParamId` or by its literal string (`in stock`, `true`, `used`…) - the string is matched WHOLE, not as a substring, and an ambiguous or unknown one is refused with the list of what this feed accepts. `action:"unmap"` removes the pairing for the given local value. Every write is verified by re-reading the mapping. Mapping affects only what the generated XML says about a product; it does not touch the products themselves. Regenerate the feed afterwards for the change to reach the marketplace (horoshop_admin_feed_generate).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `feed` | integer \| string | yes | Feed id, system_name or exact title. |
| `action` | "map" \| "unmap" \| "flags" | yes | `map`/`unmap` a value pair, or `flags` to set multipleLang / useSharedPhotosGallery. |
| `parameter` | integer \| string | no | Which parameter the local value belongs to: 374 «Наличие товаров: статус» or 428 «Состояние товара» (id or exact title). REQUIRED whenever the same localValueId exists under both - it does: 374 and 428 each have a value 3. |
| `localValueId` | integer \| string | no | Local value id from feed_params_get (e.g. 1 = «В наличии»). Value ids are unique only WITHIN a parameter - pair with `parameter`. Required for map/unmap. |
| `marketplaceValue` | string | no | Marketplace value for `map` - its literal string (`in stock`, `true`, `used`) or its marketplaceParamId. |
| `multipleLang` | boolean | no | `flags`: export the feed in several languages. |
| `useSharedPhotosGallery` | boolean | no | `flags`: share one photo gallery across modifications (the admin exposes this for rozetka-feed only). |
| `dryRun` | boolean | no | Default true - report the change without writing. |

### horoshop_admin_feed_categories_get

**Read a feed's category screen: local tree, marketplace tree, mapping** · read-only

The «Настроить категории» screen of one feed, read whole: the store's own category tree as the feed sees it, the marketplace's category tree, the configured category pairs (`jsonConfigs`, each with its marketplace category, local template and margin) and the characteristics taxonomy. This is the screen that decides WHICH categories are exported at all - a feed with no configured category generates a valid but empty document. REQUIRES AN ENABLED FEED, and fails in a way worth knowing about: the endpoint answers HTTP 200 with `{"status":"EXCEPTION","response":{"message":"The marketplace … is not enabled"}}`, so anything reading the HTTP code alone reports success with no data. This tool turns that into a plain "switch the feed on first". Read-only, and deliberately read-only: the marketplace tree is populated by «Синхронизация категорий» (`repository/sync-external-data`), which pulls the tree from the marketplace's servers and RESETS the store's local taxonomy for that feed with no inverse call. That button is not wrapped by this server - run it in the admin panel if you accept it. Empty `marketplaceCategories` here means exactly that: the sync has never run for this feed.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `allowLarge` | boolean | no | Default false. The answer is MEASURED before it is returned, and a payload over the size limit (default 100 KB, override with HOROSHOP_MAX_RESPONSE_BYTES) is REFUSED with its measured size and how to narrow it, instead of overflowing the conversation. Set true to get the whole thing anyway. |
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `feed` | integer \| string | yes | Feed id, system_name or exact title. |
| `full` | boolean | no | Return the raw taxonomy arrays too (large). Default false - counts and the mapped pairs only. |

## Admin panel: design and localization

| Tool | Access | Summary |
|---|---|---|
| [`horoshop_admin_design_get`](#horoshop_admin_design_get) | read-only | Read design config (application JSON) |
| [`horoshop_admin_design_set`](#horoshop_admin_design_set) | write, idempotent | Edit design config (application JSON) |
| [`horoshop_admin_css_get`](#horoshop_admin_css_get) | read-only | Read custom CSS |
| [`horoshop_admin_css_set`](#horoshop_admin_css_set) | write, idempotent | Set custom CSS |
| [`horoshop_admin_languages`](#horoshop_admin_languages) | read-only | List store languages |
| [`horoshop_admin_language_set`](#horoshop_admin_language_set) | write, idempotent | Edit a store language |
| [`horoshop_admin_interface_translation_get`](#horoshop_admin_interface_translation_get) | read-only | Find interface translation strings |
| [`horoshop_admin_interface_translation_set`](#horoshop_admin_interface_translation_set) | write, idempotent | Set an interface translation string |

### horoshop_admin_design_get

**Read design config (application JSON)** · read-only

Read the store's design 'application JSON' - the full theme config (colours, blocks, homepage layout, header/footer, mobile, banners…). Without `section` returns the version and top-level section names; pass a `section` (e.g. "header", "homepage", "footer") to get that subtree. Read the shape here before editing it with horoshop_admin_design_set. SECRETS ARE NEVER RETURNED: the `payment` section (LiqPay / PayPal / merchant credentials) is withheld wholesale - it is not design - and in every other section any value under a key matching key/token/secret/password/signature/private is masked as "•••• (N chars)", so a transcript of a read cannot leak a live payment key. Editing still works on the real values: horoshop_admin_design_set merges into the unredacted config. Note: values shaped like {"source":"db","field_name":"…"} are NOT stored in this JSON - they are pointers into the store's general settings, which THIS tool does not reach but other tools do: read them with horoshop_admin_settings_get (index:true gives the label→field map) or with horoshop_admin_record_get / horoshop_admin_record_save on the site_settings form, and write the common ones through the named tools (horoshop_admin_store_contacts, horoshop_admin_store_info_set, horoshop_admin_settings_brand / _checkout / _catalog / _tracking / _social_auth). SIZE: `section:"mobile"` returns roughly 1500 lines in one payload and there is no `depth`/`path` narrowing here - read it only when you need it.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `allowLarge` | boolean | no | Default false. The answer is MEASURED before it is returned, and a payload over the size limit (default 100 KB, override with HOROSHOP_MAX_RESPONSE_BYTES) is REFUSED with its measured size and how to narrow it, instead of overflowing the conversation. Set true to get the whole thing anyway. |
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `section` | string | no | Top-level section to drill into (e.g. "header", "homepage", "common"). Omit for the section index. |

### horoshop_admin_design_set

**Edit design config (application JSON)** · write, idempotent

Edit the store's design config by deep-merging a patch into one of its top-level sections (the design editor's blocks): common, header, footer, homepage, catalog, catalogCategories, product, mobile, cart, banners, contacts, brands, favorites, etc. Read the current shape first with horoshop_admin_design_get. Example: section "common", patch {"style":{"background":"#111"}}. Read-modify-write against the REAL config - the redaction that horoshop_admin_design_get applies to its output never reaches the write path, so patching a design section cannot damage the store's payment credentials (only the merged preview this tool prints is masked). DRY RUN BY DEFAULT. Colour/font changes need an SCSS recompile to reach the storefront and this tool runs it for you (`recompile`, default true) - but be precise about what that proves: the tool POSTs to Horoshop's recompile endpoint and reports the status it answers, i.e. THE JOB WAS ACCEPTED. It does not fetch the compiled theme CSS, does not compare the asset hash and does not look for your colour in the served file. On a live storefront that difference is worth money: if you need a hard guarantee the new colour is actually being served, fetch the storefront's compiled CSS yourself and check. Structural changes (blocks, layout, toggles) apply from the config directly.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `section` | string | yes | Top-level design section to edit (e.g. "header", "homepage", "common"). |
| `patch` | object | yes | Partial object deep-merged into the section (only the keys you set change). |
| `recompile` | boolean | no | Default true: recompile SCSS after saving so colour/font changes reach the storefront. |
| `dryRun` | boolean | no | Default true: preview the merged section without saving. Set false to save. |

### horoshop_admin_css_get

**Read custom CSS** · read-only

Read the store's custom CSS (desktop and mobile) from the client-styles editor. ALWAYS CHECK `available` BEFORE ACTING ON THE RESULT: the «Редактор CSS» admin section is per-store AND per-account - when THIS login has no rights to that section (the common case: the menu simply omits it) or the module is off, this returns available:false with empty strings, meaning the CSS is UNKNOWN, not absent. The storefront can still be serving custom rules (/assets/*/production/client.*.css) that no admin endpoint on that store exposes. `source` says where the values came from ("legacy-ace-editor" or "unavailable"). Reading decodes the HTML entities the editor page escapes, so a `>` child combinator comes back as `>` and survives a round-trip through horoshop_admin_css_set.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `allowLarge` | boolean | no | Default false. The answer is MEASURED before it is returned, and a payload over the size limit (default 100 KB, override with HOROSHOP_MAX_RESPONSE_BYTES) is REFUSED with its measured size and how to narrow it, instead of overflowing the conversation. Set true to get the whole thing anyway. |
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |

### horoshop_admin_css_set

**Set custom CSS** · write, idempotent

Set the store's custom CSS. Provide `desktop` and/or `mobile` (the one you omit is preserved). Horoshop recompiles SCSS after saving. DRY RUN BY DEFAULT - pass dryRun:false to save. BLIND-WRITE GUARD: the save always posts BOTH sides, so it can only preserve what it could read. If horoshop_admin_css_get could not read the current CSS (the editor module is off on this store) or the side you are overwriting reads back empty, this refuses to write - an empty read is the exact condition under which a read-modify-write silently wipes a live stylesheet. Pass force:true only when you have confirmed out of band (e.g. by fetching the storefront's client.css) that there is nothing to lose.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `desktop` | string | no | Desktop CSS (omit to keep current). |
| `mobile` | string | no | Mobile CSS (omit to keep current). |
| `force` | boolean | no | Override the blind-write guard when the current CSS reads empty or unreadable. Default false. |
| `dryRun` | boolean | no | Default true: preview without saving. Set false to save. |

### horoshop_admin_languages

**List store languages** · read-only

List the store's languages (id + label) from the languages grid. Use an id with horoshop_admin_language_set.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `allowLarge` | boolean | no | Default false. The answer is MEASURED before it is returned, and a payload over the size limit (default 100 KB, override with HOROSHOP_MAX_RESPONSE_BYTES) is REFUSED with its measured size and how to narrow it, instead of overflowing the conversation. Set true to get the whole thing anyway. |
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |

### horoshop_admin_language_set

**Edit a store language** · write, idempotent

Edit a language's settings by id: site_title (its name), enabled (0/1), is_displayed_in_admin (0/1), currency (currency id - see the language editor), noindex (0/1). Read-modify-write; posts to the languages route. DRY RUN BY DEFAULT. (Adding/removing languages changes the whole storefront and is left to the admin UI.)

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `id` | integer \| string | yes | Language id (from horoshop_admin_languages). |
| `site_title` | string | no | Language display name. |
| `enabled` | "0" \| "1" | no | Enabled on the storefront. |
| `is_displayed_in_admin` | "0" \| "1" | no | Shown in the admin language switcher. |
| `currency` | string | no | Currency id for this language. |
| `noindex` | "0" \| "1" | no | noindex this language's pages. |
| `dryRun` | boolean | no | Default true: preview changes without saving. Set false to save. |

### horoshop_admin_interface_translation_get

**Find interface translation strings** · read-only

Search the store's «Перевод интерфейса» table (l10n, handler 340) - the THEME strings the storefront renders around your content: «Чесна ціна», «Ви економите», «Оцінка», «відгуків», button and label text, and the headings of product characteristics. This is where a shop that is fully translated in the catalog still shows the first language. One record per (key, language) pair: `key` is the source string and is the same across languages, `value` is that language's text. Search by key (default) or by value; results come back with the record id you feed to horoshop_admin_interface_translation_set. SEARCHING THE WRONG COLUMN LOOKS LIKE "THE STRING DOES NOT EXIST". `searchIn` defaults to `key`, and the key is always the BASE language's wording - so hunting for the Ukrainian text on a store whose base language is Russian (or the reverse) returns zero rows for a string that is right there in the table. Nothing is broken; you searched the wrong column. If a search comes back empty, run it again with searchIn:"value". Server-side substring search - do NOT try to list this table, it has thousands of rows and walking it is what used to fail with "Network error … fetch failed". Searching an empty query is refused for the same reason. COST: a narrow match is 3 grid requests (reload, filter, clear); a broad substring pages through the matches up to `maxRows` (default 500) and can be dozens. Still far cheaper than listing the table - just keep the substring specific.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `allowLarge` | boolean | no | Default false. The answer is MEASURED before it is returned, and a payload over the size limit (default 100 KB, override with HOROSHOP_MAX_RESPONSE_BYTES) is REFUSED with its measured size and how to narrow it, instead of overflowing the conversation. Set true to get the whole thing anyway. |
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `search` | string | yes | Substring to look for, e.g. "Чесна ціна" or "Матеріал". Case-insensitive substring match, server-side. |
| `searchIn` | "key" \| "value" | no | Which column to match: "key" (the source string, default) or "value" (the translated text). |
| `lang` | "ru" \| "ua" \| "en" \| "pl" \| "ro" | no | Return only this language's rows. Omit for every language of each match. |
| `maxRows` | integer | no | Cap on rows collected (default 500). |

### horoshop_admin_interface_translation_set

**Set an interface translation string** · write, idempotent

Set one interface-translation string (l10n, handler 340) - the storefront theme text for a given key and language. Target it either by `id` (from horoshop_admin_interface_translation_get) or by `key` + `lang`, which is resolved by exact-key search and refuses to guess if it is ambiguous. Read-modify-write on the record's own edit form: only `names[value]` changes, the key and language are left as stored. Verifies by re-reading the record. DRY RUN BY DEFAULT - pass dryRun:false to persist. This is also how a CHARACTERISTIC HEADING gets translated (e.g. «Розмір постільної білизни» → Russian): the template editor has no per-language title field, the label is translated here. TEMPLATE TOKENS ARE PROTECTED: if the stored value contains a storefront placeholder ({DISCOUNT_PERCENT}, {COUNTDOWN_INFO}, {title}, {price}…) and your new value does not, dryRun reports `placeholderWarnings` and a real write is REFUSED until you pass allowPlaceholderLoss:true - overwriting such a value with a constant freezes the substitution for every product/page that uses it, with nothing erroring and nothing looking broken. Keeping the token (the normal case when translating) passes silently.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `id` | integer \| string | no | Record id from horoshop_admin_interface_translation_get. Either this, or key+lang. |
| `key` | string | no | Source string (exact key) - used with `lang` when you have no id. |
| `lang` | "ru" \| "ua" \| "en" \| "pl" \| "ro" | no | Language of the row to change - required with `key`. |
| `value` | string | yes | New translated text for that key + language. |
| `allowPlaceholderLoss` | boolean | no | Default false. A write whose NEW value drops a storefront template token that the STORED value had ({DISCOUNT_PERCENT}, {PRICE}, {title}…) is REFUSED, because that silently turns a per-product substitution into frozen text. Set true only when losing the token is intended. |
| `dryRun` | boolean | no | Default true: preview the change without saving. Set false to persist. |

## Admin panel: store settings, marketing, fiscal receipts

| Tool | Access | Summary |
|---|---|---|
| [`horoshop_admin_checkout_option_set`](#horoshop_admin_checkout_option_set) | write, idempotent | Enable/disable or retitle a checkout option |
| [`horoshop_admin_store_contacts`](#horoshop_admin_store_contacts) | write | Read or set the store's contacts |
| [`horoshop_admin_store_info_set`](#horoshop_admin_store_info_set) | write, idempotent | Set store name, address, hours and product-card info tabs |
| [`horoshop_admin_coupons_generate`](#horoshop_admin_coupons_generate) | write | Generate gift certificates / discount coupons |
| [`horoshop_admin_settings_tracking`](#horoshop_admin_settings_tracking) | write, idempotent | Read or set the store's tracking / analytics scripts |
| [`horoshop_admin_settings_checkout`](#horoshop_admin_settings_checkout) | write, idempotent | Read or set checkout / order-form options |
| [`horoshop_admin_settings_catalog`](#horoshop_admin_settings_catalog) | write, idempotent | Read or set catalog behaviour options |
| [`horoshop_admin_settings_brand`](#horoshop_admin_settings_brand) | write, idempotent | Read or set brand texts, timezone, map and moderation |
| [`horoshop_admin_settings_social_auth`](#horoshop_admin_settings_social_auth) | write, idempotent | Read or set social login providers |
| [`horoshop_admin_settings_get`](#horoshop_admin_settings_get) | read-only | Read any general setting, or list what settings exist |
| [`horoshop_admin_prro_get`](#horoshop_admin_prro_get) | read-only | Read the Checkbox ПРРО (fiscalization) settings |
| [`horoshop_admin_prro_set`](#horoshop_admin_prro_set) | write, idempotent | Set the Checkbox ПРРО (fiscalization) settings |
| [`horoshop_admin_tracking_get`](#horoshop_admin_tracking_get) | read-only | List the store's marketing / tracking services |
| [`horoshop_admin_tracking_set`](#horoshop_admin_tracking_set) | write, idempotent | Switch a marketing / tracking service on or off and set its id |

### horoshop_admin_checkout_option_set

**Enable/disable or retitle a checkout option** · write, idempotent

Turn a payment or delivery option on/off and/or retitle it per language - the thing that decides what a buyer can actually pick at checkout. `kind` picks the list, `id` is the option id from horoshop_payment_export / horoshop_delivery_export. Verify the result where it matters with horoshop_checkout_inspect: an option enabled here but missing there never reached the buyer. DRY RUN BY DEFAULT.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `kind` | "payment" \| "delivery" | yes | Which checkout list this option belongs to. |
| `id` | integer \| string | yes | Option id (from payment_export / delivery_export). |
| `enabled` | boolean | no | Show or hide the option at checkout. |
| `titles` | object | no | Per-language title, e.g. {"ua":"Нова пошта","ru":"Новая почта"}. |
| `dryRun` | boolean | no | Default true: preview. Set false to apply. |

### horoshop_admin_store_contacts

**Read or set the store's contacts** · write

Read or replace the phones/messengers/e-mails a buyer sees in the header and on the contacts page. These are not in the design config or the public API: they live in a table the admin builds in JavaScript, so this is the only way to reach them from here. ONE TABLE HOLDS EVERY LANGUAGE, told apart only by a per-row language cell - so a read lists ALL languages (each row carries `lang`, plus `countByLang`), and a write REPLACES ONLY THE ROWS OF THE LANGUAGE YOU PASS (`lang`, default ua) while every other language is resent untouched. ⚠ `lang` decides WHICH ROWS ARE REPLACED, but it does NOT tag the rows you create: Horoshop stamps every new contact row with the store's own main language and ignores the one sent (measured - a row written as ru read back as ua). The write detects this and answers `languageForcedByPlatform` + `WARNING_LANG` rather than pretending; to have a row in another language it has to already exist there. It used to drop the whole table and resend just one language, which silently deleted the other languages' phones from the storefront; the write now reports `countByLang` and warns if any language lost rows. Within the chosen language it is a full replace - the admin has no per-row delete from outside. Types: phone, viber, telegram, whatsapp, email, raw. DRY RUN BY DEFAULT (the preview shows what is replaced and what is preserved).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `contacts` | object[] | no | Omit to just read the current contacts. |
| `lang` | "ua" \| "ru" \| "en" \| "pl" \| "ro" | no | Language these contacts belong to. Default ua. |
| `dryRun` | boolean | no | Default true: preview. Set false to apply. |

### horoshop_admin_store_info_set

**Set store name, address, hours and product-card info tabs** · write, idempotent

Set the store's general information: display name, and per-language address, timetable, and the text of FOUR of the product card's info tabs - delivery, payment, returns, warranty. Those tabs are prime CRO space and the design config only references them as {"source":"db"} - they live here. HTML is allowed in the tab texts. DRY RUN BY DEFAULT. The fifth tab, «Консультация», has no parameter here: it is `extra[i18n][<langId>][info_consult]` on the general-settings form and is written with horoshop_admin_record_save entity=site_settings (find the exact field with horoshop_admin_settings_get index:true). SAVING RESUBMITS THE WHOLE SETTINGS FORM: like every other general-settings writer here, this posts all ~373 fields of utils/site_settings.php back at once. There is no versioning or ETag, so a change somebody is making in the browser at the same moment is overwritten without a word.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `siteName` | string | no | Store display name, e.g. "My Shop". |
| `lang` | "ua" \| "ru" \| "en" \| "pl" \| "ro" | no | Language for the text fields below. Default ua. |
| `address` | string | no |  |
| `timetable` | string | no | e.g. "Пн–Пт 10:00–19:00". |
| `infoDelivery` | string | no | Product card "Доставка" tab (HTML ok). |
| `infoPayment` | string | no | Product card "Оплата" tab (HTML ok). |
| `infoReturn` | string | no | Product card "Повернення" tab (HTML ok). |
| `infoWarranty` | string | no | Product card "Гарантія" tab (HTML ok). |
| `dryRun` | boolean | no | Default true: preview. Set false to apply. |

### horoshop_admin_coupons_generate

**Generate gift certificates / discount coupons** · write

Mass-generate discount codes - the «Сгенерировать сертификаты» button on Скидки → Сертификаты и купоны. Horoshop invents the codes itself (10-character, e.g. ZY86929093); you choose the kind, the value, how many, and when they expire. Two kinds: `certificate` is a GIFT CERTIFICATE worth a fixed amount of money (`amount` is in the store's currency) and is spent once; `coupon` is a PERCENTAGE discount (`amount` is the percent) that can be used `usesPerCoupon` times. DRY RUN BY DEFAULT - this creates records in bulk and Horoshop allows up to 500 000 in one call, so the preview states exactly what would be created. Pass dryRun:false to generate; it then re-lists the grid and reports how many codes actually appeared plus a sample of them. The generated codes are ordinary records: read them with horoshop_admin_list entity=coupons, edit one with horoshop_admin_record_save, remove them with horoshop_admin_record_delete. There is no bulk 'undo' - deleting a bad batch means deleting the ids it created.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `kind` | "certificate" \| "coupon" | yes | certificate = fixed-value gift certificate (amount in money, single use) · coupon = percentage discount, reusable `usesPerCoupon` times. |
| `amount` | number | yes | Value: the certificate's face value in store currency, or the coupon's discount PERCENT. |
| `count` | integer | yes | How many codes to generate. Horoshop's own ceiling is 500 000 per call (it answers COUPON_LIMIT above it). |
| `validUntil` | string | yes | Expiry date, "YYYY-MM-DD". |
| `usesPerCoupon` | integer | no | kind=coupon only: how many times each coupon may be used. Default 100 (the admin form's own default). Ignored for certificates, which are single-use. |
| `dryRun` | boolean | no | Default true: describe the batch without creating it. Set false to generate. |

### horoshop_admin_settings_tracking

**Read or set the store's tracking / analytics scripts** · write, idempotent

Read or set the site-wide tracking scripts injected into every storefront page: `scriptOnTop` (right after <body>), `scriptOnBottom` (before </body>), `scriptInHead` (inside <head>), and `ga4Id` (the GA4 measurement/resource id). This is where GTM, Meta Pixel, GA and any custom JS live - HTML/JS is allowed verbatim. Call with no script args to just read the current values. DRY RUN BY DEFAULT. HOW THE SAVE WORKS - IT IS NOT A PATCH. All settings_* writers share ONE form (utils/site_settings.php, ~370 fields covering every section, not just this one). Saving re-posts that whole form with your fields overridden, and Horoshop offers no version/ETag to detect a conflict. So if a colleague is editing anything on the store's settings page in a browser while you save, their change is overwritten without a warning on either side. On a live store, save when nobody else is in there.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `scriptOnTop` | string | no | Скрипты после тега <body> |
| `scriptOnBottom` | string | no | Скрипты перед тегом </body> |
| `scriptInHead` | string | no | Скрипты внутри тега <head> |
| `ga4Id` | string | no | Аналитика: идентификатор ресурса GA4 |
| `dryRun` | boolean | no | Default true: preview the change. Set false to apply. |

### horoshop_admin_settings_checkout

**Read or set checkout / order-form options** · write, idempotent

Read or set the checkout form's behaviour: the e-mail fields (`showEmail`, `requireEmail`), `requireAuthorization`, the newsletter opt-in (`newsletterSubscription` + `newsletterSubscriptionDefault`), `showCouponCode`, `showCountries`, `phoneMask`, the 'do not call' option (`orderWithoutCallback` + `orderWithoutCallbackDefault`), `commentFieldExpanded`, and the quick-order block (`quickOrderEnabled`, `quickOrderShowName`, `quickOrderShowEmail`, `quickOrderPriorityMobile`). All are booleans (true=on). Booleans are stored as a hidden 0 plus a checkbox 1, so turning one off sends the hidden 0 exactly like a browser would. Call with no args to read. DRY RUN BY DEFAULT. HOW THE SAVE WORKS - IT IS NOT A PATCH. All settings_* writers share ONE form (utils/site_settings.php, ~370 fields covering every section, not just this one). Saving re-posts that whole form with your fields overridden, and Horoshop offers no version/ETag to detect a conflict. So if a colleague is editing anything on the store's settings page in a browser while you save, their change is overwritten without a warning on either side. On a live store, save when nobody else is in there.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `showEmail` | boolean | no | Отображать поле «Эл. почта» |
| `requireEmail` | boolean | no | Эл. почта обязательна |
| `requireAuthorization` | boolean | no | Обязательная авторизация при известном email |
| `newsletterSubscription` | boolean | no | Согласие на получение рассылок (показывать опцию) |
| `newsletterSubscriptionDefault` | boolean | no | Согласие на рассылки - отмечено по умолчанию |
| `showCouponCode` | boolean | no | Отображать поле для купонов |
| `showCountries` | boolean | no | Отображать поле «Страна» |
| `phoneMask` | boolean | no | Маска ввода номера телефона (UA) |
| `orderWithoutCallback` | boolean | no | Опция «Не звонить для подтверждения заказа» |
| `orderWithoutCallbackDefault` | boolean | no | «Не звонить» - отмечено по умолчанию |
| `commentFieldExpanded` | boolean | no | Поле «Комментарий» развёрнуто |
| `quickOrderEnabled` | boolean | no | Быстрый заказ: включить |
| `quickOrderShowName` | boolean | no | Быстрый заказ: поле «Имя и фамилия» |
| `quickOrderShowEmail` | boolean | no | Быстрый заказ: поле «Эл. почта» |
| `quickOrderPriorityMobile` | boolean | no | Быстрый заказ: приоритет в мобильной версии |
| `dryRun` | boolean | no | Default true: preview the change. Set false to apply. |

### horoshop_admin_settings_catalog

**Read or set catalog behaviour options** · write, idempotent

Read or set how the catalog behaves: modification grouping (`groupModifications`, `useGeneratedTitle`, `highlightUnavailableModifications`, `highlightMissingModifications`), `compareItems`, `allowListView`, price rounding (`currencyRoundTo`), `primarySort` (enum), `newIconDaysDuration`, the B2B toggles (`accessMultiplicity`, `accessUnitsOfMeasurement`, `accessWholesalePrices`, `accessMinOrder`), stock accounting (`useResiduesByStock`), `productsSetEnabled`, `giftsEnabled`, `specifyPrice`, `digitalProductsEnabled`, `cartAddOpen`, `checkAllParams`, `hintType` (enum), `mobileCardView`, `contentCopyProtection`, and `omnibusPrice` (EU 30-day-low law). Booleans are true/false; enums reject unknown values and list the valid ones. Call with no args to read. DRY RUN BY DEFAULT. HOW THE SAVE WORKS - IT IS NOT A PATCH. All settings_* writers share ONE form (utils/site_settings.php, ~370 fields covering every section, not just this one). Saving re-posts that whole form with your fields overridden, and Horoshop offers no version/ETag to detect a conflict. So if a colleague is editing anything on the store's settings page in a browser while you save, their change is overwritten without a warning on either side. On a live store, save when nobody else is in there.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `groupModifications` | boolean | no | Группировать товары по модификациям |
| `useGeneratedTitle` | boolean | no | Генерировать названия для модификаций |
| `compareItems` | boolean | no | Сравнение товаров |
| `allowListView` | boolean | no | Отображение товаров списком |
| `currencyRoundTo` | integer \| string | no | Округление цен (знаков после запятой) |
| `primarySort` | string | no | Приоритетная сортировка товаров в каталоге |
| `newIconDaysDuration` | integer \| string | no | Новинка: кол-во дней |
| `accessMultiplicity` | boolean | no | Кратность (шаг кол-ва в корзине) |
| `accessUnitsOfMeasurement` | boolean | no | Единицы измерения товара |
| `accessWholesalePrices` | boolean | no | Оптовые цены за количество |
| `accessMinOrder` | boolean | no | Минимальный заказ |
| `useResiduesByStock` | boolean | no | Учёт остатков |
| `productsSetEnabled` | boolean | no | Комплекты товаров |
| `giftsEnabled` | boolean | no | Подарки |
| `specifyPrice` | boolean | no | Функция «Узнать цену» |
| `digitalProductsEnabled` | boolean | no | Электронные товары |
| `cartAddOpen` | boolean | no | Открывать корзину при добавлении товара |
| `checkAllParams` | boolean | no | Похожие товары по всем характеристикам |
| `hintType` | string | no | Подсказки для характеристик (вид) |
| `mobileCardView` | boolean | no | Крупная плитка по умолчанию (мобайл) |
| `highlightUnavailableModifications` | boolean | no | Выделять товары не в наличии в переключателе модификаций |
| `highlightMissingModifications` | boolean | no | Выделять отсутствующие модификации в переключателе |
| `contentCopyProtection` | boolean | no | Защита от копирования текста |
| `omnibusPrice` | boolean | no | Поле «Самая низкая цена за 30 дней до скидки» (Omnibus) |
| `dryRun` | boolean | no | Default true: preview the change. Set false to apply. |

### horoshop_admin_settings_brand

**Read or set brand texts, timezone, map and moderation** · write, idempotent

Read or set the store's brand-level settings: the display `siteName`, and the translatable `headerSite` (common title), `siteDescription`, `slogan`, `copyright`, `aboutStore` (the 'О магазине' block on the home page). Plus `timezone` (enum), `multicurrencyEnabled`, `commentsModeration`, `onlinePaymentModeration`, `gmapApiKey` and `mapCode` (HTML). Translatable fields use `lang` (default ua). Call with no field args to read. DRY RUN BY DEFAULT. HOW THE SAVE WORKS - IT IS NOT A PATCH. All settings_* writers share ONE form (utils/site_settings.php, ~370 fields covering every section, not just this one). Saving re-posts that whole form with your fields overridden, and Horoshop offers no version/ETag to detect a conflict. So if a colleague is editing anything on the store's settings page in a browser while you save, their change is overwritten without a warning on either side. On a live store, save when nobody else is in there.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `siteName` | string | no | Название магазина |
| `headerSite` | string | no | Общий title сайта |
| `siteDescription` | string | no | Описание сайта (для соцсетей) |
| `slogan` | string | no | Слоган (шапка сайта) |
| `copyright` | string | no | Копирайт (футер) |
| `aboutStore` | string | no | О магазине (блок на Главной) |
| `timezone` | string | no | Часовой пояс |
| `multicurrencyEnabled` | boolean | no | Мультивалютность |
| `commentsModeration` | boolean | no | Модерация отзывов и комментариев |
| `onlinePaymentModeration` | boolean | no | Модерация онлайн-оплат |
| `gmapApiKey` | string | no | API-ключ Google карт |
| `mapCode` | string | no | HTML-код карты проезда |
| `lang` | "ua" \| "ru" \| "en" \| "pl" \| "ro" | no | Language for translatable fields. Default ua. |
| `dryRun` | boolean | no | Default true: preview the change. Set false to apply. |

### horoshop_admin_settings_social_auth

**Read or set social login providers** · write, idempotent

Read or set which social-login buttons the storefront offers: `facebookAuth`, `googleAuth`, `linkedInAuth` (all booleans, true=enabled). Enabling here shows the provider; the client_id/secret are configured separately. Call with no args to read. DRY RUN BY DEFAULT. HOW THE SAVE WORKS - IT IS NOT A PATCH. All settings_* writers share ONE form (utils/site_settings.php, ~370 fields covering every section, not just this one). Saving re-posts that whole form with your fields overridden, and Horoshop offers no version/ETag to detect a conflict. So if a colleague is editing anything on the store's settings page in a browser while you save, their change is overwritten without a warning on either side. On a live store, save when nobody else is in there.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `facebookAuth` | boolean | no | Facebook: авторизация включена |
| `googleAuth` | boolean | no | Google: авторизация включена |
| `linkedInAuth` | boolean | no | LinkedIn: авторизация включена |
| `dryRun` | boolean | no | Default true: preview the change. Set false to apply. |

### horoshop_admin_settings_get

**Read any general setting, or list what settings exist** · read-only

The read/discovery companion to the settings_* writers. With no filters it returns the current value of every named setting, grouped by section. Narrow it with `section`, with `keys` (human keys like 'showCouponCode'), or with `fields` (raw names like 'extra[show_coupon_code]'). `lang` (default ua) selects the language of translatable values. Set `catalog:true` to get the map of every writable key -> raw field + section (the 'what can I change' reference), or `index:true` for the raw label->field index of the general-settings page - including entries without a named tool yet: SMTP, fiscal/Checkbox, reCAPTCHA, marketplaces, cookies/age gates. THE INDEX NOW ALSO LISTS THE FORM'S HIDDEN FIELDS, which is where a whole class of "unreachable" settings was hiding: 12 `extra[np_*]` (Nova Poshta), 4 legacy `extra[sms_fly_*]`, 3 GA4 service-account fields, `extra[domain_address]`, `extra[inpost_map_points_enabled]`. They are `<input type=hidden>` on the settings page, so nothing that maps the visible form ever saw them. ⚠ `np_*` IS A LEGACY MIRROR, NOT THE SOURCE OF TRUTH - the real Nova Poshta editor is the delivery method (handler 235) under `Delivery[delivery_method][serviceSettings.<dotted.path>]`, and the two have already drifted (`serviceSettings.byDefault.description` = «Товари» vs `extra[np_native_description]` = «Товары»). Read NP from 235, write NP in 235; the mirror is listed here only so a read-modify-write passes it through knowingly. The GA4 fields and `domain_address` are CONDITIONAL - the page renders them only where the integration exists, so reading them on a store without it returns nothing, which is "not configured", not a failure. THE INDEX IS STILL NOT THE WHOLE FORM. What it does not list is what other tools already own - logos, favicon, og:image, watermark, the contacts table, the names[…] cluster. Missing from `index` therefore means "reached elsewhere" (horoshop_admin_upload_image, horoshop_admin_store_contacts, the category tools), not "unreachable". DO NOT reach for horoshop_admin_record_get entity=site_settings just to browse: that form is 374 fields / ~98 KB and will eat the answer budget in one call. Use this tool's filters instead, and go to record_get only for a field you have already named.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `allowLarge` | boolean | no | Default false. The answer is MEASURED before it is returned, and a payload over the size limit (default 100 KB, override with HOROSHOP_MAX_RESPONSE_BYTES) is REFUSED with its measured size and how to narrow it, instead of overflowing the conversation. Set true to get the whole thing anyway. |
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `section` | "tracking" \| "checkout" \| "catalog" \| "brand" \| "social" | no | Limit to one section. |
| `keys` | string[] | no | Specific human keys to read, e.g. ["siteName","showCouponCode"]. |
| `fields` | string[] | no | Specific raw field names to read, e.g. ["extra[timezone]"]. |
| `lang` | "ua" \| "ru" \| "en" \| "pl" \| "ro" | no | Language for translatable fields. Default ua. |
| `catalog` | boolean | no | Return the key -> field/section map instead of values. |
| `index` | boolean | no | Return the full raw label->field index of all general-settings fields. |

### horoshop_admin_prro_get

**Read the Checkbox ПРРО (fiscalization) settings** · read-only

Read the store's Checkbox.ua ПРРО (Ukrainian fiscal receipts) configuration from the general-settings form. Returns all 17 fields by human name: the mode toggles (`enabled`, `automaticReceipts`, `useTax`), receipt sending (`sendCheckOnEmail`, `sendCheckViaSms`), receipt layout (`footer`, `deliveryTitle`, `paymentTitle`), delivery-in-receipt (`deliveryAsProduct`, `deliveryArticle`, `deliveryTaxCode`) and payment-fee-in-receipt (`paymentAsProduct`, `paymentArticle`, `paymentTaxCode`). SECRETS ARE MASKED: `login`, `password` and `cashboxLicenseKey` are never returned as their value - only whether they are set and their length. The two tax-code selects are reported read-only (their stored value is not in the form markup). Read-only tool.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `allowLarge` | boolean | no | Default false. The answer is MEASURED before it is returned, and a payload over the size limit (default 100 KB, override with HOROSHOP_MAX_RESPONSE_BYTES) is REFUSED with its measured size and how to narrow it, instead of overflowing the conversation. Set true to get the whole thing anyway. |
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |

### horoshop_admin_prro_set

**Set the Checkbox ПРРО (fiscalization) settings** · write, idempotent

Write the store's Checkbox.ua ПРРО settings on the general-settings form (read-modify-write, then verify by re-reading). Writable keys: booleans `enabled`, `automaticReceipts`, `useTax`, `sendCheckOnEmail`, `sendCheckViaSms`, `deliveryAsProduct`, `paymentAsProduct`; texts `footer`, `deliveryTitle`, `paymentTitle`, `deliveryArticle`, `paymentArticle`; and the SECRETS `login`, `password`, `cashboxLicenseKey`. Secrets are accepted but NEVER echoed back - the plan/verify report shows a masked placeholder, so a write can't leak the key. The tax-code selects (`deliveryTaxCode`, `paymentTaxCode`) are NOT writable here: they render unselected, so blindly resubmitting them would overwrite the stored value with the placeholder - set those via horoshop_admin_record_save with an explicit, valid option instead. DRY RUN BY DEFAULT: pass dryRun:false to apply.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `enabled` | boolean | no | Checkbox ПРРО: включить |
| `automaticReceipts` | boolean | no | Checkbox ПРРО: автосоздание чеков |
| `useTax` | boolean | no | Checkbox ПРРО: передавать налоги |
| `login` | string | no | Checkbox ПРРО: логин кассира (secret - not echoed back) |
| `password` | string | no | Checkbox ПРРО: пароль кассира (secret - not echoed back) |
| `cashboxLicenseKey` | string | no | Checkbox ПРРО: ключ лицензии кассы (secret - not echoed back) |
| `sendCheckOnEmail` | boolean | no | Checkbox ПРРО: чек на email |
| `sendCheckViaSms` | boolean | no | Checkbox ПРРО: чек по SMS |
| `footer` | string | no | Checkbox ПРРО: доп. информация в чеке (footer) |
| `deliveryTitle` | string | no | Checkbox ПРРО: название доставки в чеке |
| `paymentTitle` | string | no | Checkbox ПРРО: название наценки на оплату |
| `deliveryAsProduct` | boolean | no | Checkbox ПРРО: доставка как товар в чеке |
| `deliveryArticle` | string | no | Checkbox ПРРО: артикул доставки |
| `paymentAsProduct` | boolean | no | Checkbox ПРРО: комиссия как товар в чеке |
| `paymentArticle` | string | no | Checkbox ПРРО: артикул комиссии |
| `deliveryTaxCode` | string | no | Checkbox ПРРО: код налога для доставки - READ-ONLY here (unselected select); passing it is rejected with instructions. |
| `paymentTaxCode` | string | no | Checkbox ПРРО: код налога комиссии - READ-ONLY here (unselected select); passing it is rejected with instructions. |
| `dryRun` | boolean | no | Default true: preview the change. Set false to apply. |

### horoshop_admin_tracking_get

**List the store's marketing / tracking services** · read-only

Read the «Маркетинг → Маркетингові сервіси» screen: every analytics and tracking integration the store has, with its NAME, whether it is switched on, its tracking id, and where the snippet is injected (inside <head> / after <body> / before </body>). This is the panel that holds GTM (head and noscript), Facebook Pixel, Facebook SDK, Google Tag (GA4 / Google Ads), TikTok Pixel, eSputnik, Binotel call tracking and Google Customer Reviews. It also AUDITS what it finds: a service switched on whose `{SYSTEM_ID}` placeholder has no id to fill it (a broken snippet on every page), and an id whose shape is wrong for its service - a domain name once sat unnoticed in a live store's GA4 field, which is why this check exists. Read-only. For the store-wide free-form script blocks (custom JS in <head>/<body>) see horoshop_admin_settings_tracking - a different screen.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `allowLarge` | boolean | no | Default false. The answer is MEASURED before it is returned, and a payload over the size limit (default 100 KB, override with HOROSHOP_MAX_RESPONSE_BYTES) is REFUSED with its measured size and how to narrow it, instead of overflowing the conversation. Set true to get the whole thing anyway. |
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `onlyEnabled` | boolean | no | Default false (all services). True: return only the ones that are switched on. |

### horoshop_admin_tracking_set

**Switch a marketing / tracking service on or off and set its id** · write, idempotent

Configure one tracking service BY NAME - the everyday job of connecting a client's analytics. `service` takes a human name or a common alias: "GTM head", "GTM noscript", "GA4", "Google Ads", "Facebook Pixel", "Facebook SDK", "TikTok", "eSputnik", "Binotel", "Google Customer Reviews" (an ambiguous name is refused with the candidates, never guessed). Set `enabled` to switch it on/off, `identifier` for the tracking id, `position` for where the snippet goes ("head" / "after_body" / "body_end"). THE ID IS CHECKED AGAINST THE SERVICE'S FORMAT and a mismatch is reported as a WARNING - GTM-XXXXXXX for Tag Manager, G-XXXXXXXXXX for GA4, AW-XXXXXXXXX for Google Ads, 15–16 digits for a Meta pixel - plus a universal check for a URL or domain in the id field, which is what a live client store turned out to have in its GA4 row. Warnings do not block: formats change. ONE HARD REFUSAL: switching a service ON while its `{SYSTEM_ID}` placeholder would have nothing to fill it with, because that publishes a broken snippet on every page. Pass force:true if you really mean it. DRY RUN BY DEFAULT - pass dryRun:false to apply; the change is verified by re-reading the record.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `store` | string | no | Configured store name to target (e.g. "myshop"). Omit to use the default store. |
| `service` | string | yes | Which service - a name or alias ("GA4", "Facebook Pixel", "GTM head"), or its numeric record id. |
| `enabled` | boolean | no | Switch the service on (true) or off (false). |
| `identifier` | string | no | The tracking id substituted into the snippet ("G-XXXXXXXXXX", "GTM-XXXXXXX", "AW-XXXXXXXXX", a 15–16 digit pixel id…). Pass "" to clear it. |
| `position` | string \| integer | no | Where the snippet is injected: "head", "after_body", "body_end" (or the numeric code 3 / 1 / 2). |
| `force` | boolean | no | Default false. True: allow switching the service on with an empty tracking id (publishes the snippet with an unfilled placeholder). |
| `dryRun` | boolean | no | Default true: preview the change. Set false to apply. |
