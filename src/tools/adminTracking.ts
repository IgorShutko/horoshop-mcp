import { z } from "zod";
import { storeField, type ToolSpec } from "../register.js";
import { fieldValue, type ParsedForm } from "../admin/form.js";

/**
 * MARKETING SERVICES (Маркетинг → Маркетингові сервіси, entity 407,
 * `h_marketing_system`) — the screen an agency touches for EVERY client.
 *
 * It is the store's analytics patch panel: GTM (head + noscript), Facebook Pixel,
 * Facebook SDK, Google Tag (GA4 / Google Ads), TikTok Pixel, eSputnik, Binotel
 * call tracking, Google Customer Reviews. Each row is four things — a name, an
 * on/off switch, a TRACKING ID, and where the snippet is injected — and the
 * snippet itself is a stored template carrying `{SYSTEM_ID}`, which the platform
 * replaces with that tracking id at render time.
 *
 * Generic `record_save` already reaches all of it, and that is exactly the
 * problem: it needs the record id (4, 5, 8, 10…), the raw field names, and the
 * numeric code for "inside <head>". Connecting a client's GA4 then reads
 * `{"entity":"marketing_services","id":10,"set":{"names[identifier]":"G-…",
 * "names[enabled]":"1"}}` — four chances to get it wrong on a live storefront.
 * These two tools take the service by NAME and validate what you put in the id
 * field.
 *
 * WHY THE VALIDATION EXISTS. On a live client store the GA4 row held a DOMAIN
 * NAME instead of a `G-…` id. Everything looked configured — the service was on,
 * the field was full — and nobody noticed, because nothing in the admin or in the
 * MCP ever said the value was the wrong shape. So both tools check the id against
 * the service's known format and WARN (never block: formats change, and a warning
 * that blocks gets forced away and stops being read). The one hard refusal is
 * switching a service ON while its `{SYSTEM_ID}` placeholder has nothing to fill
 * it with — that ships a broken snippet to every page for certain.
 */

const HANDLER = 407;
const HANDLERTABLE = "h_marketing_system";

const F = {
  title: "names[title]",
  enabled: "names[enabled]",
  identifier: "names[identifier]",
  code: "names[js_code]",
  position: "names[position]",
} as const;

/** The placeholder the platform substitutes with `identifier` when rendering. */
const ID_PLACEHOLDER = "{SYSTEM_ID}";

/** Where a snippet is injected. Values verified live on the position select. */
const POSITIONS: Record<string, string> = { "1": "after <body>", "2": "before </body>", "3": "inside <head>" };
const POSITION_ALIASES: Record<string, string> = {
  head: "3",
  "in head": "3",
  "inside head": "3",
  "<head>": "3",
  body: "1",
  "after body": "1",
  "body start": "1",
  "body end": "2",
  "before body": "2",
  "before /body": "2",
  footer: "2",
};

/**
 * Known id formats. Order matters: "Google Tag Manager" also contains "google
 * tag", so GTM must be tested before the gtag row.
 */
interface Shape {
  kind: string;
  matches: RegExp;
  accept: RegExp[];
  hint: string;
}
const SHAPES: Shape[] = [
  {
    kind: "gtm",
    matches: /google tag manager|(^|[^a-z])gtm([^a-z]|$)/i,
    accept: [/^GTM-[A-Z0-9]{5,9}$/],
    hint: "GTM-XXXXXXX (Google Tag Manager container id)",
  },
  {
    kind: "google-tag",
    matches: /gtag|(^|[^a-z])ga4([^a-z]|$)|google tag/i,
    accept: [/^G-[A-Z0-9]{8,12}$/, /^AW-\d{9,12}$/, /^GT-[A-Z0-9]{6,12}$/, /^UA-\d{4,10}-\d{1,4}$/],
    hint: "G-XXXXXXXXXX (GA4), AW-XXXXXXXXX (Google Ads), GT-… or the legacy UA-…",
  },
  {
    kind: "fb-pixel",
    matches: /pixel.*facebook|facebook.*pixel|meta.*pixel/i,
    accept: [/^\d{15,16}$/],
    hint: "15–16 digits (Meta/Facebook Pixel ID)",
  },
  {
    kind: "fb-sdk",
    matches: /facebook sdk/i,
    accept: [/^\d{15,16}$/],
    hint: "15–16 digits (Facebook App ID)",
  },
];

