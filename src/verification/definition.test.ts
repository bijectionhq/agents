import { describe, expect, it } from "vitest";
import {
  linkedToolContracts,
  symbolicToolContracts,
  tool,
} from "bijection/tools";
import {
  defineVerification,
  verificationAnswers,
  verificationIdentity,
  verificationInputDigest,
  checkOutcome,
} from "./definition.js";

const args = JSON.stringify({
  type: "object",
  value: {
    organizationId: {
      fieldType: { type: "id", tableName: "organizations" },
      optional: false,
    },
    projectCode: { fieldType: { type: "string" }, optional: false },
  },
});
const returns = JSON.stringify({
  type: "union",
  value: [
    {
      type: "object",
      value: {
        kind: {
          fieldType: { type: "literal", value: "matched" },
          optional: false,
        },
        resource: {
          fieldType: {
            type: "object",
            value: {
              type: {
                fieldType: { type: "literal", value: "project" },
                optional: false,
              },
              key: {
                fieldType: { type: "id", tableName: "projects" },
                optional: false,
              },
            },
          },
          optional: false,
        },
      },
    },
    {
      type: "object",
      value: {
        kind: {
          fieldType: { type: "literal", value: "unmatched" },
          optional: false,
        },
      },
    },
  ],
});
const contracts = linkedToolContracts({
  "checks.js:project": { kind: "check", args, returns, digest: "a".repeat(64) },
});
const options = {
  check: contracts.checks.project,
  bind: { organizationId: "org" },
  questions: { projectCode: "Project ID?" },
};

describe("verification declaration", () => {
  it("uses private analyzed contracts and refuses them as model tools", () => {
    const declaration = defineVerification(options);
    expect(verificationAnswers(declaration, { projectCode: "P-42" })).toEqual({
      organizationId: "org",
      projectCode: "P-42",
    });
    expect(() => tool.query(contracts.checks.project, "Bypass")).toThrow();
    expect(() =>
      verificationAnswers(declaration, { organizationId: "another" }),
    ).toThrow();
    expect(Object.isFrozen(declaration.questions)).toBe(true);
  });
  it("refuses missing inputs, unknown questions and symbolic execution", () => {
    expect(() => defineVerification({ ...options, questions: {} })).toThrow(
      /required input/,
    );
    expect(() =>
      defineVerification({ ...options, questions: { missing: "?" } }),
    ).toThrow();
    const symbolic = defineVerification({
      ...options,
      check: symbolicToolContracts().checks.project,
    });
    expect(() => verificationIdentity(symbolic)).toThrow(/analyzed/);
  });
  it("requires distinct exhaustive verdicts and required resource fields", () => {
    const validator = JSON.parse(returns);
    const duplicated = linkedToolContracts({
      "checks.js:project": {
        kind: "check",
        args,
        returns: JSON.stringify({
          ...validator,
          value: [validator.value[0], validator.value[0]],
        }),
        digest: "b".repeat(64),
      },
    });
    expect(() =>
      defineVerification({ ...options, check: duplicated.checks.project }),
    ).toThrow(/returns/);
    validator.value[0].value.resource.optional = true;
    const optional = linkedToolContracts({
      "checks.js:project": {
        kind: "check",
        args,
        returns: JSON.stringify(validator),
        digest: "c".repeat(64),
      },
    });
    expect(() =>
      defineVerification({ ...options, check: optional.checks.project }),
    ).toThrow(/returns/);
  });
  it("changes retained identity when scope, questions or limits change", () => {
    const first = verificationIdentity(defineVerification(options));
    expect(
      verificationIdentity(
        defineVerification({ ...options, bind: { organizationId: "other" } }),
      ),
    ).not.toBe(first);
    expect(
      verificationIdentity(
        defineVerification({ ...options, limits: { attempts: 2 } }),
      ),
    ).not.toBe(first);
  });
  it("binds replay digests to their request and never retains submitted text", async () => {
    const input = verificationAnswers(defineVerification(options), { projectCode: "P-42" });
    const first = await verificationInputDigest("first", input);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(await verificationInputDigest("first", input)).toBe(first);
    expect(await verificationInputDigest("second", input)).not.toBe(first);
    expect(await verificationInputDigest("first", { ...input, projectCode: "P-43" })).not.toBe(first);
    expect(() => defineVerification({ ...options, bind: { organizationId: "é".repeat(8192) } })).toThrow(/16 KiB/);
  });
  it("does not accept success flags or a caller identity as a check verdict", () => {
    expect(() => checkOutcome({ verified: true, userId: "owner" })).toThrow();
    expect(() =>
      checkOutcome({
        kind: "matched",
        resource: { type: "project", key: "p", role: "admin" },
      }),
    ).toThrow();
  });
});
