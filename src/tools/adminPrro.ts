import { z } from "zod";
import { storeField, type ToolSpec } from "../register.js";
import { fieldValue, type ParsedForm } from "../admin/form.js";

/**
 * Named tools over the Ukrainian ПРРО (fiscalization) subsystem — the Checkbox.ua
 * integration. Its 17 fields live in the SAME general-settings singleton
 * (`utils/site_settings.php`) as adminSettings.ts, as `extra[checkbox_*]`, so
 * these tools reuse the exact same contract: getFormFromUrl → read, or
 * override + save + verify by re-reading. `save` is not reimplemented here.
 *
 * Two things make this its own tool rather than another adminSettings section:
 *
 *  1. Secrets. The cashier login/password and the cashbox licence key are
 *     credentials. `_get` never returns their value — it masks them (a bullet
 *     string plus the length), and `_set` never echoes a secret back either:
 *     the plan/verify report shows a masked placeholder, so a transcript of a
 *     write can't leak the key. (Same posture as payment_settings.)
 *
 *  2. The two tax-code selects. `checkbox_delivery_tax_code` and
 *     `checkbox_payment_tax_code` render as <select>s with NO selected option
 *     (the parser marks them `unselected`), and on this store they carry only
 *     the `0=[выберите]` placeholder — there is no real tax option to pick until
 *     Checkbox is configured. Blindly resubmitting them would overwrite the
 *     stored value with the placeholder (the same class of bug that dropped
 *     pages out of the tree), so they are exposed READ-ONLY here: `_get` reports
 *     them with their live options and a "value unknown" flag, and `_set`
 *     refuses them, pointing at record_save for a deliberate, explicit write.
 *
 * Field shapes verified live on a test store:
 *  - is_enabled / automatic_receipts / use_tax / send_check_on_email /
 *    send_check_via_sms / delivery_as_product / payment_as_product are booleans
 *    (hidden `=0`, plus a checkbox `=1` only when on — buildMultipart handles it).
 *  - login / password / cashbox_license_key are text (secrets).
 *  - footer / delivery_title / payment_title / delivery_article /
 *    payment_article are plain text.
 *  - delivery_tax_code / payment_tax_code are unselected selects (read-only).
 */

const SETTINGS_URL = "/adminLegacy/utils/site_settings.php?checkcode=yamete_kudasai";

type Kind = "bool" | "text" | "secret" | "taxcode";

interface FieldDef {
  /** Raw submitted field name. */
  field: string;
  kind: Kind;
  /** Russian admin label, for discovery and the tool descriptions. */
  label: string;
}

/** The 17 Checkbox ПРРО fields, grouped by the section of the admin form they sit in. */
const FIELDS = {
  // Enable / mode
  enabled: { field: "extra[checkbox_is_enabled]", kind: "bool", label: "Checkbox ПРРО: включить" },
  automaticReceipts: { field: "extra[checkbox_automatic_receipts]", kind: "bool", label: "Checkbox ПРРО: автосоздание чеков" },
  useTax: { field: "extra[checkbox_use_tax]", kind: "bool", label: "Checkbox ПРРО: передавать налоги" },
  // Access — SECRETS
  login: { field: "extra[checkbox_login]", kind: "secret", label: "Checkbox ПРРО: логин кассира" },
  password: { field: "extra[checkbox_password]", kind: "secret", label: "Checkbox ПРРО: пароль кассира" },
  cashboxLicenseKey: { field: "extra[checkbox_cashbox_license_key]", kind: "secret", label: "Checkbox ПРРО: ключ лицензии кассы" },
  // Send receipt
  sendCheckOnEmail: { field: "extra[checkbox_send_check_on_email]", kind: "bool", label: "Checkbox ПРРО: чек на email" },
  sendCheckViaSms: { field: "extra[checkbox_send_check_via_sms]", kind: "bool", label: "Checkbox ПРРО: чек по SMS" },
  // Receipt layout
  footer: { field: "extra[checkbox_footer]", kind: "text", label: "Checkbox ПРРО: доп. информация в чеке (footer)" },
  deliveryTitle: { field: "extra[checkbox_delivery_title]", kind: "text", label: "Checkbox ПРРО: название доставки в чеке" },
  paymentTitle: { field: "extra[checkbox_payment_title]", kind: "text", label: "Checkbox ПРРО: название наценки на оплату" },
  // Delivery in the receipt
  deliveryAsProduct: { field: "extra[checkbox_delivery_as_product]", kind: "bool", label: "Checkbox ПРРО: доставка как товар в чеке" },
  deliveryArticle: { field: "extra[checkbox_delivery_article]", kind: "text", label: "Checkbox ПРРО: артикул доставки" },
  deliveryTaxCode: { field: "extra[checkbox_delivery_tax_code]", kind: "taxcode", label: "Checkbox ПРРО: код налога для доставки" },
  // Payment fee in the receipt
  paymentAsProduct: { field: "extra[checkbox_payment_as_product]", kind: "bool", label: "Checkbox ПРРО: комиссия как товар в чеке" },
  paymentArticle: { field: "extra[checkbox_payment_article]", kind: "text", label: "Checkbox ПРРО: артикул комиссии" },
  paymentTaxCode: { field: "extra[checkbox_payment_tax_code]", kind: "taxcode", label: "Checkbox ПРРО: код налога комиссии" },
} satisfies Record<string, FieldDef>;

