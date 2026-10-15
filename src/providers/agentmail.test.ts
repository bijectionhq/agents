import { describe, expect, test, vi } from "vitest";
import { defineIntegration, makeFunctionReference } from "bijection/server";
import { agentMailDefinition } from "./agentmail.js";

const inbox = "owned@agentmail.to";
const definition = () =>
  agentMailDefinition({
    governingRule: makeFunctionReference<"query", any, [null]>("policy:email"),
  });
const row = (message_id = "<one@example.test>") => ({
  inbox_id: inbox,
  message_id,
  thread_id: "thread",
  from: "sender@example.test",
  to: [inbox],
  subject: "Test",
  text: "Quoted history",
  extracted_text: "Current reply",
  labels: ["received"],
  timestamp: "2026-10-13T10:00:00Z",
});
const response = (body: any, status = 200, evidence = "response") => ({
  status,
  body,
  evidence,
  headers: {},
});
function manifest() {
  const integration = defineIntegration(definition());
  (integration as any)[Symbol.for("convex.integration.attach")]({
    module: "email.js",
    export: "email",
  });
  return JSON.parse((integration as any).exportIntegration());
}

describe("AgentMail native provider", () => {
  test("email acceptance has bounded native idempotency and does not claim contact confirmation", () => {
    const m = manifest();
    expect(m.commands.send.creates.kind).toBe("deduplicated");
    expect(m.commands.send.delivery).toEqual({
      kind: "idempotent",
      retention: { kind: "stated", unit: "hours", value: 24 },
      max_delivery_hours: 1,
      request_expiry: "none",
    });
    expect(m.http.send.headers["Idempotency-Key"]).toEqual({
      kind: "input",
      input: "operation_id",
    });
    expect(m.http.send.response.failures).toBeUndefined();
    expect(m.http.send.evidence.outcomes["409"]).toEqual({ kind: "unknown" });
    expect(m.http.accepted.evidence.attribution).toEqual({ kind: "created" });
    expect(m.http.accepted.route.at(-1)).toEqual({
      kind: "input",
      input: "created_key",
    });
    expect(JSON.stringify(m)).not.toMatch(
      /api_key|Authorization|verified|authenticated/,
    );
  });

  test("the key must belong to the installed inbox and no account identity is invented", async () => {
    const d = definition();
    const request = vi.fn().mockResolvedValue(response({ inbox_id: inbox }));
    await expect(
      d.identify({ setup: { inbox }, request } as any),
    ).resolves.toEqual({ evidence: "response" });
    request.mockResolvedValue(response({ inbox_id: "other@agentmail.to" }));
    await expect(
      d.identify({ setup: { inbox }, request } as any),
    ).rejects.toThrow(/inbox/);
  });

  test("a retained six-item discovery resumes by its own evidence and current reply text", async () => {
    const d = definition();
    const request = vi.fn().mockResolvedValue(response(row()));
    const discovery = {
      evidence: "listing",
      items: [
        { key: row().message_id, item_index: 0, kind: "present", resume: null },
      ],
    };
    const result = await d.collections.messages.sync.read(
      { setup: { inbox }, request } as any,
      { discovery } as any,
    );
    expect(request).toHaveBeenCalledExactlyOnceWith("detail", {
      key: row().message_id,
    });
    expect(result).toEqual({
      evidence: "listing",
      records: [
        {
          kind: "present",
          key: row().message_id,
          evidence: "response",
          item_index: 0,
          value: {
            messageId: row().message_id,
            threadId: "thread",
            from: row().from,
            to: [inbox],
            subject: "Test",
            text: "Current reply",
            labels: ["received"],
            timestamp: row().timestamp,
          },
        },
      ],
      unresolved: [],
    });
  });

  test("deleted or unreadable messages remain unresolved rather than becoming invented tombstones", async () => {
    const request = vi.fn().mockResolvedValue(response(null, 404));
    expect(
      await definition().collections.messages.sync.read(
        { setup: { inbox }, request } as any,
        { keys: ["one"] } as any,
      ),
    ).toEqual({
      records: [],
      unresolved: [{ key: "one", evidence: "response" }],
    });
  });

  test.each([
    { inbox_id: "other@agentmail.to" },
    { message_id: "other-message" },
    { extracted_text: "x".repeat(65537) },
    { subject: "x".repeat(999) },
    { to: Array(51).fill("recipient@example.test") },
    { labels: [true] },
  ])(
    "refuses a detail outside the requested identity, scope or bounds",
    async (override) => {
      const request = vi
        .fn()
        .mockResolvedValue(response({ ...row("one"), ...override }));
      await expect(
        definition().collections.messages.sync.read(
          { setup: { inbox }, request } as any,
          { keys: ["one"] } as any,
        ),
      ).rejects.toThrow(/AgentMail/);
    },
  );

  test("a seven-message page or sweep cannot expand the admitted slice", async () => {
    const request = vi
      .fn()
      .mockResolvedValue(response({ messages: Array(7).fill(row()) }));
    await expect(
      definition().collections.messages.sync.read(
        { setup: { inbox }, request } as any,
        { discovery: null } as any,
      ),
    ).rejects.toThrow(/listing/);
    request.mockClear();
    await expect(
      definition().collections.messages.sync.read(
        { setup: { inbox }, request } as any,
        { keys: Array(7).fill("one") } as any,
      ),
    ).rejects.toThrow(/six/);
    expect(request).not.toHaveBeenCalled();
  });

  test.each([409, 429, 500, 502, 503])(
    "a send with HTTP %s stays unknown",
    async (status) => {
      const ctx = {
        setup: { inbox },
        request: vi.fn().mockResolvedValue(response(null, status)),
      };
      expect(await definition().commands.send.send(ctx as any)).toEqual({
        outcome: "unknown",
        evidence: "response",
      });
    },
  );

  test("a missing previously created message proves no completed acceptance", async () => {
    const ctx = {
      setup: { inbox },
      request: vi.fn().mockResolvedValue(response(null, 404)),
    };
    expect(await definition().commands.send.reconcile(ctx as any)).toEqual({
      outcome: "unknown",
      evidence: "response",
    });
  });

  test.each([400, 401, 403, 404])(
    "HTTP %s explicitly refuses an email send",
    async (status) => {
      expect(
        (
          await definition().commands.send.send({
            setup: { inbox },
            request: vi.fn().mockResolvedValue(response(null, status)),
          } as any)
        ).outcome,
      ).toBe("rejected");
    },
  );

  test("terminal listing may omit its continuation; optional message subject and current text stay exact", async () => {
    const request = vi.fn().mockImplementation(async (name) =>
      name === "listing"
        ? response({ messages: [row()] }, 200, "listing")
        : response({
            ...row(),
            subject: null,
            extracted_text: undefined,
            text: "",
          }),
    );
    const result = await definition().collections.messages.sync.read(
      { setup: { inbox }, request } as any,
      { discovery: null, resume: null } as any,
    );
    expect(result.records[0]?.value.subject).toBeNull();
    expect(result.records[0]?.value.text).toBe("");
    expect(request.mock.calls).toHaveLength(2);
  });

  test("a lost send response is not turned into a completed message or a refusal", async () => {
    const state = {
      setup: { inbox },
      request: vi.fn().mockRejectedValue(new Error("response lost")),
    };
    await expect(definition().commands.send.send(state as any)).rejects.toThrow(
      "response lost",
    );
    await expect(
      definition().commands.send.reconcile(state as any),
    ).rejects.toThrow("response lost");
  });
});
