import { expect, test } from "vitest";
import schema from "./schema.js";
import * as rules from "./access.js";

// Declaration checks, not a simulation of native authorization.
test("every table binds current read, write and disclosure policies and retains source requirements", () => {
  const wire = JSON.parse(schema.export());
  expect(wire.accessCoverage).toBe("strict");
  expect(wire.tables.map((t: any) => t.tableName).sort()).toEqual([
    "apiKeys",
    "embeddings_1024",
    "embeddings_128",
    "embeddings_1408",
    "embeddings_1536",
    "embeddings_2048",
    "embeddings_256",
    "embeddings_2560",
    "embeddings_3072",
    "embeddings_4096",
    "embeddings_512",
    "embeddings_768",
    "files",
    "memories",
    "messages",
    "streamDeltas",
    "streamingMessages",
    "threads",
  ]);
  for (const table of wire.tables) {
    expect(table).not.toHaveProperty("owner");
    expect(table).not.toHaveProperty("unrestricted");
    expect(table.access).toBeDefined();
    expect(table.governingRule).toBeDefined();
    expect(table.retain).toBeDefined();
    for (const kind of ["Read", "Write", "Disclose"]) {
      const rule = (rules as any)[table.tableName + kind];
      const policy = JSON.parse(rule.exportQueryPolicy());
      expect(policy.reads).toEqual([table.tableName]);
      expect(policy.calls).toEqual(["_reference/policySlot/access"]);
      expect(Object.keys(policy.slots)).toEqual(["access"]);
    }
  }
});
