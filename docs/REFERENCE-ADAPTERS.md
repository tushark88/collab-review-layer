# Reference security adapters

The package includes local adapters that make the security seams executable and
testable without choosing a production identity or database provider. They are
safe references, not a hosted deployment architecture.

## Authorization

`ReviewKernel` requires a `ReviewAuthorizer`. `StaticReviewAuthorizer` grants an
explicit set of actions to one actor within one Review and denies everything
else. It has no wildcard or implicit administrator grant. Production consumers
must bind their authenticated principal and policy engine through the same
interface; an actor ID supplied by a browser is not authentication.

## Event persistence

`FileEventStore` requires an absolute path and writes newline-delimited events
with owner-only permissions. Each append:

- acquires an exclusive adjacent lock file;
- gives readers the same lock so they never inspect a partial append;
- validates all prior records, unique event IDs, and contiguous sequences;
- enforces a configurable total-size bound;
- appends one JSON-serializable event and calls `fsync`.

The adapter deliberately fails closed on corruption, conflicts, symlinks, or a
stale lock. It is suitable for local and single-host reference use. Production
deployments need transactional shared storage, backups, retention, encryption,
and an operator-owned recovery procedure.

## Webhook replay protection

Both tracker adapters require a `WebhookDeliveryLedger` and expose webhook
processing as a verified apply callback. The in-memory adapter is test-only.
`FileWebhookDeliveryLedger` atomically reserves a SHA-256 digest of the provider
and delivery ID in an absolute, owner-only directory. Successful application
creates a durable completed receipt; failed application removes only the pending
reservation so a provider retry can proceed. Provider IDs are never written to
disk.

The file ledger intentionally does not expire completed receipts and requires
operator recovery for a pending marker left by a crashed process. A production
adapter must define retention and capacity limits and transactionally couple the
applied update with receipt completion across every webhook worker.

## Tracker search

Both provider adapters implement the ordered search tiers used by
`TrackerOrchestrator`: exact linked item, current container, open workspace, and
recent closed context. GitHub workspace kind is explicit (`user` or `org`), and
both adapters recover route and anchor evidence only from the versioned stable
context block. Automatic reuse still requires the orchestrator's deterministic
confidence threshold; ambiguous candidates produce a new Work Item.