function shapeFor(title: string): Shape | null {
  return SHAPES.find((s) => s.matches.test(title)) ?? null;
}

/**
 * Is this value obviously not a tracking id? Applies to EVERY service, whatever
 * its format — this is the check that would have caught the domain sitting in a
 * live GA4 field.
 */
function looksLikeJunk(value: string): string | null {
  const v = value.trim();
  if (v === "") return null;
  if (/^https?:\/\//i.test(v) || v.includes("://")) return "it is a URL";
  if (/^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.(com|ua|net|org|io|shop|store|info|biz|com\.ua|co\.uk)$/i.test(v)) return "it is a domain name";
  if (/\s/.test(v)) return "it contains whitespace";
  if (/^[<]/.test(v)) return "it looks like HTML, not an id";
  return null;
}

/** Validate an identifier for a service; returns a human warning or null. */
function checkIdentifier(title: string, value: string): string | null {
  const junk = looksLikeJunk(value);
  const shape = shapeFor(title);
  if (junk) {
    return `"${value}" does not look like a tracking id — ${junk}.${shape ? ` «${title}» expects ${shape.hint}.` : ""} This is exactly the mistake that sat unnoticed in a live store's GA4 field.`;
  }
  if (!shape || value.trim() === "") return null;
  if (shape.accept.some((re) => re.test(value.trim()))) return null;
  return `"${value}" does not match the expected format for «${title}»: ${shape.hint}. Formats do change, so this is a WARNING, not a refusal — check it before you rely on the data.`;
}

interface Service {
  id: string;
  title: string;
  enabled: boolean;
  identifier: string;
  position: string;
  positionLabel: string;
  usesPlaceholder: boolean;
  form: ParsedForm;
}

function readService(id: string, form: ParsedForm): Service {
  const title = fieldValue(form, F.title);
  const position = fieldValue(form, F.position);
  // The position labels are localised per store, so take them from the live
  // select rather than hardcoding a translation.
  const opt = form.selects[F.position]?.options?.find((o) => o.value === position);
  return {
    id,
    title,
    enabled: fieldValue(form, F.enabled) === "1",
    identifier: fieldValue(form, F.identifier),
    position,
    positionLabel: opt?.label ?? POSITIONS[position] ?? position,
    usesPlaceholder: fieldValue(form, F.code).includes(ID_PLACEHOLDER),
    form,
  };
}

async function loadServices(client: any, store: string | undefined): Promise<Service[]> {
  const rows = await client.admin.listRecords(store, HANDLER, {});
  const out: Service[] = [];
  for (const r of rows as Array<{ id: string }>) {
    const form = await client.admin.getEditForm(store, { id: r.id, handler: HANDLER, handlertable: HANDLERTABLE, extra: {} });
    out.push(readService(String(r.id), form));
  }
  return out;
}

/** Normalise a name for matching: lowercase, punctuation → spaces, collapsed. */
const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9а-яёіїєґ]+/gi, " ")
    .trim()
    .replace(/\s+/g, " ");

/**
 * Aliases people actually type. Each maps to a regex tested against the service
 * TITLE — never to a record id, which differs per store.
 */
const ALIASES: Array<{ q: RegExp; title: RegExp }> = [
  // Bare "GTM" is DELIBERATELY ambiguous: a Tag Manager install is two records
  // (the <head> script and the <body> noscript), and quietly picking one wrote a
  // container id into the head row while the noscript half stayed empty. So the
  // bare name resolves to BOTH and the caller is asked which — "GTM head" or
  // "GTM noscript".
  { q: /^(gtm|google tag manager|tag manager)$/, title: /google tag manager/i },
  { q: /^(gtm|google tag manager|tag manager) ?head$/, title: /google tag manager.*head/i },
  { q: /^(gtm|google tag manager|tag manager) ?(noscript|body)$/, title: /google tag manager.*noscript/i },
  { q: /^(ga4|ga 4|google analytics|analytics|gtag|google ads|ads|aw|google tag)$/, title: /gtag|ga4/i },
  { q: /^(fb|facebook|meta)? ?pixel$/, title: /pixel.*facebook|facebook.*pixel/i },
  { q: /^(fb|facebook) sdk$/, title: /facebook sdk/i },
  { q: /^tiktok( pixel)?$/, title: /tiktok/i },
  { q: /^(esputnik|e sputnik)$/, title: /esputnik/i },
  { q: /^(binotel|call tracking)$/, title: /binotel/i },
  { q: /^(google customer reviews|customer reviews|reviews)$/, title: /customer reviews|відгуки/i },
];

