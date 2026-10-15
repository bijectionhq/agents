import { afterEach, expect, expectTypeOf, test, vi } from "vitest";
import {
  defineAgent,
  agentsModule,
  startAgent,
  getAgentRun,
  type RunRef,
  type PublicProposal,
} from "./index.js";
import { linkedAgentReferences, type AgentReference } from "./references.js";
import { validateModelResponse } from "./response.js";
import { issuedSessions } from "bijection/sessions";
import { v, type GenericId } from "bijection/values";
import { bijectionToJson } from "bijection/values";
import {
  componentsGeneric,
  getFunctionAddress,
  type AccessModel,
  type ApiFromModules,
  type FunctionArgs,
  type FunctionReturnType,
} from "bijection/server";

const definition = () => ({
  args: { request: v.string() },
  returns: v.int64(),
  description: "Read and complete",
  instructions: "Complete with an exact integer",
  model: "test",
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
  if (completed.state !== "succeeded") throw new Error("Expected success");
  expectTypeOf(completed.result).toEqualTypeOf<bigint>();
  expect(completed.result).toBe(9007199254740993n);
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

test("the module commits decoded completion in its component without native reasoning bytes", async () => {
  const agent = defineAgent(definition());
  const component = componentsGeneric().agents as any;
  const bundle = agentsModule({
    component,
    agents: { test: agent },
    access: {} as AccessModel,
    models: {
      open: async () => {
        throw new Error("Completion replays no model call");
      },
    },
  });
  const response = {
    content: [call("complete", "finish", "9007199254740993")],
  };
  const runQuery = vi.fn(async (reference: string) => {
    expect(getFunctionAddress(reference as any)).toEqual(
      getFunctionAddress(component.native.progress),
    );
    return {
      step: 0,
      phase: "responded",
      prompt: "[]",
      response: JSON.stringify(response),
    };
  });
  const runMutation = vi.fn(async (reference: string, update: any) => {
    expect(getFunctionAddress(reference as any)).toEqual(
      getFunctionAddress(component.native.advance),
    );
    expect(update.result).toEqual({ value: 9007199254740993n });
    return { step: 0, phase: "done" };
  });
  const syscall = vi.fn(() => {
    throw new Error("Completion cannot use native agent checkpoints");
  });
  vi.stubGlobal("Convex", { asyncSyscall: syscall });
  const advance = (bundle as any).test_advance._handler;
  expect(
    await advance(
      { runQuery, runMutation },
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
  expect(runMutation).toHaveBeenCalledOnce();
  expect(syscall).not.toHaveBeenCalled();
});

test("governed runs require an installed component", () => {
  expect(() =>
    agentsModule({ agents: {}, access: {}, models: {} } as any),
  ).toThrow("install and pass the agents component");
});

test("the generated API publishes one reviewed component operation with private proposal types", () => {
  type Api = ApiFromModules<{
    agents: { default: ReturnType<typeof agentsModule> };
  }>;
  expectTypeOf<Api["agents"]["submit"]["_args"]>().toEqualTypeOf<{
    proposal: GenericId<"agentProposals">;
  }>();
  expectTypeOf<Api["agents"]["submit"]["_returnType"]>().toEqualTypeOf<
    GenericId<"agentProposals">
  >();
  expectTypeOf<FunctionArgs<Api["agents"]["proposals"]>>().toEqualTypeOf<{
    for: string;
  }>();
  expectTypeOf<FunctionReturnType<Api["agents"]["proposals"]>>().toEqualTypeOf<
    PublicProposal[]
  >();
  const bundle = agentsModule({
    component: componentsGeneric().agents as any,
    agents: {},
    access: {} as AccessModel,
    models: {} as any,
  });
  const binding = JSON.parse((bundle as any).exportComponentBinding());
  expect(binding.callbacks).toEqual({
    resolve: { name: ":_resolveProposal" },
    submit: { name: ":_submitProposal" },
    legacy: { name: ":_legacyProposals" },
  });
  expect(binding.configure.reference).toBe(
    "_reference/childComponent/agents/proposals/configure",
  );
  expect(Object.keys(bundle)).toContain("submit__invoke");
  expect(Object.keys(bundle)).not.toContain("submit");
  expect(
    JSON.parse((bundle as any).submit__invoke.exportOperationForwarder()),
  ).toEqual({
    export: "submit",
    member: "invoke",
    reference: "_reference/childComponent/agents/proposals/submit__invoke",
  });
});
