/** Bounded, resumable custody handoff. Native declaration evidence selects
 * the original module; caller arguments cannot manufacture archival inputs. */
import {
  componentDeclaration,
  retainComponentCallback,
  resumeComponentWork,
  scopedExecution,
  type LegacyExecution,
  type FunctionReference,
} from "bijection/server";
import { v, type GenericId } from "bijection/values";
import {
  internalMutation,
  query,
  type MutationCtx,
} from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import { archiveProposal, type Proposal } from "../native/legacy.js";

export async function begin(
  ctx: MutationCtx,
  module: string,
  agents: string[],
  legacy: string,
) {
  const old = await ctx.db
    .query("agentMigrations")
    .withIndex("by_module", (q) => q.eq("module", module))
    .unique();
  if (old && old.phase !== "done") return;
  const value = {
    module,
    agents,
    legacy: "",
    phase: "runs" as const,
    cursor: null,
  };
  const id = old?._id ?? (await ctx.db.insert("agentMigrations", value));
  const callback = await retainComponentCallback(legacy, id);
  await ctx.db.patch("agentMigrations", id, { ...value, legacy: callback });
  await advance(ctx, id);
}
async function archive(ctx: MutationCtx, execution: LegacyExecution) {
  const old = await ctx.db
    .query("agentRunArchives")
    .withIndex("by_run", (q) => q.eq("run", execution.run))
    .unique();
  if (old && old.body !== execution.body)
    throw new Error("Original checkpoint bytes changed");
  const id = old?._id ?? (await ctx.db.insert("agentRunArchives", execution));
  await scopedExecution.archive(execution.run, id);
}
async function advance(ctx: MutationCtx, id: GenericId<"agentMigrations">) {
  const state = await ctx.db.get("agentMigrations", id);
  if (!state || state.phase === "done") return;
  if (!(await resumeComponentWork(id)))
    throw new Error("Original migration custody is absent");
  const declaration = await componentDeclaration();
  if (declaration?.declaration !== `/${state.module}.js:default`)
    throw new Error("Original migration declaration changed");
  if (state.phase === "runs") {
    const next = await scopedExecution.legacy(state.cursor);
    if (next.execution) await archive(ctx, next.execution);
    await ctx.db.patch(
      "agentMigrations",
      id,
      next.cursor
        ? { cursor: next.cursor }
        : { cursor: null, phase: "proposals" },
    );
    if (!next.cursor) return advance(ctx, id);
  } else {
    const page: { page: Proposal[]; continueCursor: string; isDone: boolean } =
      await ctx.runQuery(
        state.legacy as unknown as FunctionReference<"query">,
        { cursor: state.cursor, agents: state.agents },
      );
    for (const source of page.page) {
      const originalRun = await ctx.db
        .query("agentRunArchives")
        .withIndex("by_principal", (q) => q.eq("principal", source.session))
        .unique();
      if (
        !originalRun ||
        originalRun.module !== state.module ||
        originalRun.agent !== source.agent
      )
        throw new Error("Original proposal execution is absent");
      const old = await ctx.db
        .query("agentProposals")
        .withIndex("by_original", (q) =>
          q.eq("module", state.module).eq("originalId", source._id),
        )
        .unique();
      const value = archiveProposal(state.module, source, old ?? undefined);
      if (value) {
        if (old) await ctx.db.patch("agentProposals", old._id, value);
        else await ctx.db.insert("agentProposals", value as any);
      }
    }
    await ctx.db.patch(
      "agentMigrations",
      id,
      page.isDone
        ? { phase: "done", cursor: null }
        : { cursor: page.continueCursor },
    );
  }
  const next = await ctx.db.get("agentMigrations", id);
  if (next?.phase !== "done")
    await ctx.scheduler.runAfter(0, internal.migrations.step, {
      migration: id,
    });
}
export const step = internalMutation({
  args: { migration: v.id("agentMigrations") },
  handler: async (ctx, { migration }) => advance(ctx, migration),
});
export const status = query({
  args: { module: v.string() },
  handler: async (ctx, { module }) => {
    const row = await ctx.db
      .query("agentMigrations")
      .withIndex("by_module", (q) => q.eq("module", module))
      .unique();
    return { complete: row?.phase === "done", phase: row?.phase ?? "absent" };
  },
});
export const originalProposal = query({
  args: { module: v.string(), originalId: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("agentProposals")
      .withIndex("by_original", (q) =>
        q.eq("module", args.module).eq("originalId", args.originalId),
      )
      .unique();
    return row?._id ?? null;
  },
});
