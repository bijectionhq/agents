"use client";
import { useMutation, useQuery } from "bijection/react";
import { useRef } from "react";
import type { FunctionReference } from "bijection/server";
import type { VerificationProgress } from "../verification/lifecycle.js";
import type { VerificationAdmission } from "../verification/boundary.js";

export type VerificationView = VerificationProgress & {
  admission: VerificationAdmission | null;
  expiredAt: number | null;
};
export type VerificationApi = {
  current: FunctionReference<
    "query",
    "public",
    { check: string; conversationId: string },
    {
      request: { requestId: string; progress: VerificationView } | null;
      questions: Record<string, string>;
    }
  >;
  begin: FunctionReference<
    "mutation",
    "public",
    { check: string; conversationId: string; requestKey: string },
    string
  >;
  submit: FunctionReference<
    "mutation",
    "public",
    {
      check: string;
      conversationId: string;
      requestId: string;
      attemptKey: string;
      answers: Record<string, string>;
    },
    VerificationView
  >;
  resume: FunctionReference<
    "mutation",
    "public",
    { check: string; conversationId: string; requestId: string },
    VerificationView
  >;
  cancel: FunctionReference<
    "mutation",
    "public",
    { check: string; conversationId: string; requestId: string },
    null
  >;
};

/** Reactive server-owned progress survives refresh and reconnect.
 * Answers go only to the installed check; they never become chat messages. */
// concave:invariant verification-client-scope
// Answers and progress remain with the installed verification API; the hook issues no authority.
export function useVerification(
  api: VerificationApi,
  interaction: { check: string; conversationId: string },
) {
  const current = useQuery(api.current, interaction);
  const begin = useMutation(api.begin);
  const submit = useMutation(api.submit);
  const cancel = useMutation(api.cancel);
  const resume = useMutation(api.resume);
  const pending = useRef<{
    identity: string;
    key: string;
    promise?: Promise<VerificationView>;
  } | null>(null);
  return {
    loading: current === undefined,
    questions: current?.questions ?? {},
    progress: current?.request?.progress ?? null,
    start: () => begin({ ...interaction, requestKey: crypto.randomUUID() }),
    submit: async (answers: Record<string, string>) => {
      if (!current?.request)
        throw new Error("Start verification before submitting answers");
      const identity = JSON.stringify([
        interaction.check,
        interaction.conversationId,
        current.request.requestId,
        Object.entries(answers).sort(([a], [b]) => a.localeCompare(b)),
      ]);
      // A lost reply must retry the original attempt, rather than debit the
      // budget again. The envelope stays in memory and never enters chat.
      if (pending.current?.identity !== identity)
        pending.current = { identity, key: crypto.randomUUID() };
      const attempt = pending.current;
      if (attempt.promise) return attempt.promise;
      const promise = submit({
        ...interaction,
        requestId: current.request.requestId,
        attemptKey: attempt.key,
        answers: { ...answers },
      });
      attempt.promise = promise;
      try {
        const progress = await promise;
        if (pending.current === attempt) pending.current = null;
        return progress;
      } finally {
        attempt.promise = undefined;
      }
    },
    resume: () => {
      if (!current?.request)
        throw new Error("No verification request to resume");
      return resume({ ...interaction, requestId: current.request.requestId });
    },
    cancel: () => {
      if (!current?.request)
        throw new Error("No verification request to cancel");
      return cancel({ ...interaction, requestId: current.request.requestId });
    },
  };
}
