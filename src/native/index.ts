import {
  getAgentRun,
  cancelAgentRun,
  recentAgentRuns,
  agentExecution,
  agentTables,
  PROPOSALS,
  type Proposal,
  type AgentCheckpointChange,
} from "bijection/agents";
export * from "bijection/agents";
import { checkedAllocations, type AllowanceAllocation } from "bijection/server";
import { linkedToolContract, toolContractLink } from "bijection/tools";
import { continueRequest } from "bijection/requests";
import { generateAgentStep } from "./generation.js";
import {
  MAX_TOOL_REASON,
  MAX_AGENT_INPUT_BYTES,
  textBytes,
  MAX_PROMPT_BYTES,
  MAX_TOOL_RESULT_BYTES,
  jsonBytes,
  validateModelResponse,
  normalizeAgentResponse,
} from "./response.js";
/** Agents the deployment runs (`defineAgent`): a model loop that reads
 * with its own query tools as one of its service-issued sessions, invokes the
 * operations it is permitted to, and proposes others a person reviews.
 *
 * `agentsModule` installs agents independently of MCP servers. An operation
 * starts a run for one object; the scheduler starts its service-issued
 * session and runs its model with its tools. Current access decides every
 * read and invocation. An operation tool declared `mode: "invoke"` runs as
 * the session, through the operation role its service may issue, with the
 * operation's own access rules and checks; an accepted invocation moves the
 * run's read basis to its commit. Other operation tools become protected
 * proposals that a person submits under their own authority. Administration
 * enables the service's agent credential.
 * @module
 */
import {
  internalActionGeneric,
  internalMutationGeneric,
  mutationGeneric,
  queryGeneric,
} from "bijection/server";
import { makeFunctionReference } from "bijection/server";
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
import { encodeValue, decodeValue, digest, schemaFor } from "bijection/tools";
import {
  toolArguments,
  suppliedArgs,
  type CompiledTool,
  type ToolPlace,
} from "bijection/tools";
import { issuedSessions, type IssuedSessionPolicy } from "bijection/sessions";
import {
  defineToolset,
  type ToolDeclaration,
  type Toolset,
} from "bijection/tools";
import { toolRuntime } from "bijection/tools";
import type { AccessModel } from "bijection/server";
import { functionBundle } from "bijection/server";
import { internalQueryGeneric } from "bijection/server";
import { defineOperation } from "bijection/server";
import { BijectionError } from "bijection/values";

const AGENT_NAME = /^[a-z][A-Za-z0-9]{0,31}$/;
const DEFAULT_LIMITS = {
  steps: 8,
  toolCalls: 32,
  durationMs: 120_000,
} as const;
const MAX_STEPS = 16;
/** The deadline of one model step's provider request. */
const STEP_TIMEOUT_MS = 30_000;
/** Proposals one listing returns, newest first. */
const PROPOSALS_PAGE = 50;

function seenCalls(prompt: any[]): Set<string> {
  const seen = new Set<string>();
  for (const message of prompt)
    if (message.role === "assistant")
      for (const part of message.content)
        if (part.type === "tool-call" && part.toolName !== "complete")
          seen.add(part.toolCallId);
  return seen;
}

/** `<call id>:<field>` or `<call id>:<index>.<field>`: a value a handed-out
 * query result held, which the model sees only as this reference. */
const HANDLE = /^([^:]{1,128}):((?:\d{1,4}\.)?[A-Za-z_][A-Za-z0-9_]{0,63})$/;
const HANDLE_SCHEMA = {
  type: "object",
  properties: { $handle: { type: "string" } },
  required: ["$handle"],
  additionalProperties: false,
} as const;

function handleOf(value: unknown): string | undefined {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    typeof (value as { $handle?: unknown }).$handle === "string"
    ? (value as { $handle: string }).$handle
    : undefined;
}

/** Replace a query result's handed-out top-level fields, or those of each
 * object of a result list, by their handles. @internal */
export function handOut(
  callId: string,
  fields: readonly string[],
  result: any,
) {
  const hide = (row: any, prefix: string) =>
    row && typeof row === "object" && !Array.isArray(row)
      ? Object.fromEntries(
          Object.entries(row).map(([field, value]) => [
            field,
            fields.includes(field)
              ? { $handle: `${callId}:${prefix}${field}` }
              : value,
          ]),
        )
      : row;
  return Array.isArray(result)
    ? result.map((row, index) => hide(row, `${index}.`))
    : hide(result, "");
}

/** Accept a handle where a top-level argument is expected. @internal */
export function acceptingHandles(schema: any): any {
  return schema?.type === "object" && schema.properties
    ? {
        ...schema,
        properties: Object.fromEntries(
          Object.entries(schema.properties).map(([name, property]) => [
            name,
            { anyOf: [property, HANDLE_SCHEMA] },
          ]),
        ),
      }
    : schema;
}

/** One provider request of a model step: the prompt, the run's function
 * tools and the step's deadline. @public */
export type AgentModelRequest = {
  prompt: any[];
  tools: {
    type: "function";
    name: string;
    description: string;
    inputSchema: any;
  }[];
  toolChoice: { type: "auto" };
  abortSignal?: AbortSignal;
};

/** The part of an AI SDK `LanguageModelV4` a run uses: one generation step
 * with function tools. @public */
