import { storeField, type ToolSpec } from "../register.js";
import { buildStatus } from "../buildInfo.js";

export const systemTools: ToolSpec[] = [
  {
    name: "horoshop_list_stores",
    title: "List configured stores",
    description:
      "List the Horoshop stores this server is configured for — names and base URLs only, never credentials. Use a returned name as the `store` argument on any other tool. The store marked isDefault is used when `store` is omitted. Also returns `serverBuild` — the build this running process is executing, with `stale:true` when dist/ on disk is newer (someone rebuilt but did not restart the MCP process).",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async (client) => ({ stores: client.listStores(), serverBuild: buildStatus() }),
  },
  {
    name: "horoshop_check_auth",
    title: "Check store authentication",
    description:
      "Verify that the configured credentials authenticate against a store, without exposing the token. Run this first when other calls return UNAUTHORIZED. Horoshop tokens live 600 s and are refreshed by the server automatically. Returns `serverBuild`: the build id + timestamp of the code THIS process is running, with `stale:true` (and a restart note) when dist/ on disk is newer — i.e. the server was rebuilt but not restarted, so it is still serving old tool schemas/behaviour.",
    inputSchema: { ...storeField },
    annotations: { readOnlyHint: true },
    handler: async (client, args) => {
      const { name } = client.resolveStore(args.store);
      // Cheap authenticated read that exercises the full auth + token flow.
      // A store that does not implement the probe method still authenticated —
      // the token was accepted — so that must not read as an auth failure.
      let probe = "payment/exportMethods";
      try {
        await client.call(args.store, probe);
      } catch (e) {
        if (!(e instanceof Error && /UNDEFINED_FUNCTION/.test(e.message))) throw e;
        probe = "payment/exportMethods (not implemented here; auth itself succeeded)";
      }
      return {
        status: "OK",
        store: name,
        probe,
        serverBuild: buildStatus(),
        message:
          "Credentials authenticate. Tokens are valid for 600 s and refresh automatically.",
      };
    },
  },
];
