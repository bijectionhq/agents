/// <reference types="vite/client" />
import type { TestBijection } from "@bijectionhq/test";
import type { GenericSchema, SchemaDefinition } from "bijection/server";
import schema from "./component/schema.js";
const modules = import.meta.glob("./component/**/*.ts");

/**
 * Register the component with the test convex instance.
 * @param t - The test convex instance, e.g. from calling `bijectionTest`.
 * @param name - The name of the component, as registered in convex.config.ts.
 */
export function register<
  Schema extends SchemaDefinition<GenericSchema, boolean>,
>(t: TestBijection<Schema>, name: string = "agent") {
  t.registerComponent(name, schema, modules);
}
export default { register, schema, modules };
