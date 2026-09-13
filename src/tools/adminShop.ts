import { z } from "zod";
import { storeField, type ToolSpec } from "../register.js";
import { LANG_INDEX, INDEX_LANG, fieldValue, type ParsedForm } from "../admin/form.js";

/**
 * Profile wrappers over things the generic writer can technically do, but only
 * if you already know the handler id and the exact form field name — e.g.
 * `payment_type[enabled]` vs `delivery[enabled]` vs `names[enabled]` for what is
 * conceptually the same checkbox. Every one of these was a hand-written
 * record_save before; here they are the thing you actually wanted to do.
 */

const LANGS = ["ua", "ru", "en", "pl", "ro"] as const;
const langMap = z.object(Object.fromEntries(LANGS.map((l) => [l, z.string().optional()])) as any).partial();

/**
 * Read the order-status list from the public API — an independent witness for a
 * write made through the admin form. Returns null when the store does not
 * implement the method, so a missing witness reads as "unverified" rather than
 * as "the write failed".
 *
 * The method name matters: `orders/get_statuses` is UNDEFINED on Horoshop (the
 * documented one is `orders/get_available_statuses`, which is what the public
 * horoshop_orders_get_statuses tool calls). This used to ask for the wrong one,
 * get `{status:"UNDEFINED_FUNCTION", response:[]}` back with no error, read zero
 * statuses out of it and then report a perfectly good save as "No new status
 * appeared — check the titles".
 */
async function readOrderStatuses(
  client: any,
  store: string | undefined,
): Promise<Record<string, any> | null> {
  try {
    const body: any = await client.call(store, "orders/get_available_statuses");
    return body?.response?.statuses ?? {};
  } catch (e) {
    if (e instanceof Error && /UNDEFINED_FUNCTION/.test(e.message)) return null;
    throw e;
  }
}

/** Field prefixes differ per entity ("payment_type", "delivery", "names"); find it. */
function prefixOf(form: ParsedForm, suffix: string): string | undefined {
  const re = new RegExp(`^(.+)\\[${suffix.replace(/[[\]]/g, "\\$&")}\\]$`);
  for (const f of form.fields) {
    const m = f.name.match(re);
    if (m) return m[1];
  }
  return undefined;
}

function i18nPrefix(form: ParsedForm, field: string): string | undefined {
  const re = new RegExp(`^(.+)\\[i18n\\]\\[\\d+\\]\\[${field}\\]$`);
  for (const f of form.fields) {
    const m = f.name.match(re);
    if (m) return m[1];
  }
  return undefined;
}

const CHECKOUT_ENTITY = { payment: "payment_methods", delivery: "delivery_methods" } as const;

