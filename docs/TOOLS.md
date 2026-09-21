# Tool reference

Generated from the server's own `tools/list` answer: **118 tools**. Do not edit by hand; run `npm run docs:tools` after changing a tool.

Every tool accepts an optional `store` argument (the store name from your configuration). Access labels come from the MCP tool annotations: **read-only** tools never change the store; **destructive** tools can delete or overwrite data and usually require `dryRun:false` plus an explicit confirmation.

Agents: `tools.json` next to this file is the same index without the prose - one compact record per tool.

## Sections

| Section | Tools | Reference |
|---|---|---|
| Setup and diagnostics | 2 | [tools/setup-and-diagnostics.md](tools/setup-and-diagnostics.md) |
| Catalog (public API) | 4 | [tools/catalog-public-api.md](tools/catalog-public-api.md) |
| Orders (public API) | 3 | [tools/orders-public-api.md](tools/orders-public-api.md) |
| Categories, users, product sets (public API) | 5 | [tools/categories-users-product-sets-public-api.md](tools/categories-users-product-sets-public-api.md) |
| Payment, delivery, currency (public API) | 5 | [tools/payment-delivery-currency-public-api.md](tools/payment-delivery-currency-public-api.md) |
| B2B (public API) | 2 | [tools/b2b-public-api.md](tools/b2b-public-api.md) |
| Webhooks (public API) | 2 | [tools/webhooks-public-api.md](tools/webhooks-public-api.md) |
| Storefront: cart and checkout | 6 | [tools/storefront-cart-and-checkout.md](tools/storefront-cart-and-checkout.md) |
| Admin panel: generic engine | 6 | [tools/admin-panel-generic-engine.md](tools/admin-panel-generic-engine.md) |
| Admin panel: orders and analytics | 8 | [tools/admin-panel-orders-and-analytics.md](tools/admin-panel-orders-and-analytics.md) |
| Admin panel: products, prices, images | 9 | [tools/admin-panel-products-prices-images.md](tools/admin-panel-products-prices-images.md) |
| Admin panel: characteristics and dictionaries | 15 | [tools/admin-panel-characteristics-and-dictionaries.md](tools/admin-panel-characteristics-and-dictionaries.md) |
| Admin panel: categories, pages, blog, banners, filters | 12 | [tools/admin-panel-categories-pages-blog-banners-filters.md](tools/admin-panel-categories-pages-blog-banners-filters.md) |
| Admin panel: SEO, sitemap, redirects | 11 | [tools/admin-panel-seo-sitemap-redirects.md](tools/admin-panel-seo-sitemap-redirects.md) |
| Admin panel: marketplace feeds | 6 | [tools/admin-panel-marketplace-feeds.md](tools/admin-panel-marketplace-feeds.md) |
| Admin panel: design and localization | 8 | [tools/admin-panel-design-and-localization.md](tools/admin-panel-design-and-localization.md) |
| Admin panel: store settings, marketing, fiscal receipts | 14 | [tools/admin-panel-store-settings-marketing-fiscal-receipts.md](tools/admin-panel-store-settings-marketing-fiscal-receipts.md) |

## All tools

