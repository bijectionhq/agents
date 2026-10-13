/** Closed application handlers retain the actual caller across component calls.
 * The component owns request state, while application queries own matching and
 * the existing session owner alone establishes the admitted authority. */
import { functionBundle, programIdentity } from "bijection/components";
import {
  mutationGeneric,
  queryGeneric,
  makeFunctionReference,
  type GenericMutationCtx,
  type GenericQueryCtx,
} from "bijection/server";
import { v } from "bijection/values";
import { verificationContract } from "bijection/tools";
import type { ComponentApi } from "../component/_generated/component.js";
import type { Id } from "../component/_generated/dataModel.js";
import {
  checkOutcome,
  verificationAnswers,
  verificationIdentity,
  verificationInputDigest,
  type VerificationDeclaration,
  type VerificationResource,
} from "./definition.js";
import { verificationView } from "../component/verificationTables.js";

type QueryCtx = GenericQueryCtx<any>;
export type VerificationInteraction = {
  participantId: string;
  audienceRevision: number;
};
export type VerificationAdmission =
  | { kind: "admitted"; reference: string }
  | { kind: "refused"; reference: null };
export type VerificationModuleOptions = {
  component: ComponentApi;
  checks: Readonly<Record<string, VerificationDeclaration>>;
  /** Check ownership/channel admission through the application's current policy. */
  authorize: (
    ctx: QueryCtx,
    conversationId: string,
  ) => Promise<VerificationInteraction>;
  /** Application-owned composition with existing native session/run admission.
   * No public argument can select this handler, its service or its role. */
  admit?: (
    ctx: GenericMutationCtx<any>,
    request: {
      requestId: string;
      conversationId: string;
      resource: VerificationResource;
      expiresAt: number;
    },
  ) => Promise<VerificationAdmission>;
};

