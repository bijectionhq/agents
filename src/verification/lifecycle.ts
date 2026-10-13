/** Pure request transitions; transactions persist their decisions together. */
import type { ContextCheckResult, VerificationResource } from "./definition.js";

export type VerificationState =
  | "collecting"
  | "waiting"
  | "succeeded"
  | "refused"
  | "expired"
  | "cancelled";
export type VerificationProgress = {
  state: VerificationState;
  attemptsUsed: number;
  maxAttempts: number;
  expiresAt: number;
  outcome: VerificationResource | null;
  completedAt: number | null;
};

export function currentProgress<T extends VerificationProgress>(
  request: T,
  now: number,
): T {
  if (
    !["collecting", "waiting"].includes(request.state) ||
    now < request.expiresAt
  )
    return request;
  return { ...request, state: "expired", completedAt: request.expiresAt };
}

export function submitCheck<T extends VerificationProgress>(
  request: T,
  outcome: ContextCheckResult,
  now: number,
): T {
  const current = currentProgress(request, now);
  if (current.state !== "collecting")
    throw new Error("Verification request is not collecting answers");
  const attemptsUsed = current.attemptsUsed + 1;
  if (attemptsUsed > current.maxAttempts)
    throw new Error("Verification attempt budget exhausted");
  if (outcome.kind === "matched")
    return {
      ...current,
      attemptsUsed,
      state: "succeeded",
      outcome: outcome.resource,
      completedAt: now,
    };
  const exhausted = attemptsUsed === current.maxAttempts;
  return {
    ...current,
    attemptsUsed,
    state: exhausted ? "refused" : "collecting",
    completedAt: exhausted ? now : null,
  };
}