export type AgentModelStep = {
  doGenerate(options: AgentModelRequest): PromiseLike<{
    content: readonly { type: string; [field: string]: unknown }[];
  }>;
  doStream?(options: AgentModelRequest): PromiseLike<{
    stream: ReadableStream<unknown>;
  }>;
};

/** The language model an agent runs: a handle of the program's metered
 * language models, `models.language(key, { requires: ["tools"] })` from
 * `@bijectionhq/language-models`. Each run opens one session of it. @public */
export type AgentModel = {
  readonly kind: "language";
  /** The catalog key, which keys the run's model session. */
  readonly key: string;
  /** Capabilities the handle checked against its catalog: an agent needs
   * `tools`. */
  readonly requires: readonly string[];
  open(
    ctx: any,
    session: { consumer: string; subject: string; key: string },
  ): Promise<{
    /** One durable step identity within this run's model session. Reusing it
     * must refuse before dispatch rather than send another provider request. */
    attempt(attemptKey: string): AgentModelStep;
    close(failure?: any): Promise<unknown>;
  }>;
};

/** A model handle that requires `tools`, or a type error naming the gap. */
type ToolModel<Model extends AgentModel> =
  "tools" extends Model["requires"][number]
    ? Model
    : Model & { requires: readonly ["tools"] };

/** Work admitted for one run. Retries retain the original limits. @public */
export type AgentLimits = Readonly<{
  /** Model steps, 1 to 16. */
  steps: number;
  /** Query, invocation and proposal calls across every response, 0 to 64. */
  toolCalls: number;
  /** Absolute run lifetime, 1 to 86400000 milliseconds, bounded by session authority. */
  durationMs: number;
}>;

/** One agent: what it reads, what it may invoke or propose, and its model.
 * @public */
export type AgentDefinition<
  Args extends PropertyValidators = PropertyValidators,
  Result extends Validator<any, "required", any> = Validator<
    any,
    "required",
    any
  >,
  Model extends AgentModel = AgentModel,
> = {
  /** Business input, validated natively when the operation admits the run. */
  args: Args;
  /** The value required to complete a run. Text alone never completes it. */
  returns: Result;
  description: string;
  /** Each run receives this service-issued authority on one object. */
  sessions: IssuedSessionPolicy;
  /** Queries become observations. An operation becomes a proposal for a
   * person's review, or with `mode: "invoke"` is called as the run's session:
   * that needs the service's current `operation:issuer` grant for the
   * session's invoking role, and the operation's own access rules, checks and
   * any required review still apply. Tool declarations confer no authority. */
  tools: Toolset;
  /** The program's language model that can call tools:
   * `models.language(key, { requires: ["tools"] })`. Each step of a run is
   * one durable, metered attempt of it with a 30-second deadline. */
  model: ToolModel<Model>;
  /** What this agent does, which the model reads before every run after
   * tools. */
  instructions: string;
  /** Defaults: 8 steps, 32 tool calls, 2 minutes. */
  limits?: Partial<AgentLimits>;
  /** Exact allocations per run. Every allowance spent by an invoked effect
   * is bounded here or explicitly unbounded; inherited caps still apply. */
  allowances?: readonly AllowanceAllocation[];
};

/** A validated agent declaration. @public */
export type AgentDeclaration<Args = any, Result = any> = Readonly<{
  args: Validator<Args, "required", any>;
  returns: Validator<Result, "required", any>;
  description: string;
  sessions: IssuedSessionPolicy;
  tools: Toolset;
  model: AgentModel;
  instructions: string;
  limits: AgentLimits;
  allowances: Readonly<Record<string, bigint | "unbounded">>;
}>;

type NamedAgent = AgentDeclaration & { readonly name: string };

/** Declare an agent the deployment runs. Throws on an inconsistent
 * declaration. @public */
export function defineAgent<
  Args extends PropertyValidators,
  Result extends Validator<any, "required", any>,
  Model extends AgentModel,
>(
  definition: AgentDefinition<Args, Result, Model>,
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
        "limits",
        "allowances",
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
      "runs start for a known object; evidence is established through a native interaction",
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
  if (
    Object.hasOwn(tools, "complete") ||
    Object.hasOwn(tools, "continue_request")
  )
    fail("complete and continue_request are reserved native agent tools");
  if (Object.values(tools).some((tool) => tool.kind === "status"))
    fail("tools are queries or operations: use tool.query or tool.operation");
  if (Object.values(tools).filter((tool) => tool.kind === "query").length > 32)
    fail("read with at most 32 queries");
  if (
    Object.values(tools).filter((tool) => tool.kind === "operation").length > 16
  )
    fail("invoke or propose at most 16 operations");
  const model = definition.model as AgentModel;
  if (
    !model ||
    model.kind !== "language" ||
    typeof model.key !== "string" ||
    !model.key ||
    typeof model.open !== "function" ||
    !Array.isArray(model.requires) ||
    !model.requires.includes("tools")
  )
    fail(
      'model is a language model handle that requires tools: models.language(key, { requires: ["tools"] })',
    );
  if (
    typeof definition.instructions !== "string" ||
    !definition.instructions.trim() ||
    textBytes(definition.instructions) > MAX_AGENT_INPUT_BYTES
  )
    fail("instructions are at most 16 KiB of text");
  if (
    definition.limits !== undefined &&
    (definition.limits === null ||
      typeof definition.limits !== "object" ||
      Array.isArray(definition.limits))
  )
    fail("limits is an object");
  const limits = { ...DEFAULT_LIMITS, ...definition.limits };
  for (const key of Object.keys(limits))
    if (!["steps", "toolCalls", "durationMs"].includes(key))
      fail(`unexpected limit ${key}`);
  for (const [key, maximum, minimum] of [
    ["steps", MAX_STEPS, 1],
    ["toolCalls", 64, 0],
    ["durationMs", 86_400_000, 1],
  ] as const)
    if (
      !Number.isSafeInteger(limits[key]) ||
      limits[key] < minimum ||
      limits[key] > maximum
    )
      fail(`limits.${key} is a whole number from ${minimum} to ${maximum}`);
  const allowances = checkedAllowances(definition.allowances, fail);
  return Object.freeze({
    description: definition.description,
    args,
    returns: definition.returns,
    sessions,
    tools,
    model,
    instructions: definition.instructions,
    limits: Object.freeze(limits),
    allowances,
  });
}

