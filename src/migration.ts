/** Transitional custody declarations for applications with pre-component
 * records. Fresh applications use only the installed component. Root records
 * and native receipts remain retained until validated retirement is possible. */
import {
  defineTable,
  expose,
  registerSchemaTableNames,
  type FunctionReference,
} from "bijection/server";
import { v } from "bijection/values";
const table = expose(
  defineTable({
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
    .retain({ by: "for" }),
  { label: "Agent proposal" },
);
export function legacyAgentTables() {
  const tables = { agentProposals: table };
  registerSchemaTableNames(tables);
  return tables;
}
/** Resolve an original identity to its component record under current source
 * access. A missing alias is not permission to recreate or resubmit it. */
export function findMigratedProposal(
  ctx: { runQuery: (...args: any[]) => Promise<any> },
  component: {
    migrations: {
      originalProposal: FunctionReference<
        "query",
        "public",
        { module: string; originalId: string },
        string | null
      >;
    };
  },
  args: { module: string; originalId: string },
): Promise<string | null> {
  return ctx.runQuery(component.migrations.originalProposal, args);
}
