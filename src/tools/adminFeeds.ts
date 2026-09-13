import { z } from "zod";
import { storeField, type ToolSpec } from "../register.js";
import { fieldValue, type ParsedForm } from "../admin/form.js";

/**
 * MARKETPLACE FEEDS (Маркетинг → Маркетплейси, entity 429,
 * `h_marketplace_templates`) — the "put this shop on Rozetka / Hotline / Google
 * Merchant / Facebook / Kasta" screen, and the sub-screens hiding behind it.
 *
 * WHY THIS IS NOT JUST `record_save` ON 429. The 429 record itself is four
 * fields and generic already reaches them. Everything that MAKES A FEED WORK
 * lives somewhere else entirely:
 *
 *  - The public URL a marketplace actually pulls is
 *    `<base>/marketplace-integration/<system_name>/<marketplace_alias>` — it is
 *    composed from two fields of the record and appears nowhere in the admin as
 *    a copyable string.
 *  - That URL is 404 until someone presses «Сгенерировать feed», and 404 again
 *    the moment the feed is switched off. A feed row reading `enabled=1` is
 *    therefore NOT evidence that anything is being served.
 *  - The «Настроить категории» / «Настройка параметров» screens are not menu
 *    items and not form fields: they are three links rendered into the third
 *    grid column, and the platform only renders them for an ENABLED feed (a
 *    disabled row's control column is an empty `<div>`). That is why every
 *    earlier navigation-based recon missed them.
 *  - The feed's own parameter mapping (`/marketplace-integration/params/<id>`)
 *    is a DIFFERENT screen from entity 427 «Статусы наличия для площадок», even
 *    though the admin gives both the same name. 427 belongs to the export-file
 *    formats (Excel / YML / Prom / Google CSV — Rozetka is not even in its enum)
 *    and maps only `presence`; the feed one belongs to one feed and maps both
 *    374 «Наличие товаров: статус» AND 428 «Состояние товара».
 *
 * TRANSPORT. Two different stacks in one feature. The record is legacy
 * multipart `save.php`; the sub-screens are a Vue app on `apiRoot =
 * /marketplace-integration` answering `{status, response}` where `status` is an
 * APPLICATION status independent of the HTTP code — a disabled feed answers
 * `HTTP 200` + `{"status":"EXCEPTION","response":{"message":"The marketplace
 * \"rozetka-feed\" is not enabled"}}`. Reading the HTTP code alone reports that
 * as success with no data.
 *
 * ⛔ NOT WRAPPED ON PURPOSE: `GET /marketplace-integration/repository/
 * sync-external-data/<system_name>/`, the «Синхронизация категорий» button. It
 * fetches the marketplace's category tree from Rozetka's servers and REPLACES
 * the store's local taxonomy table with it ("Текущие категории будут сброшены и
 * синхронизированы…"). There is no inverse call, so a mistake is unrecoverable
 * through this API. Running it stays a human decision in the admin panel.
 */

const HANDLER = 429;
const HANDLERTABLE = "h_marketplace_templates";

const F = {
  title: "names[title]",
  enabled: "names[enabled]",
  alias: "names[marketplace_alias]",
  systemName: "names[system_name]",
  /** Service hidden, always resent verbatim — never set by hand. */
  configurable: "names[is_configurable_in_catalog]",
} as const;

interface Feed {
  id: string;
  title: string;
  systemName: string;
  alias: string;
  enabled: boolean;
  publicUrl: string;
  form: ParsedForm & { url: string };
}

function baseOf(client: any, store?: string): string {
  return String(client.resolveStore(store).conf.baseUrl).replace(/\/+$/, "");
}

/** Read one feed record (the edit form is the only place the alias lives). */
async function readFeed(client: any, store: string | undefined, id: string | number): Promise<Feed> {
  const form = await client.admin.getEditForm(store, { handler: HANDLER, id, handlertable: HANDLERTABLE });
  const systemName = fieldValue(form, F.systemName);
  const alias = fieldValue(form, F.alias);
  return {
    id: String(id),
    title: fieldValue(form, F.title),
    systemName,
    alias,
    // The pair hidden=0 + checkbox=1 shares one name; the parser keeps the
    // checkbox field ONLY when it is checked, so "the checkbox field exists"
    // is the on/off answer, and `fieldValue` (which returns the first match,
    // the hidden 0) is not.
    enabled: form.fields.some((f: any) => f.name === F.enabled && f.checkbox),
    publicUrl: `${baseOf(client, store)}/marketplace-integration/${systemName}/${alias}`,
    form,
  };
}

