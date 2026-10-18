import type { AgentModelRequest, AgentModelStep } from "./index.js";
import { jsonBytes } from "./response.js";

type Part = { type: string; [field: string]: unknown };

/** Streaming is a provider transport. The complete bounded response still
 * crosses native checkpoint admission before any text reaches a channel.
 * Only the content is kept; reasoning is the provider's and is dropped. */
export async function generateAgentStep(
  model: AgentModelStep,
  request: AgentModelRequest,
): Promise<{ content: Part[] }> {
  if (!model.doStream) {
    const { content } = await model.doGenerate(request);
    if (!Array.isArray(content)) throw new Error("Invalid model response");
    return {
      content: content.filter((part) => part?.type !== "reasoning"),
    };
  }
  const { stream } = await model.doStream(request);
  const reader = stream.getReader();
  const content: Part[] = [];
  const texts = new Map<
    string,
    { index: number; chunks: string[]; isClosed: boolean }
  >();
  const tools = new Map<
    string,
    { index: number; name: string; chunks: string[]; isComplete: boolean }
  >();
  let bytes = 0;
  let isFinished = false;
  let isComplete = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (
        typeof next.value !== "object" ||
        next.value === null ||
        Array.isArray(next.value)
      )
        throw new Error("Invalid model stream");
      const part = next.value as { type: unknown; [field: string]: unknown };
      if (typeof part.type !== "string")
        throw new Error("Invalid model stream");
      bytes += jsonBytes(part);
      if (bytes > 256 * 1024 || isFinished)
        throw new Error("Invalid model stream");
      const id = typeof part.id === "string" ? part.id : "";
      switch (part.type) {
        case "text-start":
          if (!id || texts.has(id)) throw new Error("Invalid model stream");
          texts.set(id, { index: content.length, chunks: [], isClosed: false });
          content.push({ type: "text", text: "" });
          break;
        case "text-delta": {
          const text = texts.get(id);
          if (!text || text.isClosed || typeof part.delta !== "string")
            throw new Error("Invalid model stream");
          text.chunks.push(part.delta);
          break;
        }
        case "text-end": {
          const text = texts.get(id);
          if (!text || text.isClosed) throw new Error("Invalid model stream");
          text.isClosed = true;
          content[text.index] = { type: "text", text: text.chunks.join("") };
          break;
        }
        case "tool-input-start":
          if (
            !id ||
            tools.has(id) ||
            typeof part.toolName !== "string" ||
            part.providerExecuted
          )
            throw new Error("Invalid model stream");
          tools.set(id, {
            index: content.length,
            name: part.toolName,
            chunks: [],
            isComplete: false,
          });
          content.push({
            type: "tool-call",
            toolCallId: id,
            toolName: part.toolName,
            input: "",
          });
          break;
        case "tool-input-delta": {
          const tool = tools.get(id);
          if (!tool || tool.isComplete || typeof part.delta !== "string")
            throw new Error("Invalid model stream");
          tool.chunks.push(part.delta);
          break;
        }
        case "tool-input-end":
          if (!tools.has(id)) throw new Error("Invalid model stream");
          break;
        case "tool-call": {
          if (
            typeof part.toolCallId !== "string" ||
            typeof part.toolName !== "string" ||
            typeof part.input !== "string" ||
            part.providerExecuted
          )
            throw new Error("Invalid model stream");
          const tool = tools.get(part.toolCallId);
          if (
            tool &&
            (tool.isComplete ||
              tool.name !== part.toolName ||
              (tool.chunks.length && tool.chunks.join("") !== part.input))
          )
            throw new Error("Invalid model stream");
          const call = {
            type: "tool-call",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
          };
          if (tool) {
            tool.isComplete = true;
            content[tool.index] = call;
          } else {
            tools.set(part.toolCallId, {
              index: content.length,
              name: part.toolName,
              chunks: [],
              isComplete: true,
            });
            content.push(call);
          }
          break;
        }
        case "finish":
          if (
            (part.finishReason as { unified?: string } | undefined)?.unified ===
            "error"
          )
            throw new Error("Model stream failed");
          isFinished = true;
          break;
        case "error":
          throw new Error("Model stream failed");
        case "stream-start":
        case "response-metadata":
        case "reasoning-start":
        case "reasoning-delta":
        case "reasoning-end":
          break;
        default:
          throw new Error("Unsupported model stream part");
      }
      if (content.length > 64) throw new Error("Invalid model stream");
    }
    if (
      !isFinished ||
      [...texts.values()].some((text) => !text.isClosed) ||
      [...tools.values()].some((tool) => !tool.isComplete) ||
      jsonBytes({ content }) > 64 * 1024
    )
      throw new Error("Incomplete model stream");
    isComplete = true;
    return { content };
  } finally {
    if (!isComplete) await reader.cancel();
    reader.releaseLock();
  }
}
