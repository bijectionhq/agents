# @bijectionhq/agents

This is a maintained fork of get-convex/agent at
`3e5bc1f698877b8ff55bd56f62a76d92cafc2bbd`. The package keeps inherited
validators, function references, serialization, and transaction behavior. Its
SDK imports resolve through the application's single `bijection` installation.
The component owns `defineAgent`, `agentsModule`, model generation, response
validation and tool-loop orchestration, exposed by `@bijectionhq/agents/native`.
The root entry retains the inherited `Agent` conversation API. Service runs are
imported explicitly from `/native`; native run transport comes from
`bijection/agents`. Conversation storage and streaming retain their inherited implementation. The
SDK supplies the `agentExecution` transport; the engine still admits runs, retains
checkpoints and source custody, enforces bounds, and authorizes output delivery.
Moving the recipe does not move these enforcement decisions into application code.

Every inherited difference is checked by the same Concave source in Bijection.
Mechanical module and public identifier changes have explicit recipes in
`concave.json`. Runtime symbols and validator markers are never rebranded.
Semantic changes require narrow `concave:begin` / `concave:end` fences with
`why`, `witness`, `preserves`, and `remove-when`, followed by a recorded
binding. Never approve an entire source file to avoid explaining its changed
invariants.

Run `just concave check`, then the selected build and tests. Land through
the platform `stack repo land --repository <this-worktree>` owner. Record bounded source exceptions before publication. Upstream updates use
ordinary merge commits, followed by inspection and narrowly justified repairs.
Original examples and documentation are retained for comparison; they do not
advertise Bijection's native authority, billing, or recovery guarantees. GitHub
Actions are disabled. Builds run remotely; hosted qualification is explicit and uses Atlas.

## Native interaction admission

`defineVerification`, `defineChallenge` and `defineInteraction` belong to
`bijection/sessions`. Their shared adapter declares installed verifiers and
transports answers to the engine. The engine executes private checks, budgets
attempts, attests named facts and binds sessions to one native interaction
context. Application handlers do not submit a match verdict or mint proofs.
Verification has one native owner; the retired component verification and
interaction tables are removed. Inherited conversation storage remains.

`issuedSessions({ roles, interaction })` composes with both `defineMcpServer`
and `defineAgent`. Roles remain capability bundles; typed evidence conditions
attach to permissions in the existing access model. Each operation names its
required permission on its target. Native operation proposals own exact terms,
trusted presentation, agreement and atomic consumption. Write rules read
agreement through `requireAgreement`; an ordinary handler cannot supply the
receipt. Native agent runs wait for the proposal's decision and resume through
the scheduler while retaining their source obligations.

Closing an authorization context invalidates its bound sessions without a scan.
MCP request ownership has its own durable owner so request recovery survives
access-token replacement. An MCP application's interaction adapter closes that
owner through `close` in the same transaction. Conversation storage and
streaming remain component features; native runs and authorization remain engine
features.

See the [airline example](../../../examples/airline-desk/docs/phone-desk.md) for
the vocabulary, channel integration and transport limitations. Test presence and
source acceptance do not imply hosted qualification.

## Native table policies and source custody

Each installation must bind its `access` policy slot using
`componentAccessArgs` and `readAccessResults` from `bijection/server`.
`src/component/access.ts` registers ordinary native read, write and disclosure
queries. The engine runs them for direct component function calls as well as
client helpers. An unbound slot is refused; the component has no default allow.

The host receives the table, `componentPath`, and a discriminated `decision`:

- `read`: exact native requests and aligned private document images; null means
  a range request or an absent object. An empty result is still a searched range.
- `write`: native before/after images, including both sides of ownership changes.
- `disclose`: the requests, private images and exact native destination.

Return one result per request/change. Throw to refuse. Check current membership
and permissions in declared private policy inputs. These are decisions over a
searched population, not post-query row filters. Unknown tables, ranges,
resources and destinations should be refused. Stored user IDs and bearer tokens
are data; they do not identify the caller. `ctx.auth` and `policyExecution()`
supply the actual execution context. The path identifies nested runner policy
requests relative to this installation; it confers no authority.

Nested runners forward their decisions through the parent's bound slot and
prepend their installation name to `componentPath`. Hosts must decide these
requests explicitly too. Installation, callback handles, queue IDs, retries and
TTL expiry confer no service permission. Scheduled execution does not impersonate
the enqueueing user. Authorize only the intended native custody holder and
resource scope, with current source consent; refuse ordinary anonymous callers.

Retained custody preserves engine-observed source obligations, not an old allow
verdict. Every later read/release is checked against current policy. Custody keys:

- `apiKeys`: `_id`.
- `embeddings_1024`: `_id`.
- `embeddings_128`: `_id`.
- `embeddings_1408`: `_id`.
- `embeddings_1536`: `_id`.
- `embeddings_2048`: `_id`.
- `embeddings_256`: `_id`.
- `embeddings_2560`: `_id`.
- `embeddings_3072`: `_id`.
- `embeddings_4096`: `_id`.
- `embeddings_512`: `_id`.
- `embeddings_768`: `_id`.
- `files`: `hash`.
- `memories`: `_id`.
- `messages`: `threadId`.
- `streamDeltas`: `streamId`.
- `streamingMessages`: `threadId`.
- `threads`: `_id`.

A key groups obligations, not tenants. Unconfined scans and absent-key reads can
require a broader population; background sweeps need matching source consent.
Deleting a row or changing its key does not erase those obligations. Raw caller
values and external SDK secrets have no historical native lineage. Existing
untracked data is not certified by changing a schema.

The fork preserves inherited public algorithms and function contracts. No ACL
store, copied JWT, frozen permission verdict, admin fallback or second scheduler
is introduced. Generic actions keep their inherited attempt/retry semantics;
use current governed operations for business effects. They do not acquire an
exactly-once provider guarantee or a retained business-code contract by being
queued. Native operation acceptance, callback retention, credential custody and
external-call recovery remain the platform's existing owners.

The schema tests exercise real SDK declarations, not a native authorization
emulator. The platform's policy-slot and retained/scheduled-custody fixtures own
runtime enforcement tests. Source type refresh is not native runtime analysis
or deployed qualification. This source requires the recorded platform SDK
capabilities; an older npm range is not evidence that they have shipped. No npm
publication or hosted qualification is claimed.
