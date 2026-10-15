import {
  selectedAgentReference,
  type AgentReference,
  type RunRef,
} from "./references.js";
export {
  linkedAgentReferences,
  symbolicAgentReferences,
} from "./references.js";
export type { AgentReference, RunRef } from "./references.js";
import { linkedToolContract, toolContractLink } from "bijection/tools";
import {
  MAX_TOOL_REASON,
  MAX_AGENT_INPUT_BYTES,
  textBytes,
  MAX_PROMPT_BYTES,
  MAX_TOOL_RESULT_BYTES,
  jsonBytes,
  validateModelResponse,
} from "./response.js";
/** Agents the deployment runs (`defineAgent`): a model loop that reads
 * with its own query tools as one of its service-issued sessions and proposes
 * operations a person reviews.
 *
 * `agentsModule` installs agents independently of MCP servers. An operation
 * starts a run for one object; the scheduler starts its service-issued
 * session and runs its model with query tools. Current access decides every
 * read. Operations become protected proposals that a person submits under
 * their own authority. Administration enables the service's agent credential.
 * @module
 */
import {
  internalActionGeneric,
  internalMutationGeneric,
  mutationGeneric,
  queryGeneric,
} from "bijection/server";
import {
  makeFunctionReference,
  getFunctionAddress,
  type FunctionReference,
} from "bijection/server";
import { scopedExecution, registerScopedSession } from "bijection/server";
import { log } from "bijection/server";
import {
  v,
  asObjectValidator,
  type PropertyValidators,
  type ObjectType,
  type Infer,
} from "bijection/values";
import type { Validator } from "bijection/values";
import { bijectionToJson, jsonToBijection } from "bijection/values";
import {
  generatedOperationReference,
  operationFunctionReference,
} from "bijection/server";
import { isPerson, PERSON_DECISION_REQUIRED } from "bijection/server";
import {
  CREDENTIAL_CLAIM,
  SESSION_SUBJECT,
  serviceIssuer,
  servicePrincipal,
} from "bijection/server";
import { encodeValue, decodeValue, schemaFor } from "bijection/tools";
import {
  toolArguments,
  suppliedArgs,
  type CompiledTool,
} from "bijection/tools";
import { issuedSessions, type IssuedSessionPolicy } from "bijection/sessions";
import { defineToolset, type Toolset } from "bijection/tools";
import { toolRuntime } from "bijection/tools";
import type { AccessModel } from "bijection/server";
import { functionBundle } from "bijection/server";
import { internalQueryGeneric } from "bijection/server";
import {
  defineComponentBinding,
  type OperationReference,
} from "bijection/server";
import { exposeComponentOperation } from "bijection/components";
import type { GenericId, Value } from "bijection/values";

export type PublicProposal = {
  id: GenericId<"agentProposals">;
  originalId?: string;
  agent: string;
  for: string;
  session: string;
  tool: string;
  operation: string;
  arguments: Record<string, Value>;
  reason: string;
  state: "pending" | "submitted" | "rejected";
  proposed_at: number;
  decided_by: string | null;
  decided_at: bigint | null;
};

const AGENT_NAME = /^[a-z][A-Za-z0-9]{0,31}$/;
const DEFAULT_STEPS = 8;
const MAX_STEPS = 16;

function seenCalls(prompt: any[]): Set<string> {
  const seen = new Set<string>();
  for (const message of prompt)
    if (message.role === "assistant")
      for (const part of message.content)
        if (part.type === "tool-call" && part.toolName !== "complete")
          seen.add(part.toolCallId);
  return seen;
}

/** The part of an AI SDK `LanguageModelV4` a run uses: one generation step
 * with function tools. @public */
export type AgentLanguageModel = {
  doGenerate(options: {
    prompt: unknown[];
    tools: {
      type: "function";
      name: string;
      description: string;
      inputSchema: unknown;
    }[];
    toolChoice: { type: "auto" };
  }): Promise<{ content: { type: string; [field: string]: unknown }[] }>;
};

/** Where an agent's runs get their model: the program's language models,
 * metered per run (`new LanguageModels(component, catalog)` from
 * `@bijectionhq/language-models`). @public */
export type AgentModels = {
  open(
    ctx: any,
    session: { consumer: string; subject: string; key: string },
  ): Promise<{
    /** One durable step identity within this run's model session. Reusing it
     * must refuse before dispatch rather than send another provider request. */
    attempt(
      attemptKey: string,
      modelKey: string,
      requires?: readonly string[],
    ): AgentLanguageModel;
    close(failure?: any): Promise<unknown>;
  }>;
};

/** One agent: what it reads, what it may propose, and its model. @public */
export type AgentDefinition<
  Args extends PropertyValidators = PropertyValidators,
  Result extends Validator<any, "required", any> = Validator<
    any,
    "required",
    any
  >,
