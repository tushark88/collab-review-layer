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

The Work Item description contains stable Review, Prototype, Revision, Viewport,
Variant, route, Anchor, Capture, and review-link context. The first shell Message
is posted as a tracker comment; it is not folded into that stable description.

## Synchronization

- Provider delivery IDs and shell event IDs are idempotency keys.
- Webhooks must pass signature, provider timestamp when available, and acquire a
  durable delivery reservation before any change is applied.
- A failed application releases its pending reservation so the provider can
  retry. A successful application finalizes the reservation before returning.
- Provider comments can append Messages; they cannot rewrite shell history.
- Loop markers prevent a shell-originated comment from returning as a duplicate.
- Reconciliation is explicit and auditable after partial failures.

The reference delivery ledger uses atomic file creation so completed receipts
survive process replacement on one host while failed applications stay
retryable. Production deployments need shared storage that transactionally
couples the applied update and completed receipt, with an explicit retention
policy.

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