/** Every feed on the store, cheapest path: one grid read + one form per row. */
async function readAllFeeds(client: any, store?: string): Promise<Feed[]> {
  const rows = await client.admin.listRecords(store, HANDLER);
  const out: Feed[] = [];
  for (const r of rows) out.push(await readFeed(client, store, r.id));
  return out;
}

/**
 * Resolve a user-supplied feed reference to one record. Accepts the numeric id,
 * the `system_name` (`rozetka-feed`), or the exact title. Matching is strict and
 * whole-string: a substring match here would send «Google Feed for Merchant
 * Center» and «Фід відгуків для Google Merchant Center» to the same record.
 */
async function resolveFeed(client: any, store: string | undefined, ref: string | number): Promise<Feed> {
  const feeds = await readAllFeeds(client, store);
  const needle = String(ref).trim().toLowerCase();
  const hits = feeds.filter(
    (f) => f.id === needle || f.systemName.toLowerCase() === needle || f.title.trim().toLowerCase() === needle,
  );
  if (hits.length === 1) return hits[0];
  const listing = feeds.map((f) => `${f.id} ${f.systemName} («${f.title}»)`).join(" · ");
  if (hits.length === 0) {
    throw new Error(`No feed matches ${JSON.stringify(String(ref))} on this store. Feeds here: ${listing}.`);
  }
  throw new Error(`${JSON.stringify(String(ref))} matches ${hits.length} feeds — use the id. Feeds here: ${listing}.`);
}

/** Fetch the public feed URL and say what it really is (XML vs the 404 page). */
async function probePublic(client: any, store: string | undefined, url: string) {
  const r = await client.admin.fetchBytes(url);
  const ct = r.contentType ? r.contentType.split(";")[0].trim() : null;
  const live = r.httpStatus === 200 && !!ct && /xml/i.test(ct);
  return { httpStatus: r.httpStatus, contentType: ct, bytes: r.bytes.length, live };
}

/** Envelope check shared by every `/marketplace-integration/*` call. */
function unwrap(res: { httpStatus: number; status: string | null; response: any; text: string }, what: string): any {
  if (res.status === "OK") return res.response;
  if (res.status) {
    throw new Error(
      `${what} refused (HTTP ${res.httpStatus}, status ${res.status}): ${
        res.response?.message ?? JSON.stringify(res.response ?? {}).slice(0, 300)
      }`,
    );
  }
  throw new Error(`${what} did not answer JSON (HTTP ${res.httpStatus}): ${res.text.slice(0, 200)}`);
}

