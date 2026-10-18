// Current host decisions, evaluated only by native table policy execution.
import {
  defineComponentTableRules,
  makeFunctionReference,
} from "bijection/server";

export const apiKeysAccess = defineComponentTableRules({
  table: "apiKeys",
  rules: {
    read: makeFunctionReference<"query">("access:apiKeysRead"),
    write: makeFunctionReference<"query">("access:apiKeysWrite"),
    disclose: makeFunctionReference<"query">("access:apiKeysDisclose"),
  },
});
export const apiKeysRead = apiKeysAccess.read;
export const apiKeysWrite = apiKeysAccess.write;
export const apiKeysDisclose = apiKeysAccess.disclose;

export const embeddings_1024Access = defineComponentTableRules({
  table: "embeddings_1024",
  rules: {
    read: makeFunctionReference<"query">("access:embeddings_1024Read"),
    write: makeFunctionReference<"query">("access:embeddings_1024Write"),
    disclose: makeFunctionReference<"query">("access:embeddings_1024Disclose"),
  },
});
export const embeddings_1024Read = embeddings_1024Access.read;
export const embeddings_1024Write = embeddings_1024Access.write;
export const embeddings_1024Disclose = embeddings_1024Access.disclose;

export const embeddings_128Access = defineComponentTableRules({
  table: "embeddings_128",
  rules: {
    read: makeFunctionReference<"query">("access:embeddings_128Read"),
    write: makeFunctionReference<"query">("access:embeddings_128Write"),
    disclose: makeFunctionReference<"query">("access:embeddings_128Disclose"),
  },
});
export const embeddings_128Read = embeddings_128Access.read;
export const embeddings_128Write = embeddings_128Access.write;
export const embeddings_128Disclose = embeddings_128Access.disclose;

export const embeddings_1408Access = defineComponentTableRules({
  table: "embeddings_1408",
  rules: {
    read: makeFunctionReference<"query">("access:embeddings_1408Read"),
    write: makeFunctionReference<"query">("access:embeddings_1408Write"),
    disclose: makeFunctionReference<"query">("access:embeddings_1408Disclose"),
  },
});
export const embeddings_1408Read = embeddings_1408Access.read;
export const embeddings_1408Write = embeddings_1408Access.write;
export const embeddings_1408Disclose = embeddings_1408Access.disclose;

export const embeddings_1536Access = defineComponentTableRules({
  table: "embeddings_1536",
  rules: {
    read: makeFunctionReference<"query">("access:embeddings_1536Read"),
    write: makeFunctionReference<"query">("access:embeddings_1536Write"),
    disclose: makeFunctionReference<"query">("access:embeddings_1536Disclose"),
  },
});
export const embeddings_1536Read = embeddings_1536Access.read;
export const embeddings_1536Write = embeddings_1536Access.write;
export const embeddings_1536Disclose = embeddings_1536Access.disclose;

export const embeddings_2048Access = defineComponentTableRules({
  table: "embeddings_2048",
  rules: {
    read: makeFunctionReference<"query">("access:embeddings_2048Read"),
    write: makeFunctionReference<"query">("access:embeddings_2048Write"),
    disclose: makeFunctionReference<"query">("access:embeddings_2048Disclose"),
  },
});
export const embeddings_2048Read = embeddings_2048Access.read;
export const embeddings_2048Write = embeddings_2048Access.write;
export const embeddings_2048Disclose = embeddings_2048Access.disclose;

export const embeddings_256Access = defineComponentTableRules({
  table: "embeddings_256",
  rules: {
    read: makeFunctionReference<"query">("access:embeddings_256Read"),
    write: makeFunctionReference<"query">("access:embeddings_256Write"),
    disclose: makeFunctionReference<"query">("access:embeddings_256Disclose"),
  },
});
export const embeddings_256Read = embeddings_256Access.read;
export const embeddings_256Write = embeddings_256Access.write;
export const embeddings_256Disclose = embeddings_256Access.disclose;

export const embeddings_2560Access = defineComponentTableRules({
  table: "embeddings_2560",
  rules: {
    read: makeFunctionReference<"query">("access:embeddings_2560Read"),
    write: makeFunctionReference<"query">("access:embeddings_2560Write"),
    disclose: makeFunctionReference<"query">("access:embeddings_2560Disclose"),
  },
});
export const embeddings_2560Read = embeddings_2560Access.read;
export const embeddings_2560Write = embeddings_2560Access.write;
export const embeddings_2560Disclose = embeddings_2560Access.disclose;

export const embeddings_3072Access = defineComponentTableRules({
  table: "embeddings_3072",
  rules: {
    read: makeFunctionReference<"query">("access:embeddings_3072Read"),
    write: makeFunctionReference<"query">("access:embeddings_3072Write"),
    disclose: makeFunctionReference<"query">("access:embeddings_3072Disclose"),
  },
});
export const embeddings_3072Read = embeddings_3072Access.read;
export const embeddings_3072Write = embeddings_3072Access.write;
export const embeddings_3072Disclose = embeddings_3072Access.disclose;

