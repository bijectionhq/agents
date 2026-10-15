import { expect, test } from "vitest";
import { archiveProposal, type Proposal } from "./legacy.js";
const original: Proposal = {
  _id: "original-id" as any,
  agent: "triage",
  for: "customer",
  session: "session",
  tool: "refund",
  operation: "desk.js:refund",
  contract: "old-contract",
  arguments: { amount: 9007199254740993n },
  reason: "Damaged",
  state: "pending",
  proposed_at: 1,
  decided_by: null,
  decided_at: null,
};
test("archive retains original proposal and business request identities and native values", () => {
  const copy = archiveProposal("agents", original)!;
  expect(copy).toMatchObject({
    originalId: original._id,
    requestKey: "proposal:original-id",
    contract: "old-contract",
    arguments: original.arguments,
  });
  expect(archiveProposal("agents", original, copy)).toBeNull();
  expect(() =>
    archiveProposal("agents", { ...original, arguments: { amount: 1n } }, copy),
  ).toThrow("meaning changed");
});
test("decision refresh cannot reopen or replace a terminal decision", () => {
  const copy = archiveProposal("agents", original)!;
  const submitted = {
    ...original,
    state: "submitted" as const,
    decided_by: "alice",
    decided_at: 123n,
  };
  const decision = archiveProposal("agents", submitted, copy)!;
  expect(decision).toEqual({
    state: "submitted",
    decided_by: "alice",
    decided_at: 123n,
  });
  const settled = { ...copy, ...decision };
  expect(archiveProposal("agents", original, settled)).toBeNull();
  expect(archiveProposal("agents", submitted, settled)).toBeNull();
  expect(() =>
    archiveProposal("agents", { ...submitted, state: "rejected" }, settled),
  ).toThrow("conflicting decisions");
});
