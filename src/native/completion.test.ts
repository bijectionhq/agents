import { defineAllowance, allowanceKey } from "bijection/server";
import { afterEach, expect, expectTypeOf, test, vi } from "vitest";
import {
  acceptingHandles,
  defineAgent,
  agentsModule,
  handOut,
  startAgent,
  getAgentRun,
  claimAgentDelivery,
  settleAgentDelivery,
  type RunRef,
} from "./index.js";
import { linkedAgentReferences, type AgentReference } from "bijection/agents";
import { normalizeAgentResponse, validateModelResponse } from "./response.js";
import { issuedSessions } from "bijection/sessions";
import { v } from "bijection/values";
import { bijectionToJson } from "bijection/values";
import type { AccessModel } from "bijection/server";
import { defineToolset, tool, linkedToolContracts } from "bijection/tools";
import {
  makeOperationReference,
  getOperationContract,
} from "bijection/server";

/** A model handle whose runs must never reach a provider. */
const model = (reason = "This run replays no model call") => ({
  kind: "language" as const,
  key: "test",
  requires: ["tools"] as const,
  open: async (): Promise<never> => {
    throw new Error(reason);
  },
});
const definition = () => ({
  args: { request: v.string() },
  returns: v.int64(),
  description: "Read and complete",
  instructions: "Complete with an exact integer",
  model: model(),
  tools: {},
  sessions: issuedSessions({ service: "support", role: "customer:agent" }),
});
afterEach(() => vi.unstubAllGlobals());

test("declarations require explicit input and result meaning", () => {
  const agent = defineAgent(definition());
  expectTypeOf(agent.args.type).toEqualTypeOf<{ request: string }>();
  expectTypeOf(agent.returns.type).toEqualTypeOf<bigint>();
  for (const invalid of [
    { ...definition(), args: undefined },
    { ...definition(), returns: undefined },
    { ...definition(), returns: v.any() },
    { ...definition(), args: { input: v.any() } },
  ])
    expect(() => defineAgent(invalid as any)).toThrow();
});

test("agents retain exact typed allocations and explicit unbounded choices", () => {
  const allowance = defineAllowance({ unit: "eur_cent" });
  (allowance as any)[Symbol.for("convex.allowance.attach")]({
    module: "allowances.js",
    export: "refunds",
  });
  const key = allowanceKey(allowance);
  expect(
    defineAgent({
      ...definition(),
      allowances: [{ allowance, limit: 9007199254740993n }],
    }).allowances,
  ).toEqual({ [key]: 9007199254740993n });
  expect(defineAgent(definition()).allowances).toEqual({});
  expect(
    defineAgent({
      ...definition(),
      allowances: [{ allowance, limit: "unbounded" }],
    }).allowances,
  ).toEqual({ [key]: "unbounded" });
  for (const limit of [-1n, 9223372036854775808n, 1, "infinite"])
    expect(() =>
      defineAgent({
        ...definition(),
        allowances: [{ allowance, limit }],
      } as any),
    ).toThrow("allowances");
});

test("generated references carry typed inputs and run results without provider data", async () => {
  const catalog = linkedAgentReferences({
    test: {
      contract: "a".repeat(64),
      args: JSON.stringify(v.object({ request: v.string() }).json),
      returns: JSON.stringify(v.int64().json),
    },
  }) as { test: AgentReference<{ request: string }, bigint> };
  const syscall = vi.fn(async (name: string, _args: string) =>
    name === "1.0/agents/schedule"
      ? JSON.stringify("run")
      : JSON.stringify({
          id: "run",
          agent: "test",
          state: "succeeded",
          createdAt: 0,
          finishedAt: 1,
          progress: { step: 0, phase: "done" },
          result: bijectionToJson(9007199254740993n),
        }),
  );
  vi.stubGlobal("Convex", { asyncSyscall: syscall });
  const run = await startAgent({}, catalog.test, {
    for: "object",
    args: { request: "read" },
  });
  expectTypeOf(run).toEqualTypeOf<RunRef<bigint>>();
  expect(JSON.parse(syscall.mock.calls[0][1] as string)).toEqual({
    agent: "test",
    contract: "a".repeat(64),
    for: "object",
    input: '{"request":"read"}',
  });
  const completed = await getAgentRun({}, run);
  if (completed.state !== "succeeded" || completed.delivery === "withheld")
    throw new Error("Expected delivered success");
  expectTypeOf(completed.result).toEqualTypeOf<bigint>();
  expect(completed.result).toBe(9007199254740993n);
});