/** Install one bounded verification API at the application root. */
export function verificationModule(options: VerificationModuleOptions) {
  if (
    !options.component ||
    typeof options.authorize !== "function" ||
    !options.checks ||
    Object.keys(options.checks).length < 1 ||
    Object.keys(options.checks).length > 16
  )
    throw new Error(
      "Install 1 to 16 verification checks with an authorization boundary",
    );
  const checks = Object.freeze({ ...options.checks });
  const declaration = (name: string) => {
    if (!Object.hasOwn(checks, name))
      throw new Error("Verification check unavailable");
    return checks[name]!;
  };
  async function binding(ctx: QueryCtx, conversationId: string) {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Verification requires an admitted caller");
    const interaction = await options.authorize(ctx, conversationId);
    return { actor: identity.tokenIdentifier, conversationId, ...interaction };
  }
  async function identityOf(definition: VerificationDeclaration) {
    const contract = verificationContract(definition.check);
    if (contract.kind !== "check")
      throw new Error("Verification requires analyzed contracts");
    return programIdentity({
      path: contract.path,
      args: contract.link.args,
      returns: contract.link.returns,
      digest: contract.link.digest,
    });
  }
  const requestArgs = {
    check: v.string(),
    conversationId: v.string(),
    requestId: v.string(),
  };
  const resolve = async (
    ctx: QueryCtx,
    args: { check: string; conversationId: string; requestId: string },
  ) => {
    const definition = declaration(args.check);
    return {
      definition,
      owned: {
        ...(await binding(ctx, args.conversationId)),
        requestId: args.requestId as Id<"verificationRequests">,
        definition: verificationIdentity(definition),
        programIdentity: await identityOf(definition),
      },
    };
  };
  return functionBundle({
    begin: mutationGeneric({
      args: {
        check: v.string(),
        conversationId: v.string(),
        requestKey: v.string(),
      },
      returns: v.string(),
      handler: async (ctx, args) => {
        const definition = declaration(args.check);
        const contract = verificationContract(definition.check);
        if (contract.kind !== "check")
          throw new Error("Verification requires analyzed contracts");
        return ctx.runMutation(options.component.verification.begin, {
          ...(await binding(ctx, args.conversationId)),
          requestKey: args.requestKey,
          definition: verificationIdentity(definition),
          programIdentity: await identityOf(definition),
          checkPath: contract.path,
          attempts: definition.limits.attempts,
          durationMs: definition.limits.durationMs,
        });
      },
    }),
    current: queryGeneric({
      args: { check: v.string(), conversationId: v.string() },
      returns: v.object({
        request: v.union(
          v.null(),
          v.object({ requestId: v.string(), progress: verificationView }),
        ),
        questions: v.record(v.string(), v.string()),
      }),
      handler: async (ctx, args) => {
        const definition = declaration(args.check);
        const contract = verificationContract(definition.check);
        if (contract.kind !== "check")
          throw new Error("Verification requires analyzed contracts");
        return {
          request: await ctx.runQuery(options.component.verification.current, {
            ...(await binding(ctx, args.conversationId)),
            checkPath: contract.path,
            definition: verificationIdentity(definition),
            programIdentity: await identityOf(definition),
          }),
          questions: definition.questions,
        };
      },
    }),
    inspect: queryGeneric({
      args: requestArgs,
      returns: v.object({
        progress: verificationView,
        questions: v.record(v.string(), v.string()),
      }),
      handler: async (ctx, args) => {
        const { definition, owned } = await resolve(ctx, args);
        return {
          progress: await ctx.runQuery(
            options.component.verification.inspect,
            owned,
          ),
          questions: definition.questions,
        };
      },
    }),
    submit: mutationGeneric({
      args: {
        ...requestArgs,
        attemptKey: v.string(),
        answers: v.record(v.string(), v.string()),
      },
      returns: verificationView,
      handler: async (ctx, args) => {
        const { definition, owned } = await resolve(ctx, args);
        const input = verificationAnswers(definition, args.answers);
        const contract = verificationContract(definition.check);
        if (contract.kind !== "check")
          throw new Error("Verification requires analyzed contracts");
        if (
          contract.args.type !== "object" ||
          Object.entries(contract.args.value).some(
            ([name, field]) => !field.optional && !Object.hasOwn(input, name),
          )
        )
          throw new Error("Verification needs all required answers");
        const inputDigest = await verificationInputDigest(
          args.requestId,
          input,
        );
        const previous = await ctx.runQuery(
          options.component.verification.attempt,
          { ...owned, key: args.attemptKey, inputDigest },
        );
        if (previous)
          return ctx.runQuery(options.component.verification.inspect, owned);
        const before = await ctx.runQuery(
          options.component.verification.inspect,
          owned,
        );
        if (
          before.state !== "collecting" ||
          Date.now() >= before.expiresAt ||
          before.attemptsUsed >= before.maxAttempts
        )
          throw new Error("Verification request ended");
        const outcome = checkOutcome(
          await ctx.runQuery(
            makeFunctionReference<"query">(contract.path),
            input,
          ),
        );
        await ctx.runMutation(options.component.verification.complete, {
          ...owned,
          key: args.attemptKey,
          inputDigest,
          outcome,
        });
        return ctx.runQuery(options.component.verification.inspect, owned);
      },
    }),
    // The match is already committed. Current admission and its recorded
    // outcome commit together under the actual caller in this transaction.
    resume: mutationGeneric({
      args: requestArgs,
      returns: verificationView,
      handler: async (ctx, args) => {
        const { owned } = await resolve(ctx, args);
        const before = await ctx.runQuery(
          options.component.verification.inspect,
          owned,
        );
        if (
          before.state !== "succeeded" ||
          !before.outcome ||
          Date.now() >= before.expiresAt
        )
          throw new Error("Verification cannot admit access");
        if (before.admission?.kind === "admitted") return before;
        if (!options.admit)
          throw new Error("No application admission handler installed");
        const admission = await options.admit(ctx, {
          requestId: args.requestId,
          conversationId: args.conversationId,
          resource: before.outcome,
          expiresAt: before.expiresAt,
        });
        await ctx.runMutation(options.component.verification.recordAdmission, {
          ...owned,
          admission,
        });
        return ctx.runQuery(options.component.verification.inspect, owned);
      },
    }),
    cancel: mutationGeneric({
      args: requestArgs,
      returns: v.null(),
      handler: async (ctx, args) => {
        const { owned } = await resolve(ctx, args);
        return ctx.runMutation(options.component.verification.cancel, owned);
      },
    }),
  });
}
