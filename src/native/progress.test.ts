import { expect, test } from "vitest";
import { jsonToBijection } from "bijection/values";
import {
  initializeCheckpoint,
  retainResponse,
  advanceCheckpoint,
  validateCheckpoint,
} from "./progress.js";

const response = (name: string, id: string, input: unknown) =>
  JSON.stringify({
    content: [
      {
        type: "tool-call",
        toolName: name,
        toolCallId: id,
        input: JSON.stringify(input),
      },
    ],
    usage: { outputTokens: 3 },
    response: { id: "provider-1" },
  });
test("retained responses preserve metadata, replay exactly and reject replacements", () => {
  const initial = initializeCheckpoint("[]", 4);
  const saved = retainResponse(initial, 0, response("read", "one", {}), 4);
  expect(initial.responses).toEqual([]);
  expect(saved.responses).toHaveLength(1);
  expect(retainResponse(saved, 0, saved.responses[0], 4)).toBe(saved);
  expect(() =>
    retainResponse(saved, 0, response("read", "two", {}), 4),
  ).toThrow("changed");
  expect(() => retainResponse(saved, 1, saved.responses[0], 4)).toThrow(
    "changed",
  );
});
test("empty and text-only responses continue and exhaust the admitted budget", () => {
  let progress = initializeCheckpoint("[]", 2);
  progress = advanceCheckpoint(
    retainResponse(progress, 0, '{"content":[]}', 2),
    0,
    "[]",
    2,
    null,
  );
  expect(progress.phase).toBe("ready");
  expect(progress.step).toBe(1);
  progress = advanceCheckpoint(
    retainResponse(
      progress,
      1,
      '{"content":[{"type":"text","text":"done"}]}',
      2,
    ),
    1,
    "[]",
    2,
    null,
  );
  expect(progress.phase).toBe("exhausted");
  expect(progress.result).toBeNull();
});
test("completion binds the exact native value, including int64 and nullable fields", () => {
  const value = { integer: 9007199254740993n, nullable: null };
  const saved = retainResponse(
    initializeCheckpoint("[]", 1),
    0,
    response("complete", "done", {
      result: { nullable: null, integer: "9007199254740993" },
    }),
    1,
  );
  const done = advanceCheckpoint(saved, 0, "[]", 1, { value });
  expect(done.phase).toBe("done");
  expect(jsonToBijection(JSON.parse(done.result!))).toEqual(value);
  expect(() =>
    advanceCheckpoint(saved, 0, "[]", 1, {
      value: { ...value, integer: 9007199254740992n },
    }),
  ).toThrow("differs");
  expect(() => advanceCheckpoint(saved, 0, "[]", 1, null)).toThrow("missing");
});
test("completion cannot coexist with business work or be fabricated from plain text", () => {
  const complete = JSON.parse(response("complete", "done", { result: null }));
  complete.content.push(JSON.parse(response("read", "read", {})).content[0]);
  const mixed = retainResponse(
    initializeCheckpoint("[]", 1),
    0,
    JSON.stringify(complete),
    1,
  );
  expect(() => advanceCheckpoint(mixed, 0, "[]", 1, { value: null })).toThrow(
    "only tool call",
  );
  const text = retainResponse(
    initializeCheckpoint("[]", 1),
    0,
    '{"content":[{"type":"text","text":"done"}]}',
    1,
  );
  expect(() => advanceCheckpoint(text, 0, "[]", 1, { value: null })).toThrow(
    "only tool call",
  );
});
test("invalid batches and repeated tool calls never advance", () => {
  const first = advanceCheckpoint(
    retainResponse(
      initializeCheckpoint("[]", 3),
      0,
      response("read", "same", {}),
      3,
    ),
    0,
    "[]",
    3,
    null,
  );
  const repeated = retainResponse(first, 1, response("read", "same", {}), 3);
  expect(() => advanceCheckpoint(repeated, 1, "[]", 3, null)).toThrow(
    "Invalid model response",
  );
  const malformed = retainResponse(
    initializeCheckpoint("[]", 1),
    0,
    '{"content":[{"type":"unknown"}]}',
    1,
  );
  expect(() => advanceCheckpoint(malformed, 0, "[]", 1, null)).toThrow(
    "Invalid model response",
  );
});
test("original bounds cover prompt, responses, cumulative custody and progress", () => {
  expect(() => initializeCheckpoint("[]", 17)).toThrow("step limit");
  expect(() =>
    initializeCheckpoint(JSON.stringify(["x".repeat(256 * 1024)]), 1),
  ).toThrow("byte limit");
  expect(() =>
    retainResponse(
      initializeCheckpoint("[]", 1),
      0,
      JSON.stringify({ content: [], extra: "x".repeat(64 * 1024) }),
      1,
    ),
  ).toThrow("byte limit");
  let progress = initializeCheckpoint("[]", 16);
  for (let step = 0; step < 5; step++) {
    const body = JSON.stringify({ content: [], extra: "x".repeat(60 * 1024) });
    if (step === 4)
      expect(() => retainResponse(progress, step, body, 16)).toThrow(
        "retention limit",
      );
    else
      progress = advanceCheckpoint(
        retainResponse(progress, step, body, 16),
        step,
        "[]",
        16,
        null,
      );
  }
  expect(() => validateCheckpoint({ ...progress, step: -1 }, 16)).toThrow(
    "step limit",
  );
});
