import { afterEach, describe, expect, it, vi } from "vitest";
import { getFunctionName } from "bijection/server";
import { v } from "bijection/values";
import { linkedToolContracts } from "bijection/tools";
import { defineVerification } from "./definition.js";
import { verificationModule } from "./boundary.js";

const contract = linkedToolContracts({
  "checks.js:project": {
    kind: "check",
    args: JSON.stringify(
      v.object({ organizationId: v.string(), projectCode: v.string() }).json,
    ),
    returns: JSON.stringify(
      v.union(
        v.object({
          kind: v.literal("matched"),
          resource: v.object({ type: v.literal("project"), key: v.string() }),
        }),
        v.object({ kind: v.literal("unmatched") }),
      ).json,
    ),
    digest: "a".repeat(64),
  },
}).checks.project;
const definition = defineVerification({
  check: contract,
  bind: { organizationId: "fixed-org" },
  questions: { projectCode: "Project ID?" },
});
const request = {
  check: "project",
  conversationId: "conversation",
  requestId: "request",
};

function boundary() {
  vi.stubGlobal("Convex", {
    asyncSyscall: vi.fn(async (name: string) => {
      if (name !== "1.0/agents/program")
        throw new Error("Unexpected native capability");
      return JSON.stringify("b".repeat(64));
    }),
  });
  const refs = Object.fromEntries(
    [
      "begin",
      "current",
      "inspect",
      "attempt",
      "complete",
      "recordAdmission",
      "cancel",
    ].map((name) => [name, { name }]),
  );
  const authorize = vi.fn(async () => ({
    participantId: "participant",
    audienceRevision: 2,
  }));
  const admit = vi.fn(async () => ({
    kind: "refused" as const,
    reference: null,
  }));
  const progress = {
    state: "collecting",
    attemptsUsed: 0,
    maxAttempts: 3,
    expiresAt: Date.now() + 60_000,
    outcome: null as any,
    completedAt: null as number | null,
    expiredAt: null as number | null,
    admission: null as any,
  };
  let prior: any = null;
  const ctx: any = {
    auth: {
      getUserIdentity: vi.fn(async () => ({
        tokenIdentifier: "actual-caller",
      })),
    },
    runQuery: vi.fn(async (reference: any, input: any) => {
      if (reference === refs.inspect) return { ...progress };
      if (reference === refs.attempt) return prior;
      expect(getFunctionName(reference)).toBe("checks.js:project");
      expect(input).toEqual({
        organizationId: "fixed-org",
        projectCode: "P-42",
      });
      expect(await ctx.auth.getUserIdentity()).toEqual({
        tokenIdentifier: "actual-caller",
      });
      return {
        kind: "matched",
        resource: { type: "project", key: "project-42" },
      };
    }),
    runMutation: vi.fn(async (reference: any, input: any) => {
      expect(input.actor).toBe("actual-caller");
      expect(input.participantId).toBe("participant");
      expect(input.audienceRevision).toBe(2);
      expect(input.programIdentity).toBe("b".repeat(64));
      if (reference === refs.complete)
        Object.assign(progress, {
          state: "succeeded",
          outcome: input.outcome.resource,
          attemptsUsed: 1,
          completedAt: Date.now(),
        });
      if (reference === refs.recordAdmission)
        progress.admission = input.admission;
      return reference === refs.begin ? "request" : null;
    }),
  };
  const api = verificationModule({
    component: { verification: refs } as any,
    checks: { project: definition },
    authorize,
    admit,
  });
  return {
    api,
    ctx,
    authorize,
    admit,
    progress,
    prior: (value: any) => {
      prior = value;
    },
  };
}
afterEach(() => vi.unstubAllGlobals());

describe("verification application boundary", () => {
  it("derives caller and audience before crossing the component boundary", async () => {
    const { api, ctx, authorize } = boundary();
    await api.begin._handler(ctx, {
      check: "project",
      conversationId: "conversation",
      requestKey: "retry",
    });
    expect(authorize).toHaveBeenCalledWith(ctx, "conversation");
    ctx.auth.getUserIdentity.mockResolvedValue(null);
    await expect(
      api.begin._handler(ctx, {
        check: "project",
        conversationId: "conversation",
        requestKey: "another",
      }),
    ).rejects.toThrow(/admitted caller/);
    expect(ctx.runMutation).toHaveBeenCalledTimes(1);
  });
  it("keeps a successful match distinct from current admission", async () => {
    const { api, ctx, admit } = boundary();
    const result = await api.submit._handler(ctx, {
      ...request,
      attemptKey: "attempt",
      answers: { projectCode: "P-42" },
    });
    expect(result.state).toBe("succeeded");
    expect(result.admission).toBe(null);
    expect(admit).not.toHaveBeenCalled();
    expect((await api.resume._handler(ctx, request)).admission).toEqual({
      kind: "refused",
      reference: null,
    });
    expect(admit).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        resource: { type: "project", key: "project-42" },
      }),
    );
    await expect(
      api.submit._handler(ctx, {
        ...request,
        attemptKey: "override",
        answers: { organizationId: "other" },
      }),
    ).rejects.toThrow(/bound input/);
  });
  it("replays an attempt without executing its private check or admission again", async () => {
    const { api, ctx, admit, prior, progress } = boundary();
    Object.assign(progress, {
      state: "succeeded",
      outcome: { type: "project", key: "project-42" },
      attemptsUsed: 1,
    });
    prior({ kind: "matched", resource: progress.outcome });
    const result = await api.submit._handler(ctx, {
      ...request,
      attemptKey: "same",
      answers: { projectCode: "P-42" },
    });
    expect(result.attemptsUsed).toBe(1);
    expect(ctx.runMutation).not.toHaveBeenCalled();
    expect(admit).not.toHaveBeenCalled();
  });
  it("resumes current admission separately and leaves an admitted reference immutable", async () => {
    const { api, ctx, admit, progress } = boundary();
    Object.assign(progress, {
      state: "succeeded",
      outcome: { type: "project", key: "project-42" },
      admission: { kind: "refused", reference: null },
    });
    admit.mockResolvedValueOnce({
      kind: "admitted",
      reference: "native-session",
    } as any);
    expect((await api.resume._handler(ctx, request)).admission).toEqual({
      kind: "admitted",
      reference: "native-session",
    });
    await api.resume._handler(ctx, request);
    expect(admit).toHaveBeenCalledTimes(1);
  });
});
