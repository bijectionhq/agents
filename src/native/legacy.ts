/** Read-only pre-component shape and pure archival comparison. */
import { bijectionToJson, type Value, type GenericId } from "bijection/values";
export type Proposal = {
  _id: GenericId<"agentProposals">;
  agent: string;
  /** The object the run acted for. */
  for: string;
  /** The run's session. */
  session: string;
  tool: string;
  operation: string;
  /** The operation's contract as proposed: submission refuses another. */
  contract: string;
  /** Validated arguments in their exact native types, retained for recovery
   * even when the current tool or schema changes. */
  arguments: Record<string, Value>;
  reason: string;
  state: "pending" | "submitted" | "rejected";
  proposed_at: number;
  decided_by: string | null;
  /** The native commit instant, in nanoseconds since the epoch. */
  decided_at: bigint | null;
};

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, child]) => [key, canonical(child)]),
        )
      : value;
/** Preserve original identities, exact native arguments and decisions. This
 * pure copier grants no authority; component migration proves the source. */
export function archiveProposal(
  module: string,
  source: Proposal,
  previous?: Record<string, any>,
) {
  const { _id: originalId, ...proposal } = source;
  const copy = {
    ...proposal,
    originalId,
    module,
    run: `legacy:${originalId}`,
    call: originalId,
    requestKey: `proposal:${originalId}`,
  };
  const same = (a: unknown, b: unknown) =>
    JSON.stringify(canonical(bijectionToJson(a as Value))) ===
    JSON.stringify(canonical(bijectionToJson(b as Value)));
  if (!previous) return copy;
  for (const key of Object.keys(copy).filter(
    (key) => !["state", "decided_by", "decided_at"].includes(key),
  ))
    if (!same((copy as any)[key], previous[key]))
      throw new Error("Original proposal meaning changed");
  if (
    source.state === "pending" ||
    same(
      [source.state, source.decided_by, source.decided_at],
      [previous.state, previous.decided_by, previous.decided_at],
    )
  )
    return null;
  if (previous.state !== "pending")
    throw new Error("Original proposal has conflicting decisions");
  return {
    state: source.state,
    decided_by: source.decided_by,
    decided_at: source.decided_at,
  };
}
