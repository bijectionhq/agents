/** Reasoning checkpoints belong to the component. Native execution supplies
 * authority and fencing; a retained provider body remains provisional. */
import { bijectionToJson, jsonToBijection } from "bijection/values";
import { encodeValue } from "bijection/tools";
import {
  textBytes,
  validateModelResponse,
  MAX_PROMPT_BYTES,
} from "./response.js";

export type Checkpoint = {
  step: number;
  phase: "ready" | "responded" | "done" | "exhausted";
  prompt: string;
  responses: string[];
  result: string | null;
};
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_RETAINED_RESPONSE_BYTES = 256 * 1024;

function body(text: string, bound: number, array: boolean): unknown {
  if (typeof text !== "string" || textBytes(text) > bound)
    throw new Error("Agent checkpoint byte limit reached");
  const value = JSON.parse(text);
  if (
    array
      ? !Array.isArray(value)
      : value === null || typeof value !== "object" || Array.isArray(value)
  )
    throw new Error("Invalid agent checkpoint body");
  return value;
}
function limit(maxSteps: number) {
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 16)
    throw new Error("Invalid agent step limit");
}
export function initializeCheckpoint(
  prompt: string,
  maxSteps: number,
): Checkpoint {
  limit(maxSteps);
  body(prompt, MAX_PROMPT_BYTES, true);
  return { step: 0, phase: "ready", prompt, responses: [], result: null };
}
export function retainResponse(
  progress: Checkpoint,
  step: number,
  response: string,
  maxSteps: number,
): Checkpoint {
  validateCheckpoint(progress, maxSteps);
  if (step !== progress.step) throw new Error("Agent checkpoint changed");
  if (progress.phase !== "ready") {
    if (progress.responses.at(-1) !== response)
      throw new Error("Agent response changed");
    return progress;
  }
  body(response, MAX_RESPONSE_BYTES, false);
  const next: Checkpoint = {
    ...progress,
    phase: "responded",
    responses: [...progress.responses, response],
  };
  validateCheckpoint(next, maxSteps);
  return next;
}
function calls(progress: Checkpoint) {
  const seen = new Set<string>();
  let last: ReturnType<typeof validateModelResponse<unknown>> | null = null;
  for (const response of progress.responses) {
    last = validateModelResponse(
      JSON.parse(response),
      seen,
      (_name, input) => input,
    );
    for (const { part } of last.calls)
      if (part.toolName !== "complete") seen.add(part.toolCallId);
  }
  return last;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => JSON.stringify(key) + ":" + canonical(item))
        .join(",") +
      "}"
    );
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Invalid agent completion");
  return encoded;
}
function requireCompletion(progress: Checkpoint, result: unknown) {
  const response = calls(progress);
  if (
    response?.calls.length !== 1 ||
    response.calls[0].part.toolName !== "complete"
  )
    throw new Error("Agent completion must be the only tool call");
  if (
    canonical(response.calls[0].prepared) !==
    canonical({ result: encodeValue(result) })
  )
    throw new Error("Agent result differs from retained completion");
}
export function validateCheckpoint(
  progress: Checkpoint,
  maxSteps: number,
): void {
  limit(maxSteps);
  if (
    !Number.isInteger(progress.step) ||
    progress.step < 0 ||
    progress.step >= maxSteps
  )
    throw new Error("Agent step limit reached");
  if (!["ready", "responded", "done", "exhausted"].includes(progress.phase))
    throw new Error("Invalid agent checkpoint");
  body(progress.prompt, MAX_PROMPT_BYTES, true);
  const count = progress.step + (progress.phase === "ready" ? 0 : 1);
  if (progress.responses.length !== count)
    throw new Error("Invalid agent checkpoint");
  if (
    progress.responses.reduce((sum, value) => sum + textBytes(value), 0) >
    MAX_RETAINED_RESPONSE_BYTES
  )
    throw new Error("Agent response retention limit reached");
  for (const response of progress.responses)
    body(response, MAX_RESPONSE_BYTES, false);
  if ((progress.phase === "done") !== (progress.result !== null))
    throw new Error("Agent success requires a typed completion");
  if (progress.phase === "exhausted" && progress.step + 1 !== maxSteps)
    throw new Error("Agent step limit has not been reached");
  if (progress.result !== null) {
    if (textBytes(progress.result) > 32 * 1024)
      throw new Error("Agent result exceeds byte bounds");
    requireCompletion(progress, jsonToBijection(JSON.parse(progress.result)));
  }
}
export function advanceCheckpoint(
  progress: Checkpoint,
  step: number,
  prompt: string,
  maxSteps: number,
  completion: { value: unknown } | null,
): Checkpoint {
  validateCheckpoint(progress, maxSteps);
  if (progress.phase !== "responded" || progress.step !== step)
    throw new Error("Agent checkpoint changed");
  body(prompt, MAX_PROMPT_BYTES, true);
  const response = calls(progress)!;
  if (completion !== null) requireCompletion(progress, completion.value);
  else if (response.calls.some(({ part }) => part.toolName === "complete"))
    throw new Error("Agent completion result is missing");
  const phase =
    completion !== null
      ? "done"
      : step + 1 === maxSteps
        ? "exhausted"
        : "ready";
  const result =
    completion === null
      ? null
      : JSON.stringify(bijectionToJson(completion.value as any));
  if (result !== null && textBytes(result) > 32 * 1024)
    throw new Error("Agent result exceeds byte bounds");
  const next: Checkpoint = {
    ...progress,
    step: phase === "ready" ? step + 1 : step,
    phase,
    prompt,
    result,
  };
  validateCheckpoint(next, maxSteps);
  return next;
}
