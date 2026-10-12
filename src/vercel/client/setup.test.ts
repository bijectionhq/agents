/// <reference types="vite/client" />
import { test } from "vitest";
import { bijectionTest } from "@bijectionhq/test";
export const modules = {
  ...import.meta.glob("./**/*.*s"),
  "./_generated/api.ts": () => import("../../component/_generated/api.js"),
};

import {
  defineSchema,
  type GenericSchema,
  type SchemaDefinition,
} from "bijection/server";
import { type AgentComponent } from "./types.js";
import { componentsGeneric } from "bijection/server";
import component from "../../test.js";

export function initBijectionTest<
  Schema extends SchemaDefinition<GenericSchema, boolean>,
>(schema?: Schema) {
  const t = bijectionTest((schema ?? defineSchema({})) as Schema, modules);
  component.register(t);
  return t;
}
export const components = componentsGeneric() as unknown as {
  agent: AgentComponent;
};

test("setup", () => {});