export const adminShopTools: ToolSpec[] = [
  {
    name: "horoshop_admin_checkout_option_set",
    title: "Enable/disable or retitle a checkout option",
    description:
      "Turn a payment or delivery option on/off and/or retitle it per language — the thing that decides what a buyer can actually pick at checkout. `kind` picks the list, `id` is the option id from horoshop_payment_export / horoshop_delivery_export. Verify the result where it matters with horoshop_checkout_inspect: an option enabled here but missing there never reached the buyer. DRY RUN BY DEFAULT.",
    inputSchema: {
      ...storeField,
      kind: z.enum(["payment", "delivery"]).describe("Which checkout list this option belongs to."),
      id: z.union([z.number().int(), z.string()]).describe("Option id (from payment_export / delivery_export)."),
      enabled: z.boolean().optional().describe("Show or hide the option at checkout."),
      titles: langMap.optional().describe("Per-language title, e.g. {\"ua\":\"Нова пошта\",\"ru\":\"Новая почта\"}."),
      dryRun: z.boolean().optional().describe("Default true: preview. Set false to apply."),
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
    handler: async (client, args) => {
      const entity = CHECKOUT_ENTITY[args.kind as "payment" | "delivery"];
      const handler = args.kind === "payment" ? 234 : 235;
      const table = args.kind === "payment" ? "h_payment_type" : "h_delivery_type";
      const form = await client.admin.getEditForm(args.store, { id: args.id, handler, handlertable: table });

      const set: Record<string, string> = {};
      if (args.enabled != null) {
        const p = prefixOf(form, "enabled");
        if (!p) throw new Error(`No enabled checkbox on this ${args.kind} option's form.`);
        set[`${p}[enabled]`] = args.enabled ? "1" : "0";
      }
      const titles = (args.titles ?? {}) as Record<string, string>;
      if (Object.keys(titles).length) {
        const p = i18nPrefix(form, "title");
        if (!p) throw new Error(`No per-language title field on this ${args.kind} option's form.`);
        for (const [lang, val] of Object.entries(titles)) {
          const idx = LANG_INDEX[lang];
          if (idx) set[`${p}[i18n][${idx}][title]`] = val;
        }
      }
      if (!Object.keys(set).length) throw new Error("Nothing to do: pass `enabled` and/or `titles`.");

      const planned = Object.entries(set).map(([field, to]) => ({ field, from: fieldValue(form, field), to }));
      if (args.dryRun !== false) return { kind: args.kind, id: String(args.id), dryRun: true, willChange: planned };

      const res = await client.admin.save(args.store, form, set);
      const after = await client.admin.getEditForm(args.store, { id: args.id, handler, handlertable: table });
      const changes = planned.map((p) => ({ ...p, persisted: fieldValue(after, p.field) === p.to }));
      const ok = changes.every((c) => c.persisted);
      return {
        kind: args.kind,
        id: String(args.id),
        dryRun: false,
        saved: ok,
        httpStatus: res.httpStatus,
        changes,
        entity,
        note: ok
          ? "Saved and verified. Confirm it reached the buyer with horoshop_checkout_inspect (needs a non-empty cart)."
          : "Some fields did not persist.",
      };
    },
  },
  {
    name: "horoshop_admin_order_status_set",
    title: "Create or edit an order status",
    description:
      "Create or edit an order status — the labels your orders move through, in every language. Omit `id` to create. `successful` marks the status that counts as a completed sale (it drives reporting), `inReports` includes it in report totals. Read the current list with horoshop_orders_get_statuses. DRY RUN BY DEFAULT. " +
      "`titles` IS REQUIRED even when you only want to flip a flag on an existing status — the schema has no optional marker on it, so a call carrying just `id` and `successful` is rejected by validation before it ever reaches the store. Pass `titles:{}` to change flags only.",
    inputSchema: {
      ...storeField,
      id: z.union([z.number().int(), z.string()]).optional().describe("Status id to edit; omit to create a new one."),
      titles: langMap.describe("Per-language title, e.g. {\"ua\":\"Оплачено\",\"ru\":\"Оплачен\",\"en\":\"Paid\"}."),
      successful: z.boolean().optional().describe("Counts as a successful sale."),
      inReports: z.boolean().optional().describe("Include in report totals."),
      sortOrder: z.number().int().optional().describe("Position in the list."),
      dryRun: z.boolean().optional().describe("Default true: preview. Set false to apply."),
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
    handler: async (client, args) => {
      const isCreate = args.id == null;
      const id = isCreate ? "addnew" : String(args.id);
      const form = await client.admin.getEditForm(args.store, { id, handler: 436, handlertable: "h_order_statuses" });
      const set: Record<string, string> = {};
      for (const [lang, val] of Object.entries((args.titles ?? {}) as Record<string, string>)) {
        const idx = LANG_INDEX[lang];
        if (idx) set[`names[i18n][${idx}][title]`] = val;
      }
      if (args.successful != null) set["names[is_successful]"] = args.successful ? "1" : "0";
      if (args.inReports != null) set["names[include_in_reports]"] = args.inReports ? "1" : "0";
      if (args.sortOrder != null) set["names[sortorder]"] = String(args.sortOrder);
      if (!Object.keys(set).length) throw new Error("Nothing to do: pass titles and/or flags.");

      if (args.dryRun !== false) {
        return { dryRun: true, creating: isCreate, willSet: set };
      }
      const before = isCreate ? await readOrderStatuses(client, args.store) : null;
      await client.admin.save(args.store, form, set);
      // The public API is an independent read path — a far better witness than
      // re-reading the same admin form we just posted. When the store does not
      // expose it, say the write is unverified; do not call it failed.
      const statuses = await readOrderStatuses(client, args.store);
      if (statuses === null) {
        return {
          dryRun: false,
          saved: true,
          verified: false,
          creating: isCreate,
          note: "Saved through the admin form, but NOT verified: this store does not implement orders/get_available_statuses, so there is no independent read path to confirm it. Check the status list in the admin panel.",
        };
      }
      if (isCreate) {
        const had = new Set(Object.keys(before ?? {}));
        const fresh = Object.keys(statuses).filter((k) => !had.has(k));
        return {
          dryRun: false,
          created: fresh.length > 0,
          verified: true,
          newId: fresh.length === 1 ? fresh[0] : null,
          status: fresh.length === 1 ? statuses[fresh[0]] : undefined,
          note: fresh.length === 1
            ? `Created status id ${fresh[0]}, confirmed via the public API.`
            : "No new status appeared — check the titles.",
        };
      }
      return { dryRun: false, saved: true, verified: true, id, status: statuses[id], note: "Saved; value read back from the public API." };
    },
  },
  {
    name: "horoshop_admin_store_contacts",
    title: "Read or set the store's contacts",
    description:
      "Read or replace the phones/messengers/e-mails a buyer sees in the header and on the contacts page. These are not in the design config or the public API: they live in a table the admin builds in JavaScript, so this is the only way to reach them from here. ONE TABLE HOLDS EVERY LANGUAGE, told apart only by a per-row language cell — so a read lists ALL languages (each row carries `lang`, plus `countByLang`), and a write REPLACES ONLY THE ROWS OF THE LANGUAGE YOU PASS (`lang`, default ua) while every other language is resent untouched. ⚠ `lang` decides WHICH ROWS ARE REPLACED, but it does NOT tag the rows you create: Horoshop stamps every new contact row with the store's own main language and ignores the one sent (measured — a row written as ru read back as ua). The write detects this and answers `languageForcedByPlatform` + `WARNING_LANG` rather than pretending; to have a row in another language it has to already exist there. It used to drop the whole table and resend just one language, which silently deleted the other languages' phones from the storefront; the write now reports `countByLang` and warns if any language lost rows. Within the chosen language it is a full replace — the admin has no per-row delete from outside. Types: phone, viber, telegram, whatsapp, email, raw. DRY RUN BY DEFAULT (the preview shows what is replaced and what is preserved).",
    inputSchema: {
      ...storeField,
      contacts: z
        .array(
          z.object({
            type: z.enum(["phone", "viber", "telegram", "whatsapp", "email", "raw"]),
            value: z.string().describe("The real value: +380…, a handle, an address."),
            display: z.string().optional().describe("What the site shows, e.g. \"067 000 00 00\"."),
            icon: z.string().optional().describe("auto (default) | ks | vodafone | life | phone."),
          }),
        )
        .optional()
        .describe("Omit to just read the current contacts."),
      lang: z.enum(LANGS).optional().describe("Language these contacts belong to. Default ua."),
      dryRun: z.boolean().optional().describe("Default true: preview. Set false to apply."),
    },
    annotations: { readOnlyHint: false },
    handler: async (client, args) => {
      const URL_ = "/adminLegacy/utils/site_settings.php?checkcode=yamete_kudasai";
      const form = await client.admin.getFormFromUrl(args.store, URL_);
      // One contacts table holds EVERY language's rows, told apart only by the
      // `i18n_language` cell. Collect each row whole: a row we are keeping has to
      // go back exactly as it came, including cells this tool has no opinion about.
      const collect = (f: ParsedForm) => {
        const rows: Record<string, Record<string, string>> = {};
        for (const fld of f.fields) {
          const m = fld.name.match(/^extra\[contacts_data\]\[common\]\[(\d+)\]\[(\w+)\]$/);
          if (m) (rows[m[1]] ??= {})[m[2]] = fld.value;
        }
        return Object.values(rows);
      };
      const langOf = (r: Record<string, string>) =>
        INDEX_LANG[Number(r.i18n_language)] ?? String(r.i18n_language ?? "?");
      const view = (rows: Record<string, string>[]) =>
        rows.map((r) => ({ id: r.id, lang: langOf(r), type: r.type, value: r.value, display: r.display_value }));

      const existing = collect(form);
      const current = view(existing);
      const byLang = (rows: { lang: string }[]) =>
        rows.reduce<Record<string, number>>((acc, r) => ((acc[r.lang] = (acc[r.lang] ?? 0) + 1), acc), {});
      if (!args.contacts) {
        return {
          contacts: current,
          count: current.length,
          countByLang: byLang(current),
          note: "Rows of ALL languages are listed; `lang` says which one each belongs to. A write replaces only the rows of the language you pass.",
        };
      }

      const idx = LANG_INDEX[args.lang ?? "ua"] ?? 3;
      const lang = INDEX_LANG[idx] ?? String(idx);
      // Replace only this language's rows; every other language is preserved.
      // Dropping the whole table (which this once did) deleted the other
      // languages' phones outright — nothing errored, the storefront just lost
      // them, and no re-read complained because the tool never showed languages.
      const keep = existing.filter((r) => String(r.i18n_language) !== String(idx));
      const replaced = existing.length - keep.length;

      const set: Record<string, string> = {};
      let slot = 0;
      for (const r of keep) {
        for (const [k, v] of Object.entries(r)) set[`extra[contacts_data][common][${slot}][${k}]`] = v;
        slot++;
      }
      (args.contacts as any[]).forEach((c, i) => {
        const at = (k: string, v: string) => (set[`extra[contacts_data][common][${slot}][${k}]`] = v);
        at("id", "NEW");
        at("i18n_language", String(idx));
        at("type", c.type);
        at("value", c.value);
        at("display_value", c.display ?? c.value);
        at("icon", c.icon ?? "auto");
        at("sort_order", String(i));
        slot++;
      });

      if (args.dryRun !== false) {
        return {
          dryRun: true,
          lang,
          current,
          currentByLang: byLang(current),
          wouldSet: args.contacts,
          preserved: view(keep),
          note:
            `Replaces the ${lang} rows only: ${replaced} ${lang} contact(s) → ${(args.contacts as any[]).length}. ` +
            `${keep.length} row(s) in other languages are resent unchanged. Set dryRun:false to apply.`,
        };
      }
      // The rows are positional, so they are rebuilt from scratch: strip every
      // existing row from the form and send `set`, which already carries both the
      // preserved rows and the new ones, renumbered without gaps.
      const withoutRows: ParsedForm = {
        ...form,
        fields: form.fields.filter((f) => !/^extra\[contacts_data\]\[common\]\[\d+\]/.test(f.name)),
      };
      await client.admin.save(args.store, withoutRows, set);
      const after = await client.admin.getFormFromUrl(args.store, URL_);
      const now = view(collect(after));
      const lostLangs = Object.entries(byLang(current))
        .filter(([l, n]) => l !== lang && (byLang(now)[l] ?? 0) < n)
        .map(([l]) => l);
      // The per-row language cell is NOT honoured for rows we create: Horoshop
      // stamps a new row with the store's own main language whatever we send.
      // Measured on the test store — a row written as ru read back as ua. Say so
      // instead of letting `lang` imply a per-language write that did not happen.
      const wanted = (args.contacts as any[]).length;
      const landed = now.filter((r) => r.lang === lang).length;
      const languageForced = wanted > 0 && landed < wanted;
      return {
        dryRun: false,
        lang,
        saved: now.length > 0,
        contacts: now,
        countByLang: byLang(now),
        ...(lostLangs.length ? { WARNING: `Rows disappeared in: ${lostLangs.join(", ")} — this should not happen, verify the storefront.` } : {}),
        ...(languageForced
          ? {
              languageForcedByPlatform: true,
              WARNING_LANG: `Asked for ${lang}, but only ${landed} of ${wanted} new row(s) came back as ${lang} — Horoshop stamps new contact rows with the store's main language and ignores the one sent. The rows ARE saved (see countByLang); they just are not tagged ${lang}. Editing an existing row keeps its language.`,
            }
          : {}),
        note: "Saved. These render in the site header and on the contacts page — check with a storefront fetch if it matters.",
      };
    },
  },
  {
    name: "horoshop_admin_store_info_set",
    title: "Set store name, address, hours and product-card info tabs",
    description:
      "Set the store's general information: display name, and per-language address, timetable, and the text of FOUR of the product card's info tabs — delivery, payment, returns, warranty. Those tabs are prime CRO space and the design config only references them as {\"source\":\"db\"} — they live here. HTML is allowed in the tab texts. DRY RUN BY DEFAULT. " +
      "The fifth tab, «Консультация», has no parameter here: it is `extra[i18n][<langId>][info_consult]` on the general-settings form and is written with horoshop_admin_record_save entity=site_settings (find the exact field with horoshop_admin_settings_get index:true). " +
      "SAVING RESUBMITS THE WHOLE SETTINGS FORM: like every other general-settings writer here, this posts all ~373 fields of utils/site_settings.php back at once. There is no versioning or ETag, so a change somebody is making in the browser at the same moment is overwritten without a word.",
    inputSchema: {
      ...storeField,
      siteName: z.string().optional().describe("Store display name, e.g. \"My Shop\"."),
      lang: z.enum(LANGS).optional().describe("Language for the text fields below. Default ua."),
      address: z.string().optional(),
      timetable: z.string().optional().describe("e.g. \"Пн–Пт 10:00–19:00\"."),
      infoDelivery: z.string().optional().describe("Product card \"Доставка\" tab (HTML ok)."),
      infoPayment: z.string().optional().describe("Product card \"Оплата\" tab (HTML ok)."),
      infoReturn: z.string().optional().describe("Product card \"Повернення\" tab (HTML ok)."),
      infoWarranty: z.string().optional().describe("Product card \"Гарантія\" tab (HTML ok)."),
      dryRun: z.boolean().optional().describe("Default true: preview. Set false to apply."),
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
    handler: async (client, args) => {
      const URL_ = "/adminLegacy/utils/site_settings.php?checkcode=yamete_kudasai";
      const form = await client.admin.getFormFromUrl(args.store, URL_);
      const idx = LANG_INDEX[args.lang ?? "ua"] ?? 3;
      const set: Record<string, string> = {};
      const put = (field: string, v?: string) => {
        if (v != null) set[`extra[i18n][${idx}][${field}]`] = v;
      };
      if (args.siteName != null) set["extra[site_name]"] = args.siteName;
      put("address", args.address);
      put("timetable", args.timetable);
      put("info_delivery", args.infoDelivery);
      put("info_payment", args.infoPayment);
      put("info_return", args.infoReturn);
      put("info_warranty", args.infoWarranty);
      if (!Object.keys(set).length) throw new Error("Nothing to set.");

      const planned = Object.entries(set).map(([field, to]) => ({ field, from: fieldValue(form, field), to }));
      if (args.dryRun !== false) return { dryRun: true, willChange: planned };

      const res = await client.admin.save(args.store, form, set);
      const after = await client.admin.getFormFromUrl(args.store, URL_);
      const changes = planned.map((p) => ({ ...p, persisted: fieldValue(after, p.field) === p.to }));
      const ok = changes.every((c) => c.persisted);
      return {
        dryRun: false,
        saved: ok,
        httpStatus: res.httpStatus,
        changes: changes.map((c) => ({ field: c.field, persisted: c.persisted })),
        note: ok ? "Saved and verified." : "Some fields did not persist.",
      };
    },
  },
  {
    name: "horoshop_admin_coupons_generate",
    title: "Generate gift certificates / discount coupons",
    description:
      "Mass-generate discount codes — the «Сгенерировать сертификаты» button on Скидки → Сертификаты и купоны. Horoshop invents the codes itself (10-character, e.g. ZY86929093); you choose the kind, the value, how many, and when they expire. " +
      "Two kinds: `certificate` is a GIFT CERTIFICATE worth a fixed amount of money (`amount` is in the store's currency) and is spent once; `coupon` is a PERCENTAGE discount (`amount` is the percent) that can be used `usesPerCoupon` times. " +
      "DRY RUN BY DEFAULT — this creates records in bulk and Horoshop allows up to 500 000 in one call, so the preview states exactly what would be created. Pass dryRun:false to generate; it then re-lists the grid and reports how many codes actually appeared plus a sample of them. " +
      "The generated codes are ordinary records: read them with horoshop_admin_list entity=coupons, edit one with horoshop_admin_record_save, remove them with horoshop_admin_record_delete. There is no bulk 'undo' — deleting a bad batch means deleting the ids it created.",
    inputSchema: {
      ...storeField,
      kind: z
        .enum(["certificate", "coupon"])
        .describe("certificate = fixed-value gift certificate (amount in money, single use) · coupon = percentage discount, reusable `usesPerCoupon` times."),
      amount: z
        .number()
        .positive()
        .describe("Value: the certificate's face value in store currency, or the coupon's discount PERCENT."),
      count: z
        .number()
        .int()
        .positive()
        .max(500000)
        .describe("How many codes to generate. Horoshop's own ceiling is 500 000 per call (it answers COUPON_LIMIT above it)."),
      validUntil: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe('Expiry date, "YYYY-MM-DD".'),
      usesPerCoupon: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("kind=coupon only: how many times each coupon may be used. Default 100 (the admin form's own default). Ignored for certificates, which are single-use."),
      dryRun: z.boolean().optional().describe("Default true: describe the batch without creating it. Set false to generate."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    handler: async (client, args) => {
      const COUPONS_HANDLER = 263;
      const isCoupon = args.kind === "coupon";
      const uses = isCoupon ? String(args.usesPerCoupon ?? 100) : undefined;
      const plan = {
        kind: args.kind,
        count: args.count,
        value: isCoupon ? `${args.amount}%` : `${args.amount} (store currency)`,
        ...(isCoupon ? { usesPerCoupon: Number(uses) } : { usesPerCoupon: 1 }),
        validUntil: args.validUntil,
      };

      const before: any[] = await client.admin.listRecords(args.store, COUPONS_HANDLER, {});
      if (args.dryRun !== false) {
        return {
          store: args.store ?? null,
          dryRun: true,
          willGenerate: plan,
          existingCodes: before.length,
          warning:
            `This CREATES ${args.count} new discount record(s). They are live the moment they exist (until ${args.validUntil}) — there is no bulk undo, only deleting the ids afterwards.`,
          note: "Nothing was written. Set dryRun:false to generate.",
        };
      }

      const params: Record<string, string> = {
        load: "generate_coupons",
        type: isCoupon ? "2" : "1",
        amount: String(args.amount),
        count: String(args.count),
        date_to: String(args.validUntil),
      };
      if (uses) params.quantity = uses;

      const r = await client.admin.postUrlencoded(args.store, "/adminLegacy/js/projectAjax.php", params, {
        accept: "application/json",
      });
      let body: any = {};
      try {
        body = JSON.parse(r.text);
      } catch {
        /* reported raw below */
      }
      if (body?.status === "COUPON_LIMIT") {
        throw new Error(`Horoshop refused the batch (COUPON_LIMIT): at most 500 000 codes per call, ${args.count} asked for.`);
      }
      if (body?.status !== "OK") {
        throw new Error(`Generation failed (HTTP ${r.httpStatus}, status ${body?.status ?? "?"}): ${r.text.slice(0, 200)}`);
      }

      const after: any[] = await client.admin.listRecords(args.store, COUPONS_HANDLER, {});
      const knownIds = new Set(before.map((x) => x.id));
      const created = after.filter((x) => !knownIds.has(x.id));
      return {
        store: args.store ?? null,
        dryRun: false,
        generated: plan,
        codesBefore: before.length,
        codesAfter: after.length,
        createdCount: created.length,
        sample: created.slice(0, 10).map((x) => ({ id: x.id, label: x.label })),
        note:
          created.length === args.count
            ? `Verified: ${created.length} code(s) now exist in the grid. Remove them with horoshop_admin_record_delete entity=coupons if this batch was wrong.`
            : `⚠ Asked for ${args.count}, the grid grew by ${created.length}. Re-list with horoshop_admin_list entity=coupons before generating again — a second call would add another full batch.`,
      };
    },
  },
];
