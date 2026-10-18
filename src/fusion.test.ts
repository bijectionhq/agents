import { expect, test } from "vitest";
import { fuseRanks } from "./fusion.js";

test("an absent lexical match has no fabricated reciprocal-rank contribution", () => {
  // The previous indexOf-based expression gave absent candidates 1/9, moving
  // vector-only 'a' ahead of the actual overlap 'b'.
  expect(fuseRanks(["a", "b"], ["b"])).toEqual(["b", "a"]);
  expect(fuseRanks(["a", "b", "c"], [])).toEqual(["a", "b", "c"]);
});

test("overlaps are deterministic and repeated identities use their first rank", () => {
  expect(fuseRanks(["a", "b", "c"], ["b", "a"])).toEqual(["a", "b", "c"]);
  expect(fuseRanks(["a", "b", "a", "c"], [undefined, "b", "b", "a"])).toEqual([
    "b",
    "a",
    "c",
  ]);
  expect(fuseRanks([], ["a", undefined])).toEqual(["a"]);
});

test("lexical-only candidates enter the same bounded ranking before truncation", () => {
  expect(fuseRanks(["a", "b", "c"], ["text", "b"])).toEqual([
    "b",
    "a",
    "text",
    "c",
  ]);
  expect(fuseRanks(["a", "b", "c"], ["text", "b"]).slice(0, 2)).toEqual([
    "b",
    "a",
  ]);
});
