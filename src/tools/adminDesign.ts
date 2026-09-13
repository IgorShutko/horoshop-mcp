import { z } from "zod";
import { storeField, type ToolSpec } from "../register.js";
import {
  REDACTED_SECTIONS,
  REDACTED_SECTION_MARKER,
  redactSecrets,
} from "../admin/redact.js";

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep-merge `patch` into `target` in place (objects merge, everything else replaces). */
function deepMerge(target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  for (const [k, v] of Object.entries(patch)) {
    if (isObject(v) && isObject(target[k])) {
      deepMerge(target[k] as Record<string, unknown>, v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

/** True if every leaf in `patch` is present with the same value in `obj`. */
function containsPatch(obj: unknown, patch: unknown): boolean {
  if (isObject(patch)) {
    if (!isObject(obj)) return false;
    return Object.entries(patch).every(([k, v]) => containsPatch(obj[k], v));
  }
  return JSON.stringify(obj) === JSON.stringify(patch);
}

export const adminDesignTools: ToolSpec[] = [
  {
    name: "horoshop_admin_design_get",
    title: "Read design config (application JSON)",
    description:
      "Read the store's design 'application JSON' — the full theme config (colours, blocks, homepage layout, header/footer, mobile, banners…). Without `section` returns the version and top-level section names; pass a `section` (e.g. \"header\", \"homepage\", \"footer\") to get that subtree. Read the shape here before editing it with horoshop_admin_design_set. SECRETS ARE NEVER RETURNED: the `payment` section (LiqPay / PayPal / merchant credentials) is withheld wholesale — it is not design — and in every other section any value under a key matching key/token/secret/password/signature/private is masked as \"•••• (N chars)\", so a transcript of a read cannot leak a live payment key. Editing still works on the real values: horoshop_admin_design_set merges into the unredacted config. Note: values shaped like {\"source\":\"db\",\"field_name\":\"…\"} are NOT stored in this JSON — they are pointers into the store's general settings, which THIS tool does not reach but other tools do: read them with horoshop_admin_settings_get (index:true gives the label→field map) or with horoshop_admin_record_get / horoshop_admin_record_save on the site_settings form, and write the common ones through the named tools (horoshop_admin_store_contacts, horoshop_admin_store_info_set, horoshop_admin_settings_brand / _checkout / _catalog / _tracking / _social_auth). " +
      "SIZE: `section:\"mobile\"` returns roughly 1500 lines in one payload and there is no `depth`/`path` narrowing here — read it only when you need it.",
    inputSchema: {
      ...storeField,
      section: z
        .string()
        .optional()
        .describe("Top-level section to drill into (e.g. \"header\", \"homepage\", \"common\"). Omit for the section index."),
    },
    annotations: { readOnlyHint: true },
    handler: async (client, args) => {
      const json = await client.admin.getDesignJson(args.store);
      if (args.section) {
        if (!(args.section in json)) {
          return { error: `No such section "${args.section}"`, sections: Object.keys(json) };
        }
        if (REDACTED_SECTIONS.has(args.section)) {
          return {
            section: args.section,
            value: REDACTED_SECTION_MARKER,
            note: "This section holds live payment-gateway credentials, not design. It is withheld by design. Payment options a buyer can pick are configured with horoshop_admin_checkout_option_set; merchant keys belong in the admin panel, by a human.",
          };
        }
        // Redaction is an OUTPUT filter: redactSecrets clones, so the config the
        // write path merges into (design_set) is still the real one.
        return { section: args.section, value: redactSecrets(json[args.section]), secretsRedacted: true };
      }
      const withheld = Object.keys(json).filter((s) => REDACTED_SECTIONS.has(s));
      return {
        version: json.version,
        sections: Object.keys(json),
        ...(withheld.length ? { withheldSections: withheld } : {}),
        secretsRedacted: true,
        note: "Secret-looking values are masked as \"•••• (N chars)\" and the payment section is withheld entirely. design_set still writes against the real config.",
      };
    },
  },
  {
    name: "horoshop_admin_design_set",
    title: "Edit design config (application JSON)",
    description:
      "Edit the store's design config by deep-merging a patch into one of its top-level sections (the design editor's blocks): common, header, footer, homepage, catalog, catalogCategories, product, mobile, cart, banners, contacts, brands, favorites, etc. Read the current shape first with horoshop_admin_design_get. Example: section \"common\", patch {\"style\":{\"background\":\"#111\"}}. Read-modify-write against the REAL config — the redaction that horoshop_admin_design_get applies to its output never reaches the write path, so patching a design section cannot damage the store's payment credentials (only the merged preview this tool prints is masked). DRY RUN BY DEFAULT. Colour/font changes need an SCSS recompile to reach the storefront and this tool runs it for you (`recompile`, default true) — but be precise about what that proves: the tool POSTs to Horoshop's recompile endpoint and reports the status it answers, i.e. THE JOB WAS ACCEPTED. It does not fetch the compiled theme CSS, does not compare the asset hash and does not look for your colour in the served file. On a live storefront that difference is worth money: if you need a hard guarantee the new colour is actually being served, fetch the storefront's compiled CSS yourself and check. Structural changes (blocks, layout, toggles) apply from the config directly.",
    inputSchema: {
      ...storeField,
      section: z.string().describe("Top-level design section to edit (e.g. \"header\", \"homepage\", \"common\")."),
      patch: z.record(z.any()).describe("Partial object deep-merged into the section (only the keys you set change)."),
      recompile: z.boolean().optional().describe("Default true: recompile SCSS after saving so colour/font changes reach the storefront."),
      dryRun: z.boolean().optional().describe("Default true: preview the merged section without saving. Set false to save."),
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
    handler: async (client, args) => {
      const json: any = await client.admin.getDesignJson(args.store);
      if (!(args.section in json)) {
        return { error: `No such section "${args.section}"`, sections: Object.keys(json) };
      }
      // Merge against the RAW config — never a redacted copy, or the mask string
      // would be written back over the store's real credentials. Only the
      // preview that leaves this tool is redacted.
      const before = JSON.parse(JSON.stringify(json[args.section]));
      const merged = deepMerge(JSON.parse(JSON.stringify(before)), args.patch as Record<string, unknown>);
      const dryRun = args.dryRun !== false;
      if (dryRun) {
        return {
          section: args.section,
          dryRun: true,
          patch: args.patch,
          mergedPreview: redactSecrets(merged),
          secretsRedacted: true,
        };
      }
      json[args.section] = merged;
      const res = await client.admin.saveDesignJson(args.store, json);
      const after: any = await client.admin.getDesignJson(args.store);
      const applied = containsPatch(after[args.section], args.patch);
      let recompiled: string | undefined;
      if (applied && args.recompile !== false) {
        const rc = await client.admin.recompileScss(args.store, "ajax");
        recompiled = rc.status;
      }
      return {
        section: args.section,
        dryRun: false,
        saved: res.status === "OK" && applied,
        status: res.status,
        message: res.message,
        applied,
        recompiled: recompiled ?? null,
        note: applied
          ? recompiled === "OK"
            ? "Saved, verified, and SCSS recompiled — changes are live on the storefront."
            : "Saved and verified. SCSS recompile did not report OK (structural changes still apply from the config)."
          : "Save reported but the patch did not verify on re-read.",
      };
    },
  },
  {
    name: "horoshop_admin_css_get",
    title: "Read custom CSS",
    description:
      "Read the store's custom CSS (desktop and mobile) from the client-styles editor. ALWAYS CHECK `available` BEFORE ACTING ON THE RESULT: the «Редактор CSS» admin section is per-store AND per-account — when THIS login has no rights to that section (the common case: the menu simply omits it) or the module is off, this returns available:false with empty strings, meaning the CSS is UNKNOWN, not absent. The storefront can still be serving custom rules (/assets/*/production/client.*.css) that no admin endpoint on that store exposes. `source` says where the values came from (\"legacy-ace-editor\" or \"unavailable\"). Reading decodes the HTML entities the editor page escapes, so a `>` child combinator comes back as `>` and survives a round-trip through horoshop_admin_css_set.",
    inputSchema: { ...storeField },
    annotations: { readOnlyHint: true },
    handler: async (client, args) => client.admin.getClientStyles(args.store),
  },
  {
    name: "horoshop_admin_css_set",
    title: "Set custom CSS",
    description:
      "Set the store's custom CSS. Provide `desktop` and/or `mobile` (the one you omit is preserved). Horoshop recompiles SCSS after saving. DRY RUN BY DEFAULT — pass dryRun:false to save. BLIND-WRITE GUARD: the save always posts BOTH sides, so it can only preserve what it could read. If horoshop_admin_css_get could not read the current CSS (the editor module is off on this store) or the side you are overwriting reads back empty, this refuses to write — an empty read is the exact condition under which a read-modify-write silently wipes a live stylesheet. Pass force:true only when you have confirmed out of band (e.g. by fetching the storefront's client.css) that there is nothing to lose.",
    inputSchema: {
      ...storeField,
      desktop: z.string().optional().describe("Desktop CSS (omit to keep current)."),
      mobile: z.string().optional().describe("Mobile CSS (omit to keep current)."),
      force: z
        .boolean()
        .optional()
        .describe("Override the blind-write guard when the current CSS reads empty or unreadable. Default false."),
      dryRun: z.boolean().optional().describe("Default true: preview without saving. Set false to save."),
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
    handler: async (client, args) => {
      if (args.desktop === undefined && args.mobile === undefined) {
        throw new Error("Provide desktop and/or mobile CSS to set.");
      }
      const current = await client.admin.getClientStyles(args.store);

      // Guard: never overwrite CSS we could not read. saveStyles posts desktop AND
      // mobile together, so an unreadable editor endangers the omitted side too.
      if (args.force !== true) {
        if (!current.available) {
          throw new Error(
            `Refusing to write: horoshop_admin_css_get could not read the current CSS on this store (source: ${current.source}). The client-styles editor is not reachable for this account — usually this login lacks rights to the «Редактор CSS» section (ask the store owner to grant it), sometimes the module is off — so the values are UNKNOWN, not empty — and saving posts both desktop and mobile, which would overwrite whatever the storefront is serving (check /assets/*/production/client.*.css). Pass force:true only if you are certain there is nothing to lose.`,
          );
        }
        const blind = (["desktop", "mobile"] as const).filter(
          (side) => args[side] !== undefined && current[side] === "",
        );
        if (blind.length) {
          throw new Error(
            `Refusing to write: the current ${blind.join(" and ")} CSS reads back EMPTY, which may mean the read is not supported on this store rather than that there is no CSS — writing would clobber the live stylesheet. Verify against the storefront's /assets/*/production/client.*.css, then pass force:true if the side really is empty.`,
          );
        }
      }

      const next = {
        desktop: args.desktop ?? current.desktop,
        mobile: args.mobile ?? current.mobile,
      };
      const dryRun = args.dryRun !== false;
      if (dryRun) {
        return {
          dryRun: true,
          source: current.source,
          forced: args.force === true,
          willChange: {
            desktop: args.desktop !== undefined && args.desktop !== current.desktop,
            mobile: args.mobile !== undefined && args.mobile !== current.mobile,
          },
        };
      }
      const res = await client.admin.setClientStyles(args.store, next);
      const after = await client.admin.getClientStyles(args.store);
      const rc = await client.admin.recompileScss(args.store, "clients");
      return {
        dryRun: false,
        saved: res.status === "OK" || res.httpStatus === 200,
        status: res.status,
        recompiled: rc.status ?? null,
        verified: {
          desktop: after.desktop === next.desktop,
          mobile: after.mobile === next.mobile,
        },
      };
    },
  },
];
