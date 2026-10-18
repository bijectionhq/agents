import { expect, test } from "vitest";
import { generateAgentStep } from "./generation.js";
import type { AgentModelStep } from "./index.js";
import { validateModelResponse } from "./response.js";

function model(parts: unknown[]): AgentModelStep {
  return {
    doGenerate: async () => {
      throw new Error("A stream is never retried through generate");
    },
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          for (const part of parts) controller.enqueue(part);
          controller.close();
        },
      }),
    }),
  };
}
const request = {
  prompt: [],
  tools: [],
  toolChoice: { type: "auto" as const },
};

test("agent stream admits complete text and tool input without exposing provisional deltas", async () => {
  const result = await generateAgentStep(
    model([
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "Checking " },
      { type: "text-delta", id: "t", delta: "your flight." },
      { type: "text-end", id: "t" },
      { type: "tool-input-start", id: "c", toolName: "itinerary" },
      { type: "tool-input-delta", id: "c", delta: "{}" },
      { type: "tool-input-end", id: "c" },
      {
        type: "tool-call",
        toolCallId: "c",
        toolName: "itinerary",
        input: "{}",
      },
      { type: "finish" },
    ]),
    request,
  );
  expect(result.content).toEqual([
    { type: "text", text: "Checking your flight." },
    { type: "tool-call", toolCallId: "c", toolName: "itinerary", input: "{}" },
  ]);
});

test("agent steps drop provider reasoning and keep only the content", async () => {
  const call = {
    type: "tool-call",
    toolCallId: "c",
    toolName: "complete",
    input: "{}",
  };
  const generated = await generateAgentStep(
    {
      doGenerate: async () => ({
        content: [
          { type: "reasoning", text: "private chain", providerMetadata: {} },
          call,
        ],
        usage: { inputTokens: { total: 1 } },
        response: { body: "provider body" },
      }),
    },
    request,
  );
  expect(generated).toEqual({ content: [call] });
  const streamed = await generateAgentStep(
    model([
      { type: "reasoning-start", id: "r" },
      { type: "reasoning-delta", id: "r", delta: "private chain" },
      { type: "reasoning-end", id: "r" },
      call,
      { type: "finish" },
    ]),
    request,
  );
  expect(streamed).toEqual({ content: [call] });
  const validated = validateModelResponse(
    { content: [{ type: "reasoning", text: "saved earlier" }, call] },
    new Set(),
    (name) => name,
  );
  expect(validated.content).toEqual([call]);
  expect(() =>
    validateModelResponse(
      { content: [{ type: "file", data: "x" }] },
      new Set(),
      (name) => name,
    ),
  ).toThrow("Invalid model response");
});

test("agent stream refuses unfinished text, contradictory tools and provider execution", async () => {
  for (const parts of [
    [null],
    ["not a stream event"],
    [{}],
    [
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "Partial" },
    ],
    [
      { type: "tool-input-start", id: "c", toolName: "read" },
      { type: "tool-input-delta", id: "c", delta: "{}" },
      { type: "tool-call", toolCallId: "c", toolName: "refund", input: "{}" },
      { type: "finish" },
    ],
    [
      {
        type: "tool-call",
        toolCallId: "c",
        toolName: "refund",
        input: "{}",
        providerExecuted: true,
      },
      { type: "finish" },
    ],
  ])
    await expect(generateAgentStep(model(parts), request)).rejects.toThrow();
});