export const adminFeedTools: ToolSpec[] = [
  {
    name: "horoshop_admin_feed_list",
    title: "List marketplace feeds with their public URLs and live status",
    description:
      "Every marketplace feed the store has (Rozetka / Hotline / Google Merchant / Facebook / Kasta / Google reviews — entity 429), each with its id, `system_name`, title, on/off state, alias and — the part that exists nowhere in the admin as a copyable string — the PUBLIC URL a marketplace pulls: `<base>/marketplace-integration/<system_name>/<alias>`. " +
      "For every ENABLED feed it also fetches that URL and reports what actually comes back, because `enabled=1` is NOT evidence a feed is being served: the file is 404 until «Сгенерировать feed» has been pressed at least once (horoshop_admin_feed_generate), and 404 again the moment the feed is switched off. `live:true` means a real `text/xml` document answered. Disabled feeds are not fetched (they 404 by definition) — pass `probe:false` to skip the fetch entirely. " +
      "Read-only. Generic `horoshop_admin_list entity:marketplaces` shows the same six rows but only their titles: no alias (it lives in the edit form, not the grid), no URL, no proof anything is served.",
    inputSchema: {
      ...storeField,
      probe: z
        .boolean()
        .optional()
        .describe("Fetch each enabled feed's public URL to check it really serves XML. Default true."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: async (client, args) => {
      const feeds = await readAllFeeds(client, args.store);
      const probe = args.probe !== false;
      const out = [];
      for (const f of feeds) {
        const row: any = {
          id: f.id,
          systemName: f.systemName,
          title: f.title,
          enabled: f.enabled,
          alias: f.alias,
          publicUrl: f.publicUrl,
        };
        if (probe && f.enabled) row.public = await probePublic(client, args.store, f.publicUrl);
        out.push(row);
      }
      const enabled = out.filter((f) => f.enabled);
      const notes: string[] = [];
      if (enabled.length === 0) notes.push("No feed is switched on, so nothing is being served to any marketplace.");
      // An empty alias is not cosmetic: the public URL degenerates to
      // `…/marketplace-integration/<system_name>/` and there is nothing to hand
      // a marketplace. Measured on the test store: two of the six feeds ship this
      // way out of the box (kasta, google-review-feed).
      for (const f of out) {
        if (!f.alias) {
          notes.push(
            `«${f.title}» has an EMPTY alias, so it has no usable public URL. Give it one before enabling: horoshop_admin_feed_set {feed:"${f.systemName}", alias:"<32 hex chars>", confirm:true, dryRun:false} (the admin's «Сгенерировать» button produces a random 32-char hex string).`,
          );
        }
      }
      for (const f of enabled) {
        if (f.public && !f.public.live) {
          notes.push(
            `«${f.title}» is switched ON but its URL answers HTTP ${f.public.httpStatus} ${
              f.public.contentType ?? "?"
            } — the file has never been generated (or was invalidated). Run horoshop_admin_feed_generate.`,
          );
        }
      }
      return {
        store: args.store ?? null,
        count: out.length,
        enabledCount: enabled.length,
        feeds: out,
        ...(notes.length ? { problems: notes } : {}),
        subScreensNote:
          "«Настроить категории» / «Настройка параметров» exist only for an ENABLED feed — the platform renders those links into the grid's control column and leaves it empty for a disabled row. horoshop_admin_feed_categories_get and horoshop_admin_feed_params_get hit the same endpoints and will say so explicitly.",
      };
    },
  },

  {
    name: "horoshop_admin_feed_set",
    title: "Switch a marketplace feed on/off, or change its alias",
    description:
      "Enable or disable one feed (entity 429) and/or replace the secret `marketplace_alias` segment of its public URL. Takes the feed by id, `system_name` or exact title. Dry-run by default: pass `dryRun:false` to write. " +
      "TWO TRAPS THIS HANDLES. (1) `names[enabled]` is present TWICE in the form — a hidden `0` plus a checkbox `1` sharing one name, and PHP keeps the LAST one; the read-modify-write here reproduces exactly what a browser submits, which is why the state is verified by re-reading the record rather than trusting the 302. (2) The alias IS the URL: `…/marketplace-integration/<system_name>/<alias>`. Changing it silently breaks the link every marketplace already has on file, so an alias change needs `confirm:true` and the tool reports both the old and the new URL. " +
      "Switching a feed ON also makes its sub-screens («Настроить категории», «Настройка параметров», «Сгенерировать feed») exist at all. Switching it OFF makes the public XML 404 immediately, even if the file was generated. Nothing here regenerates the file — that is horoshop_admin_feed_generate.",
    inputSchema: {
      ...storeField,
      feed: z.union([z.number().int(), z.string()]).describe("Feed id, system_name (e.g. \"rozetka-feed\") or exact title."),
      enabled: z.boolean().optional().describe("Switch the feed on (true) or off (false). Omit to leave as is."),
      alias: z
        .string()
        .optional()
        .describe("New marketplace_alias — the secret segment of the public URL. Requires confirm:true; breaks the existing link."),
      confirm: z.boolean().optional().describe("Required to change the alias (an existing marketplace link stops working)."),
      dryRun: z.boolean().optional().describe("Default true — report the change without writing."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    handler: async (client, args) => {
      const feed = await resolveFeed(client, args.store, args.feed);
      const wantEnabled = typeof args.enabled === "boolean" ? args.enabled : feed.enabled;
      const wantAlias = args.alias != null ? String(args.alias).trim() : feed.alias;

      if (args.alias != null && wantAlias !== feed.alias && !args.confirm) {
        throw new Error(
          `Changing the alias of «${feed.title}» rewrites its public URL — every marketplace that already pulls ${feed.publicUrl} would start getting a 404. Re-send with confirm:true if that is intended.`,
        );
      }
      if (args.alias != null && !/^[A-Za-z0-9._-]{4,}$/.test(wantAlias)) {
        throw new Error(
          `Alias ${JSON.stringify(wantAlias)} is not a usable URL segment (expected at least 4 chars of A-Z a-z 0-9 . _ -). The platform's own «Сгенерировать» button produces a 32-char hex string.`,
        );
      }

      const willChange: string[] = [];
      if (wantEnabled !== feed.enabled) willChange.push(`enabled ${feed.enabled} → ${wantEnabled}`);
      if (wantAlias !== feed.alias) willChange.push(`alias ${feed.alias} → ${wantAlias}`);
      const newUrl = `${baseOf(client, args.store)}/marketplace-integration/${feed.systemName}/${wantAlias}`;

      if (willChange.length === 0) {
        return {
          store: args.store ?? null,
          feed: { id: feed.id, systemName: feed.systemName, title: feed.title },
          changed: false,
          state: { enabled: feed.enabled, alias: feed.alias, publicUrl: feed.publicUrl },
          note: "Nothing to do — the feed already holds these values.",
        };
      }
      if (args.dryRun !== false) {
        return {
          store: args.store ?? null,
          dryRun: true,
          feed: { id: feed.id, systemName: feed.systemName, title: feed.title },
          willChange,
          publicUrlAfter: newUrl,
          note:
            wantEnabled && !feed.enabled
              ? "Enabling only makes the feed's own screens and URL exist; the XML itself stays 404 until horoshop_admin_feed_generate runs."
              : !wantEnabled && feed.enabled
                ? "Disabling makes the public XML answer 404 immediately, generated or not."
                : undefined,
        };
      }

      // Read-modify-write. The enabled override is applied by name: buildMultipart
      // emits the override for the hidden and DROPS the checkbox part when the two
      // disagree, which is exactly the browser's own body.
      const overrides: Record<string, string> = { [F.enabled]: wantEnabled ? "1" : "0" };
      if (wantAlias !== feed.alias) overrides[F.alias] = wantAlias;
      const res = await client.admin.save(args.store, feed.form, overrides);

      const after = await readFeed(client, args.store, feed.id);
      const saved = after.enabled === wantEnabled && after.alias === wantAlias;
      if (!saved) {
        throw new Error(
          `save.php answered HTTP ${res.httpStatus} but the re-read still says enabled=${after.enabled}, alias=${after.alias} (wanted enabled=${wantEnabled}, alias=${wantAlias}).`,
        );
      }
      const out: any = {
        store: args.store ?? null,
        feed: { id: feed.id, systemName: feed.systemName, title: feed.title },
        saved: true,
        changed: willChange,
        state: { enabled: after.enabled, alias: after.alias, publicUrl: after.publicUrl },
      };
      if (after.enabled) out.public = await probePublic(client, args.store, after.publicUrl);
      if (after.enabled && out.public && !out.public.live) {
        out.note = "Feed is on, but its URL is not serving XML yet — run horoshop_admin_feed_generate.";
      }
      return out;
    },
  },

  {
    name: "horoshop_admin_feed_generate",
    title: "Generate a marketplace feed file and verify the public URL serves it",
    description:
      "Press «Сгенерировать feed» for one feed and then CHECK the result: the platform's own answer is a 24-byte sentence («Файл успешно сформирован») that says nothing about the document, so this tool fetches the public URL afterwards and reports the real content type, size and the number of `<offer>` entries in it. " +
      "Generation is local — the platform renders XML from the store's own catalog and sends nothing outward — but it is NOT idempotent and not instant on a large catalog: each call rewrites the file. " +
      "Refuses on a disabled feed (the endpoint would answer, and the URL would still 404). A feed that generates an EMPTY document — `<categories/><offers/>` — is the normal result when no category is marked for upload: that mapping lives in the feed's category screen, which needs the marketplace taxonomy synced from the marketplace's own servers first (a destructive, non-reversible step deliberately left to the admin panel — see horoshop_admin_feed_categories_get).",
    inputSchema: {
      ...storeField,
      feed: z.union([z.number().int(), z.string()]).describe("Feed id, system_name or exact title."),
      dryRun: z.boolean().optional().describe("Default false — this is the one action that has no read-only form. Pass true to see what would run."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    handler: async (client, args) => {
      const feed = await resolveFeed(client, args.store, args.feed);
      if (!feed.enabled) {
        throw new Error(
          `Feed «${feed.title}» (${feed.systemName}) is switched OFF. Generating would leave its URL answering 404 anyway — switch it on first with horoshop_admin_feed_set {feed:"${feed.systemName}", enabled:true, dryRun:false}.`,
        );
      }
      if (!feed.alias) {
        throw new Error(
          `Feed «${feed.title}» (${feed.systemName}) has an empty marketplace_alias, so its public URL is just ${baseOf(client, args.store)}/marketplace-integration/${feed.systemName}/ — there is nothing to hand a marketplace. Set an alias first: horoshop_admin_feed_set {feed:"${feed.systemName}", alias:"<32 hex chars>", confirm:true, dryRun:false}.`,
        );
      }
      const path = `/marketplace-integration/generate-feed/${feed.systemName}`;
      if (args.dryRun) {
        return {
          store: args.store ?? null,
          dryRun: true,
          wouldCall: `GET ${path}`,
          publicUrl: feed.publicUrl,
          note: "Rewrites the feed file from the current catalog. Local operation, but not idempotent and slow on a big catalog.",
        };
      }

      const gen = await client.admin.getText(args.store, path);
      const said = gen.text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
      const pub = await probePublic(client, args.store, feed.publicUrl);
      let offers: number | null = null;
      let xmlHead: string | null = null;
      if (pub.live) {
        const doc = await client.admin.getText(args.store, feed.publicUrl);
        offers = (doc.text.match(/<offer\b/g) ?? []).length;
        xmlHead = doc.text.slice(0, 240);
      }
      return {
        store: args.store ?? null,
        feed: { id: feed.id, systemName: feed.systemName, title: feed.title },
        generated: gen.httpStatus === 200,
        platformSaid: said,
        publicUrl: feed.publicUrl,
        public: pub,
        offers,
        xmlHead,
        ...(pub.live && offers === 0
          ? {
              warning:
                "The document is valid XML but carries zero offers — no category is marked for upload in this feed. That mapping lives in the feed's «Настроить категории» screen and needs the marketplace taxonomy synced first (done in the admin panel: the sync wipes the local taxonomy and is not reversible through this API).",
            }
          : {}),
        ...(!pub.live
          ? {
              warning: `The generator answered, but ${feed.publicUrl} came back HTTP ${pub.httpStatus} ${
                pub.contentType ?? "?"
              } — not XML. Check that the feed is still enabled and that the alias in the URL is current.`,
            }
          : {}),
      };
    },
  },

  {
    name: "horoshop_admin_feed_params_get",
    title: "Read one feed's parameter mapping (availability / product condition)",
    description:
      "The feed's own «Настройка параметров»: which of the STORE's values for 374 «Наличие товаров: статус» and 428 «Состояние товара» are sent as which MARKETPLACE value. Returns the marketplace's own vocabulary for this feed (`in stock` / `out of stock` / `preorder` for Google, `true` / `false` for Rozetka…), the store's local values, and the current correlation between them — plus the two feed-level flags `multipleLang` and `useSharedPhotosGallery`. " +
      "⚠ THIS IS NOT ENTITY 427. The admin calls two different screens «Настройка параметров». 427 «Статусы наличия для площадок» belongs to the EXPORT FILE FORMATS (Excel / Hotline / YML / Prom / Google CSV — Rozetka and Facebook are not in its enum at all) and maps only `presence`; generic `record_save entity:marketplace_availability` is the tool for that one. This tool is the per-FEED mapping, which also covers product condition. " +
      "Reads fine on a DISABLED feed — unlike the category screen, this endpoint does not check the switch. Read-only.",
    inputSchema: {
      ...storeField,
      feed: z.union([z.number().int(), z.string()]).describe("Feed id, system_name or exact title."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: async (client, args) => {
      const feed = await resolveFeed(client, args.store, args.feed);
      const res = await client.admin.getJson(args.store, `/marketplace-integration/params/${feed.id}`);
      const r = unwrap(res, `Reading parameters of feed «${feed.title}»`);

      const params: any[] = r.marketplaceParams ?? [];
      const locals: any[] = r.localValues ?? [];
      const correlation = r.correlation ?? {};
      const byHandler = locals.map((loc: any) => {
        const corr = correlation[String(loc.id)] ?? {};
        return {
          handlerId: loc.id,
          title: loc.title,
          values: (loc.values ?? []).map((v: any) => {
            const hit = corr[String(v.id)];
            const param = hit ? params.find((p) => String(p.id) === String(hit.id)) : null;
            return {
              localId: v.id,
              localTitle: v.title,
              mappedTo: param ? param.marketplace_value : null,
              marketplaceParamId: param ? param.id : null,
            };
          }),
        };
      });
      return {
        store: args.store ?? null,
        feed: { id: feed.id, systemName: feed.systemName, title: feed.title, enabled: feed.enabled },
        feedId: r.marketplaceFeed?.id ?? null,
        marketplaceId: r.marketplaceFeed?.marketplaceId ?? null,
        flags: {
          multipleLang: r.marketplaceFeed?.multipleLang ?? null,
          useSharedPhotosGallery: r.marketplaceFeed?.useSharedPhotosGallery ?? null,
        },
        marketplaceValues: params.map((p: any) => ({
          marketplaceParamId: p.id,
          handlerId: p.handler_id,
          name: p.name,
          value: p.marketplace_value,
          description: p.value_description,
        })),
        mapping: byHandler,
        unmapped: byHandler.flatMap((h) =>
          h.values.filter((v: any) => v.mappedTo === null).map((v: any) => `${h.title}: «${v.localTitle}» (${v.localId})`),
        ),
        note: "`feedId` (used by the flag writers) and `marketplaceId` are separate ids that happen to be equal on many stores — horoshop_admin_feed_params_set uses the right one for each call.",
      };
    },
  },

  {
    name: "horoshop_admin_feed_params_set",
    title: "Map / unmap a feed parameter value, or flip its two feed-level flags",
    description:
      "Write half of the feed's «Настройка параметров»: point one of the store's local values (374 «Наличие товаров: статус», 428 «Состояние товара») at one of the marketplace's own values, drop such a mapping, or set the feed flags `multipleLang` and `useSharedPhotosGallery`. Dry-run by default. " +
      "Identify the local value by its id (as listed by horoshop_admin_feed_params_get) and the marketplace value either by its `marketplaceParamId` or by its literal string (`in stock`, `true`, `used`…) — the string is matched WHOLE, not as a substring, and an ambiguous or unknown one is refused with the list of what this feed accepts. `action:\"unmap\"` removes the pairing for the given local value. " +
      "Every write is verified by re-reading the mapping. Mapping affects only what the generated XML says about a product; it does not touch the products themselves. Regenerate the feed afterwards for the change to reach the marketplace (horoshop_admin_feed_generate).",
    inputSchema: {
      ...storeField,
      feed: z.union([z.number().int(), z.string()]).describe("Feed id, system_name or exact title."),
      action: z.enum(["map", "unmap", "flags"]).describe("`map`/`unmap` a value pair, or `flags` to set multipleLang / useSharedPhotosGallery."),
      parameter: z
        .union([z.number().int(), z.string()])
        .optional()
        .describe(
          "Which parameter the local value belongs to: 374 «Наличие товаров: статус» or 428 «Состояние товара» (id or exact title). REQUIRED whenever the same localValueId exists under both — it does: 374 and 428 each have a value 3.",
        ),
      localValueId: z.union([z.number().int(), z.string()]).optional().describe("Local value id from feed_params_get (e.g. 1 = «В наличии»). Value ids are unique only WITHIN a parameter — pair with `parameter`. Required for map/unmap."),
      marketplaceValue: z.string().optional().describe("Marketplace value for `map` — its literal string (`in stock`, `true`, `used`) or its marketplaceParamId."),
      multipleLang: z.boolean().optional().describe("`flags`: export the feed in several languages."),
      useSharedPhotosGallery: z.boolean().optional().describe("`flags`: share one photo gallery across modifications (the admin exposes this for rozetka-feed only)."),
      dryRun: z.boolean().optional().describe("Default true — report the change without writing."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    handler: async (client, args) => {
      const feed = await resolveFeed(client, args.store, args.feed);
      const read = async () => unwrap(await client.admin.getJson(args.store, `/marketplace-integration/params/${feed.id}`), `Reading parameters of feed «${feed.title}»`);
      const before = await read();
      const feedId = before.marketplaceFeed?.id;
      const params: any[] = before.marketplaceParams ?? [];
      const locals: any[] = before.localValues ?? [];

      if (args.action === "flags") {
        const calls: Array<{ path: string; payload: any; label: string }> = [];
        if (typeof args.multipleLang === "boolean") {
          calls.push({
            path: "/marketplace-integration/params/setMultipleLang",
            payload: { feedId, multipleLang: args.multipleLang ? 1 : 0 },
            label: `multipleLang ${before.marketplaceFeed?.multipleLang} → ${args.multipleLang}`,
          });
        }
        if (typeof args.useSharedPhotosGallery === "boolean") {
          calls.push({
            path: "/marketplace-integration/params/setUseSharedPhotosGallery",
            payload: { feedId, useSharedPhotosGallery: args.useSharedPhotosGallery ? 1 : 0 },
            label: `useSharedPhotosGallery ${before.marketplaceFeed?.useSharedPhotosGallery} → ${args.useSharedPhotosGallery}`,
          });
        }
        if (calls.length === 0) throw new Error("action:\"flags\" needs multipleLang and/or useSharedPhotosGallery.");
        if (args.dryRun !== false) {
          return { store: args.store ?? null, dryRun: true, feed: { id: feed.id, systemName: feed.systemName }, feedId, willChange: calls.map((c) => c.label) };
        }
        for (const c of calls) unwrap(await client.admin.postJson(args.store, c.path, c.payload), c.label);
        const after = await read();
        return {
          store: args.store ?? null,
          saved: true,
          feed: { id: feed.id, systemName: feed.systemName },
          changed: calls.map((c) => c.label),
          flags: {
            multipleLang: after.marketplaceFeed?.multipleLang ?? null,
            useSharedPhotosGallery: after.marketplaceFeed?.useSharedPhotosGallery ?? null,
          },
        };
      }

      if (args.localValueId == null) throw new Error(`action:"${args.action}" needs localValueId (see horoshop_admin_feed_params_get → mapping[].values[].localId).`);
      const localId = String(args.localValueId);

      // WHICH PARAMETER DOES THIS VALUE BELONG TO? Local value ids are unique
      // only inside one parameter: 374 «Наличие товаров: статус» has 0,1,2,3,9
      // and 428 «Состояние товара» has 1,2,3, so a bare `localValueId:3` is
      // genuinely ambiguous. Taking the first match silently unmapped
      // 374/«Ожидается» while the caller meant 428/«б/у» — measured. So the
      // parameter is resolved explicitly, or inferred from the marketplace
      // value's own handler, or refused.
      const candidates = locals.filter((l: any) => (l.values ?? []).some((v: any) => String(v.id) === localId));
      const describeLocals = () =>
        locals.map((l: any) => `${l.id} «${l.title}»: ${(l.values ?? []).map((v: any) => `${v.id}=${v.title}`).join(", ")}`).join(" | ");
      if (candidates.length === 0) {
        throw new Error(`Local value ${localId} is not one of this feed's mappable values. Known: ${describeLocals()}`);
      }
      let owner: any = null;
      if (args.parameter != null) {
        const p = String(args.parameter).trim().toLowerCase();
        const hit = candidates.filter((l: any) => String(l.id) === p || String(l.title).trim().toLowerCase() === p);
        if (hit.length !== 1) {
          throw new Error(
            `parameter ${JSON.stringify(String(args.parameter))} does not name exactly one parameter holding value ${localId}. Parameters here: ${describeLocals()}`,
          );
        }
        owner = hit[0];
      } else if (candidates.length === 1) {
        owner = candidates[0];
      } else if (args.action === "map" && args.marketplaceValue) {
        // The marketplace value itself carries a handler_id — if it names one
        // value unambiguously, that settles which parameter is meant.
        const needle = String(args.marketplaceValue).trim().toLowerCase();
        const hits = params.filter(
          (p: any) => String(p.id) === needle || String(p.marketplace_value).trim().toLowerCase() === needle,
        );
        const handlers = new Set(hits.map((h: any) => String(h.handler_id)));
        if (hits.length > 0 && handlers.size === 1) {
          owner = candidates.find((c: any) => String(c.id) === [...handlers][0]) ?? null;
        }
      }
      if (!owner) {
        throw new Error(
          `Local value ${localId} exists under ${candidates.length} parameters (${candidates
            .map((c: any) => `${c.id} «${c.title}»`)
            .join(", ")}) — pass "parameter" to say which one. Parameters here: ${describeLocals()}`,
        );
      }
      const localTitle = (owner.values ?? []).find((v: any) => String(v.id) === localId)?.title ?? localId;
      const currentParamId = before.correlation?.[String(owner.id)]?.[localId]?.id ?? null;

      let target: any = null;
      if (args.action === "map") {
        if (!args.marketplaceValue) throw new Error('action:"map" needs marketplaceValue.');
        const needle = String(args.marketplaceValue).trim().toLowerCase();
        const sameHandler = params.filter((p: any) => String(p.handler_id) === String(owner.id));
        const hits = sameHandler.filter(
          (p: any) => String(p.id) === needle || String(p.marketplace_value).trim().toLowerCase() === needle,
        );
        if (hits.length !== 1) {
          const listing = sameHandler.map((p: any) => `${p.id}=«${p.marketplace_value}» (${p.value_description})`).join(" · ");
          throw new Error(
            hits.length === 0
              ? `«${args.marketplaceValue}» is not a value this feed sends for «${owner.title}». Accepted: ${listing}`
              : `«${args.marketplaceValue}» matches ${hits.length} values — use the marketplaceParamId. Accepted: ${listing}`,
          );
        }
        target = hits[0];
      }

      const label =
        args.action === "map"
          ? `${owner.title}: «${localTitle}» (${localId}) → «${target.marketplace_value}» (param ${target.id})`
          : `${owner.title}: «${localTitle}» (${localId}) → unmapped (was param ${currentParamId ?? "none"})`;

      if (args.action === "unmap" && currentParamId == null) {
        return { store: args.store ?? null, changed: false, note: `«${localTitle}» is not mapped to anything on this feed — nothing to remove.` };
      }
      if (args.dryRun !== false) {
        return { store: args.store ?? null, dryRun: true, feed: { id: feed.id, systemName: feed.systemName }, willChange: [label] };
      }

      const path = args.action === "map" ? "/marketplace-integration/params/updateParam" : "/marketplace-integration/params/removeParam";
      const payload =
        args.action === "map"
          ? { marketplaceParam: target.id, localId: Number(localId) }
          : { marketplaceParam: currentParamId, localId: Number(localId) };
      unwrap(await client.admin.postJson(args.store, path, payload), label);

      const after = await read();
      const nowParamId = after.correlation?.[String(owner.id)]?.[localId]?.id ?? null;
      const okNow = args.action === "map" ? String(nowParamId) === String(target.id) : nowParamId == null;
      if (!okNow) {
        throw new Error(`The call was accepted but the re-read still shows ${localTitle} → param ${nowParamId ?? "none"}.`);
      }
      return {
        store: args.store ?? null,
        saved: true,
        feed: { id: feed.id, systemName: feed.systemName },
        changed: [label],
        note: "Regenerate the feed (horoshop_admin_feed_generate) for the marketplace to see this.",
      };
    },
  },

  {
    name: "horoshop_admin_feed_categories_get",
    title: "Read a feed's category screen: local tree, marketplace tree, mapping",
    description:
      "The «Настроить категории» screen of one feed, read whole: the store's own category tree as the feed sees it, the marketplace's category tree, the configured category pairs (`jsonConfigs`, each with its marketplace category, local template and margin) and the characteristics taxonomy. This is the screen that decides WHICH categories are exported at all — a feed with no configured category generates a valid but empty document. " +
      "REQUIRES AN ENABLED FEED, and fails in a way worth knowing about: the endpoint answers HTTP 200 with `{\"status\":\"EXCEPTION\",\"response\":{\"message\":\"The marketplace … is not enabled\"}}`, so anything reading the HTTP code alone reports success with no data. This tool turns that into a plain \"switch the feed on first\". " +
      "Read-only, and deliberately read-only: the marketplace tree is populated by «Синхронизация категорий» (`repository/sync-external-data`), which pulls the tree from the marketplace's servers and RESETS the store's local taxonomy for that feed with no inverse call. That button is not wrapped by this server — run it in the admin panel if you accept it. Empty `marketplaceCategories` here means exactly that: the sync has never run for this feed.",
    inputSchema: {
      ...storeField,
      feed: z.union([z.number().int(), z.string()]).describe("Feed id, system_name or exact title."),
      full: z.boolean().optional().describe("Return the raw taxonomy arrays too (large). Default false — counts and the mapped pairs only."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: async (client, args) => {
      const feed = await resolveFeed(client, args.store, args.feed);
      if (!feed.enabled) {
        throw new Error(
          `Feed «${feed.title}» (${feed.systemName}) is switched OFF, and this screen only exists for an enabled feed — the platform answers HTTP 200 with status EXCEPTION «The marketplace "${feed.systemName}" is not enabled». Switch it on with horoshop_admin_feed_set {feed:"${feed.systemName}", enabled:true, dryRun:false} (its parameter mapping, unlike this, reads fine while off: horoshop_admin_feed_params_get).`,
        );
      }
      const res = await client.admin.postJson(args.store, "/marketplace-integration/init/getStartData", {
        marketplaceName: feed.systemName,
      });
      const r = unwrap(res, `Reading the category screen of «${feed.title}»`);
      const configs: any[] = r.jsonConfigs ?? [];
      const localTree: any[] = r.localCategoriesTree ?? [];
      const mpList: any[] = r.jsonMarketplaceCategoriesList ?? [];
      return {
        store: args.store ?? null,
        feed: { id: feed.id, systemName: feed.systemName, title: feed.title },
        marketplace: r.marketplace ?? null,
        localCategories: localTree.map((c: any) => ({ id: c.id, label: c.label, templateId: c.handler })),
        marketplaceCategoryCount: mpList.length,
        configuredPairs: configs.length,
        configs: configs.map((c: any) => ({
          configId: c.id ?? c.configId ?? null,
          marketplaceCategoryId: c.marketplaceCategoryId ?? c.external_category_id ?? null,
          localTemplateId: c.localHandlerId ?? c.handler_id ?? null,
          margin: c.margin ?? null,
        })),
        templates: r.jsonHandlers ?? null,
        ...(args.full
          ? {
              raw: {
                jsonMarketplaceCategoriesTree: r.jsonMarketplaceCategoriesTree ?? [],
                categoriesTaxonomy: r.categoriesTaxonomy ?? [],
                jsonHandlerTree: r.jsonHandlerTree ?? {},
              },
            }
          : {}),
        ...(mpList.length === 0
          ? {
              warning:
                "The marketplace's category tree is empty — «Синхронизация категорий» has never run for this feed, so no category pair can be created and the generated feed will carry zero offers. That sync fetches the tree from the marketplace and resets this store's local taxonomy for the feed; it has no undo, so it is not exposed here. Run it in the admin panel if you accept that.",
            }
          : {}),
      };
    },
  },
];