type Key = keyof typeof FIELDS;
const KEYS = Object.keys(FIELDS) as Key[];
/** Keys writable by `_set`: everything except the two unselected tax-code selects. */
const WRITABLE = KEYS.filter((k) => FIELDS[k].kind !== "taxcode");

/** Mask a secret for output: never the value, only "set?" + length. */
function maskSecret(raw: string): string {
  return raw ? `•••• (${raw.length} chars)` : "(empty)";
}

/** A tax-code select's read shape: its value is unknown (unselected), so report options only. */
function readTaxCode(form: ParsedForm, name: string): unknown {
  const sel = form.selects[name];
  return {
    unselected: true,
    storedValueUnknown: true,
    note: "Rendered as a <select> with no selected option; the stored value is not in the markup. Read-only here — set it via record_save with an explicit valid option to avoid clobbering.",
    options: sel?.options ?? [],
  };
}

/** Read one field's current value out of a parsed form, typed and (for secrets) masked. */
function readValue(form: ParsedForm, def: FieldDef): boolean | string | unknown {
  if (def.kind === "taxcode") return readTaxCode(form, def.field);
  const raw = fieldValue(form, def.field);
  if (def.kind === "bool") return raw === "1";
  if (def.kind === "secret") return maskSecret(raw);
  return raw;
}

/** Read the whole subsystem as {key: value}, secrets masked, tax codes read-only. */
function snapshot(form: ParsedForm): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of KEYS) out[key] = readValue(form, FIELDS[key]);
  return out;
}

