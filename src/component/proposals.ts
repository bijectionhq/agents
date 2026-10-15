/** The component binds proposal identity and custody; application callbacks
 * supply business operation meaning under current native authority. */
import {
  componentConfiguration,
  componentDeclaration,
  defineOperation,
  isPerson,
  PERSON_DECISION_REQUIRED,
  log,
  type FunctionReference,
} from "bijection/server";
import { v, BijectionError, type Value } from "bijection/values";
import {
  query,
  mutation,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server.js";
import type { Doc } from "./_generated/dataModel.js";
import { proposalTable } from "./proposalTables.js";
import { current } from "./native.js";
import { begin } from "./migrations.js";
import { MAX_TOOL_REASON, textBytes } from "../native/response.js";

export const configure = componentConfiguration(
  mutation({
    args: {
      agents: v.array(v.string()),
      resolve: v.union(v.string(), v.null()),
      submit: v.union(v.string(), v.null()),
      legacy: v.union(v.string(), v.null()),
    },
    returns: v.null(),
    handler: async (ctx, args) => {
      const declaration = await componentDeclaration();
      if (
        declaration?.phase !== "activation" ||
        !declaration.declaration.startsWith("/")
      )
        throw new Error("Agents configuration requires native root activation");
      const module = declaration.declaration
        .slice(1)
        .split(":")[0]
        .replace(/\.js$/, "");
      if (
        args.agents.length > 16 ||
        new Set(args.agents).size !== args.agents.length ||
        args.agents.some((name) => !/^[a-z][A-Za-z0-9]{0,31}$/.test(name))
      )
        throw new Error("Invalid agents configuration");
      const old = await ctx.db
        .query("agentConfigurations")
        .withIndex("by_module", (q) => q.eq("module", module))
        .unique();
      if (old && old.declaration !== declaration.declaration)
        throw new Error("This module already has another agents declaration");
      const value = {
        module,
        declaration: declaration.declaration,
        agents: args.agents,
        resolve: args.agents.length ? args.resolve : null,
        submit: args.agents.length ? args.submit : null,
      };
      if (value.agents.length && (!value.resolve || !value.submit))
        throw new Error("Agents configuration requires business callbacks");
      if (old) await ctx.db.patch("agentConfigurations", old._id, value);
      else await ctx.db.insert("agentConfigurations", value);
      if (args.legacy) await begin(ctx, module, args.agents, args.legacy);
      return null;
    },
  }),
);
async function configuration(
  ctx: QueryCtx | MutationCtx,
  module: string,
  agent: string,
) {
  const record = await ctx.db
    .query("agentConfigurations")
    .withIndex("by_module", (q) => q.eq("module", module))
    .unique();
  if (!record?.agents.includes(agent) || !record.resolve || !record.submit)
    throw new Error("This agent is no longer declared");
  return record;
}
export const propose = mutation({
  args: {
    run: v.string(),
    call: v.string(),
    tool: v.string(),
    supplied: v.string(),
    reason: v.string(),
  },
  returns: v.id("agentProposals"),
  handler: async (ctx, args) => {
    const { execution, record } = await current(ctx, args.run);
    if (!record || record.checkpoint.phase !== "responded" || !execution.for)
      throw new Error("A proposal belongs to a retained response");
    const config = await configuration(ctx, execution.module, execution.name);
    const response = JSON.parse(record.checkpoint.responses.at(-1)!);
    const calls = response.content.filter(
      (part: any) => part.type === "tool-call" && part.toolCallId === args.call,
    );
    if (calls.length !== 1 || calls[0].toolName !== args.tool)
      throw new Error("Proposal differs from its retained call");
    const input = JSON.parse(calls[0].input);
    if (
      JSON.stringify(input.arguments) !== args.supplied ||
      input.reason !== args.reason ||
      !args.reason.trim() ||
      textBytes(args.reason) > MAX_TOOL_REASON
    )
      throw new Error("Proposal differs from its retained arguments");
    const old = await ctx.db
      .query("agentProposals")
      .withIndex("by_run_call", (q) =>
        q.eq("run", args.run).eq("call", args.call),
      )
      .unique();
    if (old) return old._id;
    const meaning: {
      operation: string;
      contract: string;
      arguments: Record<string, Value>;
    } = await ctx.runQuery(
      config.resolve as unknown as FunctionReference<"query">,
      {
        agent: execution.name,
        tool: args.tool,
        for: execution.for.key,
        supplied: args.supplied,
      },
    );
    const id = await ctx.db.insert("agentProposals", {
      module: execution.module,
      run: args.run,
      call: args.call,
      requestKey: "",
      agent: execution.name,
      for: execution.for.key,
      session: execution.principal,
      tool: args.tool,
      ...meaning,
      reason: args.reason,
      state: "pending",
      proposed_at: Date.now(),
      decided_by: null,
      decided_at: null,
    });
    await ctx.db.patch("agentProposals", id, { requestKey: `proposal:${id}` });
    await log.audit({
      action: "agent.proposal",
      agent: execution.name,
      session: execution.principal,
      tool: args.tool,
      proposal: id,
    });
    return id;
  },
});
function publicProposal(row: Doc<"agentProposals">) {
  const {
    _id: id,
    _creationTime,
    module: _module,
    run: _run,
    call: _call,
    requestKey: _requestKey,
    contract: _contract,
    ...proposal
  } = row;
  return { id, ...proposal };
}
export const proposals = query({
  args: { for: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("agentProposals")
      .withIndex("by_for", (q) => q.eq("for", args.for))
      .order("desc")
      .take(50);
    return rows.map(publicProposal);
  },
});
async function deciding(ctx: MutationCtx, id: string) {
  const identity = await ctx.auth.getUserIdentity();
  if (!isPerson(identity)) throw new Error(PERSON_DECISION_REQUIRED);
  const normalized = ctx.db.normalizeId("agentProposals", id);
  const row = normalized
    ? await ctx.db.get("agentProposals", normalized)
    : null;
  if (!row) throw new Error("Unknown proposal");
  if (row.state !== "pending")
    throw new Error(`This proposal was already ${row.state}`);
  return { identity: identity!, row };
}
export const submit = defineOperation({
  on: proposalTable,
  target: { argument: "proposal", select: [] },
  review: "required",
  args: { proposal: v.id("agentProposals") },
  returns: v.id("agentProposals"),
  prepare: async (ctx: MutationCtx, args) => {
    const { identity, row } = await deciding(ctx, args.proposal);
    const config = await configuration(ctx, row.module, row.agent);
    const receipt = await ctx.runMutation(
      config.submit as unknown as FunctionReference<"mutation">,
      {
        agent: row.agent,
        tool: row.tool,
        operation: row.operation,
        contract: row.contract,
        arguments: row.arguments,
        requestKey: row.requestKey,
      },
    );
    if (receipt.kind === "refused") throw new BijectionError(receipt.refusal);
    await ctx.db.patch("agentProposals", row._id, {
      state: "submitted",
      decided_by: identity.tokenIdentifier,
      decided_at: ctx.db.vars.commitTs,
    });
    await log.audit({
      action: "agent.submitted",
      agent: row.agent,
      proposal: row._id,
    });
    return row._id;
  },
});
export const reject = mutation({
  args: { proposal: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { identity, row } = await deciding(ctx, args.proposal);
    await ctx.db.patch("agentProposals", row._id, {
      state: "rejected",
      decided_by: identity.tokenIdentifier,
      decided_at: ctx.db.vars.commitTs,
    });
    await log.audit({
      action: "agent.rejected",
      agent: row.agent,
      proposal: row._id,
    });
    return null;
  },
});
