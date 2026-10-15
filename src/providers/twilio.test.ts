import { describe, expect, test, vi } from "vitest";
import { defineIntegration, makeFunctionReference } from "bijection/server";
import { twilioVerifyDefinition } from "./twilio.js";
const service = `VA${"1".repeat(32)}`,
  account = `AC${"2".repeat(32)}`,
  verificationId = `VE${"3".repeat(32)}`;
const rule = makeFunctionReference<"query", any, [null]>("policy:phone");
const definition = () =>
  twilioVerifyDefinition({ startRule: rule, checkRule: rule });
const body = (status = "pending") => ({
  sid: verificationId,
  service_sid: service,
  account_sid: account,
  to: "+15005550006",
  channel: "sms",
  status,
  valid: false,
});
const response = (body: any, status = 200) => ({
  body,
  status,
  evidence: "response",
  headers: {},
});
const ctx = (value: any, status = 200) => ({
  setup: { service },
  request: vi.fn().mockResolvedValue(response(value, status)),
});
describe("Twilio Verify native provider", () => {
  test("native check evidence binds the challenge, contact and transport, with no retry", () => {
    const integration = defineIntegration(definition());
    (integration as any)[Symbol.for("convex.integration.attach")]({
      module: "phone.js",
      export: "phone",
    });
    const m = JSON.parse((integration as any).exportIntegration());
    expect(m.commands.check.delivery.kind).toBe("single_attempt");
    expect(m.commands.start.creates.kind).toBe("unattributed");
    expect(m.http.check.body.fields.VerificationSid).toEqual({
      kind: "input",
      input: "target_key",
    });
    expect(m.http.check.body.fields.To).toBeUndefined();
    expect(m.http.check.headers["Content-Type"]).toEqual({
      kind: "literal",
      value: "application/x-www-form-urlencoded",
    });
    expect(m.http.check.evidence.outcomes.approved).toEqual({
      kind: "confirmed",
      target_key: { kind: "body", path: ["sid"] },
      effects: [
        { response: ["to"], input: { input: "argument", path: ["to"] } },
        {
          response: ["channel"],
          input: { input: "argument", path: ["channel"] },
        },
      ],
    });
    expect(m.http.check.evidence.outcomes.pending.kind).toBe("rejected");
    expect(m.http.check.response.failures).toBeUndefined();
    expect(Object.values(m.http.checked.evidence.outcomes)).toEqual(
      expect.arrayContaining([{ kind: "unknown" }]),
    );
  });
  test("only provider-approved status succeeds, including when the legacy valid flag disagrees", async () => {
    expect(
      await definition().commands.check.send(ctx(body("approved")) as any),
    ).toEqual({ outcome: "confirmed", evidence: "response" });
    expect(
      await definition().commands.check.send(
        ctx({ ...body(), valid: true }) as any,
      ),
    ).toEqual({
      outcome: "rejected",
      reason: "Twilio did not approve this verification check",
      evidence: "response",
    });
  });
  test.each([404, 429, 500, 502, 503])(
    "HTTP %s proves no approved check",
    async (status) => {
      expect(
        await definition().commands.check.send(ctx(null, status) as any),
      ).toEqual({ outcome: "unknown", evidence: "response" });
    },
  );
  test("a later approved read never manufactures evidence for an ambiguous original check", async () => {
    expect(
      await definition().commands.check.reconcile(ctx(body("approved")) as any),
    ).toEqual({ outcome: "unknown", evidence: "response" });
  });
  test.each([
    { service_sid: `VA${"4".repeat(32)}` },
    { status: "new_provider_state" },
    { to: "not-a-phone" },
    { channel: "email" },
    { account_sid: "account" },
  ])(
    "refuses a changed provider scope or unadmitted result",
    async (override) => {
      await expect(
        definition().commands.check.send(
          ctx({ ...body("approved"), ...override }) as any,
        ),
      ).rejects.toThrow(/Twilio/);
    },
  );
  test("the installed service identifies its real account", async () => {
    expect(
      await definition().identify(
        ctx({ sid: service, account_sid: account }) as any,
      ),
    ).toEqual({ account_id: account, evidence: "response" });
    await expect(
      definition().identify(
        ctx({ sid: `VA${"4".repeat(32)}`, account_sid: account }) as any,
      ),
    ).rejects.toThrow(/service/);
  });
  test("repeat attempts discover one member with its original wire index", async () => {
    const state = ctx(null);
    state.request.mockImplementation(async (name: string) =>
      name === "listing"
        ? response({
            attempts: [
              { service_sid: service, verification_sid: verificationId },
              { service_sid: service, verification_sid: verificationId },
            ],
          })
        : response(body()),
    );
    const result = await definition().collections.verifications.sync.read(
      state as any,
      { discovery: null, resume: null } as any,
    );
    expect(state.request.mock.calls).toEqual([
      ["listing", { pageToken: "" }],
      ["detail", { key: verificationId }],
    ]);
    expect(result.records).toHaveLength(1);
    expect(Object.keys(result.records[0]!.value).sort()).toEqual([
      "channel",
      "status",
      "to",
    ]);
    expect(result.records[0]!.key).toBe(verificationId);
  });
  test("an opaque continuation stays on Twilio's attempt resource", async () => {
    const state = ctx({ attempts: [] });
    await definition().collections.verifications.sync.read(
      state as any,
      {
        discovery: null,
        resume:
          "https://verify.twilio.com/v2/Attempts?PageSize=6&Page=1&PageToken=next%2Btoken",
      } as any,
    );
    expect(state.request).toHaveBeenCalledExactlyOnceWith("listing", {
      pageToken: "next+token",
    });
    for (const resume of [
      "https://attacker.example/v2/Attempts?PageToken=x",
      "https://verify.twilio.com/v2/Other?PageToken=x",
      "https://verify.twilio.com/v2/Attempts?PageToken=x&PageToken=y",
    ])
      await expect(
        definition().collections.verifications.sync.read(
          state as any,
          { discovery: null, resume } as any,
        ),
      ).rejects.toThrow(/Twilio/);
  });

  test.each(["sms", "call", "whatsapp"])(
    "%s uses the same approved check and bounded source contract",
    async (channel) => {
      const d = definition();
      expect(
        await d.commands.start.send(ctx({ ...body(), channel }, 201) as any),
      ).toEqual({ outcome: "confirmed", evidence: "response" });
      expect(
        await d.commands.check.send(
          ctx({ ...body("approved"), channel }) as any,
        ),
      ).toEqual({ outcome: "confirmed", evidence: "response" });
      const result = await d.collections.verifications.sync.read(
        ctx({ ...body(), channel }) as any,
        { keys: [verificationId] } as any,
      );
      expect(result.records[0]?.value.channel).toBe(channel);
    },
  );

  test.each([
    "pending",
    "canceled",
    "max_attempts_reached",
    "deleted",
    "failed",
    "expired",
  ])(
    "%s with legacy valid=true never approves a check on any channel",
    async (status) => {
      for (const channel of ["sms", "call", "whatsapp"])
        expect(
          (
            await definition().commands.check.send(
              ctx({ ...body(status), channel, valid: true }) as any,
            )
          ).outcome,
        ).toBe("rejected");
    },
  );

  test.each([400, 401, 403, 404, 429, 500, 502, 503])(
    "HTTP %s cannot prove a start or recover a lost check, on any channel",
    async (status) => {
      for (const channel of ["sms", "call", "whatsapp"]) {
        const state = ctx({ ...body("approved"), channel }, status);
        expect(
          (await definition().commands.start.send(state as any)).outcome,
        ).toBe("unknown");
        expect(
          (await definition().commands.check.reconcile(state as any)).outcome,
        ).toBe("unknown");
      }
    },
  );

  test("seven attempts, foreign discovery, foreign detail and malformed identities fail closed", async () => {
    const read = definition().collections.verifications.sync.read;
    for (const attempts of [
      Array(7).fill({ service_sid: service, verification_sid: verificationId }),
      [
        {
          service_sid: `VA${"4".repeat(32)}`,
          verification_sid: verificationId,
        },
      ],
      [{ service_sid: service, verification_sid: "not-a-sid" }],
    ])
      await expect(
        read(
          ctx({ attempts }) as any,
          { discovery: null, resume: null } as any,
        ),
      ).rejects.toThrow(/Twilio/);
    await expect(
      read(
        ctx({ ...body(), sid: `VE${"4".repeat(32)}` }) as any,
        { keys: [verificationId] } as any,
      ),
    ).rejects.toThrow(/identity/);
    const state = ctx(body());
    await expect(
      read(state as any, { keys: Array(7).fill(verificationId) } as any),
    ).rejects.toThrow(/six/);
    expect(state.request).not.toHaveBeenCalled();
  });

  test("approved-resource 404 stays unresolved and never invents a deleted source row", async () => {
    expect(
      await definition().collections.verifications.sync.read(
        ctx(null, 404) as any,
        { keys: [verificationId] } as any,
      ),
    ).toEqual({
      records: [],
      unresolved: [{ key: verificationId, evidence: "response" }],
    });
  });

  test("transport errors are not fabricated as provider refusal", async () => {
    const state = {
      setup: { service },
      request: vi.fn().mockRejectedValue(new Error("connection lost")),
    };
    for (const command of [
      definition().commands.start,
      definition().commands.check,
    ]) {
      await expect(command.send(state as any)).rejects.toThrow(
        "connection lost",
      );
      await expect(command.reconcile(state as any)).rejects.toThrow(
        "connection lost",
      );
    }
  });
});
