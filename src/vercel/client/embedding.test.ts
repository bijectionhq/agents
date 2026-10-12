import { expect, test, vi } from "vitest";
import type { EmbeddingModel } from "ai";
import type { ActionCtx } from "./types.js";

const embed = vi.hoisted(() => vi.fn());
vi.mock("ai", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  embedMany: embed,
}));
import { embedMessages, fetchContextWithPrompt } from "./search.js";
import { componentsGeneric } from "bijection/server";
import type { AgentComponent } from "./types.js";

const model = {
  specificationVersion: "v4",
  provider: "fixture",
  modelId: "embedding-fixture",
  maxEmbeddingsPerCall: 100,
  supportsParallelCalls: false,
  doEmbed: async () => {
    throw new Error("Use the controlled provider response");
  },
} satisfies EmbeddingModel;

test("prepared empty text cannot shift a provider vector onto another message", async () => {
  const first = Array(128).fill(1);
  const second = Array(128).fill(2);
  embed.mockReset().mockResolvedValue({ embeddings: [first, second] });
  const result = await embedMessages(
    {} as ActionCtx,
    {
      userId: "fixture-user",
      threadId: "fixture-thread",
      embeddingModel: model,
    },
    [
      { role: "user", content: " \n " },
      { role: "user", content: " alpha " },
      { role: "assistant", content: "\t" },
      { role: "tool", content: [] },
      { role: "user", content: " beta " },
    ],
  );
  expect(embed).toHaveBeenCalledOnce();
  expect(embed.mock.calls[0][0].values).toEqual(["alpha", "beta"]);
  expect(result?.vectors).toEqual([null, first, null, null, second]);
});

test("an empty prepared batch makes no embedding request", async () => {
  embed.mockReset();
  expect(
    await embedMessages(
      {} as ActionCtx,
      {
        userId: undefined,
        threadId: "fixture-thread",
        embeddingModel: model,
      },
      [
        { role: "user", content: "   " },
        { role: "assistant", content: "\n" },
      ],
    ),
  ).toBeUndefined();
  expect(embed).not.toHaveBeenCalled();
});

test.each([
  {
    storedText: "alpha",
    prompt: undefined,
    calls: 1,
    mutateSearchVector: false,
  },
  {
    storedText: "alpha",
    prompt: undefined,
    calls: 1,
    mutateSearchVector: true,
  },
  {
    storedText: " alpha ",
    prompt: undefined,
    calls: 2,
    mutateSearchVector: false,
  },
  {
    storedText: "alpha",
    prompt: "other query",
    calls: 2,
    mutateSearchVector: false,
  },
])(
  "query reuse matches exact prepared input: $storedText / $prompt",
  async ({ storedText, prompt, calls, mutateSearchVector }) => {
    const vector = Array(128).fill(0.1);
    embed.mockReset().mockResolvedValue({ embeddings: [vector] });
    const component = (
      componentsGeneric() as unknown as { agent: AgentComponent }
    ).agent;
    const message = {
      _id: "prompt",
      _creationTime: 1,
      threadId: "thread",
      userId: "user",
      order: 0,
      stepOrder: 0,
      status: "success",
      tool: false,
      text: storedText,
      message: { role: "user", content: storedText },
    };
    const runMutation = vi.fn(
      async (_reference: unknown, _args: unknown) => undefined,
    );
    const runAction = vi.fn(async (_reference: unknown, args: unknown) => {
      if (mutateSearchVector)
        (args as { embedding: number[] }).embedding[0] = 9;
      return [];
    });
    const result = await fetchContextWithPrompt(
      {
        runQuery: async () => ({
          page: [message],
          isDone: true,
          continueCursor: "",
        }),
        runAction,
        runMutation,
      } as unknown as ActionCtx,
      component,
      {
        userId: "user",
        threadId: "thread",
        promptMessageId: "prompt",
        prompt,
        messages: undefined,
        embeddingModel: model,
        contextOptions: { searchOptions: { vectorSearch: true, limit: 10 } },
      },
    );
    expect(embed).toHaveBeenCalledTimes(calls);
    expect(runMutation).toHaveBeenCalledOnce();
    expect(runMutation.mock.calls[0][1]).toMatchObject({
      vectorDimension: 128,
      vectors: [
        {
          messageId: "prompt",
          vector: Array(128).fill(0.1),
          model: "embedding-fixture",
        },
      ],
    });
    expect(result.messages).toEqual([
      { role: "user", content: prompt ?? storedText },
    ]);
  },
);