> = {
  /** Business input, validated natively when the operation admits the run. */
  args: Args;
  /** The value required to complete a run. Text alone never completes it. */
  returns: Result;
  description: string;
  /** Each run receives this service-issued authority on one object. */
  sessions: IssuedSessionPolicy;
  /** Queries become observations; operations become proposals for review.
   * Tool declarations never confer authority to submit an operation. */
  tools: Toolset;
  /** A key of the program's language models catalog. */
  model: string;
  /** What this agent does, which the model reads before every run after
   * tools. */
  instructions: string;
  /** Model steps one run takes at most, 1 to 16. Default 8. */
  maxSteps?: number;
};

/** A validated agent declaration. @public */
export type AgentDeclaration<Args = any, Result = any> = Readonly<{
  args: Validator<Args, "required", any>;
  returns: Validator<Result, "required", any>;
  description: string;
  sessions: IssuedSessionPolicy;
  tools: Toolset;
  model: string;
  instructions: string;
  maxSteps: number;
}>;

type NamedAgent = AgentDeclaration & { readonly name: string };

/** What one run is for. @public */
export type AgentRunInput<Args> = {
  /** The object of the session policy's resource type the run acts for. */
  for: string;
  /** Input of the selected agent's admitted contract. */
  args: Args;
};

/** Start a run from an operation's preparation; it starts once acceptance
 * commits. The native parent operation supplies its intention identity.
 * Retrying that request returns the original run without another job or
 * session. The run carries what the operation read, so a run whose
 * starter read protected rows decides them for the sessions it starts. @public */
type AgentArgs<Ref> =
  Ref extends AgentReference<infer Args, any> ? Args : never;
type AgentResult<Ref> =
  Ref extends AgentReference<any, infer Result> ? Result : never;

export async function startAgent<Ref extends AgentReference<any, any>>(
  _ctx: any,
  agent: Ref,
  run: AgentRunInput<AgentArgs<Ref>>,
): Promise<RunRef<AgentResult<Ref>>> {
  const selected = selectedAgentReference(agent);
  const input = JSON.stringify(bijectionToJson(run.args as any));
  if (
    !run ||
    typeof run.for !== "string" ||
    !run.for ||
    run.for.length > 256 ||
    textBytes(input) > MAX_AGENT_INPUT_BYTES
  )
    throw new Error(
      `Agent ${selected.name} acts for one object; its input is at most 16 KiB`,
    );
  return (await scopedExecution.schedule({
    agent: selected.name,
    contract: selected.contract,
    for: run.for,
    input,
  })) as RunRef<AgentResult<Ref>>;
}

/** The native checkpoint saved for a run. `ready` means no response has
 * been saved for this step; a provider request may already have been sent.
 * `responded` means the complete response is saved and its tool batch has
 * not committed. `done` and `exhausted` describe the committed terminal
 * checkpoint. These phases describe custody, not provider delivery or cost.
 * @public */
export type AgentRunProgress = {
  /** Zero-based model step, 0 to 15; presentation adds one. */
  step: number;
  phase: "ready" | "responded" | "done" | "exhausted";
};

/** The engine's current execution record. Failure describes execution;
 * unsettled model attempts retain their own unknown outcome. @public */
export type AgentRun<Result = unknown> = {
  id: string;
  agent: string;
  createdAt: number;
  finishedAt: number | null;
  /** The last committed checkpoint, or null before initialization. The
   * prompt and response bodies stay in private component custody. */
  progress: AgentRunProgress | null;
} & (
  | { state: "succeeded"; result: Result }
  | {
      state: "queued" | "running" | "failed" | "cancelled";
      result: null;
    }
);

/** Read a run from a query or mutation as its initiating principal. Current
 * access to its retained sources still applies. @public */
export function getAgentRun<Result>(
  ctx: any,
  run: RunRef<Result>,
): Promise<AgentRun<Result>>;
export function getAgentRun(ctx: any, run: string): Promise<AgentRun<unknown>>;
export async function getAgentRun(
  _ctx: any,
  run: string,
): Promise<AgentRun<unknown>> {
  const record = await scopedExecution.get(run);
  return decodeRun(record);
}

function decodeRun(record: any): AgentRun {
  const { checkpoint, ...run } = record;
  const phases = {
    dispatch: "ready",
    replay: "responded",
    succeeded: "done",
    exhausted: "exhausted",
  } as const;
  return {
    ...run,
    progress: checkpoint
      ? {
          step: checkpoint.step,
          phase: phases[checkpoint.state as keyof typeof phases],
        }
      : run.progress,
    result: jsonToBijection(run.result),
  };
}

/** Cancel a run from a mutation as its initiating principal. Cancellation
 * ends its issued authority and prevents further committed work. It cannot
 * undo a provider request already dispatched. Repeating it preserves the
 * first terminal state. @public */
export async function cancelAgentRun(
  _ctx: any,
  run: string,
): Promise<AgentRun> {
  const record = await scopedExecution.cancel(run);
  return decodeRun(record);
}