| Tool | Access | Summary |
|---|---|---|
| [`horoshop_list_stores`](tools/setup-and-diagnostics.md#horoshop_list_stores) | read-only | List configured stores |
| [`horoshop_check_auth`](tools/setup-and-diagnostics.md#horoshop_check_auth) | read-only | Check store authentication |
| [`horoshop_catalog_export`](tools/catalog-public-api.md#horoshop_catalog_export) | read-only | Export catalog products |
| [`horoshop_catalog_import`](tools/catalog-public-api.md#horoshop_catalog_import) | destructive write, idempotent | Import / update catalog products |
| [`horoshop_catalog_process_images`](tools/catalog-public-api.md#horoshop_catalog_process_images) | destructive write | Process FTP-uploaded images |
| [`horoshop_icons_export`](tools/catalog-public-api.md#horoshop_icons_export) | read-only | Export stickers / icons |
| [`horoshop_orders_get`](tools/orders-public-api.md#horoshop_orders_get) | read-only | Get orders |
| [`horoshop_orders_update`](tools/orders-public-api.md#horoshop_orders_update) | destructive write, idempotent | Update orders |
| [`horoshop_orders_get_statuses`](tools/orders-public-api.md#horoshop_orders_get_statuses) | read-only | Get available order statuses |
| [`horoshop_pages_export`](tools/categories-users-product-sets-public-api.md#horoshop_pages_export) | read-only | Export categories |
| [`horoshop_users_export`](tools/categories-users-product-sets-public-api.md#horoshop_users_export) | read-only | Export users |
| [`horoshop_users_import`](tools/categories-users-product-sets-public-api.md#horoshop_users_import) | write, idempotent | Import / update users |
| [`horoshop_product_set_import`](tools/categories-users-product-sets-public-api.md#horoshop_product_set_import) | write, idempotent | Import / update product sets |
| [`horoshop_product_set_remove`](tools/categories-users-product-sets-public-api.md#horoshop_product_set_remove) | destructive write, idempotent | Remove product sets |
| [`horoshop_payment_export`](tools/payment-delivery-currency-public-api.md#horoshop_payment_export) | read-only | Export payment options |
| [`horoshop_payment_methods`](tools/payment-delivery-currency-public-api.md#horoshop_payment_methods) | read-only | Export payment methods |
| [`horoshop_delivery_export`](tools/payment-delivery-currency-public-api.md#horoshop_delivery_export) | read-only | Export delivery options |
| [`horoshop_delivery_types`](tools/payment-delivery-currency-public-api.md#horoshop_delivery_types) | read-only | Export delivery types |
| [`horoshop_currency_export`](tools/payment-delivery-currency-public-api.md#horoshop_currency_export) | read-only | Export currencies and rates |
| [`horoshop_customer_groups_export`](tools/b2b-public-api.md#horoshop_customer_groups_export) | read-only | Export customer groups (B2B) |
| [`horoshop_price_levels_export`](tools/b2b-public-api.md#horoshop_price_levels_export) | read-only | Export price levels (B2B) |
| [`horoshop_hooks_subscribe`](tools/webhooks-public-api.md#horoshop_hooks_subscribe) | write | Subscribe to a webhook |
| [`horoshop_hooks_unsubscribe`](tools/webhooks-public-api.md#horoshop_hooks_unsubscribe) | destructive write, idempotent | Unsubscribe from a webhook |
| [`horoshop_cart_get`](tools/storefront-cart-and-checkout.md#horoshop_cart_get) | read-only | Read the buyer's cart |
| [`horoshop_cart_add`](tools/storefront-cart-and-checkout.md#horoshop_cart_add) | write | Add a product to the cart |
| [`horoshop_cart_set_quantity`](tools/storefront-cart-and-checkout.md#horoshop_cart_set_quantity) | write | Change a cart line's quantity |
| [`horoshop_cart_remove`](tools/storefront-cart-and-checkout.md#horoshop_cart_remove) | write | Remove a cart line |
| [`horoshop_cart_apply_coupon`](tools/storefront-cart-and-checkout.md#horoshop_cart_apply_coupon) | write | Apply a coupon to the cart |
| [`horoshop_checkout_inspect`](tools/storefront-cart-and-checkout.md#horoshop_checkout_inspect) | read-only | Inspect the checkout page |
| [`horoshop_admin_login_check`](tools/admin-panel-generic-engine.md#horoshop_admin_login_check) | read-only | Check admin session |
| [`horoshop_admin_entities`](tools/admin-panel-generic-engine.md#horoshop_admin_entities) | read-only | List admin entity types |
| [`horoshop_admin_record_get`](tools/admin-panel-generic-engine.md#horoshop_admin_record_get) | read-only | Read any admin record |
| [`horoshop_admin_list`](tools/admin-panel-generic-engine.md#horoshop_admin_list) | read-only | List admin records |
| [`horoshop_admin_record_delete`](tools/admin-panel-generic-engine.md#horoshop_admin_record_delete) | destructive write, idempotent | Delete admin records |
| [`horoshop_admin_record_save`](tools/admin-panel-generic-engine.md#horoshop_admin_record_save) | write, idempotent | Write any admin record |
| [`horoshop_admin_order_resolve`](tools/admin-panel-orders-and-analytics.md#horoshop_admin_order_resolve) | read-only | Resolve an order number to its admin record id |
| [`horoshop_admin_order_get`](tools/admin-panel-orders-and-analytics.md#horoshop_admin_order_get) | read-only | Read one order from the admin editor |
| [`horoshop_admin_order_update`](tools/admin-panel-orders-and-analytics.md#horoshop_admin_order_update) | write, idempotent | Edit an order's recipient, delivery and payment |
| [`horoshop_admin_order_status_change`](tools/admin-panel-orders-and-analytics.md#horoshop_admin_order_status_change) | destructive write, idempotent | Change an order's status (and return stock on cancel) |
| [`horoshop_admin_order_delete`](tools/admin-panel-orders-and-analytics.md#horoshop_admin_order_delete) | destructive write, idempotent | Delete an order (both halves) |
| [`horoshop_admin_order_print_url`](tools/admin-panel-orders-and-analytics.md#horoshop_admin_order_print_url) | read-only | Build the delivery-note print URL |
| [`horoshop_admin_order_status_set`](tools/admin-panel-orders-and-analytics.md#horoshop_admin_order_status_set) | write, idempotent | Create or edit an order status |
| [`horoshop_admin_reports_dashboard`](tools/admin-panel-orders-and-analytics.md#horoshop_admin_reports_dashboard) | read-only | Read the store analytics dashboard (Аналитика) |
| [`horoshop_admin_product_stock_set`](tools/admin-panel-products-prices-images.md#horoshop_admin_product_stock_set) | write | Set a product's warehouse stock |
| [`horoshop_admin_upload_image`](tools/admin-panel-products-prices-images.md#horoshop_admin_upload_image) | write | Upload a file into any admin media field (logos, favicon, covers, brand/benefit/colour/payment images, avatars) |
| [`horoshop_admin_export_characteristics`](tools/admin-panel-products-prices-images.md#horoshop_admin_export_characteristics) | write | Export a product template's characteristics to Excel |
| [`horoshop_admin_products_group_edit`](tools/admin-panel-products-prices-images.md#horoshop_admin_products_group_edit) | write, idempotent | Bulk-edit products (grid group operations) |
| [`horoshop_admin_products_merge`](tools/admin-panel-products-prices-images.md#horoshop_admin_products_merge) | destructive write | Merge products into one modification group |
| [`horoshop_admin_products_price_set`](tools/admin-panel-products-prices-images.md#horoshop_admin_products_price_set) | destructive write, idempotent | Bulk-set product prices (by article, with guards and rollback) |
| [`horoshop_admin_price_import_parse`](tools/admin-panel-products-prices-images.md#horoshop_admin_price_import_parse) | read-only | Parse a supplier price list from a URL (read-only) and propose a column mapping |
| [`horoshop_admin_price_import_run`](tools/admin-panel-products-prices-images.md#horoshop_admin_price_import_run) | destructive write | Dry-run or execute a supplier price-list import |
| [`horoshop_admin_import_images`](tools/admin-panel-products-prices-images.md#horoshop_admin_import_images) | write | Bulk-import local images by file name |
| [`horoshop_admin_dictionaries`](tools/admin-panel-characteristics-and-dictionaries.md#horoshop_admin_dictionaries) | read-only | List attribute dictionaries |
| [`horoshop_admin_dictionary_create`](tools/admin-panel-characteristics-and-dictionaries.md#horoshop_admin_dictionary_create) | write | Create a new attribute dictionary |
| [`horoshop_admin_dictionary_rename`](tools/admin-panel-characteristics-and-dictionaries.md#horoshop_admin_dictionary_rename) | write, idempotent | Rename an attribute dictionary |
| [`horoshop_admin_dictionary_delete`](tools/admin-panel-characteristics-and-dictionaries.md#horoshop_admin_dictionary_delete) | destructive write, idempotent | Delete an attribute dictionary |
| [`horoshop_admin_dictionary_values`](tools/admin-panel-characteristics-and-dictionaries.md#horoshop_admin_dictionary_values) | read-only | List dictionary values |
| [`horoshop_admin_dictionary_value_delete`](tools/admin-panel-characteristics-and-dictionaries.md#horoshop_admin_dictionary_value_delete) | destructive write, idempotent | Delete a dictionary value |
| [`horoshop_admin_dictionary_value_set`](tools/admin-panel-characteristics-and-dictionaries.md#horoshop_admin_dictionary_value_set) | write, idempotent | Translate / rename a dictionary value |
| [`horoshop_admin_dictionary_add_value`](tools/admin-panel-characteristics-and-dictionaries.md#horoshop_admin_dictionary_add_value) | write, idempotent | Create a dictionary value (via a product's characteristic) |
| [`horoshop_admin_product_templates`](tools/admin-panel-characteristics-and-dictionaries.md#horoshop_admin_product_templates) | read-only | List product templates |
| [`horoshop_admin_product_template_get`](tools/admin-panel-characteristics-and-dictionaries.md#horoshop_admin_product_template_get) | read-only | Read a product template |
| [`horoshop_admin_product_template_set`](tools/admin-panel-characteristics-and-dictionaries.md#horoshop_admin_product_template_set) | write, idempotent | Edit a product template |
| [`horoshop_admin_template_schema`](tools/admin-panel-characteristics-and-dictionaries.md#horoshop_admin_template_schema) | read-only | Read a category's characteristic schema |
| [`horoshop_admin_template_param_add`](tools/admin-panel-characteristics-and-dictionaries.md#horoshop_admin_template_param_add) | write, idempotent | Add a characteristic to a category |
| [`horoshop_admin_template_param_books`](tools/admin-panel-characteristics-and-dictionaries.md#horoshop_admin_template_param_books) | read-only | List dictionaries a characteristic can use |
| [`horoshop_admin_template_param_delete`](tools/admin-panel-characteristics-and-dictionaries.md#horoshop_admin_template_param_delete) | destructive write | Delete a characteristic from a category |
| [`horoshop_admin_page_get`](tools/admin-panel-categories-pages-blog-banners-filters.md#horoshop_admin_page_get) | read-only | Read page/category (admin) |
| [`horoshop_admin_page_seo_set`](tools/admin-panel-categories-pages-blog-banners-filters.md#horoshop_admin_page_seo_set) | write, idempotent | Set page/category SEO (admin) |
| [`horoshop_admin_banner_create`](tools/admin-panel-categories-pages-blog-banners-filters.md#horoshop_admin_banner_create) | write | Create a banner with its image (homepage / above-header / contacts lines) |
| [`horoshop_admin_blog_post_create`](tools/admin-panel-categories-pages-blog-banners-filters.md#horoshop_admin_blog_post_create) | write | Create a blog / news article (with optional cover) |
| [`horoshop_admin_blog_post_update`](tools/admin-panel-categories-pages-blog-banners-filters.md#horoshop_admin_blog_post_update) | write, idempotent | Update a blog / news article (text, SEO, cover) |
| [`horoshop_admin_page_create`](tools/admin-panel-categories-pages-blog-banners-filters.md#horoshop_admin_page_create) | write | Create an info/text page that actually opens on the storefront |
| [`horoshop_admin_category_create`](tools/admin-panel-categories-pages-blog-banners-filters.md#horoshop_admin_category_create) | write | Create a catalog category (SEO + SEO-text + cover) in one call |
| [`horoshop_admin_category_update`](tools/admin-panel-categories-pages-blog-banners-filters.md#horoshop_admin_category_update) | write, idempotent | Update a catalog category (title, SEO, SEO-text, flags, cover) |
| [`horoshop_admin_indexed_filter_create`](tools/admin-panel-categories-pages-blog-banners-filters.md#horoshop_admin_indexed_filter_create) | write | Create an indexed (SEO) filter with several conditions |
| [`horoshop_admin_indexed_filter_update`](tools/admin-panel-categories-pages-blog-banners-filters.md#horoshop_admin_indexed_filter_update) | write, idempotent | Update an indexed (SEO) filter (title, page, conditions) |
| [`horoshop_admin_filter_preset_create`](tools/admin-panel-categories-pages-blog-banners-filters.md#horoshop_admin_filter_preset_create) | write | Create an SEO filter preset (custom slug + SEO block) in one call |
| [`horoshop_admin_filter_preset_update`](tools/admin-panel-categories-pages-blog-banners-filters.md#horoshop_admin_filter_preset_update) | write | Update an SEO filter preset (page, params, slug, SEO block) |
| [`horoshop_admin_redirect_list`](tools/admin-panel-seo-sitemap-redirects.md#horoshop_admin_redirect_list) | read-only | List URL redirects |
| [`horoshop_admin_redirect_create`](tools/admin-panel-seo-sitemap-redirects.md#horoshop_admin_redirect_create) | write | Create URL redirect |
| [`horoshop_admin_redirect_update`](tools/admin-panel-seo-sitemap-redirects.md#horoshop_admin_redirect_update) | write, idempotent | Update an existing URL redirect |
| [`horoshop_admin_redirect_bulk_create`](tools/admin-panel-seo-sitemap-redirects.md#horoshop_admin_redirect_bulk_create) | write | Create URL redirects in bulk (list or file) |
| [`horoshop_admin_redirect_generate_slashes`](tools/admin-panel-seo-sitemap-redirects.md#horoshop_admin_redirect_generate_slashes) | write | Mass-generate trailing-slash redirects |
| [`horoshop_admin_redirect_delete`](tools/admin-panel-seo-sitemap-redirects.md#horoshop_admin_redirect_delete) | destructive write, idempotent | Delete URL redirect |
| [`horoshop_admin_seo_settings_get`](tools/admin-panel-seo-sitemap-redirects.md#horoshop_admin_seo_settings_get) | read-only | Read the additional SEO settings (pagination canonical/noindex, breadcrumbs) |
| [`horoshop_admin_seo_settings_set`](tools/admin-panel-seo-sitemap-redirects.md#horoshop_admin_seo_settings_set) | write, idempotent | Set the additional SEO settings (self-POST screen) |
| [`horoshop_admin_robots_get`](tools/admin-panel-seo-sitemap-redirects.md#horoshop_admin_robots_get) | read-only | Read the store's live robots.txt |
| [`horoshop_admin_sitemap_regenerate`](tools/admin-panel-seo-sitemap-redirects.md#horoshop_admin_sitemap_regenerate) | write, idempotent | Regenerate the store's XML sitemap |
| [`horoshop_admin_sitemap_status`](tools/admin-panel-seo-sitemap-redirects.md#horoshop_admin_sitemap_status) | read-only | Read the store's XML sitemap (index + child URL counts) |
| [`horoshop_admin_feed_list`](tools/admin-panel-marketplace-feeds.md#horoshop_admin_feed_list) | read-only | List marketplace feeds with their public URLs and live status |
| [`horoshop_admin_feed_set`](tools/admin-panel-marketplace-feeds.md#horoshop_admin_feed_set) | write, idempotent | Switch a marketplace feed on/off, or change its alias |
| [`horoshop_admin_feed_generate`](tools/admin-panel-marketplace-feeds.md#horoshop_admin_feed_generate) | write | Generate a marketplace feed file and verify the public URL serves it |
| [`horoshop_admin_feed_params_get`](tools/admin-panel-marketplace-feeds.md#horoshop_admin_feed_params_get) | read-only | Read one feed's parameter mapping (availability / product condition) |
| [`horoshop_admin_feed_params_set`](tools/admin-panel-marketplace-feeds.md#horoshop_admin_feed_params_set) | write, idempotent | Map / unmap a feed parameter value, or flip its two feed-level flags |
| [`horoshop_admin_feed_categories_get`](tools/admin-panel-marketplace-feeds.md#horoshop_admin_feed_categories_get) | read-only | Read a feed's category screen: local tree, marketplace tree, mapping |
| [`horoshop_admin_design_get`](tools/admin-panel-design-and-localization.md#horoshop_admin_design_get) | read-only | Read design config (application JSON) |
| [`horoshop_admin_design_set`](tools/admin-panel-design-and-localization.md#horoshop_admin_design_set) | write, idempotent | Edit design config (application JSON) |
| [`horoshop_admin_css_get`](tools/admin-panel-design-and-localization.md#horoshop_admin_css_get) | read-only | Read custom CSS |
| [`horoshop_admin_css_set`](tools/admin-panel-design-and-localization.md#horoshop_admin_css_set) | write, idempotent | Set custom CSS |
| [`horoshop_admin_languages`](tools/admin-panel-design-and-localization.md#horoshop_admin_languages) | read-only | List store languages |
| [`horoshop_admin_language_set`](tools/admin-panel-design-and-localization.md#horoshop_admin_language_set) | write, idempotent | Edit a store language |
| [`horoshop_admin_interface_translation_get`](tools/admin-panel-design-and-localization.md#horoshop_admin_interface_translation_get) | read-only | Find interface translation strings |
| [`horoshop_admin_interface_translation_set`](tools/admin-panel-design-and-localization.md#horoshop_admin_interface_translation_set) | write, idempotent | Set an interface translation string |
| [`horoshop_admin_checkout_option_set`](tools/admin-panel-store-settings-marketing-fiscal-receipts.md#horoshop_admin_checkout_option_set) | write, idempotent | Enable/disable or retitle a checkout option |
| [`horoshop_admin_store_contacts`](tools/admin-panel-store-settings-marketing-fiscal-receipts.md#horoshop_admin_store_contacts) | write | Read or set the store's contacts |
| [`horoshop_admin_store_info_set`](tools/admin-panel-store-settings-marketing-fiscal-receipts.md#horoshop_admin_store_info_set) | write, idempotent | Set store name, address, hours and product-card info tabs |
| [`horoshop_admin_coupons_generate`](tools/admin-panel-store-settings-marketing-fiscal-receipts.md#horoshop_admin_coupons_generate) | write | Generate gift certificates / discount coupons |
| [`horoshop_admin_settings_tracking`](tools/admin-panel-store-settings-marketing-fiscal-receipts.md#horoshop_admin_settings_tracking) | write, idempotent | Read or set the store's tracking / analytics scripts |
| [`horoshop_admin_settings_checkout`](tools/admin-panel-store-settings-marketing-fiscal-receipts.md#horoshop_admin_settings_checkout) | write, idempotent | Read or set checkout / order-form options |
| [`horoshop_admin_settings_catalog`](tools/admin-panel-store-settings-marketing-fiscal-receipts.md#horoshop_admin_settings_catalog) | write, idempotent | Read or set catalog behaviour options |
| [`horoshop_admin_settings_brand`](tools/admin-panel-store-settings-marketing-fiscal-receipts.md#horoshop_admin_settings_brand) | write, idempotent | Read or set brand texts, timezone, map and moderation |
| [`horoshop_admin_settings_social_auth`](tools/admin-panel-store-settings-marketing-fiscal-receipts.md#horoshop_admin_settings_social_auth) | write, idempotent | Read or set social login providers |
| [`horoshop_admin_settings_get`](tools/admin-panel-store-settings-marketing-fiscal-receipts.md#horoshop_admin_settings_get) | read-only | Read any general setting, or list what settings exist |
| [`horoshop_admin_prro_get`](tools/admin-panel-store-settings-marketing-fiscal-receipts.md#horoshop_admin_prro_get) | read-only | Read the Checkbox ПРРО (fiscalization) settings |
| [`horoshop_admin_prro_set`](tools/admin-panel-store-settings-marketing-fiscal-receipts.md#horoshop_admin_prro_set) | write, idempotent | Set the Checkbox ПРРО (fiscalization) settings |
| [`horoshop_admin_tracking_get`](tools/admin-panel-store-settings-marketing-fiscal-receipts.md#horoshop_admin_tracking_get) | read-only | List the store's marketing / tracking services |
| [`horoshop_admin_tracking_set`](tools/admin-panel-store-settings-marketing-fiscal-receipts.md#horoshop_admin_tracking_set) | write, idempotent | Switch a marketing / tracking service on or off and set its id |
