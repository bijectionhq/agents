/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `bijection dev`.
 * @module
 */
import type * as apiKeys from "../apiKeys.js";
import type * as files from "../files.js";
import type * as messages from "../messages.js";
import type * as migrationTables from "../migrationTables.js";
import type * as migrations from "../migrations.js";
import type * as native from "../native.js";
import type * as nativeTables from "../nativeTables.js";
import type * as proposalTables from "../proposalTables.js";
import type * as proposals from "../proposals.js";
import type * as streams from "../streams.js";
import type * as threads from "../threads.js";
import type * as users from "../users.js";
import type * as vector_index from "../vector/index.js";
import type * as vector_tables from "../vector/tables.js";
import type * as verification from "../verification.js";
import type * as verificationTables from "../verificationTables.js";
import type { ApiFromModules } from "bijection/server";
type FunctionExport<Module, Name extends PropertyKey> = Name extends keyof Module ? Module[Name] : Module extends {
    default: infer Bundle;
} ? Name extends keyof Bundle ? Bundle[Name] : never : never;
type FunctionReferenceFor<Module, Name extends PropertyKey> = ApiFromModules<{
    _: {
        handler: FunctionExport<Module, Name>;
    };
}> extends {
    _: {
        handler: infer Reference;
    };
} ? Reference : never;
import type { FunctionReference, OperationReference, OperationManifestEntry } from "bijection/server";
import type { GenericId as Id } from "bijection/values";
import { apiWithOperations, componentsGeneric } from "bijection/server";
const operationContracts: Record<string, OperationManifestEntry> = JSON.parse("{\"proposals.js:submit\":{\"contract\":{\"args\":{\"type\":\"object\",\"value\":{\"proposal\":{\"fieldType\":{\"tableName\":\"agentProposals\",\"type\":\"id\"},\"optional\":false}}},\"on\":\"agentProposals\",\"operation\":\"proposals.js:submit\",\"returns\":{\"tableName\":\"agentProposals\",\"type\":\"id\"},\"review\":\"required\",\"target\":{\"argument\":\"proposal\",\"select\":[]},\"version\":1,\"visibility\":\"public\"},\"contract_digest\":\"7ae31f8a17bff4b5b3a61eed768c6d5884ac10b42f62c48204fc263b0dfe7fc5\"}}");
/**
 * A utility for referencing Bijection functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export const api: {
    "apiKeys": {
        "destroy": FunctionReferenceFor<typeof apiKeys, "destroy">;
        "issue": FunctionReferenceFor<typeof apiKeys, "issue">;
        "validate": FunctionReferenceFor<typeof apiKeys, "validate">;
    };
    "files": {
        "addFile": FunctionReferenceFor<typeof files, "addFile">;
        "copyFile": FunctionReferenceFor<typeof files, "copyFile">;
        "deleteFiles": FunctionReferenceFor<typeof files, "deleteFiles">;
        "get": FunctionReferenceFor<typeof files, "get">;
        "getFilesToDelete": FunctionReferenceFor<typeof files, "getFilesToDelete">;
        "useExistingFile": FunctionReferenceFor<typeof files, "useExistingFile">;
    };
    "messages": {
        "addMessages": FunctionReferenceFor<typeof messages, "addMessages">;
        "cloneThread": FunctionReferenceFor<typeof messages, "cloneThread">;
        "deleteByIds": FunctionReferenceFor<typeof messages, "deleteByIds">;
        "deleteByOrder": FunctionReferenceFor<typeof messages, "deleteByOrder">;
        "finalizeMessage": FunctionReferenceFor<typeof messages, "finalizeMessage">;
        "getMessageSearchFields": FunctionReferenceFor<typeof messages, "getMessageSearchFields">;
        "getMessagesByIds": FunctionReferenceFor<typeof messages, "getMessagesByIds">;
        "listMessagesByThreadId": FunctionReferenceFor<typeof messages, "listMessagesByThreadId">;
        "respondToToolCallApprovals": FunctionReferenceFor<typeof messages, "respondToToolCallApprovals">;
        "searchMessages": FunctionReferenceFor<typeof messages, "searchMessages">;
        "textSearch": FunctionReferenceFor<typeof messages, "textSearch">;
        "updateMessage": FunctionReferenceFor<typeof messages, "updateMessage">;
    };
    "migrations": {
        "originalProposal": FunctionReferenceFor<typeof migrations, "originalProposal">;
        "status": FunctionReferenceFor<typeof migrations, "status">;
    };
    "native": {
        "advance": FunctionReferenceFor<typeof native, "advance">;
        "initialize": FunctionReferenceFor<typeof native, "initialize">;
        "progress": FunctionReferenceFor<typeof native, "progress">;
        "response": FunctionReferenceFor<typeof native, "response">;
    };
    "proposals": {
        "configure": FunctionReferenceFor<typeof proposals, "configure">;
        "proposals": FunctionReferenceFor<typeof proposals, "proposals">;
        "propose": FunctionReferenceFor<typeof proposals, "propose">;
        "reject": FunctionReferenceFor<typeof proposals, "reject">;
        "submit": OperationReference<"public", {
            proposal: Id<"agentProposals">;
        }, Id<"agentProposals">>;
    };
    "streams": {
        "abort": FunctionReferenceFor<typeof streams, "abort">;
        "abortByOrder": FunctionReferenceFor<typeof streams, "abortByOrder">;
        "addDelta": FunctionReferenceFor<typeof streams, "addDelta">;
        "create": FunctionReferenceFor<typeof streams, "create">;
        "deleteAllStreamsForThreadIdAsync": FunctionReferenceFor<typeof streams, "deleteAllStreamsForThreadIdAsync">;
        "deleteAllStreamsForThreadIdSync": FunctionReferenceFor<typeof streams, "deleteAllStreamsForThreadIdSync">;
        "deleteStreamAsync": FunctionReferenceFor<typeof streams, "deleteStreamAsync">;
        "deleteStreamSync": FunctionReferenceFor<typeof streams, "deleteStreamSync">;
        "finish": FunctionReferenceFor<typeof streams, "finish">;
        "heartbeat": FunctionReferenceFor<typeof streams, "heartbeat">;
        "list": FunctionReferenceFor<typeof streams, "list">;
        "listDeltas": FunctionReferenceFor<typeof streams, "listDeltas">;
    };
    "threads": {
        "createThread": FunctionReferenceFor<typeof threads, "createThread">;
        "deleteAllForThreadIdAsync": FunctionReferenceFor<typeof threads, "deleteAllForThreadIdAsync">;
        "deleteAllForThreadIdSync": FunctionReferenceFor<typeof threads, "deleteAllForThreadIdSync">;
        "getThread": FunctionReferenceFor<typeof threads, "getThread">;
        "listThreadsByUserId": FunctionReferenceFor<typeof threads, "listThreadsByUserId">;
        "searchThreadTitles": FunctionReferenceFor<typeof threads, "searchThreadTitles">;
        "updateThread": FunctionReferenceFor<typeof threads, "updateThread">;
    };
    "users": {
        "deleteAllForUserId": FunctionReferenceFor<typeof users, "deleteAllForUserId">;
        "deleteAllForUserIdAsync": FunctionReferenceFor<typeof users, "deleteAllForUserIdAsync">;
        "listUsersWithThreads": FunctionReferenceFor<typeof users, "listUsersWithThreads">;
    };
    "vector": {
        "index": {
            "deleteBatch": FunctionReferenceFor<typeof vector_index, "deleteBatch">;
            "deleteBatchForThread": FunctionReferenceFor<typeof vector_index, "deleteBatchForThread">;
            "insertBatch": FunctionReferenceFor<typeof vector_index, "insertBatch">;
            "paginate": FunctionReferenceFor<typeof vector_index, "paginate">;
            "updateBatch": FunctionReferenceFor<typeof vector_index, "updateBatch">;
        };
    };
    "verification": {
        "attempt": FunctionReferenceFor<typeof verification, "attempt">;
        "begin": FunctionReferenceFor<typeof verification, "begin">;
        "cancel": FunctionReferenceFor<typeof verification, "cancel">;
        "complete": FunctionReferenceFor<typeof verification, "complete">;
        "current": FunctionReferenceFor<typeof verification, "current">;
        "inspect": FunctionReferenceFor<typeof verification, "inspect">;
        "recordAdmission": FunctionReferenceFor<typeof verification, "recordAdmission">;
    };
} = apiWithOperations(operationContracts, "public") as any;
/**
 * A utility for referencing Bijection functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export const internal: {
    "messages": {
        "_fetchSearchMessages": FunctionReferenceFor<typeof messages, "_fetchSearchMessages">;
        "cloneMessageBatch": FunctionReferenceFor<typeof messages, "cloneMessageBatch">;
    };
    "migrations": {
        "step": FunctionReferenceFor<typeof migrations, "step">;
    };
    "streams": {
        "deleteStreamsPageForThreadIdMutation": FunctionReferenceFor<typeof streams, "deleteStreamsPageForThreadIdMutation">;
        "timeoutStream": FunctionReferenceFor<typeof streams, "timeoutStream">;
    };
    "threads": {
        "_deletePageForThreadId": FunctionReferenceFor<typeof threads, "_deletePageForThreadId">;
    };
    "users": {
        "_deleteAllForUserIdAsync": FunctionReferenceFor<typeof users, "_deleteAllForUserIdAsync">;
        "_deletePageForUserId": FunctionReferenceFor<typeof users, "_deletePageForUserId">;
        "getThreadUserId": FunctionReferenceFor<typeof users, "getThreadUserId">;
    };
    "verification": {
        "expire": FunctionReferenceFor<typeof verification, "expire">;
    };
} = apiWithOperations(operationContracts, "internal") as any;
export const components = componentsGeneric() as unknown as {};