test("ordered delivery decodes a first claim and settles its exact ticket", async () => {
  const syscall = vi.fn(async (name: string, args: string) => {
    expect(name).toBe("1.0/agents/delivery");
    const request = JSON.parse(args);
    return JSON.stringify(
      request.kind === "claim"
        ? {
            ticket: "ticket",
            state: "dispatching",
            audienceRevision: 3,
            result:
              request.requestKey === "first"
                ? bijectionToJson(9007199254740993n)
                : null,
          }
        : { ticket: request.ticket, state: request.outcome },
    );
  });
  vi.stubGlobal("Convex", { asyncSyscall: syscall });
  const first = await claimAgentDelivery(
    {},
    "spoken" as RunRef<bigint>,
    "first",
  );
  expectTypeOf(first.result).toEqualTypeOf<bigint | null>();
  expect(first.result).toBe(9007199254740993n);
  const retry = await claimAgentDelivery(
    {},
    "spoken" as RunRef<bigint>,
    "retry",
  );
  expect(retry).toMatchObject({ ticket: "ticket", result: null });
  expect(
    await settleAgentDelivery({}, "spoken", first.ticket, "unknown"),
  ).toEqual({ ticket: "ticket", state: "unknown" });
  expect(JSON.parse(syscall.mock.calls.at(-1)![1])).toEqual({
    kind: "settle",
    run: "spoken",
    ticket: "ticket",
    outcome: "unknown",
  });
});

const call = (name: string, id = name, result: unknown = null) => ({
  type: "tool-call",
  toolName: name,
  toolCallId: id,
  input: JSON.stringify(name === "complete" ? { result } : {}),
});
test("completion cannot share a batch with a query or proposal", () => {
  const prepare = vi.fn((_name: string, input: unknown) => input);
  expect(() =>
    validateModelResponse(
      { content: [call("complete"), call("read")] },
      new Set(),
      prepare,
    ),
  ).toThrow("only tool call");
  expect(() =>
    validateModelResponse(
      { content: [call("complete"), call("complete", "second")] },
      new Set(),
      prepare,
    ),
  ).toThrow("only tool call");
  expect(
    validateModelResponse(
      { content: [call("complete")] },
      new Set(Array.from({ length: 64 }, (_, i) => `${i}`)),
      prepare,
    ).calls,
  ).toHaveLength(1);
});

test("the component commits decoded completion with its final checkpoint and no continuation", async () => {
  const agent = defineAgent({
    ...definition(),
    model: model("Completion replays no model call"),
  });
  const bundle = agentsModule({
    agents: { test: agent },
    access: {} as AccessModel,
  });
  const response = {
    content: [call("complete", "finish", "9007199254740993")],
  };
  const syscall = vi.fn(async (name: string, raw: string) => {
    if (name === "1.0/agents/progress")
      return JSON.stringify({
        step: 0,
        phase: "responded",
        prompt: "[]",
        response: JSON.stringify(response),
      });
    expect(name).toBe("1.0/agents/checkpoint");
    const update = JSON.parse(raw);
    if (update.kind === "admit") {
      expect(update.response).toBe(JSON.stringify(response));
      expect(update.batch).toEqual({
        calls: [],
        outputs: [],
        completion: JSON.stringify(bijectionToJson(9007199254740993n)),
      });
      return JSON.stringify({ step: 0, phase: "responded" });
    }
    expect(update.kind).toBe("advance");
    expect(update.result).toEqual({ value: bijectionToJson(9007199254740993n) });
    return JSON.stringify({ step: 0, phase: "done" });
  });
  vi.stubGlobal("Convex", { asyncSyscall: syscall });
  const advance = (bundle as any).test_advance._handler;
  expect(
    await advance(
      {},
      {
        run: "run",
        session: "session",
        step: 0,
        for: "object",
        input: '{"request":"read"}',
        observations: "[]",
      },
    ),
  ).toEqual({ step: 0, phase: "done" });
  expect(syscall).toHaveBeenCalledTimes(3);
});

test("the SDK selects bounded native outputs and action identities from provider content", () => {
  const validated = validateModelResponse(
    {
      content: [
        { type: "reasoning", text: "private reasoning" },
        { type: "text", text: "  " },
        { type: "text", text: "delivered" },
        { type: "text", text: "é".repeat(2049) },
        {
          type: "tool-call",
          toolCallId: "read-1",
          toolName: "lookup",
          input: "{}",
        },
      ],
    },
    new Set(),
    () => ({ kind: "query" }),
  );
  expect(normalizeAgentResponse(validated, undefined)).toEqual({
    calls: ["read-1"],
    outputs: [{ part: 1, text: "delivered" }],
    completion: null,
  });
  const completed = validateModelResponse(
    { content: [call("complete", "finish", null)] },
    new Set(),
    () => ({ kind: "complete" }),
  );
  expect(normalizeAgentResponse(completed, null)).toEqual({
    calls: [],
    outputs: [],
    completion: "null",
  });
});

test("agent declarations serve an interaction with capabilities on several resource types", () => {
  const interaction = { definition: "installed interaction" };
  const agent = defineAgent({
    ...definition(),
    sessions: issuedSessions({
      service: "support",
      roles: ["customer:agent", "booking:agent"],
      interaction,
    }),
  });
  expect(agent.sessions.interaction).toEqual(interaction);
  expect(agent.sessions.roles).toEqual(["customer:agent", "booking:agent"]);
  expect(() =>
    issuedSessions({
      service: "support",
      roles: ["customer:agent", "customer:changes"],
    }),
  ).toThrow("interaction");
});

