# Work-tracker projection model

The review shell owns review identity, messages, anchors, captures, immutable
revision context, dispositions, event history, and synchronization receipts.
Trackers own assignment, priority, labels, and workflow status. A tracker record
is therefore a projection, never the only copy of review evidence.

## Operating topology

| Work class | Current tracker | Visibility |
|---|---|---|
| Generic implementation and public contribution | GitHub Issues + GitHub Project in `collab-review-layer` | Public pre-alpha |
| TourHero consumer/integration work | TourHero Linear, separated by project/labels as configured | Private |
| OSS contributions and public bugs after publication | GitHub Issues + GitHub Project in the public repository | Public |
| Plane compatibility | Temporary adapter fixture only, later | Private test fixture |

The OSS project must stay outside TourHero. No OSS Linear project, second Linear
workspace, Plane instance, or self-hosted Plane deployment should be created.

## Creation and matching

For every new Thread, the orchestration module searches sequentially:

1. exact previously linked Work Item;
2. current Work Container;
3. open Work Items across the configured workspace/team;
4. recent closed Work Items for context.

Matches weight the current container, repository/product, route, anchor, labels,
open state, and recency. Only deterministic high-confidence results are reused.
Ambiguity creates a new Work Item and may record the best candidate as a possible
duplicate. This intentionally prefers duplicate cleanup over attaching review
history to the wrong work.

Only an exact shell-owned link may short-circuit the sequence. Fuzzy candidates
from all three bounded tiers are aggregated before scoring, so a strong current-
container result cannot hide conflicting workspace or closed context. Product
identity is derived from the Thread's immutable Prototype identity, recovered
from the authenticated stable context block, and scored as a separate signal
from repository identity; callers do not supply a duplicate optional value. The
same single-line normalization is used before signing, parsing, and scoring.

Provider searches aggregate every available page before scoring. GitHub searches
that report incomplete results or exceed the provider's 1,000-result retrieval
limit return an explicitly incomplete result. Linear searches likewise cap each
tier at 20 pages and 1,000 accumulated results. Changing counts, short pages,
repeated Work Item identities, and unfinished tiers are distinct from a complete
empty search. `TrackerOrchestrator` never fuzzy-reuses a partial candidate set;
it creates a new Work Item and may relate the strongest partial candidate as a
possible duplicate, preserving the duplicate-over-misattachment policy.

GitHub Work Item, repository, and container identities are normalized and
compared case-insensitively, matching provider semantics. Display casing cannot
remove confidence signals or cause the same issue to appear as two candidates.

The Work Item description contains stable Review, Prototype, Revision, Viewport,
Variant, route, Anchor, Capture, and review-link context. The first shell Message
is posted as a tracker comment; it is not folded into that stable description.
The context block carries an HMAC bound to its provider and immutable Work Item
ID. Adapters attach it only after provider creation returns that ID, and only a
verified block contributes route or Anchor score. Hand-authored fields, edits,
and signatures copied to another Work Item fail closed. An exact linked Work
Item remains trusted because that link is shell-owned durable history rather
than tracker-authored matching evidence. Both adapters require three distinct
server-side secrets: provider webhook verification, stable-context signing, and
outbound-comment signing. Sharing a value across those trust boundaries fails
configuration validation.

The in-memory reference creation coordinator retains the provider-assigned ID
before context attachment. A failed attachment retry resumes against that same
Work Item, and concurrent retries coalesce. If the initial provider request has
an unknown outcome, the coordinator requires reconciliation instead of risking
a second item. Definitive provider refusals remain safely retryable. Under
capacity pressure, the coordinator evicts only least-recently-used completed or
known-non-creation records; in-flight, partially attached, and unknown-outcome
records remain fail-closed. Its completed-result idempotency window is therefore
bounded. Production or multi-process deployments need a shared durable
coordinator, a defined retention policy, and an operator path for resolving
unknown outcomes.

Before container lookup, the orchestrator validates the caller's base
idempotency key and every derived item/comment key. Invalid or over-limit keys
therefore fail before a provider project or repository container can be created.

## Synchronization

