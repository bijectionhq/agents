/** Generated agent identities are symbols during discovery and bound after analysis. */
declare const agentReference: unique symbol;
declare const runReference: unique symbol;

/** A native run identity carrying only its result type, never authority. @public */
export type RunRef<Result = unknown> = string & {
  readonly [runReference]: Result;
};

/** An agent selected from the generated `agents` catalog. Selecting it grants
 * no authority; native operation admission verifies its contract. @public */
export type AgentReference<Args = any, Result = unknown> = Readonly<{
  [agentReference]: { args: (args: Args) => Args; result: Result };
}>;

export type AgentReferenceManifest = Readonly<
  Record<
    string,
    Readonly<{
      contract: string;
      args: string;
      returns: string;
    }>
  >
>;
type Selection = { name: string; contract: string | null };
const selections = new WeakMap<object, Selection>();
const NAME = /^[a-z][A-Za-z0-9]{0,31}$/;

/** Discovery emits names only, never invented contract meaning. @internal */
export function symbolicAgentReferences(): Readonly<
  Record<string, AgentReference>
> {
  const children = new Map<string, AgentReference>();
  return new Proxy(Object.freeze(Object.create(null)), {
    get(_target, name) {
      if (typeof name !== "string") return undefined;
      if (!NAME.test(name)) throw new Error("Invalid generated agent name");
      let reference = children.get(name);
      if (!reference) {
        if (children.size >= 16)
          throw new Error("An agent catalog contains at most 16 agents");
        reference = Object.freeze({}) as AgentReference;
        selections.set(reference, { name, contract: null });
        children.set(name, reference);
      }
      return reference;
    },
  });
}

/** Code generation emits the exact native contract identity. @internal */
export function linkedAgentReferences(
  manifest: AgentReferenceManifest,
): Readonly<Record<string, AgentReference>> {
  const entries = Object.entries(manifest);
  if (entries.length > 16)
    throw new Error("An agent catalog contains at most 16 agents");
  const catalog: Record<string, AgentReference> = Object.create(null);
  for (const [name, entry] of entries) {
    const { contract, args, returns } = entry;
    if (
      !NAME.test(name) ||
      typeof contract !== "string" ||
      typeof args !== "string" ||
      typeof returns !== "string" ||
      !/^[0-9a-f]{64}$/.test(contract)
    )
      throw new Error("Invalid generated agent contract");
    const argument = JSON.parse(args);
    const result = JSON.parse(returns);
    if (
      argument?.type !== "object" ||
      !result ||
      typeof result.type !== "string"
    )
      throw new Error("Invalid generated agent contract");
    const reference = Object.freeze({}) as AgentReference;
    selections.set(reference, { name, contract });
    catalog[name] = reference;
  }
  return Object.freeze(catalog);
}

/** A plain object or discovery symbol cannot start an execution. @internal */
export function selectedAgentReference(reference: AgentReference<any, any>): {
  name: string;
  contract: string;
} {
  const selected =
    reference !== null && typeof reference === "object"
      ? selections.get(reference)
      : undefined;
  if (!selected)
    throw new Error("Select an agent from the generated agents catalog");
  if (selected.contract === null)
    throw new Error(
      "Agent references require native analysis before execution",
    );
  return { name: selected.name, contract: selected.contract };
}
