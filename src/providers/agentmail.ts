/** AgentMail inbox acquisition and accepted sends through the native owners.
 * Inbox identity and credentials are private connection setup. A send confirms
 * API acceptance, never recipient delivery, contact ownership or authentication.
 */
import type {
  CommandGoverningDefinition,
  EnumerationInput,
  IntegrationContext,
  SweepInput,
  RecordObservation,
} from "bijection/server";
import { v, type ObjectType } from "bijection/values";

const literal = (value: string) => ({ kind: "literal" as const, value });
const inbox = { kind: "input", input: "setup", path: ["inbox"] } as const;
const parameter = { kind: "input", input: "parameter", path: ["key"] } as const;
const json = { kind: "json", validator: v.any() } as const;
const opaque = { kind: "opaque" } as const;
const errors = {
  400: opaque,
  401: opaque,
  403: opaque,
  404: opaque,
  409: opaque,
  429: opaque,
  500: opaque,
  502: opaque,
  503: opaque,
};
const readResponse = {
  statuses: { ...errors, 200: json },
  failures: [
    { status: 401, kind: "authentication" },
    { status: 403, kind: "authentication" },
    { status: 429, kind: "throttled" },
    { status: 500, kind: "transient" },
    { status: 502, kind: "transient" },
    { status: 503, kind: "transient" },
  ],
} as const;

export const agentMailMessageFields = {
  messageId: v.string(),
  threadId: v.string(),
  from: v.string(),
  to: v.array(v.string()),
  subject: v.union(v.string(), v.null()),
  text: v.union(v.string(), v.null()),
  labels: v.array(v.string()),
  timestamp: v.string(),
};

function identifier(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 998 ||
    /[\r\n\0]/.test(value)
  )
    throw new Error("AgentMail returned an invalid message identity");
  return value;
}
function message(body: any, installedInbox: string) {
  if (
    !body ||
    body.inbox_id !== installedInbox ||
    typeof body.from !== "string" ||
    !Array.isArray(body.to) ||
    body.to.length > 50 ||
    !body.to.every((x: unknown) => typeof x === "string") ||
    !Array.isArray(body.labels) ||
    body.labels.length > 64 ||
    !body.labels.every((x: unknown) => typeof x === "string") ||
    typeof body.timestamp !== "string"
  )
    throw new Error("AgentMail message scope or shape changed");
  const text = body.extracted_text ?? body.text ?? null;
  if (
    text !== null &&
    (typeof text !== "string" ||
      new TextEncoder().encode(text).length > 64 * 1024)
  )
    throw new Error("AgentMail message text exceeds 64 KiB");
  if (
    body.subject != null &&
    (typeof body.subject !== "string" || body.subject.length > 998)
  )
    throw new Error("AgentMail message subject exceeds its bound");
  return {
    messageId: identifier(body.message_id),
    threadId: identifier(body.thread_id),
    from: body.from,
    to: body.to as string[],
    subject: body.subject ?? null,
    text: text as string | null,
    labels: body.labels as string[],
    timestamp: body.timestamp,
  };
}

/** Install at https://api.agentmail.to/v0 with one inbox-scoped bearer
 * credential. The application governing query owns recipients and disclosure.
 * AgentMail retains send idempotency for 24 hours; local dispatch is bounded
 * to one hour and no provider-enforced request deadline is claimed.
 */