/** The caller's latest 50 runs, newest first at one query basis. Each run's
 * retained sources still require current read access. `isComplete` is false
 * when this bounded scan is incomplete; use `getAgentRun` for a known older
 * identity. @public */
export async function recentAgentRuns(
  _ctx: any,
): Promise<{ runs: AgentRun[]; isComplete: boolean }> {
  const page = await scopedExecution.recent();
  return {
    ...page,
    runs: page.runs.map(decodeRun),
  };
}

/** Declare an agent the deployment runs. Throws on an inconsistent
 * declaration. @public */
export function defineAgent<
  Args extends PropertyValidators,
  Result extends Validator<any, "required", any>,
>(
  definition: AgentDefinition<Args, Result>,
): AgentDeclaration<ObjectType<Args>, Infer<Result>> {
  const fail = (message: string): never => {
    throw new Error(`Agent: ${message}`);
  };
  for (const key of Object.keys(definition))
    if (
      ![
        "description",
        "args",
        "returns",
        "sessions",
        "tools",
        "model",
        "instructions",
        "maxSteps",
      ].includes(key)
    )
      fail(`unexpected property ${key}`);
  if (
    typeof definition.description !== "string" ||
    !definition.description.trim()
  )
    fail("describe it");
  if (definition.sessions?.kind !== "issued")
    fail("runs require a service-issued session policy");
  const sessions = issuedSessions(definition.sessions);
  if (sessions.beforeVerification.length || sessions.evidence !== null)
    fail(
      "runs start for a known object; verification belongs to the application",
    );
  const args = asObjectValidator(definition.args);
  if (
    args.json.type !== "object" ||
    definition.returns?.isOptional !== "required"
  )
    fail("declare object args and a required result validator");
  schemaFor(args.json);
  schemaFor(definition.returns.json);
  const tools = defineToolset(definition.tools);
  if (Object.hasOwn(tools, "complete"))
    fail("complete is reserved for the typed result");
  if (Object.values(tools).some((tool) => tool.kind === "status"))
    fail("tools are queries or operations: use tool.query or tool.operation");
  if (Object.values(tools).filter((tool) => tool.kind === "query").length > 32)
    fail("read with at most 32 queries");
  if (
    Object.values(tools).filter((tool) => tool.kind === "operation").length > 16
  )
    fail("propose at most 16 operations");
  if (typeof definition.model !== "string" || !definition.model)
    fail("name a model of the language models catalog");
  if (
    typeof definition.instructions !== "string" ||
    !definition.instructions.trim() ||
    textBytes(definition.instructions) > MAX_AGENT_INPUT_BYTES
  )
    fail("instructions are at most 16 KiB of text");
  const maxSteps = definition.maxSteps ?? DEFAULT_STEPS;
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > MAX_STEPS)
    fail(`maxSteps is a whole number from 1 to ${MAX_STEPS}`);
  return Object.freeze({
    description: definition.description,
    args,
    returns: definition.returns,
    sessions,
    tools,
    model: definition.model,
    instructions: definition.instructions,
    maxSteps,
  });
}

/** Configuration of the independent agent module. @public */
export type AgentsModuleOptions = {
  /** Installed private state owner. */
  component: {
    native: {
      progress: FunctionReference<"query", "public", any, any>;
      initialize: FunctionReference<"mutation", "public", any, any>;
      response: FunctionReference<"mutation", "public", any, any>;
      advance: FunctionReference<"mutation", "public", any, any>;
    };
    proposals: {
      configure: FunctionReference<"mutation", "public", any, any>;
      propose: FunctionReference<"mutation", "public", any, any>;
      proposals: FunctionReference<"query", "public", any, any>;
      reject: FunctionReference<"mutation", "public", any, any>;
      submit: OperationReference<
        "public",
        { proposal: GenericId<"agentProposals"> },
        GenericId<"agentProposals">
      >;
    };
  };
  access: AccessModel;
  /** Registration supplies each agent's name exactly once. */
  agents: Readonly<Record<string, AgentDeclaration>>;
  models: AgentModels;
};

type AgentHost = ReturnType<typeof toolRuntime> & {
  models: AgentModels;
  component: AgentsModuleOptions["component"];
};

/** Proposal tools confer no operation role on the agent's issued session. */
function readAuthority(agent: AgentDeclaration) {
  return {
    sessions: agent.sessions,
    tools: Object.fromEntries(
      Object.entries(agent.tools).filter(([, tool]) => tool.kind === "query"),
    ),
  };
}

/** The host's native function metadata is the sole module identity. */
async function moduleOf(ctx: any): Promise<string> {
  const { name } = await ctx.meta.getFunctionMetadata();
  return name.slice(0, name.indexOf(":"));
}

/** Install agents and their proposal review functions. An agent needs no
 * MCP server, route, or HTTP origin. @public */
