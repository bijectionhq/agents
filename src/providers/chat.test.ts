import { expect, test, vi } from "vitest";
import { defineIntegration, makeFunctionReference } from "bijection/server";
import { chatTransportDefinition } from "./chat.js";
const definition = () =>
  chatTransportDefinition({
    governingRule: makeFunctionReference<"query", any, [null]>(
      "bots:replyPolicy",
    ),
  });
const response = (body: any, status = 200) => ({
  status,
  body,
  evidence: "retained",
  headers: {},
});
test("chat transport manifest retains native single-attempt recovery and no provider credentials", () => {
  const integration = defineIntegration(definition());
  (integration as any)[Symbol.for("convex.integration.attach")]({
    module: "providers.js",
    export: "chat",
  });
  const manifest = JSON.parse((integration as any).exportIntegration());
  expect(manifest.commands.reply.delivery.kind).toBe("single_attempt");
  expect(manifest.http.reply.response.failures).toBeUndefined();
  expect(manifest.http.reply.route.at(-1)).toEqual({
    kind: "input",
    input: "target_key",
  });
  expect(JSON.stringify(manifest)).not.toMatch(
    /telegram.org|xoxb|Authorization|api_key/,
  );
});
test("a transport does not invent a provider account identity", async () => {
  const request = vi
    .fn()
    .mockResolvedValue(response({ transport: "bijection-chat" }));
  expect(await definition().identify({ request } as any)).toEqual({
    evidence: "retained",
  });
  request.mockResolvedValue(response({ transport: "other" }));
  await expect(definition().identify({ request } as any)).rejects.toThrow(
    /identity/,
  );
});
test("destination acquisition retains exact evidence and refuses unknown or duplicate destinations", async () => {
  const request = vi.fn().mockResolvedValue(
    response({
      destinations: [{ channel: "telegram" }, { channel: "slack" }],
    }),
  );
  const read = definition().collections.destinations.sync.read;
  const result = await read({ request } as any, {} as any);
  expect(result.records.map((row) => row.key)).toEqual(["telegram", "slack"]);
  expect(result.records.every((row) => row.evidence === "retained")).toBe(true);
  for (const destinations of [
    [{ channel: "discord" }],
    [{ channel: "slack" }, { channel: "slack" }],
    [null],
  ]) {
    request.mockResolvedValue(response({ destinations }));
    await expect(read({ request } as any, {} as any)).rejects.toThrow();
  }
});
test.each(["confirmed", "rejected", "unknown"] as const)(
  "native reply preserves %s without second dispatch",
  async (outcome) => {
    const request = vi.fn().mockResolvedValue(response({ outcome }));
    expect(
      (await definition().commands.reply.send({ request } as any)).outcome,
    ).toBe(outcome);
    expect(
      (await definition().commands.reply.reconcile({ request } as any)).outcome,
    ).toBe("unknown");
    expect(request.mock.calls.map((call) => call[0])).toEqual([
      "reply",
      "unknown",
    ]);
  },
);

test.each([400, 401, 403, 404, 429, 500, 502, 503])(
  "HTTP %s never invents confirmed delivery",
  async (status) => {
    const request = vi
      .fn()
      .mockResolvedValue(response({ outcome: "confirmed" }, status));
    expect(
      (await definition().commands.reply.send({ request } as any)).outcome,
    ).toBe("unknown");
    expect(request).toHaveBeenCalledOnce();
  },
);
test.each([
  null,
  {},
  { outcome: "delivered" },
  { outcome: "not_found" },
  { outcome: 1 },
])("malformed successful verdict %j is refused", async (body) => {
  const request = vi.fn().mockResolvedValue(response(body));
  await expect(
    definition().commands.reply.send({ request } as any),
  ).rejects.toThrow(/verdict/);
  expect(request).toHaveBeenCalledOnce();
});
test.each([400, 401, 403, 404, 429, 500, 502, 503])(
  "reconciliation HTTP %s preserves unknown",
  async (status) => {
    const request = vi
      .fn()
      .mockResolvedValue(response({ outcome: "confirmed" }, status));
    expect(
      (await definition().commands.reply.reconcile({ request } as any)).outcome,
    ).toBe("unknown");
    expect(request).toHaveBeenCalledExactlyOnceWith("unknown");
  },
);
test.each(
  [[], [{ channel: "telegram" }], [{ channel: "slack" }]].map(
    (destinations) => ({ destinations }),
  ),
)(
  "destination subset %j retains evidence without claiming complete absence",
  async ({ destinations }) => {
    const request = vi.fn().mockResolvedValue(response({ destinations }));
    const result = await definition().collections.destinations.sync.read(
      { request } as any,
      {} as any,
    );
    expect(result.complete).toBe(false);
    expect(result.records.map((row) => row.key)).toEqual(
      destinations.map((row) => row.channel),
    );
    expect(result.evidence).toBe("retained");
  },
);
test.each(
  [
    null,
    {},
    [{ channel: "telegram" }, { channel: "slack" }, { channel: "telegram" }],
    [{ channel: "slack", token: "private" }, null],
  ].map((destinations) => ({ destinations })),
)(
  "malformed destination collection %j is refused",
  async ({ destinations }) => {
    const request = vi.fn().mockResolvedValue(response({ destinations }));
    await expect(
      definition().collections.destinations.sync.read(
        { request } as any,
        {} as any,
      ),
    ).rejects.toThrow();
  },
);
