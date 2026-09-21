#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { HoroshopClient } from "./client.js";
import { registerTools, type ToolSpec } from "./register.js";
import { startupLine, VERSION } from "./buildInfo.js";
import { systemTools } from "./tools/system.js";
import { catalogTools } from "./tools/catalog.js";
import { orderTools } from "./tools/orders.js";
import { adminOrderTools } from "./tools/adminOrders.js";
import { pageTools } from "./tools/pages.js";
import { userTools } from "./tools/users.js";
import { productSetTools } from "./tools/productSets.js";
import { referenceTools } from "./tools/reference.js";
import { b2bTools } from "./tools/b2b.js";
import { hookTools } from "./tools/hooks.js";
import { adminTools } from "./tools/admin.js";
import { adminGenericTools } from "./tools/adminGeneric.js";
import { adminRedirectTools } from "./tools/adminRedirects.js";
import { adminDesignTools } from "./tools/adminDesign.js";
import { adminDictionaryTools } from "./tools/adminDictionaries.js";
import { adminLanguageTools } from "./tools/adminLanguages.js";
import { adminTemplateTools } from "./tools/adminTemplates.js";
import { adminSchemaTools } from "./tools/adminSchema.js";
import { shopCartTools } from "./tools/shopCart.js";
import { adminShopTools } from "./tools/adminShop.js";
import { adminSettingsTools } from "./tools/adminSettings.js";
import { adminSeoTools } from "./tools/adminSeo.js";
import { adminPrroTools } from "./tools/adminPrro.js";
import { adminUploadTools } from "./tools/adminUpload.js";
import { adminBannerTools } from "./tools/adminBanners.js";
import { adminBlogTools } from "./tools/adminBlog.js";
import { adminCategoryTools } from "./tools/adminCategory.js";
import { adminFilterTools } from "./tools/adminFilters.js";
import { adminFilterPresetTools } from "./tools/adminFilterPreset.js";
import { adminL10nTools } from "./tools/adminL10n.js";
import { adminExportTools } from "./tools/adminExport.js";
import { adminProductGroupTools } from "./tools/adminProductGroup.js";
import { adminProductPriceTools } from "./tools/adminProductPrice.js";
import { adminTrackingTools } from "./tools/adminTracking.js";
import { adminFeedTools } from "./tools/adminFeeds.js";
import { adminPriceImportTools } from "./tools/adminPriceImport.js";
import { adminImportImageTools } from "./tools/adminImportImages.js";
import { adminReportTools } from "./tools/adminReports.js";

async function main(): Promise<void> {
  // Build visibility (FIX #1): announce which build this process is running, so a
  // "dist is newer than the process" mismatch is noticeable in the server log.
  console.error(startupLine());

  const config = loadConfig();

  const storeCount = Object.keys(config.stores).length;
  if (storeCount === 0) {
    // Not fatal: the server still advertises its tools so a client can inspect
    // them; calls return an actionable "no stores configured" error.
    console.error(
      "[horoshop-mcp] No stores configured. Set HOROSHOP_STORES (JSON) or HOROSHOP_STORES_FILE.",
    );
  }

  const client = new HoroshopClient(config);
  const server = new McpServer({ name: "horoshop-mcp", version: VERSION });

  const allTools: ToolSpec[] = [
    ...systemTools,
    ...catalogTools,
    ...orderTools,
    ...adminOrderTools,
    ...pageTools,
    ...userTools,
    ...productSetTools,
    ...referenceTools,
    ...b2bTools,
    ...hookTools,
    ...adminTools,
    ...adminGenericTools,
    ...adminRedirectTools,
    ...adminDesignTools,
    ...adminDictionaryTools,
    ...adminLanguageTools,
    ...adminTemplateTools,
    ...adminSchemaTools,
    ...shopCartTools,
    ...adminShopTools,
    ...adminSettingsTools,
    ...adminSeoTools,
    ...adminPrroTools,
    ...adminUploadTools,
    ...adminBannerTools,
    ...adminBlogTools,
    ...adminCategoryTools,
    ...adminFilterTools,
    ...adminFilterPresetTools,
    ...adminL10nTools,
    ...adminExportTools,
    ...adminProductGroupTools,
    ...adminProductPriceTools,
    ...adminTrackingTools,
    ...adminFeedTools,
    ...adminPriceImportTools,
    ...adminImportImageTools,
    ...adminReportTools,
  ];
  registerTools(server, client, allTools);

  await server.connect(new StdioServerTransport());
  // stdout is the JSON-RPC channel — all logging must go to stderr.
  console.error(
    `[horoshop-mcp] ready — ${allTools.length} tools, ${storeCount} store(s) configured.`,
  );
}

main().catch((e) => {
  console.error(
    `[horoshop-mcp] fatal: ${e instanceof Error ? e.message : String(e)}`,
  );
  process.exit(1);
});
