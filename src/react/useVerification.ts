"use client";
import { useMutation, useQuery } from "bijection/react";
import { useRef } from "react";
import type { FunctionReference } from "bijection/server";
import type { VerificationState } from "bijection/sessions";

export type VerificationView = {
  state: VerificationState;
  attemptsUsed: number;
  maxAttempts: number;
  expiresAt: number;
  establishes: string;
  completedAt: number | null;
  expiredAt: number | null;
};
type Selection = { verification: string; conversationId: string };
type Request = Selection & { requestId: string };
export type VerificationApi = {
  current: FunctionReference<
    "query",
    "public",
    Selection,
    {
      request: { requestId: string; progress: VerificationView } | null;
      questions: Record<string, string>;
    }
  >;
  begin: FunctionReference<
    "mutation",
    "public",
    Selection & { requestKey: string },
    string
  >;
  submit: FunctionReference<
    "mutation",
    "public",
    Request & { attemptKey: string; answers: Record<string, string> },
    VerificationView
  >;
  cancel: FunctionReference<"mutation", "public", Request, null>;
};

/** Reactive server-owned progress survives refresh and reconnect.
 * Answers go only to the installed interaction; they never become chat
 * messages. */
// concave:invariant verification-client-scope
// Answers and progress remain with the installed interaction API; the hook issues no authority.
export function useVerification(api: VerificationApi, selection: Selection) {
  const current = useQuery(api.current, selection);
  const begin = useMutation(api.begin);
  const submit = useMutation(api.submit);
  const cancel = useMutation(api.cancel);
  const pending = useRef<{
    identity: string;
    key: string;
    promise?: Promise<VerificationView>;
  } | null>(null);
  return {
    loading: current === undefined,
    questions: current?.questions ?? {},
    progress: current?.request?.progress ?? null,
    start: () => begin({ ...selection, requestKey: crypto.randomUUID() }),
    submit: async (answers: Record<string, string>) => {
      if (!current?.request)
        throw new Error("Start verification before submitting answers");
      const identity = JSON.stringify([
        selection.verification,
        selection.conversationId,
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
        ...selection,
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
    cancel: () => {
      if (!current?.request)
        throw new Error("No verification request to cancel");
      return cancel({ ...selection, requestId: current.request.requestId });
    },
  };
}
