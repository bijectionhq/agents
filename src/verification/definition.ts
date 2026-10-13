/** Application checks composed with a bounded conversational workflow. */
import { canonical } from "bijection/components";
import {
  verificationContract,
  type CheckContractReference,
} from "bijection/tools";
import { bijectionToJson, jsonToBijection, type Value } from "bijection/values";

export type VerificationResource = Readonly<{ type: string; key: string }>;
export type ContextCheckResult =
  | { kind: "matched"; resource: VerificationResource }
  | { kind: "unmatched" };

export type VerificationDefinition<
  Args extends Record<string, Value> = Record<string, Value>,
> = {
  check: CheckContractReference<Args, ContextCheckResult>;
  bind?: Partial<Args>;
  questions: Partial<Record<keyof Args & string, string>>;
  limits?: { attempts?: number; durationMs?: number };
};

export type VerificationDeclaration = Readonly<{
  check: CheckContractReference;
  bind: Readonly<Record<string, Value>>;
  questions: Readonly<Record<string, string>>;
  limits: Readonly<{ attempts: number; durationMs: number }>;
}>;

const MAX_INPUT_BYTES = 16 * 1024;
const fieldName = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** Questions add presentation to the query's existing validators, not a schema. */
export function defineVerification<Args extends Record<string, Value>>(
  options: VerificationDefinition<Args>,
): VerificationDeclaration {
  if (
    !options ||
    Object.keys(options).some(
      (key) => !["check", "bind", "questions", "limits"].includes(key),
    )
  )
    throw new Error("Verification declares check, bind, questions and limits");
  const contract = verificationContract(options.check);
  const bind = jsonToBijection(bijectionToJson(options.bind ?? {})) as Record<
    string,
    Value
  >;
  const questions = { ...options.questions } as Record<string, string>;
  const attempts = options.limits?.attempts ?? 3;
  const durationMs = options.limits?.durationMs ?? 5 * 60_000;
  if (
    options.limits &&
    Object.keys(options.limits).some(
      (key) => !["attempts", "durationMs"].includes(key),
    )
  )
    throw new Error("Verification limits declare attempts and durationMs");
  if (
    !Number.isSafeInteger(attempts) ||
    attempts < 1 ||
    attempts > 10 ||
    !Number.isSafeInteger(durationMs) ||
    durationMs < 1_000 ||
    durationMs > 30 * 60_000
  )
    throw new Error(
      "Verification admits 1 to 10 attempts and 1 second to 30 minutes",
    );
  if (Object.keys(questions).length > 16 || Object.keys(bind).length > 16)
    throw new Error("Verification collects or binds at most 16 inputs");
  for (const [name, question] of Object.entries(questions)) {
    if (
      !fieldName.test(name) ||
      Object.hasOwn(bind, name) ||
      typeof question !== "string" ||
      !question.trim() ||
      question.length > 240
    )
      throw new Error(
        `Verification question ${name} is invalid or already bound`,
      );
    questions[name] = question.trim();
  }
  if (new TextEncoder().encode(canonical(bind)).byteLength > MAX_INPUT_BYTES)
    throw new Error("Verification bound inputs exceed 16 KiB");
  if (contract.kind === "check") {
    if (contract.args.type !== "object")
      throw new Error("Verification arguments must be an object");
    for (const [name, field] of Object.entries(contract.args.value)) {
      if (
        !field.optional &&
        !Object.hasOwn(bind, name) &&
        !Object.hasOwn(questions, name)
      )
        throw new Error(
          `Verification required input ${name} has no question or binding`,
        );
      if (
        Object.hasOwn(questions, name) &&
        !["string", "id"].includes(field.fieldType.type)
      )
        throw new Error(
          `Verification question ${name} must collect text or an identifier`,
        );
    }
    for (const name of [...Object.keys(bind), ...Object.keys(questions)])
      if (!Object.hasOwn(contract.args.value, name))
        throw new Error(
          `Verification input ${name} is absent from the check contract`,
        );
    const actual = contract.returns;
    if (
      actual.type !== "union" ||
      actual.value.length !== 2 ||
      new Set(
        actual.value.map((member) =>
          member.type === "object" &&
          member.value.kind?.fieldType.type === "literal"
            ? member.value.kind.fieldType.value
            : null,
        ),
      ).size !== 2 ||
      !actual.value.every(
        (member) =>
          member.type === "object" &&
          member.value.kind?.optional === false &&
          member.value.kind.fieldType.type === "literal" &&
          (member.value.kind.fieldType.value === "matched"
            ? Object.keys(member.value).sort().join(",") === "kind,resource" &&
              member.value.resource?.optional === false &&
              member.value.resource.fieldType.type === "object" &&
              Object.keys(member.value.resource.fieldType.value)
                .sort()
                .join(",") === "key,type" &&
              member.value.resource.fieldType.value.type?.optional === false &&
              member.value.resource.fieldType.value.key?.optional === false &&
              member.value.resource.fieldType.value.type.fieldType.type ===
                "literal" &&
              typeof member.value.resource.fieldType.value.type.fieldType
                .value === "string" &&
              ["string", "id"].includes(
                member.value.resource.fieldType.value.key?.fieldType.type,
              )
            : member.value.kind.fieldType.value === "unmatched" &&
              Object.keys(member.value).length === 1),
      )
    )
      throw new Error(
        "Verification returns matched with one typed resource, or unmatched",
      );
  }
  return Object.freeze({
    check: options.check,
    bind: Object.freeze(bind),
    questions: Object.freeze(questions),
    limits: Object.freeze({ attempts, durationMs }),
  });
}