export const adminPrroTools: ToolSpec[] = [
  {
    name: "horoshop_admin_prro_get",
    title: "Read the Checkbox ПРРО (fiscalization) settings",
    description:
      "Read the store's Checkbox.ua ПРРО (Ukrainian fiscal receipts) configuration from the general-settings form. Returns all 17 fields by human name: the mode toggles (`enabled`, `automaticReceipts`, `useTax`), receipt sending (`sendCheckOnEmail`, `sendCheckViaSms`), receipt layout (`footer`, `deliveryTitle`, `paymentTitle`), delivery-in-receipt (`deliveryAsProduct`, `deliveryArticle`, `deliveryTaxCode`) and payment-fee-in-receipt (`paymentAsProduct`, `paymentArticle`, `paymentTaxCode`). SECRETS ARE MASKED: `login`, `password` and `cashboxLicenseKey` are never returned as their value — only whether they are set and their length. The two tax-code selects are reported read-only (their stored value is not in the form markup). Read-only tool.",
    inputSchema: { ...storeField },
    annotations: { readOnlyHint: true },
    handler: async (client, args) => {
      const form = await client.admin.getFormFromUrl(args.store, SETTINGS_URL);
      return {
        store: args.store,
        source: "site_settings.php (extra[checkbox_*])",
        provider: "Checkbox.ua",
        secretsMasked: ["login", "password", "cashboxLicenseKey"],
        values: snapshot(form),
      };
    },
  },
  {
    name: "horoshop_admin_prro_set",
    title: "Set the Checkbox ПРРО (fiscalization) settings",
    description:
      "Write the store's Checkbox.ua ПРРО settings on the general-settings form (read-modify-write, then verify by re-reading). Writable keys: booleans `enabled`, `automaticReceipts`, `useTax`, `sendCheckOnEmail`, `sendCheckViaSms`, `deliveryAsProduct`, `paymentAsProduct`; texts `footer`, `deliveryTitle`, `paymentTitle`, `deliveryArticle`, `paymentArticle`; and the SECRETS `login`, `password`, `cashboxLicenseKey`. Secrets are accepted but NEVER echoed back — the plan/verify report shows a masked placeholder, so a write can't leak the key. The tax-code selects (`deliveryTaxCode`, `paymentTaxCode`) are NOT writable here: they render unselected, so blindly resubmitting them would overwrite the stored value with the placeholder — set those via horoshop_admin_record_save with an explicit, valid option instead. DRY RUN BY DEFAULT: pass dryRun:false to apply.",
    inputSchema: {
      ...storeField,
      enabled: z.boolean().optional().describe(FIELDS.enabled.label),
      automaticReceipts: z.boolean().optional().describe(FIELDS.automaticReceipts.label),
      useTax: z.boolean().optional().describe(FIELDS.useTax.label),
      login: z.string().optional().describe(FIELDS.login.label + " (secret — not echoed back)"),
      password: z.string().optional().describe(FIELDS.password.label + " (secret — not echoed back)"),
      cashboxLicenseKey: z.string().optional().describe(FIELDS.cashboxLicenseKey.label + " (secret — not echoed back)"),
      sendCheckOnEmail: z.boolean().optional().describe(FIELDS.sendCheckOnEmail.label),
      sendCheckViaSms: z.boolean().optional().describe(FIELDS.sendCheckViaSms.label),
      footer: z.string().optional().describe(FIELDS.footer.label),
      deliveryTitle: z.string().optional().describe(FIELDS.deliveryTitle.label),
      paymentTitle: z.string().optional().describe(FIELDS.paymentTitle.label),
      deliveryAsProduct: z.boolean().optional().describe(FIELDS.deliveryAsProduct.label),
      deliveryArticle: z.string().optional().describe(FIELDS.deliveryArticle.label),
      paymentAsProduct: z.boolean().optional().describe(FIELDS.paymentAsProduct.label),
      paymentArticle: z.string().optional().describe(FIELDS.paymentArticle.label),
      deliveryTaxCode: z
        .string()
        .optional()
        .describe(FIELDS.deliveryTaxCode.label + " — READ-ONLY here (unselected select); passing it is rejected with instructions."),
      paymentTaxCode: z
        .string()
        .optional()
        .describe(FIELDS.paymentTaxCode.label + " — READ-ONLY here (unselected select); passing it is rejected with instructions."),
      dryRun: z.boolean().optional().describe("Default true: preview the change. Set false to apply."),
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
    handler: async (client, args) => {
      // Guard: the two tax-code selects are unselected — never send them blind.
      for (const k of ["deliveryTaxCode", "paymentTaxCode"] as const) {
        if (args[k] !== undefined) {
          throw new Error(
            `${k} is an unselected <select> (its stored value is not in the form markup). Setting it here would overwrite the current value with the placeholder. Set it deliberately via horoshop_admin_record_save (formUrl utils/site_settings.php) with an explicit valid option — read horoshop_admin_prro_get first to see the available options.`,
          );
        }
      }

      const form = await client.admin.getFormFromUrl(args.store, SETTINGS_URL);

      const set: Record<string, string> = {};
      const planned: Array<{ key: string; field: string; from: unknown; to: unknown; secret?: boolean }> = [];
      // Keep the intended raw values apart from the masked report, so verification
      // can compare real values without ever putting a secret in the output.
      const intended: Record<string, string> = {};

      for (const key of WRITABLE) {
        if (args[key] === undefined) continue;
        const def = FIELDS[key];
        const name = def.field;
        const raw = def.kind === "bool" ? (args[key] ? "1" : "0") : String(args[key]);
        set[name] = raw;
        intended[key] = raw;
        const secret = def.kind === "secret";
        planned.push({
          key,
          field: name,
          from: readValue(form, def), // already masked for secrets
          to: secret ? maskSecret(raw) : def.kind === "bool" ? raw === "1" : raw,
          ...(secret ? { secret: true } : {}),
        });
      }

      if (planned.length === 0) {
        throw new Error(`Nothing to set. Pass one or more of: ${WRITABLE.join(", ")}.`);
      }

      if (args.dryRun !== false) {
        return { store: args.store, provider: "Checkbox.ua", dryRun: true, willChange: planned };
      }

      const res = await client.admin.save(args.store, form, set);
      const after = await client.admin.getFormFromUrl(args.store, SETTINGS_URL);

      const changes = planned.map((p) => {
        const def = FIELDS[p.key as Key];
        // Compare against the real stored value internally; only report masked.
        const nowRaw = fieldValue(after, def.field);
        const persisted = def.kind === "bool" ? (nowRaw === "1") === (intended[p.key] === "1") : nowRaw === intended[p.key];
        return {
          key: p.key,
          field: p.field,
          from: p.from,
          to: p.to,
          now: def.kind === "secret" ? maskSecret(nowRaw) : def.kind === "bool" ? nowRaw === "1" : nowRaw,
          persisted,
        };
      });
      const ok = changes.every((c) => c.persisted);
      return {
        store: args.store,
        provider: "Checkbox.ua",
        dryRun: false,
        saved: ok,
        httpStatus: res.httpStatus,
        changes,
        note: ok
          ? "Saved and verified by re-reading the form. (No storefront proof — fiscal settings do not render on the storefront.)"
          : "Some fields did not persist — see `changes`.",
      };
    },
  },
];