export function agentsModule(options: AgentsModuleOptions) {
  for (const key of Object.keys(options))
    if (!["access", "agents", "models", "component"].includes(key))
      throw new Error(`agentsModule: unexpected property ${key}`);
  if (!options.agents || Array.isArray(options.agents))
    throw new Error("agentsModule: register agents by name");
  const agents = new Map<string, NamedAgent>();
  for (const [name, agent] of Object.entries(options.agents)) {
    if (!AGENT_NAME.test(name))
      throw new Error(
        "An agent name is a camelCase identifier of at most 32 characters",
      );
    agents.set(name, Object.freeze({ ...agent, name }));
  }
  if (agents.size > 16)
    throw new Error("agentsModule: declare at most 16 agents");
  if (!options.component)
    throw new Error("agentsModule: install and pass the agents component");
  if (!options.models)
    throw new Error("agentsModule: pass the program's models");
  const host = {
    ...toolRuntime(options.access),
    models: options.models,
    component: options.component,
  };
  const members = agentMembers(agents, host);
  const describe = internalQueryGeneric({
    args: {},
    handler: async (ctx) => ({
      module: await moduleOf(ctx),
      agents: describeAgents(agents),
    }),
  });
  Object.defineProperty(describe, "exportAgentModule", {
    value: () =>
      JSON.stringify({
        problems: [...agents.values()].flatMap((agent) =>
          host
            .problemsOf(readAuthority(agent))
            .map((problem) => `Agent ${agent.name}: ${problem}`),
        ),
        tables: [],
        agents: nativeAgents(agents, host),
      }),
  });
  const binding = defineComponentBinding({
    configure: options.component.proposals.configure,
    args: { agents: [...agents.keys()].sort() },
    removedArgs: { agents: [] },
    callbacks: {
      resolve: makeFunctionReference<"query">(":_resolveProposal"),
      submit: makeFunctionReference<"mutation">(":_submitProposal"),
      legacy: makeFunctionReference<"query">(":_legacyProposals"),
    },
    retainedCallbacks: ["legacy"],
    access: [...agents.keys()].sort().map((key) => ({
      kind: "agent",
      key,
      operations: ["propose", "review"],
    })),
  });
  const bundle = functionBundle(Object.assign(members, { describe }));
  Object.defineProperties(bundle, {
    isComponentBinding: { value: true },
    exportComponentBinding: { value: () => binding.exportComponentBinding() },
  });
  return bundle;
}

const refused = () => new Error("Access refused");

/** The functions behind `agents`: each agent's steps and proposals, and
 * the review a person makes of them. */
