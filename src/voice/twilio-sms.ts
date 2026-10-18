/** Twilio accepts one SMS creation attempt. A lost response stays unknown;
 * a similar message in a later listing never establishes its attribution. */
import type {
  CommandGoverningDefinition,
  IntegrationContext,
} from "bijection/server";
import { v } from "bijection/values";

const literal = (value: string) => ({ kind: "literal" as const, value });
const setup = (name: string) =>
  ({ kind: "input", input: "setup", path: [name] }) as const;
const argument = (name: string) =>
  ({ kind: "input", input: "argument", path: [name] }) as const;
const target = { kind: "input", input: "target_key" } as const;
const json = { kind: "json", validator: v.any() } as const;
const statuses = {
  200: json,
  201: json,
  400: json,
  401: json,
  403: json,
  404: json,
  429: json,
  500: json,
  502: json,
  503: json,
};
const unknown = Object.fromEntries(
  Object.keys(statuses).map((status) => [status, { kind: "unknown" as const }]),
);

export const twilioSenderFields = {
  phone_number: v.string(),
  account_id: v.string(),
};

/** Install at https://api.twilio.com with a scoped Basic credential. The
 * administrator selects one existing SMS-capable number of that account. */
export function twilioSmsDefinition(options: {
  governingRule: CommandGoverningDefinition;
}) {
  const base = [literal("2010-04-01"), literal("Accounts"), setup("account")];
  const requests = {
    identity: {
      handler: { member: ["identify"] },
      method: "GET",
      route: [
        literal("2010-04-01"),
        literal("Accounts"),
        { kind: "input", input: "parameter", path: ["accountFile"] },
      ],
      parameters: { accountFile: v.string() },
      query: {},
      headers: {},
      response: { statuses },
      evidence: {
        kind: "identity",
        account: { path: ["sid"], encoding: "text" },
      },
    },
    senders: {
      handler: { member: ["collections", "senders", "sync", "read"] },
      method: "GET",
      route: [...base, literal("IncomingPhoneNumbers.json")],
      query: { PhoneNumber: setup("sender"), PageSize: literal("2") },
      headers: {},
      response: { statuses },
      evidence: {
        kind: "records",
        collection: "senders",
        items: ["incoming_phone_numbers"],
        key: { kind: "field", path: ["phone_number"], encoding: "text" },
        presence: { kind: "fixed", record: "present" },
      },
    },
    send: {
      handler: { member: ["commands", "send", "send"] },
      method: "POST",
      route: [...base, literal("Messages.json")],
      query: {},
      headers: { "Content-Type": literal("application/x-www-form-urlencoded") },
      body: {
        kind: "object",
        fields: { From: target, To: argument("to"), Body: argument("text") },
      },
      response: { statuses },
      evidence: {
        kind: "command",
        command: "send",
        outcome: { kind: "status" },
        outcomes: {
          ...unknown,
          201: {
            kind: "confirmed",
            target_key: { kind: "body", path: ["from"] },
            effects: [
              { response: ["to"], input: { input: "argument", path: ["to"] } },
              {
                response: ["body"],
                input: { input: "argument", path: ["text"] },
              },
            ],
          },
        },
      },
    },
    reconcile: {
      handler: { member: ["commands", "send", "reconcile"] },
      method: "GET",
      route: [...base, literal("IncomingPhoneNumbers.json")],
      query: { PhoneNumber: target, PageSize: literal("1") },
      headers: {},
      response: { statuses },
      evidence: {
        kind: "command",
        command: "send",
        outcome: { kind: "status" },
        outcomes: unknown,
      },
    },
  } as const;
  return {
    setup: [
      {
        key: "account",
        supplier: "administrator",
        label: "Twilio account SID",
        pattern: "^AC[0-9a-fA-F]{32}$",
        help: "The existing account owning the sender.",
        docUrl: "https://www.twilio.com/docs/iam/api/account",
      },
      {
        key: "sender",
        supplier: "administrator",
        label: "SMS sender",
        pattern: "^\\+[1-9][0-9]{5,14}$",
        help: "An existing SMS-capable company number in E.164 format.",
        docUrl:
          "https://www.twilio.com/docs/phone-numbers/api/incomingphonenumber-resource",
      },
    ],
    requests,
    async identify(ctx: IntegrationContext<typeof requests>) {
      const response = await ctx.request("identity", {
        accountFile: `${ctx.setup.account}.json`,
      });
      if (response.status !== 200 || response.body?.sid !== ctx.setup.account)
        throw new Error("Twilio account identity refused");
      return { account_id: response.body.sid, evidence: response.evidence };
    },
    collections: {
      senders: {
        schema: twilioSenderFields,
        protocol: {
          kind: "record_observation",
          version: { kind: "none" },
          coverage: { kind: "filtered", completeness: "none" },
          resume: { kind: "none" },
        },
        sync: {
          every: { minutes: 1 },
          async read(ctx: IntegrationContext<typeof requests>) {
            const response = await ctx.request("senders");
            const rows = response.body?.incoming_phone_numbers;
            if (
              response.status !== 200 ||
              !Array.isArray(rows) ||
              rows.length !== 1 ||
              rows[0].account_sid !== ctx.setup.account ||
              rows[0].phone_number !== ctx.setup.sender ||
              rows[0].capabilities?.sms !== true
            )
              throw new Error("Twilio SMS sender refused");
            return {
              evidence: response.evidence,
              complete: false,
              records: [
                {
                  kind: "present" as const,
                  key: rows[0].phone_number,
                  item_index: 0,
                  evidence: response.evidence,
                  value: {
                    phone_number: rows[0].phone_number,
                    account_id: rows[0].account_sid,
                  },
                },
              ],
            };
          },
        },
      },
    },
    commands: {
      send: {
        target: "senders",
        args: { deliveryId: v.string(), to: v.string(), text: v.string() },
        governingRule: options.governingRule,
        condition: { kind: "unconditional" },
        delivery: {
          kind: "single_attempt",
          retention: { kind: "unknown" },
          max_delivery_hours: 1,
        },
        async send(ctx: IntegrationContext<typeof requests>) {
          const response = await ctx.request("send");
          if (
            response.status === 201 &&
            response.body?.account_sid === ctx.setup.account &&
            /^SM[0-9a-fA-F]{32}$/.test(response.body?.sid ?? "")
          )
            return {
              outcome: "confirmed" as const,
              evidence: response.evidence,
            };
          return { outcome: "unknown" as const, evidence: response.evidence };
        },
        async reconcile(ctx: IntegrationContext<typeof requests>) {
          return {
            outcome: "unknown" as const,
            evidence: (await ctx.request("reconcile")).evidence,
          };
        },
      },
    },
  } as const;
}
