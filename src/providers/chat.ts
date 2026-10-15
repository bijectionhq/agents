/** A credential-owning chat transport. Accepted inputs and durable replies stay
 * in the application. The transport never claims delivery or user authority. */
import type {
  CommandGoverningDefinition,
  IntegrationContext,
  EnumerationInput,
} from "bijection/server";
import { v } from "bijection/values";
const literal = (value: string) => ({ kind: "literal" as const, value });
const json = { kind: "json", validator: v.any() } as const;
const opaque = { kind: "opaque" } as const;
const statuses = {
  200: json,
  400: opaque,
  401: opaque,
  403: opaque,
  404: opaque,
  429: opaque,
  500: opaque,
  502: opaque,
  503: opaque,
};
export const chatDestinationFields = {
  channel: v.union(v.literal("telegram"), v.literal("slack")),
};

/** Install against a private transport origin with an origin-bound bearer
 * credential. Provider tokens never enter the integration declaration. */
export function chatTransportDefinition(options: {
  governingRule: CommandGoverningDefinition;
}) {
  const requests = {
    identity: {
      handler: { member: ["identify"] },
      method: "GET",
      route: [literal("identity")],
      query: {},
      headers: {},
      response: { statuses },
      evidence: { kind: "identity" },
    },
    destinations: {
      handler: { member: ["collections", "destinations", "sync", "read"] },
      method: "GET",
      route: [literal("destinations")],
      query: {},
      headers: {},
      response: { statuses },
      evidence: {
        kind: "records",
        collection: "destinations",
        items: ["destinations"],
        presence: { kind: "fixed", record: "present" },
        key: { kind: "field", path: ["channel"], encoding: "text" },
      },
    },
    reply: {
      handler: { member: ["commands", "reply", "send"] },
      method: "POST",
      route: [literal("replies"), { kind: "input", input: "target_key" }],
      query: {},
      headers: {},
      body: {
        kind: "object",
        fields: {
          requestId: { kind: "input", input: "argument", path: ["requestId"] },
          text: { kind: "input", input: "argument", path: ["text"] },
        },
      },
      response: { statuses },
      evidence: {
        kind: "command",
        command: "reply",
        outcome: {
          kind: "selected",
          from: { kind: "body", path: ["outcome"] },
        },
        outcomes: {
          confirmed: { kind: "confirmed" },
          rejected: { kind: "rejected" },
          unknown: { kind: "unknown" },
        },
      },
    },
    unknown: {
      handler: { member: ["commands", "reply", "reconcile"] },
      method: "GET",
      route: [literal("unknown")],
      query: {},
      headers: {},
      response: { statuses },
      evidence: {
        kind: "command",
        command: "reply",
        outcome: { kind: "status" },
        outcomes: Object.fromEntries(
          Object.keys(statuses).map((status) => [
            status,
            { kind: "unknown" as const },
          ]),
        ),
      },
    },
  } as const;
  return {
    requests,
    async identify(ctx: IntegrationContext<typeof requests>) {
      const response = await ctx.request("identity");
      if (
        response.status !== 200 ||
        response.body?.transport !== "bijection-chat"
      )
        throw new Error("Chat transport identity refused");
      return { evidence: response.evidence };
    },
    collections: {
      destinations: {
        schema: chatDestinationFields,
        protocol: {
          kind: "record_observation",
          version: { kind: "none" },
          coverage: { kind: "none" },
          resume: { kind: "none" },
        },
        sync: {
          every: { minutes: 1 },
          async read(
            ctx: IntegrationContext<typeof requests>,
            _input: EnumerationInput,
          ) {
            const response = await ctx.request("destinations");
            const rows: { channel: "telegram" | "slack" }[] =
              response.body?.destinations;
            if (
              response.status !== 200 ||
              !Array.isArray(rows) ||
              rows.length > 2 ||
              new Set(rows.map((row) => row?.channel)).size !== rows.length ||
              rows.some((row) => !["telegram", "slack"].includes(row?.channel))
            )
              throw new Error("Chat destination scope refused");
            return {
              evidence: response.evidence,
              complete: false,
              records: rows.map((row, item_index) => ({
                kind: "present" as const,
                key: row.channel,
                evidence: response.evidence,
                item_index,
                value: { channel: row.channel },
              })),
            };
          },
        },
      },
    },
    commands: {
      reply: {
        target: "destinations",
        args: { requestId: v.string(), text: v.string() },
        governingRule: options.governingRule,
        condition: { kind: "unconditional" },
        delivery: {
          kind: "single_attempt",
          retention: { kind: "unknown" },
          max_delivery_hours: 1,
        },
        async send(ctx: IntegrationContext<typeof requests>) {
          const response = await ctx.request("reply");
          const outcome =
            response.status === 200 ? response.body?.outcome : "unknown";
          if (!["confirmed", "rejected", "unknown"].includes(outcome))
            throw new Error("Chat reply verdict refused");
          if (outcome === "rejected")
            return {
              outcome: "rejected" as const,
              reason: "Chat provider refused this reply",
              evidence: response.evidence,
            };
          return {
            outcome: outcome as "confirmed" | "unknown",
            evidence: response.evidence,
          };
        },
        async reconcile(ctx: IntegrationContext<typeof requests>) {
          const response = await ctx.request("unknown");
          return { outcome: "unknown" as const, evidence: response.evidence };
        },
      },
    },
  } as const;
}
