import { describe, expect, it } from "vitest";
import {
  currentProgress,
  submitCheck,
  type VerificationProgress,
} from "./lifecycle.js";
const request = (): VerificationProgress => ({
  state: "collecting",
  attemptsUsed: 0,
  maxAttempts: 3,
  expiresAt: 100,
  outcome: null,
  completedAt: null,
});
describe("verification transitions", () => {
  it("consumes unmatched answers and ends the final attempt", () => {
    let row = request();
    for (let i = 0; i < 3; i++)
      row = submitCheck(row, { kind: "unmatched" }, 10 + i);
    expect(row.state).toBe("refused");
    expect(row.attemptsUsed).toBe(3);
    expect(() =>
      submitCheck(
        row,
        { kind: "matched", resource: { type: "project", key: "p" } },
        20,
      ),
    ).toThrow();
  });
  it("does not revive an expired request or expire historical success", () => {
    expect(currentProgress(request(), 100).state).toBe("expired");
    expect(() => submitCheck(request(), { kind: "unmatched" }, 100)).toThrow();
    const matched = submitCheck(
      request(),
      { kind: "matched", resource: { type: "project", key: "p" } },
      50,
    );
    expect(currentProgress(matched, 200).state).toBe("succeeded");
    expect(matched.completedAt).toBe(50);
  });
});