export const checkedAllowances = checkedAllocations;

/** Configuration of the independent agent module. @public */
export type AgentsModuleOptions = {
  access: AccessModel;
  /** Registration supplies each agent's name exactly once. */
  agents: Readonly<Record<string, AgentDeclaration>>;
};

type AgentHost = ReturnType<typeof toolRuntime>;

/** Whether an agent calls this operation tool itself instead of proposing it. */
function invokes(tool: ToolDeclaration | undefined): boolean {
  return tool?.kind === "operation" && tool.mode === "invoke";
}

/** What a run's issued session holds: its query tools and the operations it
 * invokes, each through the operation role its service must currently be
 * able to issue. Proposal tools confer no operation role. */
function runAuthority(agent: AgentDeclaration) {
  return {
    sessions: agent.sessions,
    tools: Object.fromEntries(
      Object.entries(agent.tools).filter(
        ([, tool]) => tool.kind === "query" || invokes(tool),
      ),
    ),
  };
}

/** The operation request one tool call of a run makes. Tool call identities
 * are unique within a run, so a retry of the same step recovers the same
 * request and never makes a second one. */
async function invocationKey(run: string, call: string): Promise<string> {
  const key = `agent:${run}:${call}`;
  return key.length <= 256 && /^[\x21-\x7e]+$/.test(key)
    ? key
    : `agent:${await digest([run, call])}`;
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
    if (!["access", "agents"].includes(key))
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
  const host = toolRuntime(options.access);
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
            .problemsOf(runAuthority(agent))
            .map((problem) => `Agent ${agent.name}: ${problem}`),
        ),
        tables: Object.entries(agentTables()).map(([tableName, table]) => ({
          tableName,
          ...table.export(),
        })),
        agents: nativeAgents(agents, host),
      }),
  });
  return functionBundle({ ...members, describe });
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
  // An invoked operation whose contract does not classify every argument
  // the model supplies, or needs a person to see one, is proposed instead:
  // native admission refuses the run's session such a direct request.
  const proposalsOf = async (agent: NamedAgent) =>
    Object.fromEntries(
      Object.entries(await host.toolsOf(agent)).filter(
        ([name, compiled]) =>
          agent.tools[name]?.kind === "operation" &&
          (!invokes(agent.tools[name]) || compiled.session_invocable === false),
      ),
    );
  /** The operation tools a run calls itself, compiled as for a server
   * session: the bound argument is the run's object. */
  const invocationsOf = async (agent: NamedAgent) =>
    Object.fromEntries(
      Object.entries(await host.toolsOf(agent)).filter(
        ([name, compiled]) =>
          invokes(agent.tools[name]) && compiled.session_invocable !== false,
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
     * schedule the run as the session. It holds that role, its ancestor
     * roles above the object and the operation role of each operation it
     * invokes, only while the service may issue each there; it is granted
     * nothing. */
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
        const admitted = await agentExecution.open({
          agent: name,
          ...args,
        });
        if (admitted.started) return;
        const session = admitted.session;
        const principal = `${serviceIssuer(agent.sessions.service)}|${SESSION_SUBJECT}${session}`;
        const expiresAt = admitted.expiresAt;
        if (!args.for || args.for.length > 256) throw refused();
        const interaction = agent.sessions.interaction !== null;
        if (interaction !== Boolean(admitted.interactionId)) throw refused();
        const registered = await agentExecution.registerSession({
          session,
          until: expiresAt,
          functions: [`${await moduleOf(ctx)}:${name}_run`],
          endpoint: `/agents/${name}`,
          server: name,
          roles: agent.sessions.roles,
          ancestorRoles: agent.sessions.ancestorRoles,
          // Serving an interaction, the run acts where its evidence allows,
          // for no one object.
          for: interaction
            ? null
            : { type: agent.sessions.resourceTypes[0]!, key: args.for },
          // A run holds an operation role only for the operations it
          // invokes; proposing confers none.
          operations: [
            ...host.operationsOf(
              runAuthority(agent),
              Object.keys(agent.tools).filter((tool) =>
                invokes(agent.tools[tool]),
              ),
            ),
          ].map(([key, role]) => ({ key, role })),
          evidence: admitted.evidence ?? null,
          ...(interaction ? { interactionId: admitted.interactionId } : {}),
        });
        if (registered !== principal) throw refused();
        await agentExecution.schedule({
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

    /** Where the run's session acts: the object it acts for, or, serving an
     * interaction, the objects its current evidence reaches. */
    const runPlace = async (ctx: any, actsFor: string): Promise<ToolPlace> => {
      if (agent.sessions.interaction === null) return { actsFor };
      const timing = await agentExecution.currentSession({
        endpoint: `/agents/${name}`,
      });
      return {
        targets: timing.targets ?? [],
      };
    };
    const stepTools = async (ctx: any, args: { run: string; for: string }) => {
      const place = await runPlace(ctx, args.for);
      // Query tools read with the run's session; operations are invoked as
      // that session or proposed for a person.
      const reads = Object.fromEntries(
        Object.entries(await host.toolsOf(agent)).filter(
          ([tool]) => agent.tools[tool]?.kind === "query",
        ),
      );
      const invocations = await invocationsOf(agent);
      const continuations = Object.values(invocations).some(
        (tool) => tool.binding.requires_proposal,
      );
      const pendingRequests: any[] = [];
      const proposals = await proposalsOf(agent);
      const handedOut = (tool: string) =>
        agent.tools[tool]?.kind === "query"
          ? (agent.tools[tool]!.handles ?? [])
          : [];
      const handing = Object.keys(reads).some(
        (tool) => handedOut(tool).length > 0,
      );
      const inputSchema = (published: CompiledTool) =>
        handing
          ? acceptingHandles(schemaFor(suppliedArgs(published)))
          : schemaFor(suppliedArgs(published));
      // The values handles in this step's calls name, read again as the run's
      // session from the query call that handed them out.
      let handleValues = new Map<string, unknown>();
      const resolveHandles = async (prompt: any[], response: unknown) => {
        const values = new Map<string, unknown>();
        const sources = new Map<string, { toolName: string; input: string }>();
        for (const message of prompt)
          if (message.role === "assistant" && Array.isArray(message.content))
            for (const part of message.content)
              if (part.type === "tool-call") sources.set(part.toolCallId, part);
        const content = (response as { content?: unknown })?.content;
        for (const part of Array.isArray(content) ? content : []) {
          if (part?.type !== "tool-call" || typeof part.input !== "string")
            continue;
          let input: any;
          try {
            input = JSON.parse(part.input);
          } catch {
            continue;
          }
          const supplied = Object.hasOwn(proposals, part.toolName)
            ? input?.arguments
            : input;
          if (!supplied || typeof supplied !== "object") continue;
          for (const value of Object.values(supplied)) {
            const handle = handleOf(value);
            if (handle === undefined || values.has(handle)) continue;
            const [, callId, path] = HANDLE.exec(handle) ?? [];
            const source =
              callId === undefined ? undefined : sources.get(callId);
            const segments = path?.split(".") ?? [];
            if (
              !source ||
              !Object.hasOwn(reads, source.toolName) ||
              !handedOut(source.toolName).includes(segments.at(-1)!)
            )
              throw new Error("Invalid handle");
            const tool = reads[source.toolName]!;
            let found: any = encodeValue(
              await tool.execute(
                ctx,
                toolArguments(tool, place, JSON.parse(source.input)),
                {},
              ),
            );
            for (const segment of segments) found = found?.[segment];
            if (found === undefined) throw new Error("Handle unavailable");
            values.set(handle, found);
          }
        }
        handleValues = values;
      };
      const resolved = (input: unknown) =>
        input && typeof input === "object" && !Array.isArray(input)
          ? Object.fromEntries(
              Object.entries(input).map(([name, value]) => {
                const handle = handleOf(value);
                if (handle === undefined) return [name, value];
                if (!handleValues.has(handle))
                  throw new Error("Unresolved handle");
                return [name, handleValues.get(handle)];
              }),
            )
          : input;
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
        ...(continuations
          ? [
              {
                type: "function" as const,
                name: "continue_request",
                description:
                  "Continue the original request after its native requirements are fulfilled. Reuse the request_key returned by its pending result.",
                inputSchema: {
                  type: "object",
                  properties: { request_id: { type: "string" } },
                  required: ["request_id"],
                  additionalProperties: false,
                },
              },
            ]
          : []),
        ...Object.entries(reads).map(([tool, published]) => ({
          type: "function" as const,
          name: tool,
          description: published.description,
          inputSchema: inputSchema(published),
        })),
        ...Object.entries(invocations).map(([tool, published]) => ({
          type: "function" as const,
          name: tool,
          description: `${published.description} Calling this performs the operation for this run when its access allows: the result is its accepted receipt, or a refusal when nothing changed.`,
          inputSchema: inputSchema(published),
        })),
        ...Object.entries(proposals).map(([tool, published]) => ({
          type: "function" as const,
          name: tool,
          description: `${published.description} This only proposes it: a person reviews the proposal, and nothing changes unless they submit it.`,
          inputSchema: {
            type: "object",
            properties: {
              arguments: inputSchema(published),
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
        | {
            kind: "invocation";
            tool: CompiledTool;
            arguments: unknown;
          }
        | { kind: "offer"; tool: CompiledTool; arguments: unknown }
        | { kind: "continuation"; requestId: string }
        | { kind: "proposal"; arguments: string; reason: string }
        | { kind: "complete"; result: unknown };
      const prepareCall = (tool: string, input: unknown): PreparedCall => {
        if (!input || typeof input !== "object" || Array.isArray(input))
          throw new Error("Invalid arguments");
        if (tool === "continue_request" && continuations) {
          if (
            Object.keys(input).join(" ") !== "request_id" ||
            typeof (input as any).request_id !== "string"
          )
            throw new Error("Continue one retained request");
          return { kind: "continuation", requestId: (input as any).request_id };
        }
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
            arguments: toolArguments(reads[tool]!, place, resolved(input)),
          };
        if (Object.hasOwn(invocations, tool))
          return {
            kind: invocations[tool]!.binding.requires_proposal
              ? "offer"
              : "invocation",
            tool: invocations[tool]!,
            arguments: toolArguments(
              invocations[tool]!,
              place,
              resolved(input),
            ),
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
        // A person reviews the values a handle named, not the handle.
        const values = resolved(supplied);
        toolArguments(proposals[tool]!, place, values);
        return {
          kind: "proposal",
          arguments: JSON.stringify(values),
          reason,
        };
      };
      const observe = async (
        prepared: PreparedCall,
        callId: string,
      ): Promise<unknown> => {
        if (prepared.kind !== "query" && prepared.kind !== "offer")
          throw new Error("A query tool is required");
        try {
          const encoded = encodeValue(
            await prepared.tool.execute(
              ctx,
              prepared.arguments,
              prepared.kind === "offer"
                ? { request_key: await invocationKey(args.run, callId) }
                : {},
            ),
          );
          const name = Object.keys(reads).find(
            (tool) => reads[tool] === prepared.tool,
          );
          const fields = name === undefined ? [] : handedOut(name);
          const result = fields.length
            ? handOut(callId, fields, encoded)
            : encoded;
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
      let accepted = 0;
      /** Invoke as the run's session, inside the advancing mutation. The
       * tool recovers the request first, so a retried step returns the
       * original receipt. A refusal is data: whether the session lacked the
       * operation's role, the operation requires a person's review, or its own
       * checks refused, nothing changed and the model learns no more. */
      const invoke = async (
        name: string,
        prepared: Extract<
          PreparedCall,
          { kind: "invocation" | "offer" | "continuation" }
        >,
        requestKey: string,
      ): Promise<unknown> => {
        let receipt: any = null;
        try {
          receipt =
            prepared.kind === "continuation"
              ? await continueRequest(ctx, prepared.requestId)
              : await prepared.tool.execute(ctx, prepared.arguments, {
                  request_key: requestKey,
                });
        } catch {
          receipt = null;
        }
        if (receipt?.kind === "pending") {
          pendingRequests.push(receipt);
          return { result: encodeValue(receipt) };
        }
        if (
          !receipt ||
          (receipt.kind !== "accepted" &&
            receipt.kind !== "accepted_result_omitted") ||
          typeof receipt.invocation_id !== "string"
        ) {
          await record(name, "refused");
          return {
            error: "operation_refused",
            message: "The operation was not accepted; nothing changed.",
          };
        }
        accepted++;
        await record(name, "accepted");
        const result = encodeValue(receipt);
        return {
          result:
            jsonBytes(result) > MAX_TOOL_RESULT_BYTES
              ? encodeValue({
                  kind: "accepted_result_omitted",
                  invocation_id: receipt.invocation_id,
                  accepted_revision: receipt.accepted_revision,
                  reason: "result_too_large",
                })
              : result,
        };
      };
      const call = async (
        name: string,
        callId: string,
        prepared: PreparedCall,
        observation?: unknown,
      ): Promise<unknown> => {
        if (prepared.kind === "complete") return { completed: true };
        if (prepared.kind === "invocation" || prepared.kind === "continuation")
          return await invoke(
            name,
            prepared,
            await invocationKey(args.run, callId),
          );
        if (prepared.kind === "query" || prepared.kind === "offer") {
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
            await reference<"mutation">(ctx, `${agent.name}_propose`),
            {
              for: args.for,
              tool: name,
              arguments: prepared.arguments,
              reason: prepared.reason,
            },
          );
          return { proposed: proposal, state: "pending" };
        } catch {
          return { error: "proposal_refused" };
        }
      };

      return {
        tools,
        prepareCall,
        resolveHandles,
        observe,
        call,
        validateObservation,
        acceptedInvocations: () => accepted,
        pendingRequests,
      };
    };

    type Progress = {
      step: number;
      phase: "ready" | "responded" | "done" | "exhausted";
      prompt: string | null;
      response: string | null;
      limits: Pick<AgentLimits, "steps" | "toolCalls">;
    };
    const runArgs = {
      run: v.string(),
      session: v.string(),
      step: v.number(),
      for: v.string(),
      input: v.string(),
    };
    const readProgress = (run: string): Promise<Progress> =>
      agentExecution.progress({ run });
    const checkpoint = (change: AgentCheckpointChange): Promise<Progress> =>
      agentExecution.checkpoint(change);

    members[`${name}_progress`] = internalQueryGeneric({
      args: { run: v.string() },
      handler: (_ctx: any, args) => readProgress(args.run),
    });
    members[`${name}_response`] = internalMutationGeneric({
      args: { run: v.string(), step: v.number(), response: v.string() },
      handler: (_ctx: any, args) => checkpoint({ kind: "response", ...args }),
    });
    members[`${name}_initialize`] = internalMutationGeneric({
      args: { run: v.string(), prompt: v.string() },
      handler: (_ctx: any, args) => checkpoint({ kind: "initialize", ...args }),
    });
    const normalizedBatch = (
      validated: ReturnType<typeof validateModelResponse<any>>,
    ) =>
      normalizeAgentResponse(
        validated,
        validated.calls[0]?.prepared.kind === "complete"
          ? validated.calls[0].prepared.result
          : undefined,
      );
    members[`${name}_admit`] = internalMutationGeneric({
      args: runArgs,
      handler: async (ctx: any, args) => {
        const progress = await readProgress(args.run);
        if (progress.step !== args.step || progress.phase !== "responded")
          return progress;
        const { prepareCall, resolveHandles } = await stepTools(ctx, args);
        const prompt = JSON.parse(progress.prompt!);
        await resolveHandles(prompt, JSON.parse(progress.response!));
        const validated = validateModelResponse(
          JSON.parse(progress.response!),
          seenCalls(prompt),
          prepareCall,
        );
        return checkpoint({
          kind: "admit",
          run: args.run,
          step: args.step,
          response: progress.response,
          batch: normalizedBatch(validated),
        });
      },
    });
    // Queries run through native action callbacks at the run's read basis.
    // Their observations, every invocation in the response's order and all
    // proposals enter custody with the next prompt and sole continuation in
    // one current mutation. Nothing is invoked or proposed before the
    // complete response and every query observation are validated. An
    // accepted invocation starts a new read epoch: the next step reads at
    // this commit, which includes it.
    members[`${name}_advance`] = internalMutationGeneric({
      args: { ...runArgs, observations: v.string() },
      handler: async (ctx: any, args) => {
        const progress = await readProgress(args.run);
        if (progress.step !== args.step || progress.phase !== "responded")
          return progress;
        const prompt = JSON.parse(progress.prompt!);
        const {
          prepareCall,
          resolveHandles,
          call,
          validateObservation,
          acceptedInvocations,
          pendingRequests,
        } = await stepTools(ctx, args);
        const seen = seenCalls(prompt);
        await resolveHandles(prompt, JSON.parse(progress.response!));
        const validated = validateModelResponse(
          JSON.parse(progress.response!),
          seen,
          prepareCall,
        );
        // Revalidate the exact admitted batch before any effect. Native
        // admission is immutable and rejects a changed interpretation.
        await checkpoint({
          kind: "admit",
          run: args.run,
          step: args.step,
          response: progress.response,
          batch: normalizedBatch(validated),
        });
        if (
          validated.calls.some(
            ({ prepared }) =>
              prepared.kind === "offer" || prepared.kind === "continuation",
          ) &&
          validated.calls.length !== 1
        )
          throw new Error("Continue or propose one request at a time");
        const observations = JSON.parse(args.observations);
        const queryCalls = validated.calls.filter(
          ({ prepared }) =>
            prepared.kind === "query" || prepared.kind === "offer",
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
                  part.toolCallId,
                  prepared,
                  prepared.kind === "query" || prepared.kind === "offer"
                    ? values[observed++]
                    : undefined,
                ),
              },
            });
          prompt.push({ role: "tool", content: results });
        }
        const next = await checkpoint({
          kind: "advance",
          run: args.run,
          step: args.step,
          prompt: JSON.stringify(prompt),
          result:
            validated.calls[0]?.prepared.kind === "complete"
              ? {
                  value: bijectionToJson(
                    validated.calls[0].prepared.result as any,
                  ),
                }
              : null,
          ...(acceptedInvocations() > 0 ? { epoch: "renew" } : {}),
        });
        const offers = [
          ...pendingRequests,
          ...queryCalls
            .flatMap(({ prepared }, index) =>
              prepared.kind === "offer" ? [values[index]?.result] : [],
            )
            .filter(Boolean),
        ];
        // Every requirement stays with its original native request. The wait
        // owner observes verification, agreement, approval and terminal changes
        // and schedules the sole continuation without consuming model steps.
        const requests = [
          ...new Set<string>(
            offers.flatMap((offer: any) =>
              offer.kind === "pending" && typeof offer.request_key === "string"
                ? [offer.request_key]
                : [],
            ),
          ),
        ];
        const suspension =
          next.phase === "ready" && requests.length
            ? await agentExecution.wait({
                requests,
                run: args.run,
                for: args.for,
                ...(args.input !== undefined ? { input: args.input } : {}),
              })
            : { waiting: false };
        if (next.phase === "ready" && !suspension.waiting)
          await agentExecution.schedule({
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

    const proposing = Object.values(agent.tools).some(
      (tool) => tool.kind === "operation" && !invokes(tool),
    );
    const invoking = Object.values(agent.tools).some(invokes);
    const systemGuidance = [
      "Read with your tools. Call complete with your typed result after all work.",
      ...(invoking
        ? [
            "An operation tool performs its operation for you when your access allows: its result is the accepted receipt or a refusal, and your next reads include what it changed.",
          ]
        : []),
      ...(proposing || !invoking
        ? [
            "A proposal tool records a proposal for a person to review; nothing changes unless they submit it.",
          ]
        : []),
    ].join(" ");

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
      const opened = await agent.model.open(ctx, {
        consumer: "agents",
        subject: args.session,
        key: agent.model.key,
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
              content: `${agent.instructions}\n\n${agent.sessions.interaction ? "You serve this interaction under your service’s authority. Each tool checks the selected resource and current evidence." : `You act for the ${agent.sessions.resourceTypes[0]} ${args.for}.`} ${systemGuidance}`,
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
          const generated = await generateAgentStep(
            opened.attempt(`step-${args.step}`),
            {
              prompt,
              tools,
              toolChoice: { type: "auto" },
              abortSignal: AbortSignal.timeout(STEP_TIMEOUT_MS),
            },
          );
          const response = JSON.stringify(generated);
          if (textBytes(response) > 64 * 1024)
            throw new Error("Invalid model response");
          progress = await ctx.runMutation(
            await reference<"mutation">(ctx, `${name}_response`),
            { run: args.run, step: args.step, response },
          );
        }
        if (progress.phase === "responded") {
          progress = await ctx.runMutation(
            await reference<"mutation">(ctx, `${name}_admit`),
            args,
          );
          const { prepareCall, resolveHandles, observe } = await stepTools(
            ctx,
            args,
          );
          await resolveHandles(
            JSON.parse(progress.prompt!),
            JSON.parse(progress.response!),
          );
          const validated = validateModelResponse(
            JSON.parse(progress.response!),
            seenCalls(JSON.parse(progress.prompt!)),
            prepareCall,
          );
          if (
            seenCalls(JSON.parse(progress.prompt!)).size +
              validated.calls.filter(({ part }) => part.toolName !== "complete")
                .length >
            progress.limits.toolCalls
          )
            throw new Error("Agent tool call limit reached");
          if (
            validated.calls.some(
              ({ prepared }) =>
                prepared.kind === "offer" || prepared.kind === "continuation",
            ) &&
            validated.calls.length !== 1
          )
            throw new Error("Continue or propose one request at a time");
          const observations = [];
          for (const { part, prepared } of validated.calls)
            if (prepared.kind === "query" || prepared.kind === "offer")
              observations.push({
                toolCallId: part.toolCallId,
                value: await observe(prepared, part.toolCallId),
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

    /** As the run's session: record one proposal, in retained custody, with
     * the operation's contract as proposed. */
    members[`${name}_propose`] = internalMutationGeneric({
      args: {
        for: v.string(),
        tool: v.string(),
        arguments: v.string(),
        reason: v.string(),
      },
      handler: async (ctx: any, args) => {
        const session = await runSession(ctx);
        if (
          !args.reason.trim() ||
          textBytes(args.reason) > MAX_TOOL_REASON ||
          textBytes(args.arguments) > MAX_AGENT_INPUT_BYTES
        )
          throw new Error("Invalid proposal");
        const proposed = (await proposalsOf(agent))[args.tool];
        if (!proposed) throw new Error("Tool unavailable");
        const decoded = toolArguments(
          proposed,
          await runPlace(ctx, args.for),
          JSON.parse(args.arguments),
        );
        const binding = proposed.binding as {
          operation: string;
          contract_digest: string;
        };
        const id = await ctx.db.insert(PROPOSALS, {
          agent: name,
          for: args.for,
          session,
          tool: args.tool,
          operation: binding.operation,
          contract: binding.contract_digest,
          arguments: decoded as Proposal["arguments"],
          reason: args.reason,
          state: "pending",
          proposed_at: Date.now(),
          decided_by: null,
          decided_at: null,
        } satisfies Omit<Proposal, "_id">);
        await audit(ctx, {
          action: "agent.proposal",
          agent: name,
          session,
          tool: args.tool,
          proposal: id,
        });
        return id;
      },
    });
  }

  const proposed = (row: Proposal) => ({
    id: row._id,
    agent: row.agent,
    for: row.for,
    session: row.session,
    tool: row.tool,
    operation: row.operation,
    arguments: row.arguments,
    reason: row.reason,
    state: row.state,
    proposed_at: row.proposed_at,
    decided_by: row.decided_by,
    decided_at: row.decided_at,
  });
  /** Read the protected proposal under a person's current authority. */
  const deciding = async (ctx: any, id: string) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!isPerson(identity)) throw new Error(PERSON_DECISION_REQUIRED);
    const normalized = ctx.db.normalizeId(PROPOSALS, id);
    const row: Proposal | null = normalized
      ? await ctx.db.get(normalized)
      : null;
    const agent = row ? agents.get(row.agent) : undefined;
    if (!row) throw new Error("Unknown proposal");
    return { identity, row, agent };
  };

  /** The proposals agents made for one object, newest first. A reader sees
   * them only while they may read what the run that made them read. */
  const proposals = queryGeneric({
    args: { for: v.string() },
    handler: async (ctx: any, args) => {
      const rows: Proposal[] = await ctx.db
        .query(PROPOSALS)
        .withIndex("by_for", (q: any) => q.eq("for", args.for))
        .order("desc")
        .take(PROPOSALS_PAGE);
      return rows.map(proposed);
    },
  });

  /** Resolve the original proposed contract against the current declaration.
   * The native operation owner decides its exact match and current access. */
  const pendingOperation = (row: Proposal, agent: NamedAgent | undefined) => {
    if (row.state !== "pending")
      throw new Error(`This proposal was already ${row.state}`);
    if (!agent) throw new Error("This agent is no longer declared");
    const declared = agent.tools[row.tool];
    if (!declared || declared.kind !== "operation" || invokes(declared))
      throw new Error("This agent no longer proposes that operation");
    const linked = linkedToolContract(declared.reference);
    if (linked.kind !== "operation" || linked.path !== row.operation)
      throw new Error("This proposal no longer selects its original operation");
    return generatedOperationReference(linked.metadata);
  };
  const envelopeOf = (row: Proposal) => ({
    args: row.arguments,
    request_key: `proposal:${row._id}`,
    expected_contract: row.contract,
  });

  /** Acceptance is an ordinary reviewed operation. Its native review covers
   * the proposal transition and the nested business operation in one commit.
   * The native request owner retains the review, receipt and retry identity. */
  const submit = defineOperation({
    on: agentTables()[PROPOSALS],
    target: { argument: "proposal", select: [] },
    review: "required",
    args: { proposal: v.id(PROPOSALS) },
    returns: v.id(PROPOSALS),
    prepare: async (ctx: any, args) => {
      const { identity, row, agent } = await deciding(ctx, args.proposal);
      const operation = pendingOperation(row, agent);
      const receipt = await ctx.runMutation(
        operationFunctionReference(operation, "invoke"),
        envelopeOf(row),
      );
      if (receipt.kind === "refused") throw new BijectionError(receipt.refusal);
      await ctx.db.patch(row._id, {
        state: "submitted",
        decided_by: identity.tokenIdentifier,
        decided_at: ctx.db.vars.commitTs,
      });
      await audit(ctx, {
        action: "agent.submitted",
        agent: row.agent,
        proposal: row._id,
      });
      return args.proposal;
    },
  });

  /** A person rejects a proposal; nothing it proposed happens. */
  const reject = mutationGeneric({
    args: { proposal: v.string() },
    handler: async (ctx: any, args) => {
      const { identity, row } = await deciding(ctx, args.proposal);
      if (row.state !== "pending")
        throw new Error(`This proposal was already ${row.state}`);
      await ctx.db.patch(row._id, {
        state: "rejected",
        decided_by: identity.tokenIdentifier,
        decided_at: ctx.db.vars.commitTs,
      });
      await audit(ctx, {
        action: "agent.rejected",
        agent: row.agent,
        proposal: row._id,
      });
      return null;
    },
  });
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
  return {
    ...members,
    getRun,
    cancelRun,
    recentRuns,
    proposals,
    submit,
    reject,
  };
}

/** Each agent as `describe` reports it. */
function describeAgents(agents: ReadonlyMap<string, NamedAgent>) {
  return [...agents.values()].map((agent) => ({
    name: agent.name,
    description: agent.description,
    service: agent.sessions.service,
    resource_types: agent.sessions.resourceTypes,
    roles: agent.sessions.roles,
    interaction: agent.sessions.interaction !== null,
    tools: Object.entries(agent.tools)
      .filter(([, tool]) => tool.kind === "query")
      .map(([name, tool]) => ({
        name,
        path: tool.path,
        description: tool.description,
      })),
    model: agent.model.key,
    limits: agent.limits,
    invokes: operationTools(agent, true),
    proposes: operationTools(agent, false),
  }));
}

/** An agent's operation tools that it invokes, or that it proposes, by name. */
function operationTools(agent: NamedAgent, invoked: boolean) {
  return Object.entries(agent.tools)
    .filter(
      ([, tool]) => tool.kind === "operation" && invokes(tool) === invoked,
    )
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([tool, declared]) => ({
      name: tool,
      path: declared.path,
      description: declared.description,
    }));
}

/** Each agent as the engine admits it. */
function nativeAgents(
  agents: ReadonlyMap<string, NamedAgent>,
  host: AgentHost,
) {
  return [...agents.values()].map((agent) => ({
    name: agent.name,
    // Native code retains which operations a run invokes; an operation tool
    // without a mode is a proposal, as before modes existed.
    tools: Object.values(agent.tools).map((tool) => ({
      kind: tool.kind,
      path: tool.path,
      contract: toolContractLink(tool.reference),
      ...(invokes(tool) ? { mode: "invoke" } : {}),
    })),
    service: agent.sessions.service,
    issued: {
      service: agent.sessions.service,
      roles: agent.sessions.roles,
      ancestorRoles: agent.sessions.ancestorRoles,
      ...(agent.sessions.interaction
        ? { interaction: agent.sessions.interaction.definition }
        : {}),
    },
    args: JSON.stringify(agent.args.json),
    returns: JSON.stringify(agent.returns.json),
    ...(Object.values(agent.allowances).some((limit) => limit !== "unbounded")
      ? {
          allowances: Object.fromEntries(
            Object.entries(agent.allowances)
              .filter(([, limit]) => limit !== "unbounded")
              .map(([name, limit]) => [name, limit.toString()]),
          ),
        }
      : {}),
    ...(Object.values(agent.allowances).includes("unbounded")
      ? {
          unbounded: Object.entries(agent.allowances)
            .filter(([, limit]) => limit === "unbounded")
            .map(([name]) => name),
        }
      : {}),
    limits: {
      ...agent.limits,
      durationMs: Math.min(
        agent.limits.durationMs,
        host.lifetimeOf(runAuthority(agent)),
      ),
    },
  }));
}