function agentMembers(
  agents: ReadonlyMap<string, NamedAgent>,
  host: AgentHost,
) {
  const members: Record<string, unknown> = {};
  const reference = async <Type extends "query" | "mutation" | "action">(
    ctx: any,
    member: string,
  ) => makeFunctionReference<Type>(`${await moduleOf(ctx)}:${member}`);
  /** The tools a run may propose with, as a server session would call
   * them: the bound argument is the run's object. */
  const proposalsOf = async (agent: NamedAgent) =>
    Object.fromEntries(
      Object.entries(await host.toolsOf(agent)).filter(
        ([name]) => agent.tools[name]?.kind === "operation",
      ),
    );
  const audit = (ctx: any, line: Record<string, unknown>) =>
    (ctx.audit ?? log.audit)(line);

  for (const agent of agents.values()) {
    const name = agent.name;

    /** The run's session, as the session itself: its principal. */
    const runSession = async (ctx: any) => {
      const identity = await ctx.auth.getUserIdentity();
      const principal = identity ? servicePrincipal(identity) : null;
      if (!principal?.session || principal.service !== agent.sessions.service)
        throw refused();
      return identity.tokenIdentifier as string;
    };

    /** As the agent's service: start the run's session. */
    members[`${name}_open`] = internalActionGeneric({
      args: {
        run: v.string(),
        for: v.string(),
        input: v.string(),
      },
      handler: async (ctx: any, args) => {
        await ctx.runMutation(
          await reference<"mutation">(ctx, `${name}_begin`),
          args,
        );
      },
    });
    /** As the agent's service, in one transaction: register the session in
     * the engine, acting for the run's object in its session role, and
     * schedule the run as the session. It holds that role, and its ancestor
     * roles above the object, only while the service may issue each there;
     * it is granted nothing. */
    members[`${name}_begin`] = internalMutationGeneric({
      args: {
        run: v.string(),
        for: v.string(),
        input: v.string(),
      },
      handler: async (ctx: any, args) => {
        const identity = await ctx.auth.getUserIdentity();
        const service = identity ? servicePrincipal(identity) : null;
        if (
          !service ||
          service.service !== agent.sessions.service ||
          service.session !== null ||
          typeof identity[CREDENTIAL_CLAIM] !== "string"
        )
          throw refused();
        const admitted = await scopedExecution.open({
          agent: name,
          ...args,
        });
        if (admitted.started) return;
        const session = admitted.session;
        const principal = `${serviceIssuer(agent.sessions.service)}|${SESSION_SUBJECT}${session}`;
        const expiresAt = admitted.expiresAt;
        if (!args.for || args.for.length > 256) throw refused();
        const registered = await registerScopedSession({
          session,
          until: expiresAt,
          functions: [`${await moduleOf(ctx)}:${name}_run`],
          endpoint: `/agents/${name}`,
          server: name,
          role: agent.sessions.role,
          ancestorRoles: agent.sessions.ancestorRoles,
          for: { type: agent.sessions.resourceType, key: args.for },
          // A run reads with its query tools and only proposes
          // operations: it holds no operation role.
          operations: [],
          evidence: null,
        });
        if (registered !== principal) throw refused();
        await scopedExecution.schedule({
          agent: name,
          run: args.run,
          session,
          for: args.for,
          ...(args.input !== undefined ? { input: args.input } : {}),
        });
        await audit(ctx, {
          action: "agent.run",
          agent: name,
          session: principal,
        });
      },
    });

    /** As the run's session: the model loop. The scheduler records its
     * terminal state and ends its authority even if this process exits. */
    members[`${name}_run`] = internalActionGeneric({
      args: {
        run: v.string(),
        session: v.string(),
        step: v.number(),
        for: v.string(),
        input: v.string(),
      },
      handler: async (ctx: any, args) => {
        await runLoop(ctx, args);
      },
    });

    const stepTools = async (ctx: any, args: { run: string; for: string }) => {
      // Query tools read with the run's session; operations are proposals.
      const reads = Object.fromEntries(
        Object.entries(await host.toolsOf(agent)).filter(
          ([tool]) => agent.tools[tool]?.kind === "query",
        ),
      );
      const proposals = await proposalsOf(agent);
      const tools = [
        {
          type: "function" as const,
          name: "complete",
          description:
            "Complete the run with its typed result. Call this alone, after all other work.",
          inputSchema: {
            type: "object",
            properties: { result: schemaFor(agent.returns.json) },
            required: ["result"],
            additionalProperties: false,
          },
        },
        ...Object.entries(reads).map(([tool, published]) => ({
          type: "function" as const,
          name: tool,
          description: published.description,
          inputSchema: schemaFor(suppliedArgs(published)),
        })),
        ...Object.entries(proposals).map(([tool, published]) => ({
          type: "function" as const,
          name: tool,
          description: `${published.description} This only proposes it: a person reviews the proposal, and nothing changes unless they submit it.`,
          inputSchema: {
            type: "object",
            properties: {
              arguments: schemaFor(suppliedArgs(published)),
              reason: {
                type: "string",
                description:
                  "Why you propose this, for the person reviewing it.",
              },
            },
            required: ["arguments", "reason"],
            additionalProperties: false,
          },
        })),
      ];
      const record = async (tool: string, outcome: string) =>
        ctx.runMutation(await reference<"mutation">(ctx, `${name}_record`), {
          tool,
          outcome,
        });
      type PreparedCall =
        | { kind: "query"; tool: CompiledTool; arguments: unknown }
        | { kind: "proposal"; arguments: string; reason: string }
        | { kind: "complete"; result: unknown };
      const prepareCall = (tool: string, input: unknown): PreparedCall => {
        if (!input || typeof input !== "object" || Array.isArray(input))
          throw new Error("Invalid arguments");
        if (tool === "complete") {
          if (Object.keys(input).join(" ") !== "result")
            throw new Error("Invalid completion");
          return {
            kind: "complete",
            result: decodeValue(agent.returns.json, (input as any).result),
          };
        }
        if (Object.hasOwn(reads, tool))
          return {
            kind: "query",
            tool: reads[tool]!,
            arguments: toolArguments(reads[tool]!, args.for, input),
          };
        if (!Object.hasOwn(proposals, tool))
          throw new Error("Tool unavailable");
        const { arguments: supplied, reason } = input as {
          arguments?: unknown;
          reason?: unknown;
        };
        if (
          Object.keys(input).some(
            (key) => key !== "arguments" && key !== "reason",
          ) ||
          typeof reason !== "string" ||
          !reason.trim() ||
          textBytes(reason) > MAX_TOOL_REASON
        )
          throw new Error("Invalid proposal");
        // Check the complete bound arguments before any call in this response.
        toolArguments(proposals[tool]!, args.for, supplied);
        return {
          kind: "proposal",
          arguments: JSON.stringify(supplied),
          reason,
        };
      };
      const observe = async (prepared: PreparedCall): Promise<unknown> => {
        if (prepared.kind !== "query")
          throw new Error("A query tool is required");
        try {
          const result = encodeValue(
            await prepared.tool.execute(ctx, prepared.arguments, {}),
          );
          return jsonBytes(result) > MAX_TOOL_RESULT_BYTES
            ? { error: "result_too_large" }
            : { result };
        } catch {
          return { error: "tool_refused" };
        }
      };
      const validateObservation = (observation: unknown) => {
        if (
          !observation ||
          typeof observation !== "object" ||
          Array.isArray(observation)
        )
          throw new Error("Invalid query observation");
        const value = observation as { result?: unknown; error?: unknown };
        const keys = Object.keys(value);
        if (
          keys.length !== 1 ||
          !(
            Object.hasOwn(value, "result") ||
            value.error === "result_too_large" ||
            value.error === "tool_refused"
          ) ||
          jsonBytes(value) > MAX_TOOL_RESULT_BYTES + 64
        )
          throw new Error("Invalid query observation");
        return value;
      };
      const call = async (
        name: string,
        prepared: PreparedCall,
        observation?: unknown,
        callId?: string,
      ): Promise<unknown> => {
        if (prepared.kind === "complete") return { completed: true };
        if (prepared.kind === "query") {
          const value = observation as ReturnType<typeof validateObservation>;
          await record(
            name,
            Object.hasOwn(value, "result")
              ? "completed"
              : value.error === "result_too_large"
                ? "result_too_large"
                : "refused",
          );
          return value;
        }
        try {
          const proposal = await ctx.runMutation(
            host.component.proposals.propose,
            {
              run: args.run,
              call: callId!,
              tool: name,
              supplied: prepared.arguments,
              reason: prepared.reason,
            },
          );
          return { proposed: proposal, state: "pending" };
        } catch {
          return { error: "proposal_refused" };
        }
      };

      return { tools, prepareCall, observe, call, validateObservation };
    };

    type Progress = {
      step: number;
      phase: "ready" | "responded" | "done" | "exhausted";
      prompt: string | null;
      response: string | null;
    };
    const runArgs = {
      run: v.string(),
      session: v.string(),
      step: v.number(),
      for: v.string(),
      input: v.string(),
    };
    const readProgress = (ctx: any, run: string): Promise<Progress> =>
      ctx.runQuery(host.component.native.progress, { run });
    members[`${name}_progress`] = internalQueryGeneric({
      args: { run: v.string() },
      handler: (ctx: any, { run }) => readProgress(ctx, run),
    });
    members[`${name}_response`] = internalMutationGeneric({
      args: { run: v.string(), step: v.number(), response: v.string() },
      handler: (ctx: any, args) =>
        ctx.runMutation(host.component.native.response, args),
    });
    members[`${name}_initialize`] = internalMutationGeneric({
      args: { run: v.string(), prompt: v.string() },
      handler: (ctx: any, args) =>
        ctx.runMutation(host.component.native.initialize, args),
    });
    // Queries run through native action callbacks at the run's fixed basis.
    // Their observations and all proposals enter custody with the next prompt
    // and sole continuation in one current mutation. No proposal is written
    // before the complete response and every query observation are validated.
    members[`${name}_advance`] = internalMutationGeneric({
      args: { ...runArgs, observations: v.string() },
      handler: async (ctx: any, args) => {
        const progress = await readProgress(ctx, args.run);
        if (progress.step !== args.step || progress.phase !== "responded")
          return progress;
        const prompt = JSON.parse(progress.prompt!);
        const { prepareCall, call, validateObservation } = await stepTools(
          ctx,
          args,
        );
        const seen = seenCalls(prompt);
        const validated = validateModelResponse(
          JSON.parse(progress.response!),
          seen,
          prepareCall,
        );
        const observations = JSON.parse(args.observations);
        const queryCalls = validated.calls.filter(
          ({ prepared }) => prepared.kind === "query",
        );
        if (
          !Array.isArray(observations) ||
          observations.length !== queryCalls.length ||
          queryCalls.some(
            ({ part }, index) =>
              observations[index]?.toolCallId !== part.toolCallId ||
              Object.keys(observations[index]).sort().join(" ") !==
                "toolCallId value",
          )
        )
          throw new Error("Invalid query observations");
        const values = observations.map((observation) =>
          validateObservation(observation.value),
        );
        let observed = 0;
        prompt.push({ role: "assistant", content: validated.content });
        if (validated.calls.length) {
          const results = [];
          for (const { part, prepared } of validated.calls)
            results.push({
              type: "tool-result",
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              output: {
                type: "json",
                value: await call(
                  part.toolName,
                  prepared,
                  prepared.kind === "query" ? values[observed++] : undefined,
                  part.toolCallId,
                ),
              },
            });
          prompt.push({ role: "tool", content: results });
        }
        const completion =
          validated.calls[0]?.prepared.kind === "complete"
            ? { value: validated.calls[0].prepared.result }
            : null;
        const next: Progress = await ctx.runMutation(
          host.component.native.advance,
          {
            run: args.run,
            step: args.step,
            prompt: JSON.stringify(prompt),
            result: completion,
          },
        );
        if (next.phase === "ready")
          await scopedExecution.schedule({
            agent: name,
            run: args.run,
            session: args.session,
            for: args.for,
            ...(args.input !== undefined ? { input: args.input } : {}),
            step: next.step,
          });
        return next;
      },
    });

    const runLoop = async (
      ctx: any,
      args: {
        run: string;
        session: string;
        step: number;
        for: string;
        input: string;
      },
    ) => {
      let progress: Progress = await ctx.runQuery(
        await reference<"query">(ctx, `${name}_progress`),
        { run: args.run },
      );
      // A superseded job cannot read progress natively. An idempotent replay
      // within a live job may only finish the step it was admitted to run.
      if (progress.step !== args.step) return;
      const opened = await host.models!.open(ctx, {
        consumer: "agents",
        subject: args.session,
        key: agent.model,
      });
      let failure: unknown = undefined;
      let finished =
        progress.phase === "done" || progress.phase === "exhausted";
      try {
        // A process can stop after terminal custody commits and before ledger
        // closure. Reopening the same intent lets this replay finish cleanup.
        if (finished) {
          if (progress.phase === "exhausted")
            throw new Error("Agent step limit reached");
          return;
        }
        if (progress.prompt === null) {
          const prompt: unknown[] = [
            {
              role: "system",
              content: `${agent.instructions}\n\nYou act for the ${agent.sessions.resourceType} ${args.for}. Read with your tools. Call complete with your typed result after all work. A proposal tool records a proposal for a person to review; nothing changes unless they submit it.`,
            },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    encodeValue(jsonToBijection(JSON.parse(args.input!))),
                  ),
                },
              ],
            },
          ];
          progress = await ctx.runMutation(
            await reference<"mutation">(ctx, `${name}_initialize`),
            { run: args.run, prompt: JSON.stringify(prompt) },
          );
        }
        if (progress.phase === "ready") {
          const prompt = JSON.parse(progress.prompt!);
          if (jsonBytes(prompt) > MAX_PROMPT_BYTES)
            throw new Error("Agent prompt limit reached");
          const { tools } = await stepTools(ctx, args);
          const generated = await opened
            .attempt(`step-${args.step}`, agent.model, ["tools"])
            .doGenerate({
              prompt,
              tools,
              toolChoice: { type: "auto" },
            });
          const response = JSON.stringify(generated);
          if (textBytes(response) > 64 * 1024)
            throw new Error("Invalid model response");
          progress = await ctx.runMutation(
            await reference<"mutation">(ctx, `${name}_response`),
            { run: args.run, step: args.step, response },
          );
        }
        if (progress.phase === "responded") {
          const { prepareCall, observe } = await stepTools(ctx, args);
          const validated = validateModelResponse(
            JSON.parse(progress.response!),
            seenCalls(JSON.parse(progress.prompt!)),
            prepareCall,
          );
          const observations = [];
          for (const { part, prepared } of validated.calls)
            if (prepared.kind === "query")
              observations.push({
                toolCallId: part.toolCallId,
                value: await observe(prepared),
              });
          progress = await ctx.runMutation(
            await reference<"mutation">(ctx, `${name}_advance`),
            { ...args, observations: JSON.stringify(observations) },
          );
        }
        finished = progress.phase === "done" || progress.phase === "exhausted";
        if (progress.phase === "exhausted")
          throw new Error("Agent step limit reached");
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        if (finished || failure !== undefined)
          await opened.close(failure === undefined ? null : undefined);
      }
    };

    /** As the run's session: one line in the audit log for one tool call.
     * The engine withholds its body from a reader who may not read what the
     * call read. */
    members[`${name}_record`] = internalMutationGeneric({
      args: { tool: v.string(), outcome: v.string() },
      handler: async (ctx: any, args) => {
        await audit(ctx, {
          action: "agent.call",
          agent: name,
          session: await runSession(ctx),
          tool: args.tool,
          outcome: args.outcome,
        });
        return null;
      },
    });
  }

  const resolveProposal = internalQueryGeneric({
    args: {
      agent: v.string(),
      tool: v.string(),
      for: v.string(),
      supplied: v.string(),
    },
    handler: async (_ctx: any, args) => {
      const agent = agents.get(args.agent);
      if (!agent) throw new Error("This agent is no longer declared");
      const proposed = (await proposalsOf(agent))[args.tool];
      if (!proposed) throw new Error("Tool unavailable");
      const binding = proposed.binding as {
        operation: string;
        contract_digest: string;
      };
      return {
        operation: binding.operation,
        contract: binding.contract_digest,
        arguments: toolArguments(proposed, args.for, JSON.parse(args.supplied)),
      };
    },
  });
  const submitProposal = internalMutationGeneric({
    args: {
      agent: v.string(),
      tool: v.string(),
      operation: v.string(),
      contract: v.string(),
      arguments: v.record(v.string(), v.any()),
      requestKey: v.string(),
    },
    handler: async (ctx: any, args) => {
      if (!isPerson(await ctx.auth.getUserIdentity()))
        throw new Error(PERSON_DECISION_REQUIRED);
      const agent = agents.get(args.agent);
      if (!agent) throw new Error("This agent is no longer declared");
      const declared = agent.tools[args.tool];
      if (!declared || declared.kind !== "operation")
        throw new Error("This agent no longer proposes that operation");
      const linked = linkedToolContract(declared.reference);
      if (linked.kind !== "operation" || linked.path !== args.operation)
        throw new Error(
          "This proposal no longer selects its original operation",
        );
      return ctx.runMutation(
        operationFunctionReference(
          generatedOperationReference(linked.metadata),
          "invoke",
        ),
        {
          args: args.arguments,
          request_key: args.requestKey,
          expected_contract: args.contract,
        },
      );
    },
  });
  const proposals = queryGeneric({
    args: { for: v.string() },
    handler: async (ctx, args): Promise<PublicProposal[]> =>
      ctx.runQuery(host.component.proposals.proposals, args),
  });
  const reject = mutationGeneric({
    args: { proposal: v.string() },
    returns: v.null(),
    handler: (ctx, args) =>
      ctx.runMutation(host.component.proposals.reject, args),
  });
  const submit = exposeComponentOperation(
    () => host.component.proposals.submit,
    {
      label: "Submit proposal",
      description:
        "Review and accept this agent proposal and its business operation together.",
    },
  );
  const getRun = queryGeneric({
    args: { run: v.string() },
    handler: (ctx, { run }) => getAgentRun(ctx, run),
  });
  const cancelRun = mutationGeneric({
    args: { run: v.string() },
    handler: (ctx, { run }) => cancelAgentRun(ctx, run),
  });
  const recentRuns = queryGeneric({
    args: {},
    handler: (ctx) => recentAgentRuns(ctx),
  });
  const legacyProposals = internalQueryGeneric({
    args: {
      cursor: v.union(v.string(), v.null()),
      agents: v.array(v.string()),
    },
    handler: async (ctx: any, args) => {
      if (!args.agents.length)
        return { page: [], continueCursor: "", isDone: true };
      const page = await ctx.db
        .query("agentProposals")
        .paginate({ cursor: args.cursor, numItems: 8 });
      return {
        ...page,
        page: page.page
          .filter((row: any) => args.agents.includes(row.agent))
          .map(({ _creationTime, ...row }: any) => row),
      };
    },
  });
  const bundle = {
    ...members,
    ...submit,
    _resolveProposal: resolveProposal,
    _submitProposal: submitProposal,
    _legacyProposals: legacyProposals,
    getRun,
    cancelRun,
    recentRuns,
    proposals,
    reject,
  };
  // The ordinary native forwarders publish submit. Keep its typed operation
  // descriptor for generated API types without declaring a second operation.
  Object.defineProperty(bundle, "submit", { value: submit });
  return bundle as typeof bundle & { readonly submit: typeof submit };
}

