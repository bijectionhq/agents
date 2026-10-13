/** These functions are reached only through the installed application boundary.
 * Component calls carry no user authentication; the boundary supplies the actual
 * admitted actor and interaction, never a client-selected success verdict. */
import { v } from "bijection/values";
import { internal } from "./_generated/api.js";
import {
  mutation,
  query,
  internalMutation,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import {
  resource,
  verificationView,
  verificationAdmission,
} from "./verificationTables.js";
import { submitCheck } from "../verification/lifecycle.js";

const binding = {
  actor: v.string(),
  conversationId: v.string(),
  participantId: v.string(),
  audienceRevision: v.number(),
};
const ownedRequest = {
  ...binding,
  requestId: v.id("verificationRequests"),
  definition: v.string(),
  programIdentity: v.string(),
};
const identifier = (text: string) => text.length > 0 && text.length <= 256;
function validBinding(args: {
  actor: string;
  conversationId: string;
  participantId: string;
  audienceRevision: number;
}) {
  if (
    !args.actor ||
    args.actor.length > 4096 ||
    !identifier(args.conversationId) ||
    !identifier(args.participantId) ||
    !Number.isSafeInteger(args.audienceRevision) ||
    args.audienceRevision < 0
  )
    throw new Error("Invalid verification interaction");
}
async function owned(
  ctx: QueryCtx | MutationCtx,
  args: {
    actor: string;
    conversationId: string;
    participantId: string;
    audienceRevision: number;
    requestId: Id<"verificationRequests">;
    definition: string;
    programIdentity: string;
  },
) {
  validBinding(args);
  const interaction = await ctx.db
    .query("verificationInteractions")
    .withIndex("by_request_id", (q) => q.eq("requestId", args.requestId))
    .unique();
  if (
    !interaction ||
    interaction.actor !== args.actor ||
    interaction.conversationId !== args.conversationId ||
    interaction.participantId !== args.participantId ||
    interaction.audienceRevision !== args.audienceRevision
  )
    throw new Error("Verification request unavailable");
  if (
    interaction.definition !== args.definition ||
    interaction.programIdentity !== args.programIdentity
  )
    throw new Error("Verification definition changed");
  const request = await ctx.db.get("verificationRequests", args.requestId);
  if (!request) throw new Error("Verification request unavailable");
  return request;
}

export const begin = mutation({
  args: {
    ...binding,
    requestKey: v.string(),
    definition: v.string(),
    programIdentity: v.string(),
    checkPath: v.string(),
    attempts: v.number(),
    durationMs: v.number(),
  },
  handler: async (ctx, args) => {
    validBinding(args);
    if (
      !identifier(args.requestKey) ||
      !identifier(args.checkPath) ||
      args.definition.length > 64 * 1024 ||
      !/^[a-f0-9]{64}$/.test(args.programIdentity) ||
      !Number.isSafeInteger(args.attempts) ||
      args.attempts < 1 ||
      args.attempts > 10 ||
      !Number.isSafeInteger(args.durationMs) ||
      args.durationMs < 1000 ||
      args.durationMs > 30 * 60_000
    )
      throw new Error("Invalid verification declaration");
    const previous = await ctx.db
      .query("verificationInteractions")
      .withIndex("by_request", (q) =>
        q
          .eq("actor", args.actor)
          .eq("conversationId", args.conversationId)
          .eq("requestKey", args.requestKey),
      )
      .unique();
    if (previous) {
      if (
        previous.definition !== args.definition ||
        previous.programIdentity !== args.programIdentity ||
        previous.participantId !== args.participantId ||
        previous.audienceRevision !== args.audienceRevision
      )
        throw new Error("Verification request identity changed");
      return previous.requestId;
    }
    // One request owns the interaction's attempt budget, regardless of a
    // client's retry key. Starting another request never replenishes it.
    const existing = await ctx.db
      .query("verificationInteractions")
      .withIndex("by_interaction", (q) =>
        q
          .eq("actor", args.actor)
          .eq("conversationId", args.conversationId)
          .eq("participantId", args.participantId)
          .eq("audienceRevision", args.audienceRevision)
          .eq("checkPath", args.checkPath),
      )
      .unique();
    if (existing) {
      if (
        existing.definition !== args.definition ||
        existing.programIdentity !== args.programIdentity
      )
        throw new Error("Verification interaction definition changed");
      return existing.requestId;
    }
    const now = Date.now();
    const expiresAt = now + args.durationMs;
    const requestId = await ctx.db.insert("verificationRequests", {
      attemptsUsed: 0,
      maxAttempts: args.attempts,
      state: "collecting",
      createdAt: now,
      expiresAt,
      completedAt: null,
      expiredAt: null,
      outcome: null,
      admission: null,
    });
    await ctx.db.insert("verificationInteractions", {
      actor: args.actor,
      conversationId: args.conversationId,
      participantId: args.participantId,
      audienceRevision: args.audienceRevision,
      checkPath: args.checkPath,
      requestKey: args.requestKey,
      definition: args.definition,
      programIdentity: args.programIdentity,
      requestId,
    });
    await ctx.scheduler.runAt(expiresAt, internal.verification.expire, {
      requestId,
      expiresAt,
    });
    return requestId;
  },
  returns: v.id("verificationRequests"),
});

function progress(request: Doc<"verificationRequests">) {
  const state =
    ["collecting", "waiting"].includes(request.state) &&
    request.expiredAt !== null
      ? "expired"
      : request.state;
  return {
    state,
    attemptsUsed: request.attemptsUsed,
    maxAttempts: request.maxAttempts,
    expiresAt: request.expiresAt,
    outcome: request.outcome,
    completedAt:
      request.completedAt ?? (state === "expired" ? request.expiredAt : null),
    expiredAt: request.expiredAt,
    admission: request.admission,
  };
}

export const current = query({
  args: {
    ...binding,
    checkPath: v.string(),
    definition: v.string(),
    programIdentity: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      requestId: v.id("verificationRequests"),
      progress: verificationView,
    }),
  ),
  handler: async (ctx, args) => {
    validBinding(args);
    const interaction = await ctx.db
      .query("verificationInteractions")
      .withIndex("by_interaction", (q) =>
        q
          .eq("actor", args.actor)
          .eq("conversationId", args.conversationId)
          .eq("participantId", args.participantId)
          .eq("audienceRevision", args.audienceRevision)
          .eq("checkPath", args.checkPath),
      )
      .unique();
    if (!interaction) return null;
    if (
      interaction.definition !== args.definition ||
      interaction.programIdentity !== args.programIdentity
    )
      throw new Error("Verification definition changed");
    const request = await owned(ctx, {
      ...args,
      requestId: interaction.requestId,
    });
    return { requestId: request._id, progress: progress(request) };
  },
});