/** Exact declaration identity retained by the component, not runtime attestation. */
export function verificationIdentity(
  definition: VerificationDeclaration,
): string {
  const contract = verificationContract(definition.check);
  if (contract.kind !== "check")
    throw new Error(
      "Verification requires analyzed contracts before execution",
    );
  return canonical({
    path: contract.path,
    link: contract.link,
    bind: definition.bind,
    questions: definition.questions,
    limits: definition.limits,
  });
}

export function verificationAnswers(
  definition: VerificationDeclaration,
  answers: Record<string, unknown>,
): Record<string, Value> {
  if (
    !answers ||
    typeof answers !== "object" ||
    Array.isArray(answers) ||
    Object.keys(answers).some(
      (name) => !Object.hasOwn(definition.questions, name),
    )
  )
    throw new Error("Verification answers contain an unknown or bound input");
  if (
    Object.values(answers).some(
      (value) => typeof value !== "string" || value.length > 1024,
    ) ||
    new TextEncoder().encode(canonical(answers as Record<string, Value>))
      .byteLength > MAX_INPUT_BYTES
  )
    throw new Error("Verification answers must be bounded text");
  return { ...definition.bind, ...answers } as Record<string, Value>;
}

export function checkOutcome(value: unknown): ContextCheckResult {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid verification outcome");
  const result = value as Record<string, unknown>;
  if (result.kind === "unmatched" && Object.keys(result).length === 1)
    return { kind: "unmatched" };
  if (
    result.kind !== "matched" ||
    Object.keys(result).sort().join(",") !== "kind,resource" ||
    !result.resource ||
    typeof result.resource !== "object" ||
    Array.isArray(result.resource)
  )
    throw new Error("Invalid verification outcome");
  const resource = result.resource as Record<string, unknown>;
  if (
    Object.keys(resource).sort().join(",") !== "key,type" ||
    typeof resource.type !== "string" ||
    !fieldName.test(resource.type) ||
    typeof resource.key !== "string" ||
    !resource.key ||
    resource.key.length > 256
  )
    throw new Error("Invalid verification resource");
  return {
    kind: "matched",
    resource: { type: resource.type, key: resource.key },
  };
}

/** Retain replay identity without retaining the submitted answers. */
export async function verificationInputDigest(
  requestId: string,
  input: Record<string, Value>,
): Promise<string> {
  const bytes = new TextEncoder().encode(
    "bijection.verification_input.v1\n" + canonical({ requestId, input }),
  );
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
