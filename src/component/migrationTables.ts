/** Source receipts remain under their native owners; these are private copies
 * and migration progress, retained by the original run or declaration. */
import { defineTable } from "bijection/server";
import { v } from "bijection/values";
export const migrationTables = {
  agentRunArchives: defineTable({
    run: v.string(),
    agent: v.string(),
    module: v.string(),
    principal: v.string(),
    session: v.string(),
    contract: v.string(),
    maxAdvances: v.number(),
    body: v.string(),
  })
    .index("by_run", ["run"])
    .index("by_principal", ["principal"])
    .retain({ by: "run" }),
  agentMigrations: defineTable({
    module: v.string(),
    agents: v.array(v.string()),
    legacy: v.string(),
    phase: v.union(
      v.literal("runs"),
      v.literal("proposals"),
      v.literal("done"),
    ),
    cursor: v.union(v.string(), v.null()),
  })
    .index("by_module", ["module"])
    .retain({ by: "_id" }),
};