function matchService(services: Service[], query: string): Service {
  const q = norm(query);
  const byId = services.find((s) => s.id === String(query).trim());
  if (byId) return byId;

  const exact = services.filter((s) => norm(s.title) === q);
  if (exact.length === 1) return exact[0];

  for (const a of ALIASES) {
    if (!a.q.test(q)) continue;
    const hit = services.filter((s) => a.title.test(s.title));
    if (hit.length === 1) return hit[0];
    if (hit.length > 1) {
      throw new Error(
        `"${query}" matches ${hit.length} services: ${hit.map((s) => `«${s.title}»`).join(", ")}. Name the one you mean (e.g. "GTM head" vs "GTM noscript").`,
      );
    }
  }

  const sub = services.filter((s) => norm(s.title).includes(q));
  if (sub.length === 1) return sub[0];
  if (sub.length > 1) {
    throw new Error(
      `"${query}" matches ${sub.length} services: ${sub.map((s) => `«${s.title}»`).join(", ")}. Be more specific.`,
    );
  }
  throw new Error(
    `No marketing service matches "${query}" on this store. Available: ${services.map((s) => `«${s.title}»`).join(", ")}. (horoshop_admin_tracking_get lists them with their current state.)`,
  );
}

function resolvePosition(input: string | number, form: ParsedForm): string {
  const raw = String(input).trim();
  if (POSITIONS[raw]) return raw;
  const alias = POSITION_ALIASES[norm(raw).replace(/\s+/g, " ")];
  if (alias) return alias;
  // Fall back to the store's own localised option labels.
  const opt = form.selects[F.position]?.options?.find((o) => norm(o.label) === norm(raw));
  if (opt && opt.value !== "0") return opt.value;
  throw new Error(
    `Unknown position "${input}". Use "head" (inside <head>), "after_body" (right after <body>) or "body_end" (before </body>) — or the numeric code 3 / 1 / 2.`,
  );
}

