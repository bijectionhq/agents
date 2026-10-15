import { afterEach, expect, test, vi } from "vitest";
import { begin, step, originalProposal } from "./migrations.js";

afterEach(() => vi.unstubAllGlobals());

// Protocol tests only. PostgreSQL owns transaction rollback, custody and
// persisted restart qualification; this fixture makes no durability claim.
function fixture() {
  const tables: Record<string, any[]> = {};
  let nextId = 0;
  const all = () => Object.values(tables).flat();
  const db = {
    get: async (first: string, second?: string) =>
      structuredClone(
        all().find((row) => row._id === (second ?? first)) ?? null,
      ),
    insert: async (table: string, value: object) => {
      const id = `${table}|${++nextId}`;
      (tables[table] ??= []).push({ ...value, _id: id });
      return id;
    },
    patch: async (first: string, second: string | object, third?: object) =>
      Object.assign(
        all().find((row) => row._id === (third ? second : first))!,
        third ?? second,
      ),
    query: (table: string) => ({
      withIndex: (_index: string, select: (q: any) => any) => {
        const fields: [string, unknown][] = [];
        const q = {
          eq: (field: string, value: unknown) => {
            fields.push([field, value]);
            return q;
          },
        };
        select(q);
        return {
          unique: async () => {
            const rows = (tables[table] ?? []).filter((row) =>
              fields.every(([key, value]) => row[key] === value),
            );
            if (rows.length > 1) throw new Error("Not unique");
            return structuredClone(rows[0] ?? null);
          },
        };
      },
    }),
  };
  const executions = ["one", "two"].map((run) => ({
    run,
    agent: "triage",
    module: "agents",
    principal: `session:${run}`,
    session: run,
    contract: "original",
    maxAdvances: 2,
    body: `opaque:${run}\n`,
  }));
  const proposal = {
    _id: "original",
    agent: "triage",
    for: "customer",
    session: "session:one",
    tool: "refund",
    operation: "desk.js:refund",
    contract: "old",
    arguments: { amount: 9007199254740993n },
    reason: "Damaged",
    state: "pending",
    proposed_at: 1,
    decided_by: null,
    decided_at: null,
  };
  const archived: any[] = [];
  let evidence = "/agents.js:default";
  let custody = true;
  vi.stubGlobal("Convex", {
    asyncSyscall: async (name: string, raw: string) => {
      const args = JSON.parse(raw);
      switch (name) {
        case "1.0/componentDeclaration":
          return JSON.stringify({
            component: "child",
            declaration: evidence,
            phase: "work",
            access: [],
          });
        case "1.0/retainComponentCallback":
          return JSON.stringify(`retained:${args.handle}`);
        case "1.0/resumeComponentWork":
          return JSON.stringify(custody);
        case "1.0/executions/legacy": {
          const index =
            args.cursor === null
              ? 0
              : executions.findIndex((row) => row.run === args.cursor) + 1;
          return JSON.stringify({
            cursor: executions[index]?.run ?? null,
            execution: executions[index] ?? null,
          });
        }
        case "1.0/executions/archive":
          archived.push(args);
          return "null";
        default:
          throw new Error(`Unexpected syscall ${name}`);
      }
    },
  });
  const jobs: any[] = [];
  const runQuery = vi.fn(async () => ({
    page: [proposal],
    continueCursor: "",
    isDone: true,
  }));
  const context = () => ({
    db,
    runQuery,
    scheduler: {
      runAfter: async (_delay: number, _ref: unknown, args: unknown) =>
        jobs.push(args),
    },
  });
  return {
    tables,
    executions,
    proposal,
    archived,
    jobs,
    runQuery,
    context,
    setEvidence: (value: string) => (evidence = value),
    setCustody: (value: boolean) => (custody = value),
  };
}

test("migration resumes bounded work and preserves opaque checkpoints and original proposal identities", async () => {
  const f = fixture();
  await begin(f.context() as never, "agents", ["triage"], "legacy-query");
  expect(f.archived).toHaveLength(1);
  expect(f.tables.agentRunArchives[0].body).toBe(f.executions[0].body);
  expect(f.tables.agentMigrations[0]).toMatchObject({
    cursor: "one",
    phase: "runs",
    legacy: "retained:legacy-query",
  });
  // Fresh callback contexts resume only the retained cursor and callback.
  while (f.jobs.length)
    await step._handler(f.context() as never, f.jobs.shift());
  expect(f.archived).toHaveLength(2);
  expect(f.tables.agentMigrations[0].phase).toBe("done");
  expect(f.runQuery).toHaveBeenCalledWith("retained:legacy-query", {
    cursor: null,
    agents: ["triage"],
  });
  const copy = f.tables.agentProposals[0];
  expect(copy).toMatchObject({
    originalId: "original",
    requestKey: "proposal:original",
    contract: "old",
    arguments: { amount: 9007199254740993n },
  });
  expect(
    await originalProposal._handler(f.context() as never, {
      module: "agents",
      originalId: "original",
    }),
  ).toBe(copy._id);
  const original = structuredClone(f.proposal);
  await begin(f.context() as never, "agents", ["triage"], "legacy-query");
  while (f.jobs.length)
    await step._handler(f.context() as never, f.jobs.shift());
  expect(f.tables.agentRunArchives).toHaveLength(2);
  expect(f.tables.agentProposals).toHaveLength(1);
  expect(f.proposal).toEqual(original);
});

test("migration refuses changed declaration or missing retained custody before selecting legacy data", async () => {
  const f = fixture();
  await begin(f.context() as never, "agents", ["triage"], "legacy-query");
  const job = f.jobs.shift();
  f.setEvidence("/other.js:default");
  await expect(step._handler(f.context() as never, job)).rejects.toThrow(
    "declaration changed",
  );
  f.setEvidence("/agents.js:default");
  f.setCustody(false);
  await expect(step._handler(f.context() as never, job)).rejects.toThrow(
    "custody is absent",
  );
  expect(f.archived).toHaveLength(1);
  expect(f.runQuery).not.toHaveBeenCalled();
  expect(f.tables.agentMigrations[0].cursor).toBe("one");
});