export function agentMailDefinition(options: {
  governingRule: CommandGoverningDefinition;
}) {
  const base = [literal("inboxes"), inbox];
  const requests = {
    identity: {
      handler: { member: ["identify"] },
      method: "GET",
      route: base,
      query: {},
      headers: {},
      response: readResponse,
      evidence: { kind: "identity" },
    },
    listing: {
      handler: { member: ["collections", "messages", "sync", "read"] },
      method: "GET",
      route: [...base, literal("messages")],
      query: {
        limit: literal("6"),
        page_token: { kind: "input", input: "resume" },
      },
      headers: {},
      response: readResponse,
      evidence: {
        kind: "discovery",
        collection: "messages",
        items: ["messages"],
        presence: { kind: "fixed", record: "present" },
        key: { kind: "field", path: ["message_id"], encoding: "text" },
        resume: { kind: "body", path: ["next_page_token"] },
      },
    },
    detail: {
      handler: { member: ["collections", "messages", "sync", "read"] },
      method: "GET",
      route: [...base, literal("messages"), parameter],
      parameters: { key: v.string() },
      query: {},
      headers: {},
      response: readResponse,
      evidence: {
        kind: "records",
        collection: "messages",
        subject: { input: "parameter", path: ["key"] },
        presence: { kind: "fixed", record: "present" },
        key: { kind: "field", path: ["message_id"], encoding: "text" },
      },
    },
    send: {
      handler: { member: ["commands", "send", "send"] },
      method: "POST",
      route: [...base, literal("messages"), literal("send")],
      query: {},
      headers: { "Idempotency-Key": { kind: "input", input: "operation_id" } },
      body: {
        kind: "object",
        fields: {
          to: { kind: "input", input: "argument", path: ["to"] },
          subject: { kind: "input", input: "argument", path: ["subject"] },
          text: { kind: "input", input: "argument", path: ["text"] },
          html: { kind: "input", input: "argument", path: ["html"] },
        },
      },
      response: { statuses: { ...errors, 200: json } },
      evidence: {
        kind: "command",
        command: "send",
        outcome: { kind: "status" },
        created: { kind: "body", path: ["message_id"] },
        outcomes: {
          200: { kind: "confirmed" },
          400: { kind: "rejected" },
          401: { kind: "rejected" },
          403: { kind: "rejected" },
          404: { kind: "rejected" },
          409: { kind: "unknown" },
          429: { kind: "unknown" },
          500: { kind: "unknown" },
          502: { kind: "unknown" },
          503: { kind: "unknown" },
        },
      },
    },
    accepted: {
      handler: { member: ["commands", "send", "reconcile"] },
      method: "GET",
      route: [
        ...base,
        literal("messages"),
        { kind: "input", input: "created_key" },
      ],
      query: {},
      headers: {},
      response: { statuses: { ...errors, 200: json } },
      evidence: {
        kind: "command",
        command: "send",
        outcome: { kind: "status" },
        attribution: { kind: "created" },
        created: { kind: "body", path: ["message_id"] },
        outcomes: {
          200: { kind: "confirmed" },
          ...Object.fromEntries(
            Object.keys(errors).map((status) => [status, { kind: "unknown" }]),
          ),
        },
      },
    },
  } as const;
  return {
    setup: [
      {
        key: "inbox",
        supplier: "administrator",
        label: "Inbox address",
        pattern: "^[^@\\s]+@[^@\\s]+$",
        help: "The existing AgentMail inbox this connection owns.",
        docUrl: "https://docs.agentmail.to/inboxes",
      },
    ],
    requests,
    async identify(ctx: IntegrationContext<typeof requests>) {
      const response = await ctx.request("identity");
      if (
        response.status !== 200 ||
        response.body?.inbox_id !== ctx.setup.inbox
      )
        throw new Error("AgentMail inbox verification refused");
      // An inbox is not an account or organization identifier.
      return { evidence: response.evidence };
    },
    collections: {
      messages: {
        schema: agentMailMessageFields,
        protocol: {
          kind: "record_observation",
          version: { kind: "none" },
          coverage: { kind: "filtered", completeness: "none" },
          resume: { kind: "opaque_cursor" },
        },
        reconcile: { every: { minutes: 5 } },
        sync: {
          every: { minutes: 1 },
          async read(
            ctx: IntegrationContext<typeof requests>,
            input: EnumerationInput | SweepInput,
          ) {
            let discovery = "keys" in input ? null : input.discovery;
            if (!("keys" in input) && !discovery) {
              const response = await ctx.request("listing");
              if (
                response.status !== 200 ||
                !Array.isArray(response.body?.messages) ||
                response.body.messages.length > 6
              )
                throw new Error("AgentMail inbox listing refused");
              discovery = {
                evidence: response.evidence,
                items: response.body.messages.map(
                  (row: any, item_index: number) => ({
                    key: identifier(row.message_id),
                    item_index,
                    kind: "present" as const,
                    resume: null,
                  }),
                ),
              };
            }
            const records: RecordObservation<
              ObjectType<typeof agentMailMessageFields>
            >[] = [];
            const unresolved: { key: string; evidence: string }[] = [];
            const keys =
              "keys" in input
                ? input.keys
                : discovery!.items.map((item) => item.key);
            if (keys.length > 6)
              throw new Error("AgentMail detail slice exceeds six messages");
            for (const key of keys) {
              const response = await ctx.request("detail", {
                key: identifier(key),
              });
              if (response.status === 200 && !response.unresolved) {
                const value = message(response.body, ctx.setup.inbox!);
                if (value.messageId !== key)
                  throw new Error("AgentMail message identity changed");
                records.push({
                  kind: "present",
                  key,
                  evidence: response.evidence,
                  item_index: 0,
                  value,
                });
              } else unresolved.push({ key, evidence: response.evidence });
            }
            return "keys" in input
              ? { records, unresolved }
              : { evidence: discovery!.evidence, records, unresolved };
          },
        },
      },
    },
    commands: {
      send: {
        target: "messages",
        args: {
          requestId: v.string(),
          to: v.array(v.string()),
          subject: v.string(),
          text: v.string(),
          html: v.string(),
        },
        governingRule: options.governingRule,
        creates: "deduplicated",
        identity_format: "sha256_128_hex",
        condition: { kind: "unconditional" },
        delivery: {
          kind: "idempotent",
          retention: { kind: "stated", unit: "hours", value: 24 },
          max_delivery_hours: 1,
          request_expiry: "none",
        },
        async send(ctx: IntegrationContext<typeof requests>) {
          const response = await ctx.request("send");
          if (response.status === 200)
            return {
              outcome: "confirmed" as const,
              evidence: response.evidence,
            };
          if ([400, 401, 403, 404].includes(response.status))
            return {
              outcome: "rejected" as const,
              reason: "AgentMail refused this send",
              evidence: response.evidence,
            };
          return { outcome: "unknown" as const, evidence: response.evidence };
        },
        async reconcile(ctx: IntegrationContext<typeof requests>) {
          const response = await ctx.request("accepted");
          return {
            outcome:
              response.status === 200
                ? ("confirmed" as const)
                : ("unknown" as const),
            evidence: response.evidence,
          };
        },
      },
    },
  } as const;
}
