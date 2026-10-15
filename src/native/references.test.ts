import { describe, expect, test } from "vitest";
import {
  linkedAgentReferences,
  selectedAgentReference,
  symbolicAgentReferences,
} from "./references.js";

const contract = "a".repeat(64);
const entry = (digest = contract) => ({
  contract: digest,
  args: '{"type":"object","value":{}}',
  returns: '{"type":"null"}',
});
describe("generated agent references", () => {
  test("linked names preserve exact identity in an immutable catalog", () => {
    const catalog = linkedAgentReferences({ ticketTriage: entry() });
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(catalog.ticketTriage)).toBe(true);
    expect(selectedAgentReference(catalog.ticketTriage)).toEqual({
      name: "ticketTriage",
      contract,
    });
    expect(Object.getPrototypeOf(catalog)).toBeNull();
  });
  test("a discovered symbol and fabricated reference cannot execute", () => {
    const symbols = symbolicAgentReferences();
    expect(symbols.ticketTriage).toBe(symbols.ticketTriage);
    expect(() => selectedAgentReference(symbols.ticketTriage)).toThrow(
      "native analysis",
    );
    expect(() => selectedAgentReference({} as any)).toThrow(
      "generated agents catalog",
    );
    expect(() => selectedAgentReference("ticketTriage" as any)).toThrow(
      "generated agents catalog",
    );
  });
  test("catalog identity and size are closed and bounded", () => {
    const discovered = symbolicAgentReferences();
    for (let i = 0; i < 16; i++) expect(discovered["agent" + i]).toBeTruthy();
    expect(() => discovered.agent16).toThrow("16 agents");
    for (const name of [
      "TicketTriage",
      "ticket_triage",
      "x".repeat(33),
      "",
      "__proto__",
    ])
      expect(() => linkedAgentReferences({ [name]: entry() })).toThrow();
    for (const digest of ["", "A".repeat(64), "a".repeat(63)])
      expect(() => linkedAgentReferences({ triage: entry(digest) })).toThrow();
    expect(() =>
      linkedAgentReferences(
        Object.fromEntries(
          Array.from({ length: 17 }, (_, i) => ["agent" + i, entry()]),
        ),
      ),
    ).toThrow("16 agents");
  });
});
