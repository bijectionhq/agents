/** Private reasoning state. Native context establishes the actual current
 * execution before a component read or write; arguments grant no authority. */
import { v } from "bijection/values";
import type { Doc } from "./_generated/dataModel.js";
import { scopedExecution, type ScopedExecutionContext } from "bijection/server";
import {
  query,
  mutation,
  type QueryCtx,
  type MutationCtx,
} from "./_generated/server.js";
import {
  initializeCheckpoint,
  retainResponse,
  advanceCheckpoint,
  type Checkpoint,
} from "../native/progress.js";

export async function current(
  ctx: QueryCtx | MutationCtx,
  run: string,
): Promise<{
  execution: ScopedExecutionContext;
  record: Doc<"agentRuns"> | null;
}> {
  const execution = await scopedExecution.context(run);
  const record = await ctx.db
    .query("agentRuns")
    .withIndex("by_run", (q) => q.eq("run", run))
    .unique();
  if (
    record &&
    (record.contract !== execution.contract ||
      record.session !== execution.session ||
      record.maxSteps !== execution.maxAdvances ||
      execution.checkpoint?.record !== record._id ||
      execution.checkpoint.generation !== record.generation)
  )
    throw new Error("Agent execution binding changed");
  if (!record && execution.checkpoint !== null)
    throw new Error("Agent checkpoint is absent");
  return { execution, record };
}
function view(progress: Checkpoint) {
  return {
    step: progress.step,
    phase: progress.phase,
    prompt: progress.prompt,
    response: progress.phase === "ready" ? null : progress.responses.at(-1),
  };
}
async function fence(
  run: string,
  record: string,
  generation: number,
  progress: Checkpoint,
) {
  const state = {
    ready: "dispatch",
    responded: "replay",
    done: "succeeded",
    exhausted: "exhausted",
  } as const;
  await scopedExecution.checkpoint(run, {
    record,
    generation,
    step: progress.step,
    state: state[progress.phase],
    result: progress.result,
  });
}
export const progress = query({
  args: { run: v.string() },
  handler: async (ctx, { run }) => {
    const { record } = await current(ctx, run);
    return record
      ? view(record.checkpoint)
      : { step: 0, phase: "ready", prompt: null, response: null };
  },
});
export const initialize = mutation({
  args: { run: v.string(), prompt: v.string() },
  handler: async (ctx, { run, prompt }) => {
    const { execution, record } = await current(ctx, run);
    if (record) {
      if (record.checkpoint.prompt !== prompt)
        throw new Error("Agent checkpoint changed");
      return view(record.checkpoint);
    }
    const checkpoint = initializeCheckpoint(prompt, execution.maxAdvances);
    const id = await ctx.db.insert("agentRuns", {
      run,
      contract: execution.contract,
      session: execution.session,
      maxSteps: execution.maxAdvances,
      generation: 0,
      checkpoint,
    });
    await fence(run, id, 0, checkpoint);
    return view(checkpoint);
  },
});
export const response = mutation({
  args: { run: v.string(), step: v.number(), response: v.string() },
  handler: async (ctx, args) => {
    const { record } = await current(ctx, args.run);
    if (!record) throw new Error("Agent checkpoint is absent");
    const checkpoint = retainResponse(
      record.checkpoint,
      args.step,
      args.response,
      record.maxSteps,
    );
    const generation =
      record.generation + (checkpoint === record.checkpoint ? 0 : 1);
    await ctx.db.patch("agentRuns", record._id, { checkpoint, generation });
    await fence(args.run, record._id, generation, checkpoint);
    return view(checkpoint);
  },
});
export const advance = mutation({
  args: {
    run: v.string(),
    step: v.number(),
    prompt: v.string(),
    result: v.union(v.object({ value: v.any() }), v.null()),
  },
  handler: async (ctx, args) => {
    const { record } = await current(ctx, args.run);
    if (!record) throw new Error("Agent checkpoint is absent");
    const checkpoint = advanceCheckpoint(
      record.checkpoint,
      args.step,
      args.prompt,
      record.maxSteps,
      args.result,
    );
    const generation =
      record.generation + (checkpoint === record.checkpoint ? 0 : 1);
    await ctx.db.patch("agentRuns", record._id, { checkpoint, generation });
    await fence(args.run, record._id, generation, checkpoint);
    return view(checkpoint);
  },
});
