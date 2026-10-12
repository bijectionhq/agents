/// <reference types="vite/client" />
import { bijectionTest } from "@bijectionhq/test";
import { test } from "vitest";
import schema from "./schema.js";
export const modules = import.meta.glob("./**/*.*s");

export function initBijectionTest() {
  const t = bijectionTest(schema, modules);
  return t;
}

test("setup", () => {});
