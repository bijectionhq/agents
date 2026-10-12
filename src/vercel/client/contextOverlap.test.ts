import { expect, test, vi } from "vitest";
import { componentsGeneric } from "bijection/server";
import type { ActionCtx, AgentComponent } from "./types.js";
import { fetchRecentAndSearchMessages } from "./search.js";

const component = (componentsGeneric() as unknown as { agent: AgentComponent })
  .agent;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("explicit text starts its embedding alongside the recent read and uses it once", async () => {
  const page = deferred<{
    page: [];
    isDone: boolean;
    continueCursor: string;
  }>();
  const embedding = deferred<{ embedding: number[]; embeddingModel: string }>();
  const runQuery = vi.fn(() => page.promise);
  const runAction = vi.fn(async (_reference: unknown, _args: unknown) => []);
  const getEmbedding = vi.fn(() => embedding.promise);
  const pending = fetchRecentAndSearchMessages(
    { runQuery, runAction } as unknown as ActionCtx,
    component,
    {
      userId: "user",
      threadId: "thread",
      searchText: "supplied query",
      contextOptions: { searchOptions: { vectorSearch: true, limit: 10 } },
      getEmbedding,
    },
  );
  expect(runQuery).toHaveBeenCalledOnce();
  expect(getEmbedding).toHaveBeenCalledExactlyOnceWith("supplied query");
  expect(runAction).not.toHaveBeenCalled();
  embedding.resolve({ embedding: [0.1, 0.2], embeddingModel: "fixture" });
  page.resolve({ page: [], isDone: true, continueCursor: "" });
  expect(await pending).toEqual({ recentMessages: [], searchMessages: [] });
  expect(getEmbedding).toHaveBeenCalledOnce();
  expect(runAction.mock.calls[0][1]).toMatchObject({
    embedding: [0.1, 0.2],
    embeddingModel: "fixture",
  });
});

test("both concurrent failures are observed without dispatching search", async () => {
  const page = deferred<never>();
  const embedding = deferred<never>();
  const runAction = vi.fn();
  const pending = fetchRecentAndSearchMessages(
    { runQuery: () => page.promise, runAction } as unknown as ActionCtx,
    component,
    {
      userId: "user",
      threadId: "thread",
      searchText: "query",
      contextOptions: { searchOptions: { vectorSearch: true, limit: 10 } },
      getEmbedding: () => embedding.promise,
    },
  );
  const rejected = expect(pending).rejects.toThrow("provider failed");
  embedding.reject(new Error("provider failed"));
  page.reject(new Error("recent read failed"));
  await rejected;
  expect(runAction).not.toHaveBeenCalled();
});

test("lexical-only context does not start an embedding request", async () => {
  const getEmbedding = vi.fn();
  await fetchRecentAndSearchMessages(
    {
      runQuery: async () => ({ page: [], isDone: true }),
      runAction: async () => [],
    } as unknown as ActionCtx,
    component,
    {
      userId: "user",
      threadId: "thread",
      searchText: "query",
      contextOptions: { searchOptions: { textSearch: true, limit: 10 } },
      getEmbedding,
    },
  );
  expect(getEmbedding).not.toHaveBeenCalled();
});
