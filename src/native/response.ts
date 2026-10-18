/** A provider response is provisional until the entire batch is validated.
 * Reasoning parts are tolerated and dropped: only text and function calls
 * enter the run. */
import { bijectionToJson, type Value } from "bijection/values";
export const MAX_TOOL_REASON = 1024;
export const MAX_AGENT_INPUT_BYTES = 16 * 1024;
export const MAX_TOOL_CALLS = 64;
export const MAX_PROMPT_BYTES = 256 * 1024;
export const MAX_TOOL_RESULT_BYTES = 32 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_CALLS_PER_STEP = 16;

export function textBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function jsonBytes(value: unknown): number {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error("Invalid model response");
  return textBytes(json);
}

type TextPart = { type: "text"; text: string };
type CallPart = {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  input: string;
};

export function validateModelResponse<Prepared>(
  response: unknown,
  seen: ReadonlySet<string>,
  prepare: (name: string, input: unknown) => Prepared,
) {
  const invalid = (): never => {
    throw new Error("Invalid model response");
  };
  if (
    !response ||
    typeof response !== "object" ||
    !Object.hasOwn(response, "content")
  )
    return invalid();
  const raw = (response as { content: unknown }).content;
  if (
    !Array.isArray(raw) ||
    raw.length > 64 ||
    jsonBytes(raw) > MAX_RESPONSE_BYTES
  )
    return invalid();
  const content: (TextPart | CallPart)[] = [];
  const calls: { part: CallPart; prepared: Prepared }[] = [];
  const ids = new Set<string>();
  for (const value of raw) {
    if (!value || typeof value !== "object") return invalid();
    if (value.type === "text") {
      if (typeof value.text !== "string") return invalid();
      content.push({ type: "text", text: value.text });
    } else if (value.type === "tool-call") {
      const { toolCallId, toolName, input } = value;
      if (
        typeof toolCallId !== "string" ||
        !toolCallId ||
        toolCallId.length > 128 ||
        seen.has(toolCallId) ||
        ids.has(toolCallId) ||
        typeof toolName !== "string" ||
        typeof input !== "string" ||
        textBytes(input) > MAX_AGENT_INPUT_BYTES ||
        calls.length >= MAX_CALLS_PER_STEP
      )
        return invalid();
      ids.add(toolCallId);
      const part: CallPart = { type: "tool-call", toolCallId, toolName, input };
      let prepared: Prepared;
      try {
        prepared = prepare(toolName, JSON.parse(input));
      } catch {
        return invalid();
      }
      content.push(part);
      calls.push({ part, prepared });
    } else if (value.type !== "reasoning") return invalid();
  }
  if (
    calls.some(({ part }) => part.toolName === "complete") &&
    calls.length !== 1
  )
    throw new Error("Completion must be the only tool call");
  if (
    seen.size +
      calls.filter(({ part }) => part.toolName !== "complete").length >
    MAX_TOOL_CALLS
  )
    throw new Error("Agent tool call limit reached");
  return { content, calls };
}

/** The SDK interprets the model protocol. Native admission binds this bounded
 * batch to its retained raw response and the run's admitted program. */
export function normalizeAgentResponse<Prepared>(
  response: ReturnType<typeof validateModelResponse<Prepared>>,
  completion: Value | undefined,
) {
  return {
    calls: response.calls
      .filter(({ part }) => part.toolName !== "complete")
      .map(({ part }) => part.toolCallId),
    outputs: response.content.flatMap((part, index) =>
      part.type === "text" && part.text.trim() && textBytes(part.text) <= 4096
        ? [{ part: index, text: part.text }]
        : [],
    ),
    completion:
      completion === undefined
        ? null
        : JSON.stringify(bijectionToJson(completion)),
  };
}
