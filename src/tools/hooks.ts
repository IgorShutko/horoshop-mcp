import { z } from "zod";
import { storeField, type ToolSpec } from "../register.js";

const HOOK_EVENTS = [
  "order_created",
  "user_signup",
  "request_call_me",
  "order_paid",
  "user_update",
  "order_update",
  "comments_created",
] as const;

export const hookTools: ToolSpec[] = [
  {
    name: "horoshop_hooks_subscribe",
    title: "Subscribe to a webhook",
    description:
      "Register a target URL to receive JSON (PUT) when a store event fires. Events: order_created, user_signup, request_call_me, order_paid, user_update, order_update, comments_created. Max 5 subscribers per event. The queue is flushed by cron ~every 5 min, so delivery is not instant. Returns the subscription id — keep it to unsubscribe. " +
      "TARIFF: Horoshop's own docs put webhook delivery on the Pro plan. On a lower plan the subscription can register and then simply never fire, which looks like a broken integration rather than a billing line — confirm the store's plan before building anything on top of this.",
    inputSchema: {
      ...storeField,
      event: z.enum(HOOK_EVENTS).describe("Event to subscribe to."),
      target_url: z
        .string()
        .url()
        .describe("URL that will receive the event payload."),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    handler: async (client, args) =>
      client.call(args.store, "hooks/subscribe", {
        event: args.event,
        target_url: args.target_url,
      }),
  },
  {
    name: "horoshop_hooks_unsubscribe",
    title: "Unsubscribe from a webhook",
    description:
      "Stop delivering an event to a target URL. Needs the subscription id returned by subscribe plus the same target_url.",
    inputSchema: {
      ...storeField,
      id: z.number().int().describe("Subscription id returned by subscribe."),
      target_url: z
        .string()
        .url()
        .describe("The target URL the subscription delivers to."),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    },
    handler: async (client, args) =>
      client.call(args.store, "hooks/unSubscribe", {
        id: args.id,
        target_url: args.target_url,
      }),
  },
];
