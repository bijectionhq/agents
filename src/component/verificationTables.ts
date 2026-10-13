/** Private verification custody; native sessions remain the authority owner. */
import { defineTable } from "bijection/server";
import { v } from "bijection/values";

export const resource = v.object({ type: v.string(), key: v.string() });
export const verificationState = v.union(
  v.literal("collecting"),
  v.literal("waiting"),
  v.literal("succeeded"),
  v.literal("refused"),
  v.literal("expired"),
  v.literal("cancelled"),
);
export const verificationAdmission = v.union(
  v.object({ kind: v.literal("admitted"), reference: v.string() }),
  v.object({ kind: v.literal("refused"), reference: v.null() }),
);
export const admission = v.union(v.null(), verificationAdmission);
export const verificationTables = {
  // Lookup metadata contains no matching inputs or protected outcomes.
  verificationInteractions: defineTable({
    actor: v.string(),
    conversationId: v.string(),
    participantId: v.string(),
    audienceRevision: v.number(),
    checkPath: v.string(),
    requestKey: v.string(),
    definition: v.string(),
    programIdentity: v.string(),
    requestId: v.id("verificationRequests"),
  })
    .index("by_request", ["actor", "conversationId", "requestKey"])
    .index("by_request_id", ["requestId"])
    .index("by_interaction", [
      "actor",
      "conversationId",
      "participantId",
      "audienceRevision",
      "checkPath",
    ]),
  verificationRequests: defineTable({
    attemptsUsed: v.number(),
    maxAttempts: v.number(),
    state: verificationState,
    createdAt: v.number(),
    expiresAt: v.number(),
    completedAt: v.union(v.null(), v.number()),
    expiredAt: v.union(v.null(), v.number()),
    outcome: v.union(v.null(), resource),
    admission,
  }).retain({ by: "_id", keys: "registered" }),
  verificationAttempts: defineTable({
    requestId: v.id("verificationRequests"),
    key: v.string(),
    inputDigest: v.string(),
    kind: v.union(v.literal("matched"), v.literal("unmatched")),
    at: v.number(),
    resource: v.union(v.null(), resource),
  })
    .index("by_request_key", ["requestId", "key"])
    .retain({ by: "requestId", keys: "registered" }),
};

export const verificationView = v.object({
  state: verificationState,
  attemptsUsed: v.number(),
  maxAttempts: v.number(),
  expiresAt: v.number(),
  outcome: v.union(v.null(), resource),
  completedAt: v.union(v.null(), v.number()),
  expiredAt: v.union(v.null(), v.number()),
  admission,
});
