import { beforeEach, describe, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { defineAgent, agentsModule, startAgent } from "./index.js";
import { linkedAgentReferences } from "./references.js";
import { tool, linkedToolContracts } from "bijection/tools";
import { issuedSessions, delegatedSessions } from "bijection/sessions";
import { defineMcpServer } from "bijection/mcp";
import {
  componentsGeneric,
  getFunctionAddress,
  getFunctionName,
  makeFunctionReference,
  queryGeneric,
  serviceIssuer,
  CREDENTIAL_CLAIM,
  type AccessModel,
  type ApiFromModules,
  type FunctionArgs,
  type FunctionReturnType,
} from "bijection/server";
import { v, type GenericId } from "bijection/values";
const SERVICE_ISSUER = serviceIssuer("support-desk").slice(
  0,
  -"/support-desk".length,
);
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
function assert<_T extends true>() {}
const component = componentsGeneric().agents;
const SITE = "https://happy-animal-123.bijection.run";
const ISSUER = `${SERVICE_ISSUER}/support-desk`;
const CREDENTIAL_ID = "0123456789abcdef";
const HALF_HOUR = 30 * 60_000;

const context = queryGeneric({
  args: {},
  returns: v.object({ name: v.string() }),
  handler: async () => ({ name: "Alice" }),
});
const hours = queryGeneric({
  args: {},
  returns: v.object({ open: v.boolean() }),
  handler: async () => ({ open: true }),
});
const refund = {
  on: "Customer",
  target: { argument: "customer_id", select: [] },
  args: { customer_id: v.id("customers"), amount: v.int64() },
  returns: v.object({ refunded: v.int64() }),
};

const refundContract = {
  version: 1 as const,
  operation: "support.js:refund",
  visibility: "public" as const,
  on: refund.on,
  target: refund.target,
  args: v.object(refund.args).json,
  returns: refund.returns.json,
};
const contracts = linkedToolContracts({
  "support.js:context": {
    kind: "query",
    args: context.exportArgs(),
    returns: context.exportReturns(),
    digest: createHash("sha256")
      .update(
        "bijection.query_contract.v1\n" +
          JSON.stringify([
            "support.js:context",
            context.exportArgs(),
            context.exportReturns(),
          ]),
      )
      .digest("hex"),
  },
  "support.js:hours": {
    kind: "query",
    args: hours.exportArgs(),
    returns: hours.exportReturns(),
    digest: createHash("sha256")
      .update(
        "bijection.query_contract.v1\n" +
          JSON.stringify([
            "support.js:hours",
            hours.exportArgs(),
            hours.exportReturns(),
          ]),
      )
      .digest("hex"),
  },
  "support.js:refund": {
    kind: "operation",
    metadata: {
      contract: refundContract,
      contract_digest: createHash("sha256")
        .update(JSON.stringify(refundContract))
        .digest("hex"),
    },
  },
});

/** A declaration's fields, flat as the tests vary them one at a time. */
type Flat = {
  name: string;
  description: string;
  instructions?: string;
  actsFor: string;
  by: string;
  role: string;
  ancestorRoles?: readonly string[];
  operationRoles?: { invoke?: string; read?: string };
  evidence?: readonly string[];
  beforeVerification?: readonly string[];
  sessionMinutes?: number;
  tools: Record<string, any>;
  limits?: { requestsPerMinute?: number; pollsPerMinute?: number };
};
const declare = (flat: Flat) =>
  defineMcpServer(flat.name, {
    description: flat.description,
    ...(flat.instructions !== undefined
      ? { instructions: flat.instructions }
      : {}),
    sessions: issuedSessions({
      service: flat.by,
      role: flat.role,
      ...(flat.ancestorRoles ? { ancestorRoles: flat.ancestorRoles } : {}),
      ...(flat.operationRoles ? { operationRoles: flat.operationRoles } : {}),
      ...(flat.beforeVerification
        ? { beforeVerification: flat.beforeVerification }
        : {}),
      ...(flat.sessionMinutes
        ? { maxDurationMs: flat.sessionMinutes * 60_000 }
        : {}),
      ...(flat.evidence ? { evidence: flat.evidence } : {}),
    }),
    tools: flat.tools,
    ...(flat.limits ? { limits: flat.limits } : {}),
  });
const definition = (): Flat => ({
  name: "support",
  description: "Support for verified customers.",
  actsFor: "customer",
  by: "support-desk",
  role: "customer:supportAgent",
  tools: {
    get_context: tool.query(contracts.support.context, "Read context."),
    opening_hours: tool.query(contracts.support.hours, "Opening hours."),
    request_refund: tool.operation(
      contracts.support.refund,
      "Request a refund.",
    ),
    refund_status: tool.status(
      contracts.support.refund,
      "Check a refund request.",
    ),
  },
  beforeVerification: ["opening_hours"],
  limits: { requestsPerMinute: 3, pollsPerMinute: 1 },
});

type Row = Record<string, any> & { _id: string };
function database(tables: Record<string, Row[]>) {
  let next = 1;
  const all = () => Object.values(tables).flat();
  const db = {
    normalizeId: (table: string, id: string) =>
      tables[table]?.some((row) => row._id === id) ? id : null,
    get: async (first: string, second?: string) =>
      all().find((row) => row._id === (second ?? first)) ?? null,
    insert: async (table: string, document: Record<string, any>) => {
      const _id = `${table}|${next++}`;
      (tables[table] ??= []).push({ _id, ...document });
      return _id;
    },
    patch: async (id: string, fields: Record<string, any>) => {
      Object.assign((await db.get(id))!, fields);
    },
    replace: async (id: string, document: Record<string, any>) => {
      const row = (await db.get(id))!;
      for (const key of Object.keys(row)) if (key !== "_id") delete row[key];
      Object.assign(row, document);
    },
    delete: async (id: string) => {
      for (const table of Object.keys(tables))
        tables[table] = tables[table]!.filter((row) => row._id !== id);
    },
    query: (table: string) => ({
      withIndex: (_index: string, build: (q: any) => unknown) => {
        const equalities: [string, unknown][] = [];
        const q = {
          eq: (field: string, value: unknown) => {
            equalities.push([field, value]);
            return q;
          },
        };
        build(q);
        const rows = () =>
          (tables[table] ?? []).filter((row) =>
            equalities.every(([field, value]) => row[field] === value),
          );
        return {
          unique: async () => {
            if (rows().length > 1) throw new Error("Not unique");
            return rows()[0] ?? null;
          },
          first: async () => rows()[0] ?? null,
          order: () => ({
            take: async (n: number) => rows().reverse().slice(0, n),
          }),
        };
      },
      order: () => ({
        take: async (n: number) =>
          [...(tables[table] ?? [])].reverse().slice(0, n),
      }),
    }),
  };
  return db;
}

const access = {
  describe: () => ({
    grants: "grants",
    services: [
      {
        name: "support-desk",
        description: "Starts support sessions.",
        ceiling: ["operation:issuer", "root:supportIssuer"],
        maxDuration: undefined,
      },
    ],
    roles: [
      {
        name: "customer:supportAgent",
        permissions: ["customer:read", "refund:create"],
        maxDuration: HALF_HOUR,
        justification: false,
        selfGrant: null,
        sessions: true,
      },
      {
        name: "root:supportIssuer",
        permissions: ["customer:issue.supportAgent"],
        maxDuration: undefined,
        justification: false,
        selfGrant: null,
        sessions: false,
      },
      ...(
        [
          ["operation:invoker", ["operation:read", "operation:invoke"]],
          ["operation:reader", ["operation:read"]],
          [
            "operation:issuer",
            ["operation:issue.invoker", "operation:issue.reader"],
          ],
        ] as const
      ).map(([name, permissions]) => ({
        name,
        permissions: [...permissions],
        maxDuration: undefined,
        justification: false,
        selfGrant: null,
        sessions: name !== "operation:issuer",
      })),
    ],
    resources: [
      {
        name: "customer",
        parent: null,
        permissions: ["read.risk"],
        visibility: "read",
      },
      {
        name: "operation",
        parent: null,
        permissions: ["read", "invoke", "preview"],
        visibility: "read",
      },
    ],
  }),
  grant: async (ctx: any, input: any) =>
    ctx.db.insert("grants", {
      type: input.type,
      key: input.key,
      role: input.role,
      subjectKind: "user",
      subjectType: "user",
      subject:
        input.recipient.kind === "person"
          ? input.recipient.key
          : `${SERVICE_ISSUER}/${input.recipient.name}|service`,
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    }),
  permissionsOn: async () => ["customer:read", "refund:create"],
} as unknown as AccessModel;

const caller = (issuer: string, subject: string) => ({
  issuer,
  subject,
  tokenIdentifier: `${issuer}|${subject}`,
});
const SERVICE = {
  ...caller(ISSUER, "service"),
  [CREDENTIAL_CLAIM]: CREDENTIAL_ID,
};
const OTHER_SERVICE = {
  ...caller(`${SERVICE_ISSUER}/sales`, "service"),
  [CREDENTIAL_CLAIM]: CREDENTIAL_ID,
};
const PERSON = caller("https://issuer.example", "alice");

beforeEach(() => vi.useRealTimers());
describe("agents", () => {
  const support = declare({
    ...definition(),
    instructions: "Read get_context before anything else.",
  });
  const triage = (overrides: Record<string, unknown> = {}) =>
    defineAgent({
      args: { request: v.optional(v.string()) },
      returns: v.null(),
      description: "Reads a customer and proposes refunds.",
      sessions: issuedSessions({
        service: "support-desk",
        role: "customer:supportAgent",
      }),
      tools: {
        get_context: support.tools.get_context!,
        opening_hours: support.tools.opening_hours!,
        propose_refund: tool.operation(
          contracts.support.refund,
          "Refund the customer.",
          { bind: "customer_id" },
        ),
      },
      model: "fixture",
      instructions: "Help the customer.",
      ...overrides,
    } as any);
  type Step = { type: string; [field: string]: unknown }[];
  const models = (steps: (Step | Error)[]) => {
    const prompts: any[] = [];
    const opened: unknown[] = [];
    const closed: unknown[] = [];
    const attempts: string[] = [];
    const reserved = new Set<string>();
    let next = 0;
    return {
      prompts,
      opened,
      closed,
      attempts,
      models: {
        open: async (_ctx: any, session: unknown) => {
          opened.push(session);
          return {
            attempt: (
              attemptKey: string,
              modelKey: string,
              requires?: readonly string[],
            ) => {
              expect(modelKey).toBe("fixture");
              expect(requires).toEqual(["tools"]);
              return {
                doGenerate: async (options: any) => {
                  attempts.push(attemptKey);
                  const identity = JSON.stringify([session, attemptKey]);
                  if (reserved.has(identity))
                    throw new Error("Attempt already reserved");
                  reserved.add(identity);
                  prompts.push(structuredClone(options));
                  const step = steps[next++] ?? [
                    {
                      type: "tool-call",
                      toolName: "complete",
                      toolCallId: "complete",
                      input: '{"result":null}',
                    },
                  ];
                  if (step instanceof Error) throw step;
                  return { content: step };
                },
              };
            },
            close: async (failure?: unknown) => {
              closed.push(failure);
            },
          };
        },
      },
    };
  };
  const bundleWith = (fake = models([])) =>
    agentsModule({
      component: component as any,
      access,
      agents: { triage: triage() },
      models: fake.models,
    }) as Record<string, any>;

  test("native admission retains the shortest lifetime of the run's issued roles", () => {
    const shortened = {
      ...access,
      describe: () => ({
        ...access.describe(),
        roles: access.describe().roles.map((role) => ({
          ...role,
          maxDuration:
            role.name === "customer:supportAgent" ? 60_000 : role.maxDuration,
        })),
      }),
    };
    const bundle = agentsModule({
      component: component as any,
      access: shortened,
      agents: { triage: triage() },
      models: models([]).models,
    });
    const native = JSON.parse((bundle as any).describe.exportAgentModule());
    expect(native.agents[0].maxDurationMs).toBe(60_000);
  });

  test("operation tools become proposals without requiring an operation issuer", () => {
    const model = {
      ...access,
      describe: () => ({
        ...access.describe(),
        roles: access.describe().roles.map((role) => ({
          ...role,
          permissions: role.permissions.filter(
            (permission) => !permission.startsWith("operation:issue."),
          ),
        })),
      }),
    };
    const bundle = agentsModule({
      component: component as any,
      access: model,
      agents: { triage: triage() },
      models: models([]).models,
    });
    const native = JSON.parse((bundle as any).describe.exportAgentModule());
    expect(native.problems).toEqual([]);
    expect(
      native.agents[0].tools.some((tool: any) => tool.kind === "operation"),
    ).toBe(true);
  });

  // Executes separate scheduled steps around a fake checkpoint store. This
  // witnesses SDK dispatch and batching; PostgreSQL owns persistence evidence.
  const runner = (
    bundle: Record<string, any>,
    ctx: any,
    interruptAfterResponse = false,
    maxSteps = 8,
  ) => {
    let progress: any = {
      step: 0,
      phase: "ready",
      prompt: null,
      response: null,
    };
    const responses: string[] = [];
    const scheduled: any[] = [];
    const native = (globalThis as any).Convex;
    const install = () => {
      (globalThis as any).Convex = {
        asyncSyscall: async (op: string, json: string) => {
          const args = JSON.parse(json);
          if (op === "1.0/agents/schedule") {
            expect(args).not.toHaveProperty("observations");
            scheduled.push(args);
            return JSON.stringify(args.run);
          }
          return native.asyncSyscall(op, json);
        },
      };
    };
    const privateMutation = (method: string, args: any) => {
      if (method === "initialize") {
        if (progress.prompt === null) progress.prompt = args.prompt;
      } else if (method === "response") {
        if (progress.step !== args.step) throw new Error("Checkpoint changed");
        if (progress.phase === "ready") responses.push(args.response);
        else if (progress.response !== args.response)
          throw new Error("Response changed");
        progress = { ...progress, phase: "responded", response: args.response };
      } else {
        if (progress.step !== args.step || progress.phase !== "responded")
          throw new Error("Checkpoint changed");
        const phase =
          args.result !== null
            ? "done"
            : args.step + 1 === maxSteps
              ? "exhausted"
              : "ready";
        progress = {
          step: phase === "ready" ? args.step + 1 : args.step,
          phase,
          prompt: args.prompt,
          response: null,
        };
      }
      return structuredClone(progress);
    };
    const wrapped = {
      ...ctx,
      meta: {
        getFunctionMetadata: async () => ({ name: "agents:triage_run" }),
      },
      runQuery: async (ref: any, args: any) => {
        if (getFunctionAddress(ref).reference?.endsWith("/native/progress"))
          return structuredClone(progress);
        if (getFunctionName(ref) === "agents:triage_progress")
          return bundle.triage_progress._handler(wrapped, args);
        return ctx.runQuery(ref, args);
      },
      runMutation: async (ref: any, args: any) => {
        const address = getFunctionAddress(ref).reference;
        if (address?.includes("/native/"))
          return privateMutation(address.split("/").at(-1)!, args);
        if (address?.endsWith("/proposals/propose"))
          return ctx.runMutation(
            makeFunctionReference("agents:triage_propose"),
            {
              for: "cus1",
              tool: args.tool,
              arguments: args.supplied,
              reason: args.reason,
            },
          );
        const member = getFunctionName(ref).replace(/^agents:/, "");
        if (
          ["triage_initialize", "triage_response", "triage_advance"].includes(
            member,
          )
        ) {
          const mutationCtx =
            member === "triage_advance"
              ? {
                  ...wrapped,
                  runQuery: async (reference: any) => {
                    if (
                      getFunctionAddress(reference).reference?.endsWith(
                        "/native/progress",
                      )
                    )
                      return structuredClone(progress);
                    throw new Error(
                      "Agent query tools must run through action callbacks",
                    );
                  },
                }
              : wrapped;
          const result = await bundle[member]._handler(mutationCtx, args);
          if (member === "triage_response" && interruptAfterResponse) {
            interruptAfterResponse = false;
            throw new Error("Interrupted after response retention");
          }
          return result;
        }
        return ctx.runMutation(ref, args);
      },
    };
    return {
      responses,
      progress: () => structuredClone(progress),
      run: async (args: any) => {
        install();
        scheduled.push({ run: args.session, step: 0, input: "{}", ...args });
        try {
          while (scheduled.length)
            await bundle.triage_run._handler(wrapped, scheduled.shift());
        } finally {
          (globalThis as any).Convex = native;
        }
      },
    };
  };

  test("own service-issued sessions and query tools, and propose only operations", () => {
    const agent = triage();
    expect(agent.maxSteps).toBe(8);
    expect(agent.tools.propose_refund.kind).toBe("operation");
    const desk = defineMcpServer("desk", {
      description: "A person's own assistant.",
      sessions: delegatedSessions(),
      tools: { get_context: tool.query(contracts.support.context, "Read.") },
    });
    for (const [overrides, message] of [
      [{ sessions: desk.sessions }, "service-issued"],
      [
        {
          tools: {
            lookup: tool.status(contracts.support.refund, "Read status."),
          },
        },
        "queries or operations",
      ],
      [{ maxSteps: 0 }, "maxSteps"],
      [{ model: "" }, "model"],
      [{ proposes: {} }, "unexpected property proposes"],
    ] as const)
      expect(() => triage(overrides as any)).toThrow(message);
    expect(() =>
      agentsModule({
        component: component as any,
        access,
        agents: { triage: triage() },
      } as any),
    ).toThrow("models");
    expect(() =>
      agentsModule({
        component: component as any,
        access,
        agents: { "invalid name": triage() },
        models: models([]).models,
      }),
    ).toThrow("camelCase identifier");
    expect(() =>
      agentsModule({
        component: component as any,
        access,
        agents: [triage()],
        models: models([]).models,
      } as any),
    ).toThrow("register agents by name");
    expect(() =>
      agentsModule({
        component: component as any,
        access,
        agents: { triage: triage() },
        models: models([]).models,
        module: "agents",
      } as any),
    ).toThrow("unexpected property module");
  });

  test("bring their steps, proposals and review into the bundle", async () => {
    const bundle = bundleWith();
    for (const step of [
      "triage_open",
      "triage_begin",
      "triage_run",
      "triage_record",
      "_resolveProposal",
      "_submitProposal",
    ])
      expect(bundle[step].isInternal).toBe(true);
    expect(bundle.proposals.isQuery && bundle.proposals.isPublic).toBe(true);
    expect(bundle.submit__invoke.isMutation).toBe(true);
    expect(bundle.submit__invoke.isPublic).toBe(true);
    expect(bundle).not.toHaveProperty("review");
    expect(bundle).not.toHaveProperty("preview");
    expect(bundle).not.toHaveProperty("saveReview");
    expect(bundle).not.toHaveProperty("triage_close");
    for (const member of ["reject"])
      expect(bundle[member].isMutation && bundle[member].isPublic).toBe(true);
    const native = JSON.parse(bundle.describe.exportAgentModule());
    expect(native.agents).toEqual([
      expect.objectContaining({
        name: "triage",
        service: "support-desk",
        maxSteps: 8,
        maxDurationMs: HALF_HOUR,
        tools: expect.any(Array),
      }),
    ]);
    expect(native.agents[0].tools.map((tool: any) => tool.kind)).toEqual([
      "query",
      "query",
      "operation",
    ]);
    expect(native.agents[0]).not.toHaveProperty("proposes");
    expect(native.tables).toEqual([]);
    vi.stubEnv("BIJECTION_HTTP_ACTIONS_URL", SITE);
    const described = await bundle.describe._handler(
      {
        db: database({}),
        auth: { getUserIdentity: async () => null },
        meta: {
          getFunctionMetadata: async () => ({ name: "agents:describe" }),
        },
      },
      {},
    );
    expect(described.agents).toEqual([
      expect.objectContaining({
        name: "triage",
        resource_type: "customer",
        service: "support-desk",
        model: "fixture",
        proposes: [expect.objectContaining({ name: "propose_refund" })],
      }),
    ]);
    vi.unstubAllEnvs();
  });

  test("an operation supplies run identity while the caller supplies bounded task text", async () => {
    const agent = linkedAgentReferences({
      triage: {
        contract: "a".repeat(64),
        args: JSON.stringify(
          v.object({ request: v.optional(v.string()) }).json,
        ),
        returns: JSON.stringify(v.null().json),
      },
    }).triage;
    const syscall = vi.fn(async (_op: string, _args: string) =>
      JSON.stringify("native-run"),
    );
    (globalThis as any).Convex = { asyncSyscall: syscall };
    expect(
      await startAgent({}, agent, {
        for: "cus1",
        args: { request: "Review open tickets" },
      }),
    ).toBe("native-run");
    expect(syscall).toHaveBeenCalledWith(
      "1.0/agents/schedule",
      JSON.stringify({
        agent: "triage",
        contract: "a".repeat(64),
        for: "cus1",
        input: '{"request":"Review open tickets"}',
      }),
    );
    for (const request of ["é".repeat(8193), "x".repeat(16385)])
      await expect(
        startAgent({}, agent, { for: "cus1", args: { request } }),
      ).rejects.toThrow();
    await expect(
      startAgent({}, {} as any, { for: "cus1", args: {} }),
    ).rejects.toThrow("generated agents catalog");
    expect(syscall).toHaveBeenCalledTimes(1);
  });

  test("a run starts as the service: it registers its session acting for the run's object and schedules the run", async () => {
    const tables: Record<string, Row[]> = {};
    const syscalls: [string, any][] = [];
    let started = false;
    (globalThis as any).Convex = {
      asyncSyscall: async (op: string, json: string) => {
        const args = JSON.parse(json);
        syscalls.push([op, args]);
        if (op === "1.0/agents/open")
          return JSON.stringify({
            session: "run-native-original-session",
            expiresAt: 123456789,
            started,
          });
        if (op === "1.0/sessions/register")
          return JSON.stringify(`${ISSUER}|session:${args.session}`);
        if (op === "1.0/agents/schedule") {
          started = true;
          return "null";
        }
        throw new Error(`Unexpected syscall ${op}`);
      },
    };
    const audited: Record<string, any>[] = [];
    const ctx = (identity: unknown) => ({
      db: database(tables),
      meta: {
        getFunctionMetadata: async () => ({ name: "work/triage:triage_begin" }),
      },
      auth: { getUserIdentity: async () => identity },
      audit: async (line: Record<string, any>) => {
        audited.push(line);
      },
    });
    const bundle = bundleWith();
    await bundle.triage_begin._handler(ctx(SERVICE), {
      run: "native-run",
      for: "cus1",
      input: "Look",
    });
    const [open, register, schedule] = syscalls;
    expect(open).toEqual([
      "1.0/agents/open",
      { agent: "triage", run: "native-run", for: "cus1", input: "Look" },
    ]);
    expect(register![1].session).toBe("run-native-original-session");
    expect(register![1].until).toBe(123456789);
    expect(register![0]).toBe("1.0/sessions/register");
    expect(register![1]).toMatchObject({
      functions: ["work/triage:triage_run"],
      endpoint: "/agents/triage",
      server: "triage",
      role: "customer:supportAgent",
      ancestorRoles: [],
      for: { type: "customer", key: "cus1" },
      // A run only proposes operations: it holds no operation role.
      operations: [],
      evidence: null,
    });
    const principal = `${ISSUER}|session:${register![1].session}`;
    expect(tables.grants ?? []).toEqual([]);
    expect(schedule).toEqual([
      "1.0/agents/schedule",
      {
        agent: "triage",
        run: "native-run",
        session: register![1].session,
        for: "cus1",
        input: "Look",
      },
    ]);
    expect(audited).toEqual([
      expect.objectContaining({ action: "agent.run", session: principal }),
    ]);
    await bundle.triage_begin._handler(ctx(SERVICE), {
      run: "native-run",
      for: "cus1",
      input: "Look",
    });
    expect(syscalls.map(([op]) => op)).toEqual([
      "1.0/agents/open",
      "1.0/sessions/register",
      "1.0/agents/schedule",
      "1.0/agents/open",
    ]);
    expect(audited).toHaveLength(1);
    // Only the agent's service starts it.
    for (const identity of [PERSON, OTHER_SERVICE, null])
      await expect(
        bundle.triage_begin._handler(ctx(identity), { for: "cus1" }),
      ).rejects.toThrow("Access refused");
  });

  test("a run reads with its own tools as its session, proposes, and settles its model session", async () => {
    const fake = models([
      [
        {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "get_context",
          input: "{}",
        },
      ],
      [
        {
          type: "tool-call",
          toolCallId: "c2",
          toolName: "propose_refund",
          input: JSON.stringify({
            arguments: { amount: "500" },
            reason: "Damaged",
          }),
        },
      ],
      [
        {
          type: "tool-call",
          toolName: "complete",
          toolCallId: "complete",
          input: '{"result":null}',
        },
      ],
    ]);
    const bundle = bundleWith(fake);
    const calls: string[] = [];
    const ctx = {
      runQuery: async (reference: any, args: any) => {
        const name = getFunctionName(reference);
        calls.push(name);
        expect([name, args]).toEqual(["support.js:context", {}]);
        return { name: "Alice" };
      },
      runMutation: async (reference: any, args: any) => {
        const name = getFunctionName(reference);
        calls.push(name);
        if (name === "agents:triage_record") {
          expect(args).toEqual({ tool: "get_context", outcome: "completed" });
          return null;
        }
        if (name === "agents:triage_propose") {
          expect(args).toEqual({
            for: "cus1",
            tool: "propose_refund",
            arguments: JSON.stringify({ amount: "500" }),
            reason: "Damaged",
          });
          return "p1";
        }
        throw new Error(`Unexpected mutation ${name}`);
      },
    };
    const running = runner(bundle, ctx);
    await running.run({ session: "run-1", for: "cus1" });
    expect(calls).toEqual([
      "support.js:context",
      "agents:triage_record",
      "agents:triage_propose",
    ]);
    expect(fake.opened).toEqual(
      Array(3).fill({
        consumer: "agents",
        subject: "run-1",
        key: "fixture",
      }),
    );
    expect(fake.closed).toEqual([null]);
    expect(fake.attempts).toEqual(["step-0", "step-1", "step-2"]);
    // The model sees the server's reads and the proposals, never an
    // operation it could invoke, nor the bound argument.
    const offered = fake.prompts[0].tools;
    expect(offered.map((t: any) => t.name)).toEqual([
      "complete",
      "get_context",
      "opening_hours",
      "propose_refund",
    ]);
    expect(
      offered[3].inputSchema.properties.arguments.properties,
    ).not.toHaveProperty("customer_id");
    // The agent owns its own instructions.
    expect(fake.prompts[0].prompt[0].content).toMatch(
      /^Help the customer\.\n\n/,
    );
    expect(fake.prompts[0].prompt[0].content).toContain("customer cus1");
    const results = (n: number) =>
      fake.prompts[n].prompt
        .filter((message: any) => message.role === "tool")
        .at(-1)
        .content.map((part: any) => part.output.value);
    expect(results(1)).toEqual([{ result: { name: "Alice" } }]);
    expect(results(2)).toEqual([{ proposed: "p1", state: "pending" }]);

    // The model ledger closes on failure; native job completion owns authority.
    const failing = models([new Error("provider down")]);
    calls.length = 0;
    await expect(
      runner(bundleWith(failing), ctx).run({
        session: "run-2",
        for: "cus1",
      }),
    ).rejects.toThrow("provider down");
    expect(calls).toEqual([]);
    expect(failing.closed).toEqual([undefined]);
  });

  test("replaying a run retains step identity and refuses before another generation or tool call", async () => {
    const fake = models([
      [
        {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "get_context",
          input: "{}",
        },
      ],
      new Error("Lost provider response"),
    ]);
    const bundle = bundleWith(fake);
    const query = vi.fn(async () => ({ name: "Alice" }));
    const record = vi.fn(async () => null);
    const ctx = { runQuery: query, runMutation: record };
    const running = runner(bundle, ctx);
    const input = { session: "interrupted", for: "cus1" };
    await expect(running.run(input)).rejects.toThrow("Lost provider response");
    await expect(running.run({ ...input, step: 1 })).rejects.toThrow(
      "Attempt already reserved",
    );
    expect(fake.attempts).toEqual(["step-0", "step-1", "step-1"]);
    expect(fake.prompts).toHaveLength(2);
    expect(query).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(1);
  });

  test("resumes a retained response without another model attempt or duplicate tool effects", async () => {
    const fake = models([
      [
        {
          type: "tool-call",
          toolCallId: "read",
          toolName: "get_context",
          input: "{}",
        },
      ],
      [
        {
          type: "tool-call",
          toolName: "complete",
          toolCallId: "complete",
          input: '{"result":null}',
        },
      ],
    ]);
    const query = vi.fn(async () => ({ name: "Alice" }));
    const record = vi.fn(async () => null);
    const running = runner(
      bundleWith(fake),
      { runQuery: query, runMutation: record },
      true,
    );
    const input = { session: "response-resume", for: "cus1" };
    await expect(running.run(input)).rejects.toThrow(
      "Interrupted after response retention",
    );
    expect(running.progress().phase).toBe("responded");
    expect(query).not.toHaveBeenCalled();
    await running.run(input);
    await running.run(input);
    expect(fake.attempts).toEqual(["step-0", "step-1"]);
    expect(fake.prompts).toHaveLength(2);
    expect(query).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(1);
    expect(running.responses).toHaveLength(2);
    expect(running.progress().phase).toBe("done");
  });

  test.each(["done", "exhausted"])(
    "replaying a %s checkpoint closes the original ledger without another attempt",
    async (phase) => {
      const fake = models([
        phase === "done"
          ? [
              {
                type: "tool-call",
                toolName: "complete",
                toolCallId: "complete",
                input: '{"result":null}',
              },
            ]
          : [
              {
                type: "tool-call",
                toolCallId: "read",
                toolName: "get_context",
                input: "{}",
              },
            ],
      ]);
      const bundle = agentsModule({
        component: component as any,
        access,
        agents: { triage: triage({ maxSteps: 1 }) },
        models: fake.models,
      }) as Record<string, any>;
      const query = vi.fn(async () => ({ name: "Alice" }));
      const record = vi.fn(async () => null);
      const running = runner(
        bundle,
        { runQuery: query, runMutation: record },
        false,
        1,
      );
      const args = { session: "terminal-cleanup", for: "cus1" };
      if (phase === "done") await running.run(args);
      else
        await expect(running.run(args)).rejects.toThrow(
          "Agent step limit reached",
        );
      expect(running.progress().phase).toBe(phase);
      const reads = query.mock.calls.length;
      const records = record.mock.calls.length;
      fake.closed.length = 0;
      if (phase === "done") await running.run(args);
      else
        await expect(running.run(args)).rejects.toThrow(
          "Agent step limit reached",
        );
      expect(fake.opened).toHaveLength(2);
      expect(fake.opened[1]).toEqual(fake.opened[0]);
      expect(fake.closed).toEqual([phase === "done" ? null : undefined]);
      expect(fake.attempts).toEqual(["step-0"]);
      expect(query).toHaveBeenCalledTimes(reads);
      expect(record).toHaveBeenCalledTimes(records);
    },
  );

  test("reaching the step bound fails instead of reporting a completed run", async () => {
    const fake = models([
      [
        {
          type: "tool-call",
          toolCallId: "one",
          toolName: "get_context",
          input: "{}",
        },
      ],
    ]);
    const bundle = agentsModule({
      component: component as any,
      access,
      agents: { triage: triage({ maxSteps: 1 }) },
      models: fake.models,
    }) as Record<string, any>;
    const query = vi.fn(async () => ({ name: "Alice" }));
    const record = vi.fn(async () => null);
    await expect(
      runner(bundle, { runQuery: query, runMutation: record }, false, 1).run({
        session: "bounded",
        for: "cus1",
      }),
    ).rejects.toThrow("Agent step limit reached");
    expect(fake.prompts).toHaveLength(1);
    expect(query).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(1);
    expect(fake.closed).toEqual([undefined]);
  });

  test("the admitted native limit ends a run even when deployed code asks for more", async () => {
    const fake = models([
      [
        {
          type: "tool-call",
          toolCallId: "one",
          toolName: "get_context",
          input: "{}",
        },
      ],
    ]);
    const bundle = agentsModule({
      component: component as any,
      access,
      agents: { triage: triage({ maxSteps: 16 }) },
      models: fake.models,
    }) as Record<string, any>;
    const query = vi.fn(async () => ({ name: "Alice" }));
    const record = vi.fn(async () => null);
    const running = runner(
      bundle,
      { runQuery: query, runMutation: record },
      false,
      1,
    );
    await expect(
      running.run({ session: "native-bound", for: "cus1" }),
    ).rejects.toThrow("Agent step limit reached");
    expect(running.progress()).toMatchObject({ step: 0, phase: "exhausted" });
    expect(fake.attempts).toEqual(["step-0"]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(1);
    expect(fake.closed).toEqual([undefined]);
  });

  test("validates the whole response before any query or proposal runs", async () => {
    const query = (id: string) => ({
      type: "tool-call",
      toolCallId: id,
      toolName: "get_context",
      input: "{}",
    });
    const proposal = {
      type: "tool-call",
      toolCallId: "proposal",
      toolName: "propose_refund",
      input: JSON.stringify({
        arguments: { amount: "500" },
        reason: "Damaged",
      }),
    };
    const invalid: Step[] = [
      [proposal, { ...query("bad"), toolName: "request_refund" }],
      [proposal, { ...query("bad"), input: '{"undeclared":true}' }],
      [query("duplicate"), query("duplicate")],
      [{ ...query("bad"), input: "{" }],
      [{ type: "text", text: "é".repeat(33 * 1024) }],
      Array.from({ length: 17 }, (_, i) => query(String(i))),
    ];
    for (const response of invalid) {
      const fake = models([response]);
      const query = vi.fn();
      const mutations: string[] = [];
      const running = runner(bundleWith(fake), {
        runQuery: query,
        runMutation: async (reference: any) => {
          mutations.push(getFunctionName(reference));
        },
      });
      await expect(
        running.run({ session: "run-bad", for: "cus1" }),
      ).rejects.toThrow("Invalid model response");
      expect(query).not.toHaveBeenCalled();
      expect(mutations).toEqual([]);
      expect(fake.closed).toEqual([undefined]);
      // Bounded but invalid tool content stays provisional for inspection;
      // replay must not generate again or execute its valid prefix.
      const complete = JSON.stringify({ content: response });
      expect(running.responses).toEqual(
        new TextEncoder().encode(complete).byteLength <= 64 * 1024
          ? [complete]
          : [],
      );
    }
  });

  test("validates every query observation before writing proposals", async () => {
    const response = [
      {
        type: "tool-call",
        toolCallId: "proposal",
        toolName: "propose_refund",
        input: JSON.stringify({
          arguments: { amount: "500" },
          reason: "Damaged",
        }),
      },
      {
        type: "tool-call",
        toolCallId: "query",
        toolName: "get_context",
        input: "{}",
      },
    ];
    for (const observations of [
      null,
      [],
      [{ toolCallId: "other", value: { result: null } }],
      [{ toolCallId: "query", value: { error: "arbitrary provider text" } }],
      [{ toolCallId: "query", value: { result: null, extra: true } }],
      [{ toolCallId: "query", value: { result: null }, extra: true }],
    ]) {
      const fake = models([response]);
      const open = fake.models.open;
      fake.models.open = async (ctx, session) => {
        const mutate = ctx.runMutation.bind(ctx);
        ctx.runMutation = (reference: any, args: any) =>
          mutate(
            reference,
            getFunctionAddress(reference).name === "agents:triage_advance"
              ? { ...args, observations: JSON.stringify(observations) }
              : args,
          );
        return open(ctx, session);
      };
      const query = vi.fn(async () => ({ name: "Alice" }));
      const mutation = vi.fn(async () => "proposal");
      const running = runner(bundleWith(fake), {
        runQuery: query,
        runMutation: mutation,
      });
      await expect(
        running.run({ session: "invalid-observation", for: "cus1" }),
      ).rejects.toThrow(/Invalid query observation/);
      expect(query).toHaveBeenCalledTimes(1);
      expect(mutation).not.toHaveBeenCalled();
      expect(running.progress().phase).toBe("responded");
    }
  });

  test("bounds total tool work and the results retained in a model prompt", async () => {
    const steps = Array.from({ length: 5 }, (_, step) =>
      Array.from({ length: 16 }, (_, call) => ({
        type: "tool-call",
        toolCallId: `${step}-${call}`,
        toolName: "get_context",
        input: "{}",
      })),
    );
    const fake = models(steps);
    const query = vi.fn(async () => ({ name: "Alice" }));
    await expect(
      runner(bundleWith(fake), {
        runQuery: query,
        runMutation: async () => null,
      }).run({ session: "run-many", for: "cus1" }),
    ).rejects.toThrow("tool call limit");
    expect(query).toHaveBeenCalledTimes(64);
    const large = models([
      [
        {
          type: "tool-call",
          toolCallId: "large",
          toolName: "get_context",
          input: "{}",
        },
      ],
    ]);
    await runner(bundleWith(large), {
      runQuery: async () => ({ name: "é".repeat(20 * 1024) }),
      runMutation: async () => null,
    }).run({ session: "run-large", for: "cus1" });
    expect(large.prompts[1].prompt.at(-1).content[0].output.value).toEqual({
      error: "result_too_large",
    });
  });
});

test("the generated agent API preserves proposal IDs and public member types", () => {
  type Api = ApiFromModules<{
    agents: { default: ReturnType<typeof agentsModule> };
  }>;
  assert<Equals<FunctionArgs<Api["agents"]["proposals"]>, { for: string }>>();
  assert<
    Equals<
      Api["agents"]["submit"]["_args"],
      { proposal: GenericId<"agentProposals"> }
    >
  >();
  assert<
    Equals<Api["agents"]["submit"]["_returnType"], GenericId<"agentProposals">>
  >();
  assert<
    Equals<
      FunctionReturnType<Api["agents"]["proposals"]>[number]["id"],
      GenericId<"agentProposals">
    >
  >();
});
