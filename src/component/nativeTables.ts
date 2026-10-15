/** Private governed-run state; conversation tables retain inherited meanings. */
import { defineTable } from "bijection/server";
import { v } from "bijection/values";
export const checkpoint = v.object({
  step: v.number(),
  phase: v.union(
    v.literal("ready"),
    v.literal("responded"),
    v.literal("done"),
    v.literal("exhausted"),
  ),
  prompt: v.string(),
  responses: v.array(v.string()),
  result: v.union(v.string(), v.null()),
});
export const nativeTables = {
  agentRuns: defineTable({
    run: v.string(),
    contract: v.string(),
    session: v.string(),
    maxSteps: v.number(),
    generation: v.number(),
    checkpoint,
  })
    .index("by_run", ["run"])
    .retain({ by: "run" }),
};
