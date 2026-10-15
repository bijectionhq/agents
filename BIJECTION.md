# @bijectionhq/agents

This is a maintained fork of get-convex/agent at `3e5bc1f698877b8ff55bd56f62a76d92cafc2bbd`.
The package keeps inherited validators, function references, serialization, and
transaction behavior. Its SDK imports resolve through the application's single
`bijection` installation. The platform engine owns admission, authority, deadlines and scheduled jobs.
This component owns agent authoring, model response interpretation, private
checkpoints, proposals, conversation storage and streaming.

Every inherited difference is checked by the same Concave source in Bijection.
Mechanical module and public identifier changes have explicit recipes in
`concave.json`. Runtime symbols and validator markers are never rebranded.
Semantic changes require narrow `concave:begin` / `concave:end` fences with
`why`, `witness`, `preserves`, and `remove-when`, followed by a recorded binding.
Never approve an entire source file to avoid explaining its changed invariants.

Run `just concave check`, then the selected build and tests. Land through the platform
`stack repo land --repository <this-worktree>` owner; it refuses source-parity
regressions. Upstream updates use
ordinary merge commits, followed by inspection and narrowly justified repairs.
Original examples and documentation are retained for comparison; they do not
advertise Bijection's native authority, billing, or recovery guarantees.
GitHub Actions are disabled. Verification is explicit and local.

## Private verification custody

The verification declaration, bounded interaction workflow and reactive client
are Bijection additions beside the inherited Agent. The component owns private
requests, attempts and provisional outcomes. Native scoped session admission
owns authority; a model response and a component row cannot grant it. Existing
conversation validators and hooks retain their meanings.

These additions were accepted in the platform repository at
`1b02e49756`, then moved to this source owner so platform imports remain generated.
Their definition and lifecycle checks run with the inherited component checks;
[the platform's native session owner](https://github.com/bijectionhq/bijection/blob/1b02e49756/crates/isolate/src/environment/udf/sessions.rs)
checks scoped admission. Source acceptance and test presence do not claim hosted
qualification.

## Governed agent ownership

Install the component with `app.use(agents, { name: "agents" })`, then pass
`components.agents` to `agentsModule` from this package. The package generates
application adapters; query and mutation callbacks preserve their native caller.
The root action driver remains in application scope under the inherited action
identity boundary. It is implemented here, not in a second SDK agents module.

The component retains each complete provider response before interpreting it.
Its private checkpoint and the engine's small execution fence share one mutation.
Operations become proposals; a person's ordinary reviewed operation commits the
proposal transition and nested business operation together. Provider attempts
retain their original step identity, and unknown dispatch is never blindly sent
again.

## Retained data cutover

Existing applications keep `legacyAgentTables()` from this package's explicit
`migration` entry while moving pre-component state. Fresh applications need no
root agent table. Migration runs in bounded steps under native declaration
custody. The engine verifies exact destination bytes before clearing a legacy
checkpoint body, preserves admission identities and terminal decisions, and
ends live old-program authority before handoff.

Proposal aliases preserve original IDs, contracts, native arguments, decisions
and `proposal:<original-id>` business request keys. Original root proposal rows
and native operation receipts remain retained. A copy is not permission to drop
retained table metadata: schema retirement still requires validated custody
migration. No archival copy creates a fresh session, job or provider attempt.