- Provider delivery IDs and shell event IDs are idempotency keys.
- Webhooks must pass signature, provider timestamp when available, and acquire a
  durable delivery reservation before any change is applied.
- A failed application releases its pending reservation so the provider can
  retry. A successful application finalizes the reservation before returning.
- Completed and pending file receipts are fsynced with their containing
  directory before success is reported; removal is also directory-synced.
- Provider comments can append Messages; they cannot rewrite shell history.
- Supported webhook payloads are schema-checked and projected to the fields the
  shell consumes. GitHub deliveries must name the configured repository; pull
  request comments, non-created issue-comment actions, and unknown Issue actions
  are rejected rather than being imported as new review state.
- GitHub Issue lifecycle projections retain the verified status value or changed
  assignee/label identity for the corresponding action. Linear Issue projections
  retain the current workflow state ID, nullable assignee ID, and label IDs. The
  apply callback therefore receives enough state to synchronize the tracker-owned
  workflow, assignment, and label fields without exposing provider profiles.
- Created-comment projections retain stable provider actor and comment IDs for
  authorization, attribution, and deduplication. GitHub Issue lifecycle events
  likewise retain only the stable sender ID. Unattributed supported events fail
  closed; provider display names, email addresses, and other profile fields are
  not projected.
- Linear Comment events use the payload's containing `issueId`, not the Comment
  record ID, as their Work Item identity.
- Authenticated loop markers prevent a shell-originated comment from returning
  as a duplicate. A valid marked delivery is finalized in the delivery ledger
  without invoking the inbound apply callback; forged or edited markers and
  ordinary user comments are passed through unchanged.
- Outbound markers are bound to provider and immutable Work Item identity.
  Before comment creation—and after an uncertain response—the adapters search a
  bounded, fully paginated provider comment history for the exact marker. A
  found marker completes the mutation without reposting; absent results after
  an uncertain response remain fail-closed for later reconciliation.
- Each disposition projection requires the immutable shell transition/event ID.
  Comment idempotency keys bind opaque digests of that transition and the
  provider Work Item identity. Retries remain stable, while a later lifecycle
  transition—even with the same disposition and reason—cannot collide with the
  first projection.
- Reconciliation is explicit and auditable after partial failures.

The reference delivery ledger uses atomic file creation so completed receipts
are crash-durable on one host while failed applications stay retryable.
Production deployments need shared storage that transactionally
couples the applied update and completed receipt, with an explicit retention
policy.

For rejection, adapters record the required reason before moving the Work Item
to its final canceled/not-planned state. If the later state transition fails,
retry reconciliation may encounter the same reason marker again; duplicate
reason records are safer than a final rejection with no explanation.
Linear mutation payloads must also report `success: true`; an HTTP 200 response
or a GraphQL envelope without top-level errors is not treated as acceptance.

Disposition mapping:

| Shell disposition | Tracker workflow |
|---|---|
| accepted | open/actionable |
| rejected | canceled/not-planned, with recorded reason |
| implemented and verified | done/completed |

Review completion synthesizes decisions, conflicts, and duplicates. It may create
separate implementation Work Items, but Thread projection occurs when each Thread
is created rather than waiting for completion.

## Identity and mutation gate

Before any real provider call, verify the authenticated actor, workspace or
repository, Work Container, requested operation, and credential scope. Log only
boolean/scope metadata—never token values. Project/repository creation remains a
separate explicitly approved mutation.

The GitHub reference adapter is repository-scoped by default: search, exact
reuse, outbound comments, and inbound webhooks stay in the configured
repository. Cross-repository workspace search is enabled only with explicit
`webhookScope: "workspace"` configuration and a provider webhook installation
that covers the full configured owner. This keeps every reusable Work Item
inside the same bidirectional synchronization boundary.

The Linear reference adapter requires an exact configured workspace and team.
Container lookup verifies the credential's organization ID, filters same-name
projects to the configured team, and fails closed if more than one remains.
Candidate and exact-link reads, outbound mutations, and inbound webhooks remain
inside that team. Linear creation resolves requested public label names only
through an explicit configured name-to-ID map and reports the labels returned by
the provider; an unconfigured label fails before issue creation.
