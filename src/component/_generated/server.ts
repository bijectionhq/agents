/* eslint-disable */
/**
 * Generated utilities for implementing server-side Bijection query and mutation functions.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `bijection dev`.
 * @module
 */
import type { BijectionActionBuilder as ActionBuilder, HttpActionBuilder, BijectionMutationBuilder as MutationBuilder, BijectionQueryBuilder as QueryBuilder, BijectionActionCtx as GenericActionCtx, BijectionMutationCtx as GenericMutationCtx, BijectionQueryCtx as GenericQueryCtx, GenericDatabaseReader, GenericDatabaseWriter, } from "bijection/server";
import { bijectionActionGeneric as actionGeneric, httpActionGeneric, bijectionQueryGeneric as queryGeneric, bijectionMutationGeneric as mutationGeneric, bijectionInternalActionGeneric as internalActionGeneric, bijectionInternalMutationGeneric as internalMutationGeneric, bijectionInternalQueryGeneric as internalQueryGeneric, } from "bijection/server";
import type { DataModel, QuerySchema } from "./dataModel.js";
/**
 * Typesafe environment variables.
 *
 * This includes platform-provided env vars and any variables declared in
 * `bijection.config.ts`.
 */
type Env = {
    readonly BIJECTION_CLOUD_URL: string;
    readonly BIJECTION_HTTP_ACTIONS_URL: string;
};
/**
 * Define a query in this Bijection app's public API.
 *
 * This function will be allowed to read your Bijection database and will be accessible from the client.
 *
 * @param func - The query function. It receives a {@link QueryCtx} as its first argument.
 * @returns The wrapped query. Include this as an `export` to name it and make it accessible.
 */
export const query: QueryBuilder<DataModel, "public", QuerySchema> = queryGeneric;
/**
 * Define a query that is only accessible from other Bijection functions (but not from the client).
 *
 * This function will be allowed to read from your Bijection database. It will not be accessible from the client.
 *
 * @param func - The query function. It receives a {@link QueryCtx} as its first argument.
 * @returns The wrapped query. Include this as an `export` to name it and make it accessible.
 */
export const internalQuery: QueryBuilder<DataModel, "internal", QuerySchema> = internalQueryGeneric;
/**
 * Define a mutation in this Bijection app's public API.
 *
 * This function will be allowed to modify your Bijection database and will be accessible from the client.
 *
 * @param func - The mutation function. It receives a {@link MutationCtx} as its first argument.
 * @returns The wrapped mutation. Include this as an `export` to name it and make it accessible.
 */
export const mutation: MutationBuilder<DataModel, "public", QuerySchema> = mutationGeneric;
/**
 * Define a mutation that is only accessible from other Bijection functions (but not from the client).
 *
 * This function will be allowed to modify your Bijection database. It will not be accessible from the client.
 *
 * @param func - The mutation function. It receives a {@link MutationCtx} as its first argument.
 * @returns The wrapped mutation. Include this as an `export` to name it and make it accessible.
 */
export const internalMutation: MutationBuilder<DataModel, "internal", QuerySchema> = internalMutationGeneric;
/**
 * Define an action in this Bijection app's public API.
 *
 * An action is a function which can execute any JavaScript code, including non-deterministic
 * code and code with side-effects, like calling third-party services.
 * They can be run in Bijection's JavaScript environment or in Node.js using the "use node" directive.
 * They can interact with the database indirectly by calling queries and mutations using the {@link ActionCtx}.
 *
 * @param func - The action. It receives an {@link ActionCtx} as its first argument.
 * @returns The wrapped action. Include this as an `export` to name it and make it accessible.
 */
export const action: ActionBuilder<DataModel, "public", QuerySchema> = actionGeneric;
/**
 * Define an action that is only accessible from other Bijection functions (but not from the client).
 *
 * @param func - The function. It receives an {@link ActionCtx} as its first argument.
 * @returns The wrapped function. Include this as an `export` to name it and make it accessible.
 */
export const internalAction: ActionBuilder<DataModel, "internal", QuerySchema> = internalActionGeneric;
/**
 * Define an HTTP action.
 *
 * The wrapped function will be used to respond to HTTP requests received
 * by a Bijection deployment if the requests matches the path and method where
 * this action is routed. Be sure to route your httpAction in `bijection/http.js`.
 *
 * @param func - The function. It receives an {@link ActionCtx} as its first argument
 * and a Fetch API `Request` object as its second.
 * @returns The wrapped function. Import this function from `bijection/http.js` and route it to hook it up.
 */
export const httpAction: HttpActionBuilder = httpActionGeneric;
export const env: Env = (globalThis as unknown as {
    process: {
        env: Env;
    };
})
    .process.env;
/**
 * A set of services for use within Bijection query functions.
 *
 * The query context is passed as the first argument to any Bijection query
 * function run on the server.
 *
 * If you're using code generation, use the `QueryCtx` type in `bijection/_generated/server.d.ts` instead.
 */
export type QueryCtx = GenericQueryCtx<DataModel, QuerySchema>;
/**
 * A set of services for use within Bijection mutation functions.
 *
 * The mutation context is passed as the first argument to any Bijection mutation
 * function run on the server.
 *
 * If you're using code generation, use the `MutationCtx` type in `bijection/_generated/server.d.ts` instead.
 */
export type MutationCtx = GenericMutationCtx<DataModel, QuerySchema>;
/**
 * A set of services for use within Bijection action functions.
 *
 * The action context is passed as the first argument to any Bijection action
 * function run on the server.
 */
export type ActionCtx = GenericActionCtx<DataModel, QuerySchema>;
/**
 * An interface to read from the database within Bijection query functions.
 *
 * The two entry points are {@link DatabaseReader.get}, which fetches a single
 * document by its {@link Id}, or {@link DatabaseReader.query}, which starts
 * building a query.
 */
export type DatabaseReader = GenericDatabaseReader<DataModel>;
/**
 * An interface to read from and write to the database within Bijection mutation
 * functions.
 *
 * Bijection guarantees that all writes within a single mutation are
 * executed atomically, so you never have to worry about partial writes leaving
 * your data in an inconsistent state. See [the Bijection Guide](https://docs.bijection.com/database/advanced/occ)
 * for the guarantees Bijection provides your functions.
 */
export type DatabaseWriter = GenericDatabaseWriter<DataModel>;