export const inspect = query({
  args: ownedRequest,
  handler: async (ctx, args) => {
    const request = await owned(ctx, args);
    return progress(request);
  },
  returns: verificationView,
});

export const attempt = query({
  args: { ...ownedRequest, key: v.string(), inputDigest: v.string() },
  handler: async (ctx, args) => {
    await owned(ctx, args);
    const previous = await ctx.db
      .query("verificationAttempts")
      .withIndex("by_request_key", (q) =>
        q.eq("requestId", args.requestId).eq("key", args.key),
      )
      .unique();
    if (previous && previous.inputDigest !== args.inputDigest)
      throw new Error("Verification attempt identity changed");
    return previous
      ? { kind: previous.kind, resource: previous.resource }
      : null;
  },
  returns: v.union(
    v.null(),
    v.object({
      kind: v.union(v.literal("matched"), v.literal("unmatched")),
      resource: v.union(v.null(), resource),
    }),
  ),
});

export const complete = mutation({
  args: {
    ...ownedRequest,
    key: v.string(),
    inputDigest: v.string(),
    outcome: v.union(
      v.object({ kind: v.literal("matched"), resource }),
      v.object({ kind: v.literal("unmatched") }),
    ),
  },
  handler: async (ctx, args) => {
    const request = await owned(ctx, args);
    if (!identifier(args.key) || !/^[a-f0-9]{64}$/.test(args.inputDigest))
      throw new Error("Invalid verification attempt");
    const previous = await ctx.db
      .query("verificationAttempts")
      .withIndex("by_request_key", (q) =>
        q.eq("requestId", args.requestId).eq("key", args.key),
      )
      .unique();
    if (previous) {
      if (previous.inputDigest !== args.inputDigest)
        throw new Error("Verification attempt identity changed");
      return null;
    }
    const now = Date.now();
    if (request.state !== "collecting" || now >= request.expiresAt)
      throw new Error("Verification request ended");
    const next = submitCheck(
      {
        state: request.state,
        attemptsUsed: request.attemptsUsed,
        maxAttempts: request.maxAttempts,
        expiresAt: request.expiresAt,
        outcome: request.outcome,
        completedAt: request.completedAt,
        expiredAt: request.expiredAt,
      },
      args.outcome,
      now,
    );
    await ctx.db.insert("verificationAttempts", {
      requestId: request._id,
      key: args.key,
      inputDigest: args.inputDigest,
      kind: args.outcome.kind,
      at: now,
      resource: args.outcome.kind === "matched" ? args.outcome.resource : null,
    });
    await ctx.db.patch("verificationRequests", request._id, {
      state: next.state,
      attemptsUsed: next.attemptsUsed,
      outcome: next.outcome,
      completedAt: next.completedAt,
    });
    return null;
  },
  returns: v.null(),
});

export const recordAdmission = mutation({
  args: {
    ...ownedRequest,
    admission: verificationAdmission,
  },
  handler: async (ctx, args) => {
    const request = await owned(ctx, args);
    if (request.state !== "succeeded" || Date.now() >= request.expiresAt)
      throw new Error("Verification cannot admit access");
    if (
      request.admission?.kind === "admitted" &&
      (request.admission.kind !== args.admission.kind ||
        request.admission.reference !== args.admission.reference)
    )
      throw new Error("Verification admission already recorded");
    if (args.admission.kind === "admitted" && !args.admission.reference)
      throw new Error("Admitted access requires its native reference");
    await ctx.db.patch("verificationRequests", request._id, {
      admission: args.admission,
    });
    return null;
  },
  returns: v.null(),
});

export const cancel = mutation({
  args: ownedRequest,
  handler: async (ctx, args) => {
    const request = await owned(ctx, args);
    if (["collecting", "waiting"].includes(request.state)) {
      await ctx.db.patch("verificationRequests", request._id, {
        state: "cancelled",
        completedAt: Date.now(),
      });
    }
    return null;
  },
  returns: v.null(),
});

/** Deadline work touches only lifecycle metadata. It never reads a matched
 * resource or submitted answers under the scheduler's anonymous identity. */
export const expire = internalMutation({
  args: { requestId: v.id("verificationRequests"), expiresAt: v.number() },
  returns: v.null(),
  handler: async (ctx, { requestId, expiresAt }) => {
    if (!Number.isSafeInteger(expiresAt) || Date.now() < expiresAt)
      throw new Error("Verification deadline has not been reached");
    await ctx.db.patch("verificationRequests", requestId, {
      expiredAt: expiresAt,
    });
    return null;
  },
});
