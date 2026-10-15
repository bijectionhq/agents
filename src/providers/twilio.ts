/** Twilio owns phone challenge secrets and code validation. Native external
 * calls own intent, dispatch and ambiguity; no delivery or 404 proves approval.
 */
import type {
  CommandGoverningDefinition,
  EnumerationInput,
  IntegrationContext,
  RecordObservation,
  SweepInput,
} from "bijection/server";
import { v, type ObjectType } from "bijection/values";

const literal = (value: string) => ({ kind: "literal" as const, value });
const service = { kind: "input", input: "setup", path: ["service"] } as const;
const target = { kind: "input", input: "target_key" } as const;
const parameter = { kind: "input", input: "parameter", path: ["key"] } as const;
const json = { kind: "json", validator: v.any() } as const;
const opaque = { kind: "opaque" } as const;
const errors = {
  400: opaque,
  401: opaque,
  403: opaque,
  404: opaque,
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
const delivery = {
  kind: "single_attempt",
  retention: { kind: "unknown" },
  max_delivery_hours: 1,
} as const;
const states = [
  "pending",
  "approved",
  "canceled",
  "max_attempts_reached",
  "deleted",
  "failed",
  "expired",
] as const;

const channels = ["sms", "call", "whatsapp"] as const;
const channel = v.union(...channels.map((value) => v.literal(value)));

export const twilioVerificationFields = {
  to: v.string(),
  channel,
  status: v.string(),
};
function sid(value: unknown, prefix: "VE" | "VA" | "AC"): string {
  if (
    typeof value !== "string" ||
    !new RegExp(`^${prefix}[0-9a-fA-F]{32}$`).test(value)
  )
    throw new Error("Twilio returned an invalid resource identity");
  return value;
}
function verification(body: any, installedService: string) {
  if (
    !body ||
    body.service_sid !== installedService ||
    typeof body.to !== "string" ||
    !/^\+[1-9][0-9]{1,14}$/.test(body.to) ||
    !channels.includes(body.channel) ||
    !states.includes(body.status)
  )
    throw new Error("Twilio verification scope or shape changed");
  sid(body.account_sid, "AC");
  sid(body.sid, "VE");
  return {
    to: body.to as string,
    channel: body.channel as (typeof channels)[number],
    status: body.status as string,
  };
}
function pageToken(value: string | null): string {
  if (!value) return "";
  const parsed = new URL(value);
  if (
    parsed.origin !== "https://verify.twilio.com" ||
    parsed.pathname !== "/v2/Attempts"
  )
    throw new Error("Twilio attempt continuation changed resource");
  const tokens = parsed.searchParams.getAll("PageToken");
  if (tokens.length !== 1 || !tokens[0] || tokens[0].length > 4096)
    throw new Error("Twilio attempt continuation omitted its token");
  return tokens[0];
}

/** Install at https://verify.twilio.com/v2 with a scoped Basic credential.
 * The private service is existing provider configuration. Start sends exactly
 * once; check binds the exact challenge, destination and transport. Only the
 * original approved check response establishes success. A lost response stays
 * unknown, including when Twilio has deleted the approved verification.
 */
export function twilioVerifyDefinition(options: {
  startRule: CommandGoverningDefinition;
  checkRule: CommandGoverningDefinition;
}) {
  const base = [literal("Services"), service];
  const requests = {
    identity: {
      handler: { member: ["identify"] },
      method: "GET",
      route: base,
      query: {},
      headers: {},
      response: readResponse,
      evidence: {
        kind: "identity",
        account: { path: ["account_sid"], encoding: "text" },
      },
    },
    listing: {
      handler: { member: ["collections", "verifications", "sync", "read"] },
      method: "GET",
      route: [literal("Attempts")],
      query: {
        PageSize: literal("6"),
        VerifyServiceSid: service,
        PageToken: { kind: "input", input: "parameter", path: ["pageToken"] },
      },
      parameters: { pageToken: v.string() },
      headers: {},
      response: readResponse,
      evidence: {
        kind: "discovery",
        collection: "verifications",
        items: ["attempts"],
        presence: { kind: "fixed", record: "present" },
        key: { kind: "field", path: ["verification_sid"], encoding: "text" },
        resume: { kind: "body", path: ["meta", "next_page_url"] },
      },
    },
    detail: {
      handler: { member: ["collections", "verifications", "sync", "read"] },
      method: "GET",
      route: [...base, literal("Verifications"), parameter],
      parameters: { key: v.string() },
      query: {},
      headers: {},
      response: readResponse,
      evidence: {
        kind: "records",
        collection: "verifications",
        subject: { input: "parameter", path: ["key"] },
        presence: { kind: "fixed", record: "present" },
        key: { kind: "field", path: ["sid"], encoding: "text" },
      },
    },
    start: {
      handler: { member: ["commands", "start", "send"] },
      method: "POST",
      route: [...base, literal("Verifications")],
      query: {},
      headers: { "Content-Type": literal("application/x-www-form-urlencoded") },
      body: {
        kind: "object",
        fields: {
          To: { kind: "input", input: "argument", path: ["to"] },
          Channel: { kind: "input", input: "argument", path: ["channel"] },
        },
      },
      response: { statuses: { ...errors, 201: json } },
      evidence: {
        kind: "command",
        command: "start",
        outcome: { kind: "selected", from: { kind: "body", path: ["status"] } },
        created: { kind: "body", path: ["sid"] },
        outcomes: {
          pending: {
            kind: "confirmed",
            effects: [
              { response: ["to"], input: { input: "argument", path: ["to"] } },
              {
                response: ["channel"],
                input: { input: "argument", path: ["channel"] },
              },
            ],
          },
        },
      },
    },
    started: {
      handler: { member: ["commands", "start", "reconcile"] },
      method: "GET",
      route: [
        ...base,
        literal("Verifications"),
        { kind: "input", input: "created_key" },
      ],
      query: {},
      headers: {},
      response: { statuses: { ...errors, 200: json } },
      evidence: {
        kind: "command",
        command: "start",
        outcome: { kind: "status" },
        attribution: { kind: "created" },
        created: { kind: "body", path: ["sid"] },
        outcomes: {
          200: {
            kind: "confirmed",
            effects: [
              { response: ["to"], input: { input: "argument", path: ["to"] } },
              {
                response: ["channel"],
                input: { input: "argument", path: ["channel"] },
              },
            ],
          },
          ...Object.fromEntries(
            Object.keys(errors).map((status) => [status, { kind: "unknown" }]),
          ),
        },
      },
    },
    check: {
      handler: { member: ["commands", "check", "send"] },
      method: "POST",
      route: [...base, literal("VerificationCheck")],
      query: {},
      headers: { "Content-Type": literal("application/x-www-form-urlencoded") },
      body: {
        kind: "object",
        fields: {
          VerificationSid: target,
          Code: { kind: "input", input: "argument", path: ["code"] },
        },
      },
      response: { statuses: { ...errors, 200: json } },
      evidence: {
        kind: "command",
        command: "check",
        outcome: { kind: "selected", from: { kind: "body", path: ["status"] } },
        outcomes: {
          approved: {
            kind: "confirmed",
            target_key: { kind: "body", path: ["sid"] },
            effects: [
              { response: ["to"], input: { input: "argument", path: ["to"] } },
              {
                response: ["channel"],
                input: { input: "argument", path: ["channel"] },
              },
            ],
          },
          ...Object.fromEntries(
            states
              .filter((state) => state !== "approved")
              .map((state) => [state, { kind: "rejected" }]),
          ),
        },
      },
    },
    checked: {
      handler: { member: ["commands", "check", "reconcile"] },
      method: "GET",
      route: [...base, literal("Verifications"), target],
      query: {},
      headers: {},
      response: { statuses: { ...errors, 200: json } },
      evidence: {
        kind: "command",
        command: "check",
        outcome: { kind: "status" },
        outcomes: {
          200: { kind: "unknown" },
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
        key: "service",
        supplier: "administrator",
        label: "Verify Service SID",
        pattern: "^VA[0-9a-fA-F]{32}$",
        help: "The existing Twilio Verify service this connection uses.",
        docUrl: "https://www.twilio.com/docs/verify/api/service",
      },
    ],
    requests,
    async identify(ctx: IntegrationContext<typeof requests>) {
      const response = await ctx.request("identity");
      if (response.status !== 200 || response.body?.sid !== ctx.setup.service)
        throw new Error("Twilio Verify service verification refused");
      return {
        account_id: sid(response.body.account_sid, "AC"),
        evidence: response.evidence,
      };
    },
    collections: {
      verifications: {
        schema: twilioVerificationFields,
        protocol: {
          kind: "record_observation",
          version: { kind: "none" },
          coverage: { kind: "filtered", completeness: "none" },
          resume: { kind: "opaque_cursor" },
        },
        reconcile: { every: { minutes: 1 } },
        sync: {
          every: { minutes: 1 },
          async read(
            ctx: IntegrationContext<typeof requests>,
            input: EnumerationInput | SweepInput,
          ) {
            let discovery = "keys" in input ? null : input.discovery;
            if (!("keys" in input) && !discovery) {
              const response = await ctx.request("listing", {
                pageToken: pageToken(input.resume),
              });
              if (
                response.status !== 200 ||
                !Array.isArray(response.body?.attempts) ||
                response.body.attempts.length > 6
              )
                throw new Error("Twilio attempt listing refused");
              const seen = new Set<string>();
              discovery = {
                evidence: response.evidence,
                items: response.body.attempts.flatMap(
                  (row: any, item_index: number) => {
                    if (row.service_sid !== ctx.setup.service)
                      throw new Error("Twilio attempt service changed");
                    const key = sid(row.verification_sid, "VE");
                    if (seen.has(key)) return [];
                    seen.add(key);
                    return [
                      {
                        key,
                        item_index,
                        kind: "present" as const,
                        resume: null,
                      },
                    ];
                  },
                ),
              };
            }
            const records: RecordObservation<
              ObjectType<typeof twilioVerificationFields>
            >[] = [];
            const unresolved: { key: string; evidence: string }[] = [];
            const keys =
              "keys" in input
                ? input.keys
                : discovery!.items.map((item) => item.key);
            if (keys.length > 6)
              throw new Error("Twilio detail slice exceeds six verifications");
            for (const key of keys) {
              const response = await ctx.request("detail", {
                key: sid(key, "VE"),
              });
              if (response.status === 200 && !response.unresolved) {
                const value = verification(response.body, ctx.setup.service!);
                if (sid(response.body.sid, "VE") !== key)
                  throw new Error("Twilio verification identity changed");
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
      start: {
        target: "verifications",
        args: {
          requestId: v.string(),
          to: v.string(),
          channel,
        },
        governingRule: options.startRule,
        creates: "unattributed",
        condition: { kind: "unconditional" },
        delivery,
        async send(ctx: IntegrationContext<typeof requests>) {
          const response = await ctx.request("start");
          if (
            response.status === 201 &&
            verification(response.body, ctx.setup.service!).status === "pending"
          )
            return {
              outcome: "confirmed" as const,
              evidence: response.evidence,
            };
          return { outcome: "unknown" as const, evidence: response.evidence };
        },
        async reconcile(ctx: IntegrationContext<typeof requests>) {
          const response = await ctx.request("started");
          if (response.status !== 200)
            return { outcome: "unknown" as const, evidence: response.evidence };
          verification(response.body, ctx.setup.service!);
          return { outcome: "confirmed" as const, evidence: response.evidence };
        },
      },
      check: {
        target: "verifications",
        args: {
          requestId: v.string(),
          to: v.string(),
          channel,
          code: v.string(),
        },
        governingRule: options.checkRule,
        condition: { kind: "unconditional" },
        delivery,
        async send(ctx: IntegrationContext<typeof requests>) {
          const response = await ctx.request("check");
          if (response.status !== 200)
            return { outcome: "unknown" as const, evidence: response.evidence };
          const value = verification(response.body, ctx.setup.service!);
          if (value.status === "approved")
            return {
              outcome: "confirmed" as const,
              evidence: response.evidence,
            };
          return {
            outcome: "rejected" as const,
            reason: "Twilio did not approve this verification check",
            evidence: response.evidence,
          };
        },
        async reconcile(ctx: IntegrationContext<typeof requests>) {
          return {
            outcome: "unknown" as const,
            evidence: (await ctx.request("checked")).evidence,
          };
        },
      },
    },
  } as const;
}
