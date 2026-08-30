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

Provider searches aggregate every available page before scoring. GitHub searches
that report incomplete results or exceed the provider's 1,000-result retrieval
limit return no candidates from that tier. Linear searches likewise cap each
tier at 20 pages and 1,000 accumulated results. An unfinished tier at either
provider returns no candidates, preserving the
duplicate-over-misattachment policy.

The Work Item description contains stable Review, Prototype, Revision, Viewport,
Variant, route, Anchor, Capture, and review-link context. The first shell Message
is posted as a tracker comment; it is not folded into that stable description.
The context block carries an HMAC bound to its provider and immutable Work Item
ID. Adapters attach it only after provider creation returns that ID, and only a
verified block contributes route or Anchor score. Hand-authored fields, edits,
and signatures copied to another Work Item fail closed. An exact linked Work
Item remains trusted because that link is shell-owned durable history rather
than tracker-authored matching evidence. Deployments should configure a
dedicated context-signing secret; the reference adapter can derive it from the
webhook secret for backwards-compatible local setups.

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
  shell consumes. GitHub deliveries must name the configured repository.
- Linear Comment events use the payload's containing `issueId`, not the Comment
  record ID, as their Work Item identity.
- Loop markers prevent a shell-originated comment from returning as a duplicate.
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
