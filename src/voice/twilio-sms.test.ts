import { expect, test } from "vitest";
import { defineIntegration, makeFunctionReference } from "bijection/server";
import { twilioSmsDefinition } from "./twilio-sms.js";

const account = `AC${"a".repeat(32)}`;
const number = "+33123456789";
const definition = () =>
  twilioSmsDefinition({
    governingRule: makeFunctionReference("messaging:policy"),
  });
const context = (body: unknown, status = 200) => ({
  setup: { account, sender: number },
  request: async () => ({ body, status, evidence: "response", headers: {} }),
});

test("voice SMS uses a single governed attempt with exact recipient and body evidence", () => {
  const integration = defineIntegration(definition());
  (integration as any)[Symbol.for("convex.integration.attach")]({
    module: "messaging.js",
    export: "sms",
  });
  const artifact = JSON.parse(integration.exportIntegration());
  expect(artifact.commands.send.delivery.kind).toBe("single_attempt");
  expect(artifact.http.send.evidence.outcomes[201].target_key).toEqual({
    kind: "body",
    path: ["from"],
  });
  expect(artifact.http.send.evidence.outcomes[201].effects).toEqual([
    { response: ["to"], input: { input: "argument", path: ["to"] } },
    { response: ["body"], input: { input: "argument", path: ["text"] } },
  ]);
  expect(
    Object.values(artifact.http.reconcile.evidence.outcomes).every(
      (value: any) => value.kind === "unknown",
    ),
  ).toBe(true);
});

test("voice SMS sender discovery admits one existing SMS number of the installed account", async () => {
  const sender = {
    account_sid: account,
    phone_number: number,
    capabilities: { sms: true },
  };
  const read = definition().collections.senders.sync.read;
  expect(
    (await read(context({ incoming_phone_numbers: [sender] }) as any)).records,
  ).toHaveLength(1);
  for (const rows of [
    [],
    [sender, sender],
    [{ ...sender, account_sid: "another-account" }],
    [{ ...sender, capabilities: { sms: false } }],
  ])
    await expect(
      read(context({ incoming_phone_numbers: rows }) as any),
    ).rejects.toThrow("sender refused");
});

test("voice SMS confirms provider acceptance only and never infers a lost send from a later read", async () => {
  const send = definition().commands.send;
  expect(
    await send.send(
      context({ sid: `SM${"b".repeat(32)}`, account_sid: account }, 201) as any,
    ),
  ).toEqual({ outcome: "confirmed", evidence: "response" });
  expect(
    await send.send(
      context(
        { sid: `SM${"b".repeat(32)}`, account_sid: "another-account" },
        201,
      ) as any,
    ),
  ).toEqual({ outcome: "unknown", evidence: "response" });
  expect(
    await send.reconcile(
      context({ messages: [{ status: "delivered" }] }) as any,
    ),
  ).toEqual({ outcome: "unknown", evidence: "response" });
});
