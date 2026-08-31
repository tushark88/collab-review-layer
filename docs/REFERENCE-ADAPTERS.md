# Reference security adapters

The package includes local adapters that make the security seams executable and
testable without choosing a production identity or database provider. They are
safe references, not a hosted deployment architecture.

## Authorization

`ReviewKernel` requires a `ReviewAuthorizer`. `StaticReviewAuthorizer` grants an
explicit set of actions to one actor within one Review, optionally scoped to one
Thread, and denies everything else. Duplicate scopes and malformed identifiers
fail closed. It has no wildcard or implicit administrator grant. Production
consumers must bind their authenticated principal and policy engine through the
same interface; an actor ID supplied by a browser is not authentication. The
reference kernel's authorization contract is deliberately synchronous. Its type
and runtime guard reject promise-returning authorizers before any state change;
consumers needing network or database policy checks must complete them before
calling the synchronous kernel or provide a future async kernel implementation.

## Event persistence

`FileEventStore` requires an absolute path and writes newline-delimited events
with owner-only permissions. Each append:

- acquires an exclusive adjacent lock file;
- gives readers the same lock so they never inspect a partial append;
- validates all prior records, unique event IDs, and contiguous sequences;
- enforces a configurable total-size bound;
- appends one JSON-serializable event and calls `fsync`;
- hardens every newly created directory ancestor and fsyncs its parent entry.

`EventStore.readAll()` provides the complete ordered history needed for kernel
startup. `ReviewKernel` replays known thread and message events synchronously,
validates their lifecycle invariants, and ignores unknown extension event types.
It therefore fails closed on malformed known history while remaining compatible
with append-only extensions. Before every read or mutation, a kernel refreshes
from that ordered history. Mutations carry the observed event count into append,
where the store rejects a stale writer before persistence. Multiple kernels can
therefore share a reference store without silently losing each other's updates.
Generated Thread and per-Thread Message identifiers are checked for collisions
before append. Lifecycle mutations also use one captured operation timestamp for
both returned state and the persisted event, so refresh and restart cannot change
the displayed edit, deletion, or resolution time.

The adapter deliberately fails closed on corruption, conflicts, symlinks, or a
stale lock and repairs both its containing directory and a pre-existing data
file to owner-only mode when opened. The configured containing directory must be
dedicated to this store. It is suitable for local and single-host reference use.
Production deployments need transactional shared storage, backups, retention,
encryption, and an operator-owned recovery procedure.

## Webhook replay protection

Both tracker adapters require a `WebhookDeliveryLedger` and expose webhook
processing as a verified apply callback. The in-memory adapter is test-only.
`FileWebhookDeliveryLedger` atomically reserves a SHA-256 digest of the provider
and delivery ID in an absolute, owner-only directory. Successful application
creates a durable completed receipt; failed application removes only the pending
reservation so a provider retry can proceed. Provider IDs are never written to
disk. An existing ledger directory is repaired to owner-only mode before use.
Every newly created directory ancestor is separately hardened and its parent
entry is synced before the ledger writes a marker.

The file ledger intentionally does not expire completed receipts and requires
operator recovery for a pending marker left by a crashed process. A production
adapter must define retention and capacity limits and transactionally couple the
applied update with receipt completion across every webhook worker.

## Tracker search

Both provider adapters implement the ordered search tiers used by
`TrackerOrchestrator`: exact linked item, current container, open workspace, and
recent closed context. GitHub workspace kind is explicit (`user` or `org`) and
must match the configured repository owner. The GitHub adapter defaults to a
repository-scoped webhook boundary and will not reuse another repository's
Issues. Cross-repository search and reuse require the explicit
`webhookScope: "workspace"` configuration and a GitHub App or organization webhook that
actually delivers every repository in that workspace to the same verified
handler. The handler then rejects repositories outside the configured owner.
GitHub page results and Linear Relay
cursor pages are aggregated before matching; incomplete or over-limit GitHub
searches, changing result counts, short intermediate pages, and repeated GitHub
or Linear Issue identities are marked incomplete. Except for an exact shell-owned
link, all bounded tiers complete before fuzzy reuse; an incomplete tier forces a
new Work Item rather than scoring a partial result set. Both adapters recover
product, route, and anchor evidence only from the versioned stable context block.
Automatic reuse still requires the orchestrator's deterministic confidence
threshold plus an authenticated route or anchor match; ambiguous,
location-mismatched, or incomplete searches produce a new Work Item.

Created provider comments retain only their stable provider actor ID, comment ID,
body, and Work Item identity. GitHub Issue lifecycle events retain the stable
top-level sender ID. GitHub accepts only the explicitly supported Issue actions
needed for status, assignment, and label synchronization; unknown future actions
fail closed. Missing actors fail closed, and update/remove comment events are not
treated as newly created immutable replies. Consumers must map the provider actor
through their authorization policy before calling the kernel.

Linear container lookup is bound to configured workspace and team identifiers.
It verifies the credential's organization, filters projects by accessible team,
and rejects same-name ambiguity before creating or selecting a container. Search
results are filtered to that team, exact links outside it are rejected, and every
comment or disposition mutation verifies the Issue's current team first. Issue
webhooks must carry the configured `teamId`; Comment webhooks verify their
containing Issue through the API before application. Linear label projection is
explicit: consumers configure exact public label names to provider label IDs,
unconfigured names fail closed, and the adapter returns only labels reported by
Linear after creation.
GitHub container lookup likewise rejects a caller workspace that differs from
the configured owner and validates the provider repository identity, owner
login, and owner type (`User` or `Organization`) before returning trusted
container metadata.