export const embeddings_4096Access = defineComponentTableRules({
  table: "embeddings_4096",
  rules: {
    read: makeFunctionReference<"query">("access:embeddings_4096Read"),
    write: makeFunctionReference<"query">("access:embeddings_4096Write"),
    disclose: makeFunctionReference<"query">("access:embeddings_4096Disclose"),
  },
});
export const embeddings_4096Read = embeddings_4096Access.read;
export const embeddings_4096Write = embeddings_4096Access.write;
export const embeddings_4096Disclose = embeddings_4096Access.disclose;

export const embeddings_512Access = defineComponentTableRules({
  table: "embeddings_512",
  rules: {
    read: makeFunctionReference<"query">("access:embeddings_512Read"),
    write: makeFunctionReference<"query">("access:embeddings_512Write"),
    disclose: makeFunctionReference<"query">("access:embeddings_512Disclose"),
  },
});
export const embeddings_512Read = embeddings_512Access.read;
export const embeddings_512Write = embeddings_512Access.write;
export const embeddings_512Disclose = embeddings_512Access.disclose;

export const embeddings_768Access = defineComponentTableRules({
  table: "embeddings_768",
  rules: {
    read: makeFunctionReference<"query">("access:embeddings_768Read"),
    write: makeFunctionReference<"query">("access:embeddings_768Write"),
    disclose: makeFunctionReference<"query">("access:embeddings_768Disclose"),
  },
});
export const embeddings_768Read = embeddings_768Access.read;
export const embeddings_768Write = embeddings_768Access.write;
export const embeddings_768Disclose = embeddings_768Access.disclose;

export const filesAccess = defineComponentTableRules({
  table: "files",
  rules: {
    read: makeFunctionReference<"query">("access:filesRead"),
    write: makeFunctionReference<"query">("access:filesWrite"),
    disclose: makeFunctionReference<"query">("access:filesDisclose"),
  },
});
export const filesRead = filesAccess.read;
export const filesWrite = filesAccess.write;
export const filesDisclose = filesAccess.disclose;

export const memoriesAccess = defineComponentTableRules({
  table: "memories",
  rules: {
    read: makeFunctionReference<"query">("access:memoriesRead"),
    write: makeFunctionReference<"query">("access:memoriesWrite"),
    disclose: makeFunctionReference<"query">("access:memoriesDisclose"),
  },
});
export const memoriesRead = memoriesAccess.read;
export const memoriesWrite = memoriesAccess.write;
export const memoriesDisclose = memoriesAccess.disclose;

export const messagesAccess = defineComponentTableRules({
  table: "messages",
  rules: {
    read: makeFunctionReference<"query">("access:messagesRead"),
    write: makeFunctionReference<"query">("access:messagesWrite"),
    disclose: makeFunctionReference<"query">("access:messagesDisclose"),
  },
});
export const messagesRead = messagesAccess.read;
export const messagesWrite = messagesAccess.write;
export const messagesDisclose = messagesAccess.disclose;

export const streamDeltasAccess = defineComponentTableRules({
  table: "streamDeltas",
  rules: {
    read: makeFunctionReference<"query">("access:streamDeltasRead"),
    write: makeFunctionReference<"query">("access:streamDeltasWrite"),
    disclose: makeFunctionReference<"query">("access:streamDeltasDisclose"),
  },
});
export const streamDeltasRead = streamDeltasAccess.read;
export const streamDeltasWrite = streamDeltasAccess.write;
export const streamDeltasDisclose = streamDeltasAccess.disclose;

export const streamingMessagesAccess = defineComponentTableRules({
  table: "streamingMessages",
  rules: {
    read: makeFunctionReference<"query">("access:streamingMessagesRead"),
    write: makeFunctionReference<"query">("access:streamingMessagesWrite"),
    disclose: makeFunctionReference<"query">(
      "access:streamingMessagesDisclose",
    ),
  },
});
export const streamingMessagesRead = streamingMessagesAccess.read;
export const streamingMessagesWrite = streamingMessagesAccess.write;
export const streamingMessagesDisclose = streamingMessagesAccess.disclose;

export const threadsAccess = defineComponentTableRules({
  table: "threads",
  rules: {
    read: makeFunctionReference<"query">("access:threadsRead"),
    write: makeFunctionReference<"query">("access:threadsWrite"),
    disclose: makeFunctionReference<"query">("access:threadsDisclose"),
  },
});
export const threadsRead = threadsAccess.read;
export const threadsWrite = threadsAccess.write;
export const threadsDisclose = threadsAccess.disclose;