/** Each agent as `describe` reports it. */
function describeAgents(agents: ReadonlyMap<string, NamedAgent>) {
  return [...agents.values()].map((agent) => ({
    name: agent.name,
    description: agent.description,
    service: agent.sessions.service,
    resource_type: agent.sessions.resourceType,
    role: agent.sessions.role,
    tools: Object.entries(agent.tools)
      .filter(([, tool]) => tool.kind === "query")
      .map(([name, tool]) => ({
        name,
        path: tool.path,
        description: tool.description,
      })),
    model: agent.model,
    max_steps: agent.maxSteps,
    proposes: Object.entries(agent.tools)
      .filter(([, tool]) => tool.kind === "operation")
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([tool, declared]) => ({
        name: tool,
        path: declared.path,
        description: declared.description,
      })),
  }));
}

/** Each agent as the engine admits it. */
function nativeAgents(
  agents: ReadonlyMap<string, NamedAgent>,
  host: AgentHost,
) {
  return [...agents.values()].map((agent) => ({
    name: agent.name,
    runtime: (() => {
      const address = getFunctionAddress(host.component.native.progress);
      if (
        !("reference" in address) ||
        !address.reference?.startsWith("_reference/childComponent/")
      )
        throw new Error(
          "Install the agents component before registering agents",
        );
      return address.reference;
    })(),
    tools: Object.values(agent.tools).map(({ kind, path, reference }) => ({
      kind,
      path,
      contract: toolContractLink(reference),
    })),
    service: agent.sessions.service,
    args: JSON.stringify(agent.args.json),
    returns: JSON.stringify(agent.returns.json),
    maxSteps: agent.maxSteps,
    maxDurationMs: host.lifetimeOf(readAuthority(agent)),
  }));
}
