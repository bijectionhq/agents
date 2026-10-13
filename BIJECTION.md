# @bijectionhq/agents

This is a maintained fork of get-convex/agent at `3e5bc1f698877b8ff55bd56f62a76d92cafc2bbd`.
The package keeps inherited validators, function references, serialization, and
transaction behavior. Its SDK imports resolve through the application's single
`bijection` installation. Native agent runs remain owned by the platform engine;
conversation storage and streaming remain owned by this component.

Every inherited difference is checked by the same Concave source in Bijection.
Mechanical module and public identifier changes have explicit recipes in
`concave.json`. Runtime symbols and validator markers are never rebranded.
Semantic changes require narrow `concave:begin` / `concave:end` fences with
`why`, `witness`, `preserves`, and `remove-when`, followed by a recorded binding.
Never approve an entire source file to avoid explaining its changed invariants.

Run `just concave check`, then the selected build and tests. Land through
`scripts/land.py`; it refuses source-parity regressions. Upstream updates use
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
