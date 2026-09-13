import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodRawShape } from "zod";
import { HoroshopClient, HoroshopError } from "./client.js";
import { allowLargeField, gateSize, narrowingArgsOf, type NarrowHint } from "./sizeGate.js";

/** Shared input field: which configured store to target. */
export const storeField = {
  store: z
    .string()
    .optional()
    .describe(
      'Configured store name to target (e.g. "myshop"). Omit to use the default store.',
    ),
};

export interface ToolSpec {
  name: string;
  title: string;
  description: string;
  inputSchema: ZodRawShape;
  annotations?: ToolAnnotations;
  handler: (client: HoroshopClient, args: any) => Promise<unknown>;
  /**
   * Tool-specific sentence for a RESPONSE_TOO_LARGE refusal — how to make THIS
   * tool's answer smaller. Without it the gate builds a generic hint out of the
   * narrowing arguments found in `inputSchema`, which is honest but blunter.
   * A FUNCTION gets the measurement, so the advice can carry a real number.
   */
  narrowHint?: NarrowHint;
  /**
   * Opt out of the size gate (default: every read-only tool is gated). Only for
   * answers whose whole point is bulk and that no argument can narrow.
   */
  sizeGate?: false;
}

function ok(payload: unknown) {
  const text =
    typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: "text" as const, text }] };
}

function fail(message: string) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: message }],
  };
}

function errMessage(e: unknown): string {
  if (e instanceof HoroshopError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * The narrowing advice a refusal carries for this tool: its own `narrowHint`,
 * or one built from the narrowing arguments its schema actually declares.
 * Never the useless generic "reduce your selection" — the caller is told which
 * parameters of THIS tool exist.
 */
function narrowHintFor(spec: ToolSpec): NarrowHint {
  if (spec.narrowHint) return spec.narrowHint;
  const args = narrowingArgsOf(spec.inputSchema as Record<string, unknown>);
  return args.length
    ? `Narrow it and call again with this tool's own arguments: ${args.map((a) => `\`${a}\``).join(", ")}.`
    : `This tool takes no narrowing argument — read a smaller unit (a single record / a filtered listing) or pass allowLarge:true deliberately.`;
}

/**
 * SIZE GATE, applied here so it covers every reading tool at once (D2).
 *
 * Read-only tools are gated by default: they are the ones that can answer with
 * a megabyte (measured: `admin_list` on a live l10n grid returns 1.29 MB with no
 * argument at all), and their `allowLarge` escape hatch is injected into the
 * schema right here so the contract is identical everywhere. Writers are not
 * gated — their answers are confirmations, and refusing one AFTER the write
 * would hide what just happened.
 */
function isGated(spec: ToolSpec): boolean {
  return spec.sizeGate !== false && spec.annotations?.readOnlyHint === true;
}

export function registerTools(
  server: McpServer,
  client: HoroshopClient,
  specs: ToolSpec[],
): void {
  for (const spec of specs) {
    const gated = isGated(spec);
    const hint = gated ? narrowHintFor(spec) : "";
    server.registerTool(
      spec.name,
      {
        title: spec.title,
        description: spec.description,
        // `allowLarge` goes in FIRST so a tool that declares its own (catalog_export
        // documents it in detail) keeps its wording.
        inputSchema: gated ? { ...allowLargeField, ...spec.inputSchema } : spec.inputSchema,
        annotations: {
          title: spec.title,
          openWorldHint: true,
          ...spec.annotations,
        },
      },
      async (args: unknown) => {
        try {
          const payload = await spec.handler(client, args);
          if (!gated) return ok(payload);
          return ok(
            gateSize(payload, {
              tool: spec.name,
              allowLarge: (args as { allowLarge?: boolean } | undefined)?.allowLarge,
              hint,
              args: (args ?? {}) as Record<string, unknown>,
            }),
          );
        } catch (e) {
          return fail(errMessage(e));
        }
      },
    );
  }
}
