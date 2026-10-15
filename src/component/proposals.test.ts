import { afterEach, expect, test, vi } from "vitest";
import { propose, submit, reject } from "./proposals.js";
type Row = Record<string, any> & { _id: string };
function database(tables: Record<string, Row[]>) {
  let next = 1;
  const all = () => Object.values(tables).flat();
  const db = {
    normalizeId: (table: string, id: string) =>
      tables[table]?.some((row) => row._id === id) ? id : null,
    get: async (first: string, second?: string) =>
      structuredClone(
        all().find((row) => row._id === (second ?? first)) ?? null,
      ),
    insert: async (table: string, document: Record<string, any>) => {
      const _id = `${table}|${next++}`;
      (tables[table] ??= []).push({ _id, ...document });
      return _id;
    },
    patch: async (
      first: string,
      second: string | Record<string, any>,
      third?: Record<string, any>,
    ) => {
      const id = third ? second : first;
      const fields = third ?? second;
      Object.assign(all().find((row) => row._id === id)!, fields);
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

afterEach(() => vi.unstubAllGlobals());
function fixture() {
  const tables: Record<string, Row[]> = {
    agentRuns: [
      {
        _id: "checkpoint",
        run: "run",
        contract: "agent-contract",
        session: "session",
        maxSteps: 4,
        generation: 1,
        checkpoint: {
          phase: "responded",
          responses: [
            JSON.stringify({
              content: [
                {
                  type: "tool-call",
                  toolCallId: "call",
                  toolName: "refund",
                  input: JSON.stringify({
                    arguments: { amount: "500" },
                    reason: "Damaged",
                  }),
                },
              ],
            }),
          ],
        },
      },
    ],
    agentConfigurations: [
      {
        _id: "config",
        module: "agents",
        declaration: "/agents.js:default",
        agents: ["triage"],
        resolve: "function://resolve",
        submit: "function://submit",
      },
    ],
  };
  const db = database(tables);
  vi.stubGlobal("Convex", {
    asyncSyscall: async (name: string) => {
      if (name === "1.0/executions/context")
        return JSON.stringify({
          name: "triage",
          module: "agents",
          for: { type: "customer", key: "customer" },
          principal: "service|session",
          session: "session",
          maxAdvances: 4,
          contract: "agent-contract",
          checkpoint: { record: "checkpoint", generation: 1 },
        });
      return "null";
    },
  });
  const business = vi.fn(async () => ({ kind: "accepted" }));
  const ctx = {
    db: { ...db, vars: { commitTs: 123n } },
    auth: {
      getUserIdentity: async () => ({
        issuer: "https://people.example",
        subject: "alice",
        tokenIdentifier: "https://people.example|alice",
      }),
    },
    runQuery: async () => ({
      operation: "desk.js:refund",
      contract: "original-contract",
      arguments: { customer: "customer", amount: 500n },
    }),
    runMutation: business,
  };
  return { tables, ctx, business };
}
const call = {
  run: "run",
  call: "call",
  tool: "refund",
  supplied: JSON.stringify({ amount: "500" }),
  reason: "Damaged",
};
// Database-independent protocol checks. Native PostgreSQL qualification owns
// identity, custody, review, OCC and cross-component transaction atomicity.
test("retained call identity creates one proposal and preserves exact business inputs", async () => {
  const { ctx, tables } = fixture();
  const first = await propose._handler(ctx as never, call);
  expect(await propose._handler(ctx as never, call)).toBe(first);
  expect(tables.agentProposals).toHaveLength(1);
  expect(tables.agentProposals[0]).toMatchObject({
    requestKey: `proposal:${first}`,
    arguments: { customer: "customer", amount: 500n },
    state: "pending",
    decided_at: null,
  });
  await expect(
    propose._handler(ctx as never, { ...call, supplied: '{"amount":"900"}' }),
  ).rejects.toThrow("retained arguments");
  await expect(
    propose._handler(ctx as never, { ...call, tool: "other" }),
  ).rejects.toThrow("retained call");
});
test("review preparation forwards the original contract and request key once", async () => {
  const { ctx, tables, business } = fixture();
  const id = await propose._handler(ctx as never, call);
  const prepare = (submit as any).invoke._handler;
  expect(await prepare(ctx, { args: { proposal: id } })).toBe(id);
  expect(business).toHaveBeenCalledWith("function://submit", {
    agent: "triage",
    tool: "refund",
    operation: "desk.js:refund",
    contract: "original-contract",
    arguments: { customer: "customer", amount: 500n },
    requestKey: `proposal:${id}`,
  });
  expect(tables.agentProposals[0]).toMatchObject({
    state: "submitted",
    decided_at: 123n,
  });
  await expect(prepare(ctx, { args: { proposal: id } })).rejects.toThrow(
    "already submitted",
  );
  expect(business).toHaveBeenCalledOnce();
});
test("refusal leaves the proposal pending and rejection never calls the business operation", async () => {
  const { ctx, tables, business } = fixture();
  const id = await propose._handler(ctx as never, call);
  business.mockImplementation(
    async () =>
      ({
        kind: "refused",
        refusal: { code: "cancelled", message: "Cancelled" },
      }) as any,
  );
  await expect(
    (submit as any).invoke._handler(ctx, { args: { proposal: id } }),
  ).rejects.toThrow("Cancelled");
  expect(tables.agentProposals[0].state).toBe("pending");
  await reject._handler(ctx as never, { proposal: id });
  expect(tables.agentProposals[0].state).toBe("rejected");
  expect(business).toHaveBeenCalledOnce();
});