export const adminTrackingTools: ToolSpec[] = [
  {
    name: "horoshop_admin_tracking_get",
    title: "List the store's marketing / tracking services",
    description:
      "Read the «Маркетинг → Маркетингові сервіси» screen: every analytics and tracking integration the store has, with its NAME, whether it is switched on, its tracking id, and where the snippet is injected (inside <head> / after <body> / before </body>). This is the panel that holds GTM (head and noscript), Facebook Pixel, Facebook SDK, Google Tag (GA4 / Google Ads), TikTok Pixel, eSputnik, Binotel call tracking and Google Customer Reviews. " +
      "It also AUDITS what it finds: a service switched on whose `{SYSTEM_ID}` placeholder has no id to fill it (a broken snippet on every page), and an id whose shape is wrong for its service — a domain name once sat unnoticed in a live store's GA4 field, which is why this check exists. Read-only. For the store-wide free-form script blocks (custom JS in <head>/<body>) see horoshop_admin_settings_tracking — a different screen.",
    inputSchema: {
      ...storeField,
      onlyEnabled: z.boolean().optional().describe("Default false (all services). True: return only the ones that are switched on."),
    },
    annotations: { readOnlyHint: true },
    handler: async (client, args) => {
      const services = await loadServices(client, args.store);
      const list = args.onlyEnabled === true ? services.filter((s) => s.enabled) : services;
      const problems: string[] = [];
      const rows = list.map((s) => {
        const warn = checkIdentifier(s.title, s.identifier);
        const empty = s.enabled && s.usesPlaceholder && s.identifier.trim() === "";
        if (warn) problems.push(`«${s.title}»: ${warn}`);
        if (empty) problems.push(`«${s.title}» is SWITCHED ON but its tracking id is empty — the snippet still carries the literal ${ID_PLACEHOLDER} placeholder, so it is served broken on every page.`);
        return {
          service: s.title,
          id: s.id,
          enabled: s.enabled,
          identifier: s.identifier || null,
          position: s.positionLabel,
          positionCode: s.position,
          ...(s.usesPlaceholder ? {} : { note: `This service's snippet has no ${ID_PLACEHOLDER} placeholder — its code is self-contained and the identifier field may be unused.` }),
          ...(warn ? { identifierWarning: warn } : {}),
          ...(empty ? { brokenSnippet: true } : {}),
        };
      });
      return {
        screen: "Маркетинг → Маркетингові сервіси",
        entity: "marketing_services (handler 407)",
        count: rows.length,
        enabledCount: services.filter((s) => s.enabled).length,
        services: rows,
        ...(problems.length ? { problems } : {}),
        note: `Set any of these with horoshop_admin_tracking_set BY NAME (e.g. service:"GA4", identifier:"G-…", enabled:true). The tracking id is substituted into the stored snippet wherever it says ${ID_PLACEHOLDER}.`,
      };
    },
  },
  {
    name: "horoshop_admin_tracking_set",
    title: "Switch a marketing / tracking service on or off and set its id",
    description:
      "Configure one tracking service BY NAME — the everyday job of connecting a client's analytics. `service` takes a human name or a common alias: \"GTM head\", \"GTM noscript\", \"GA4\", \"Google Ads\", \"Facebook Pixel\", \"Facebook SDK\", \"TikTok\", \"eSputnik\", \"Binotel\", \"Google Customer Reviews\" (an ambiguous name is refused with the candidates, never guessed). Set `enabled` to switch it on/off, `identifier` for the tracking id, `position` for where the snippet goes (\"head\" / \"after_body\" / \"body_end\"). " +
      "THE ID IS CHECKED AGAINST THE SERVICE'S FORMAT and a mismatch is reported as a WARNING — GTM-XXXXXXX for Tag Manager, G-XXXXXXXXXX for GA4, AW-XXXXXXXXX for Google Ads, 15–16 digits for a Meta pixel — plus a universal check for a URL or domain in the id field, which is what a live client store turned out to have in its GA4 row. Warnings do not block: formats change. " +
      "ONE HARD REFUSAL: switching a service ON while its `{SYSTEM_ID}` placeholder would have nothing to fill it with, because that publishes a broken snippet on every page. Pass force:true if you really mean it. DRY RUN BY DEFAULT — pass dryRun:false to apply; the change is verified by re-reading the record.",
    inputSchema: {
      ...storeField,
      service: z.string().min(1).describe('Which service — a name or alias ("GA4", "Facebook Pixel", "GTM head"), or its numeric record id.'),
      enabled: z.boolean().optional().describe("Switch the service on (true) or off (false)."),
      identifier: z.string().optional().describe('The tracking id substituted into the snippet ("G-XXXXXXXXXX", "GTM-XXXXXXX", "AW-XXXXXXXXX", a 15–16 digit pixel id…). Pass "" to clear it.'),
      position: z
        .union([z.string(), z.number().int()])
        .optional()
        .describe('Where the snippet is injected: "head", "after_body", "body_end" (or the numeric code 3 / 1 / 2).'),
      force: z.boolean().optional().describe("Default false. True: allow switching the service on with an empty tracking id (publishes the snippet with an unfilled placeholder)."),
      dryRun: z.boolean().optional().describe("Default true: preview the change. Set false to apply."),
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
    handler: async (client, args) => {
      if (args.enabled === undefined && args.identifier === undefined && args.position === undefined) {
        throw new Error("Nothing to set — pass `enabled`, `identifier` and/or `position`.");
      }
      const dryRun = args.dryRun !== false;
      const services = await loadServices(client, args.store);
      const svc = matchService(services, args.service);

      const set: Record<string, string> = {};
      const planned: Array<{ field: string; label: string; from: unknown; to: unknown }> = [];
      if (args.enabled !== undefined && args.enabled !== svc.enabled) {
        set[F.enabled] = args.enabled ? "1" : "0";
        planned.push({ field: F.enabled, label: "enabled", from: svc.enabled, to: args.enabled });
      }
      if (args.identifier !== undefined && args.identifier !== svc.identifier) {
        set[F.identifier] = args.identifier;
        planned.push({ field: F.identifier, label: "identifier", from: svc.identifier || null, to: args.identifier || null });
      }
      let newPosition: string | null = null;
      if (args.position !== undefined) {
        newPosition = resolvePosition(args.position, svc.form);
        if (newPosition !== svc.position) {
          set[F.position] = newPosition;
          const opt = svc.form.selects[F.position]?.options?.find((o) => o.value === newPosition);
          planned.push({ field: F.position, label: "position", from: svc.positionLabel, to: opt?.label ?? POSITIONS[newPosition] ?? newPosition });
        }
      }

      // The effective end state, used by both guards.
      const willBeEnabled = args.enabled ?? svc.enabled;
      const willHaveId = args.identifier ?? svc.identifier;
      const warnings: string[] = [];
      const idWarn = args.identifier !== undefined ? checkIdentifier(svc.title, args.identifier) : null;
      if (idWarn) warnings.push(idWarn);
      const brokenSnippet = willBeEnabled && svc.usesPlaceholder && String(willHaveId).trim() === "";

      if (planned.length === 0) {
        return {
          service: svc.title,
          id: svc.id,
          dryRun,
          changes: [],
          current: { enabled: svc.enabled, identifier: svc.identifier || null, position: svc.positionLabel },
          note: "Nothing to change — the service is already in that state.",
        };
      }

      if (dryRun) {
        return {
          service: svc.title,
          id: svc.id,
          dryRun: true,
          willChange: planned,
          resultingState: { enabled: willBeEnabled, identifier: willHaveId || null, position: newPosition ? POSITIONS[newPosition] ?? newPosition : svc.positionLabel },
          ...(warnings.length ? { identifierWarnings: warnings } : {}),
          ...(brokenSnippet
            ? {
                blocked: `Switching «${svc.title}» ON with an empty tracking id would publish its snippet with the literal ${ID_PLACEHOLDER} still in it — broken on every page. A live run REFUSES this; pass force:true to override, or set \`identifier\` in the same call.`,
              }
            : {}),
        };
      }
      if (brokenSnippet && args.force !== true) {
        throw new Error(
          `Refused: «${svc.title}» would be switched ON with an empty tracking id, and its snippet contains ${ID_PLACEHOLDER} — every page would serve the placeholder verbatim. Set \`identifier\` in the same call, or pass force:true.`,
        );
      }

      const res = await client.admin.save(args.store, svc.form, set);
      const after = readService(
        svc.id,
        await client.admin.getEditForm(args.store, { id: svc.id, handler: HANDLER, handlertable: HANDLERTABLE, extra: {} }),
      );
      const changes = planned.map((p) => {
        const now =
          p.label === "enabled" ? after.enabled : p.label === "identifier" ? after.identifier || null : after.positionLabel;
        const expected = p.label === "position" ? after.positionLabel : p.to;
        return { ...p, now, persisted: p.label === "position" ? after.position === newPosition : JSON.stringify(now) === JSON.stringify(expected) };
      });
      const ok = changes.every((c) => c.persisted);
      return {
        service: svc.title,
        id: svc.id,
        dryRun: false,
        saved: ok,
        httpStatus: res.httpStatus,
        changes,
        state: { enabled: after.enabled, identifier: after.identifier || null, position: after.positionLabel },
        ...(warnings.length ? { identifierWarnings: warnings } : {}),
        ...(brokenSnippet ? { forced: `Switched ON with an empty id — the snippet now carries the literal ${ID_PLACEHOLDER}.` } : {}),
        note: ok
          ? `Saved and verified by re-reading the record. «${svc.title}» is now ${after.enabled ? "ON" : "OFF"}${after.identifier ? ` with id ${after.identifier}` : ""}, injected ${after.positionLabel}.`
          : "Some fields did not persist — see `changes`.",
      };
    },
  },
];
