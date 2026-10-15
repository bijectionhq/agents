/** Governed proposals are private component custody. Ordinary operation
 * review still owns acceptance and the nested business commit. */
import {
  defineTable,
  expose,
  registerSchemaTableNames,
} from "bijection/server";
import { v } from "bijection/values";
export const proposalTable = expose(
  defineTable({
    originalId: v.optional(v.string()),
    module: v.string(),
    run: v.string(),
    call: v.string(),
    requestKey: v.string(),
    agent: v.string(),
    for: v.string(),
    session: v.string(),
    tool: v.string(),
    operation: v.string(),
    contract: v.string(),
    arguments: v.record(v.string(), v.any()),
    reason: v.string(),
    state: v.union(
      v.literal("pending"),
      v.literal("submitted"),
      v.literal("rejected"),
    ),
    proposed_at: v.number(),
    decided_by: v.union(v.string(), v.null()),
    decided_at: v.union(v.commitTs(), v.null()),
  })
    .index("by_for", ["for", "proposed_at"])
    .index("by_run_call", ["run", "call"])
    .index("by_original", ["module", "originalId"])
    .retain({ by: "for" }),
  { label: "Agent proposal" },
);
registerSchemaTableNames({ agentProposals: proposalTable });
export const proposalTables = {
  agentProposals: proposalTable,
  agentConfigurations: defineTable({
    module: v.string(),
    declaration: v.string(),
    agents: v.array(v.string()),
    resolve: v.union(v.string(), v.null()),
    submit: v.union(v.string(), v.null()),
  }).index("by_module", ["module"]),
};