test("native requirements suspend one run and ready requests schedule one continuation", async () => {
  const operation = await makeOperationReference("desk.js:change", {
    on: "Record",
    args: { item: v.string() },
    provenance: { item: "checked" },
    returns: v.null(),
    agreement: { presentation: "desk:terms" },
  });
  const contracts = linkedToolContracts({
    "desk.js:change": {
      kind: "operation",
      metadata: getOperationContract(operation),
    },
  });
  const agent = defineAgent({
    ...definition(),
    model: model("Advance never reruns the model"),
    tools: {
      change: tool.operation(contracts.desk.change, "Change it", {
        mode: "invoke",
      }),
    },
  });
  const bundle = agentsModule({
    agents: { test: agent },
    access: { describe: () => ({ resources: [] }) } as unknown as AccessModel,
  });
  for (const kind of ["verification", "agreement", "approval"])
    for (const waiting of [true, false]) {
      const syscall = vi.fn(async (name: string, raw: string) => {
        const args = JSON.parse(raw);
        if (name === "1.0/agents/progress")
          return JSON.stringify({
            step: 0,
            phase: "responded",
            prompt: "[]",
            response: JSON.stringify({
              content: [
                {
                  type: "tool-call",
                  toolName: "change",
                  toolCallId: "ask",
                  input: '{"item":"alice"}',
                },
              ],
            }),
          });
        if (name === "1.0/agents/checkpoint")
          return JSON.stringify({ step: 1, phase: "ready" });
        if (name === "1.0/agents/wait") {
          expect(args).toMatchObject({
            requests: ["request"],
            run: "run",
          });
          return JSON.stringify({ waiting });
        }
        expect(name).toBe("1.0/agents/schedule");
        return "null";
      });
      vi.stubGlobal("Convex", { asyncSyscall: syscall });
      await (bundle as any).test_advance._handler(
        {
          meta: {
            getFunctionMetadata: async () => ({ name: "agents:test_run" }),
          },
          runMutation: async () => null,
        },
        {
          run: "run",
          session: "session",
          step: 0,
          for: "alice",
          input: "{}",
          observations: JSON.stringify([
            {
              toolCallId: "ask",
              value: {
                result: {
                  kind: "pending",
                  proposal_id: "offer",
                  requirements: [
                    {
                      kind,
                      ...(kind === "verification"
                        ? { verificationId: "customer:alice" }
                        : kind === "agreement"
                          ? { proposalId: "offer", agreementId: "offer" }
                          : { proposalId: "offer", approvalId: "offer:0" }),
                    },
                  ],
                  request_key: "request",
                  expires_at: "1000",
                },
              },
            },
          ]),
        },
      );
      expect(
        syscall.mock.calls.filter(([name]) => name === "1.0/agents/schedule"),
      ).toHaveLength(waiting ? 0 : 1);
    }
});

// Fails if: a handed-out field reaches the model as a value, another field is
// hidden, or a tool schema refuses a handle where an argument is expected.
test("handed-out query fields reach the model only as handles", () => {
  expect(
    handOut("call-1", ["payment_method"], {
      order: "o1",
      payment_method: "pm_secret",
    }),
  ).toEqual({
    order: "o1",
    payment_method: { $handle: "call-1:payment_method" },
  });
  expect(
    handOut(
      "call-2",
      ["payment_method"],
      [
        { order: "o1", payment_method: "pm_a" },
        { order: "o2", payment_method: "pm_b" },
      ],
    ),
  ).toEqual([
    { order: "o1", payment_method: { $handle: "call-2:0.payment_method" } },
    { order: "o2", payment_method: { $handle: "call-2:1.payment_method" } },
  ]);
  const schema = acceptingHandles({
    type: "object",
    properties: { destination: { type: "string" } },
    required: ["destination"],
  });
  expect(schema.properties.destination.anyOf).toEqual([
    { type: "string" },
    {
      type: "object",
      properties: { $handle: { type: "string" } },
      required: ["$handle"],
      additionalProperties: false,
    },
  ]);
});

// Fails if: an operation tool hands out values, or a query tool hands out an
// invalid or repeated field.
test("only a query tool hands out distinct result fields", async () => {
  const operation = await makeOperationReference("desk.js:refund", {
    on: "Record",
    args: { destination: v.string() },
    returns: v.null(),
  });
  const contracts = linkedToolContracts({
    "desk.js:refund": {
      kind: "operation",
      metadata: getOperationContract(operation),
    },
  });
  const refund = tool.operation(contracts.desk.refund, "Refund.");
  expect(() =>
    defineToolset({ refund: { ...refund, handles: ["destination"] } }),
  ).toThrow("only a query tool");
  expect(defineToolset({ refund }).refund).not.toHaveProperty("handles");
});
