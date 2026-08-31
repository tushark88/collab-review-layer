# Public pre-alpha security review — 2026-08-31

## Scope

All tracked source, tests, workflows, documentation, dependency metadata, and Git
history through the publication candidate were reviewed. The TourHero reference
checkout was not modified or copied.

## Checks

- strict TypeScript checking and behavior tests;
- npm vulnerability audit and registry signature/attestation verification;
- secret-pattern and private-consumer provenance scans of the worktree and history;
- webhook raw-body signature, timestamp, size, and delivery-ID handling;
- HTTP credential transport, redirect, plaintext, and timeout behavior;
- GitHub Actions permissions and third-party Action pinning;
- repository visibility, security features, rulesets, and CI status;
- public README, contribution, conduct, vulnerability-reporting, and threat-model
  documentation.

## Findings addressed

1. Linear replay validation used a non-existent `Linear-Delivery-Time` header.
   It now validates the official payload/header timestamp within one minute.
2. A malformed non-hex signature could reach `timingSafeEqual` with a differently
   sized buffer. Strict 64-character hex validation now fails cleanly first.
3. Webhook bodies and delivery IDs were unbounded or optional. The reference
   handlers now reject empty/oversized bodies and missing delivery IDs.
4. The HTTP transport allowed default redirects and had no timeout or HTTPS
   enforcement. It now refuses redirects, bounds requests, and requires HTTPS
   outside loopback development.
5. CI Actions used movable tags. Actions are pinned to immutable commit SHAs and
   security scanning/dependency automation are configured.

## Residual risk

This is contract/reference pre-alpha software, not a production system.
Transactional shared delivery storage, browser origin isolation, capture
privacy, production authorization and storage, accessibility, and upgrade safety
remain release blockers. No `v0.1.0` release is authorized by this review.

## Publication verification

The public publication candidate `45ee489ef6be5716a7d94ff24c217573107b83f9`
passed CI and CodeQL. GitHub reported zero code-scanning, secret-scanning, and
Dependabot alerts. The public repository has secret scanning and push protection,
private vulnerability reporting, SHA-pinned GitHub-owned Actions, read-only
default workflow permissions, Dependabot updates, and an active protected-main
ruleset. The mixed TourHero milestone Project remains private.

## Independent xhigh follow-up

A second clean-room and security pass reviewed the complete public Git history,
tracked files, public issues and comments, pull requests, CI logs, and package
contents. It also compared every public tracked blob with 5,884 unique tracked
blob hashes from the reference checkout and ran a token-sequence comparison
against the explicitly identified reference implementation files.

Results:

- no identical tracked blobs;
- no private-consumer identifiers in any source, test, workflow, or dependency
  metadata revision;
- no suspicious large or binary objects, releases, tags, or Actions artifacts;
- no private-consumer matches in 30 public CI runs;
- only high-level provenance and release-gate references in public documentation
  and the three intentionally named consumer-integration milestone issues;
- maximum cross-code overlap of six contiguous generic tokens, with no evidence
  of copied implementation.

The follow-up found and addressed four independent hardening gaps:

1. Agent export used a denylist of sensitive field names. Unknown strings and
   anchor text now fail closed through redaction while explicit identity and
   review-context fields remain readable.
2. `InMemoryEventStore.append` returned the nested object retained by the store,
   allowing a caller to mutate recorded payload history. It now returns a clone.
3. GitHub issue-search context could be interpreted as search qualifiers. Route
   and anchor inputs are now escaped quoted phrases limited to issue bodies.
4. The npm package had no explicit file allowlist. Package metadata now exposes
   only the public source entrypoint, and CI compares every packed path against
   an explicit reviewed package manifest.

The follow-up also added fail-closed review authorization, durable local event
storage, retry-safe file-backed webhook reservations and completed receipts,
stable-context parsing, and real exact/current/open-workspace/recent-closed
search behavior in both tracker adapters.

Subsequent review found that a syntactically valid context block was still
tracker-editable evidence. Context blocks are now HMAC-authenticated and bound
to the provider's immutable Work Item ID before their route or Anchor can affect
matching; edited, forged, and cross-item copied blocks fail closed.

Review also found two partial-integration gaps. Context attachment retries now
resume against the retained provider Work Item instead of creating another,
while unknown initial-creation outcomes stop for reconciliation. Definitive
provider refusals can retry, and bounded capacity evicts only safe idle records.
Outbound tracker-comment echoes now complete their delivery receipts without
being reimported as shell replies.

The final automated-review pass also separated webhook, context, and comment
signing secrets; repaired the event store's containing-directory mode; and made
outbound comment projection reconcile a Work Item-bound authenticated marker
before creation and after uncertain provider responses. Retries and adapter
replacement therefore recover a remotely accepted comment without reposting it.
Disposition comment keys also include the immutable Work Item identity, avoiding
cross-item collisions while retaining stable same-item retries.

The final first-principles pass removed fuzzy search short-circuiting, restored
product as an authenticated scoring signal, bound Linear same-name project lookup
to the verified workspace and configured team, rejected GitHub pull-request and
non-created issue-comment webhooks, and removed cross-item disposition-comment
collisions. Exact links remain the only safe search short-circuit.

Review follow-up then made authorization synchrony runtime-enforceable, retained
stable provider actor/comment identity for inbound authorization, rejected Linear
comment edits as new replies, failed prematurely short GitHub search pages closed,
and keyed disposition comments by immutable lifecycle transition rather than by
the disposition value or reason.

The matching follow-up made Prototype identity an orchestrator-derived product
signal and normalized GitHub Work Item/repository/container identity across
provider casing, preventing avoidable duplicate projections. Prototype identity
also uses the same non-empty, single-line normalization for storage and scoring.

The closing adapter-boundary pass restricted every Linear search, exact lookup,
mutation, and webhook to the configured team; made Linear label projection
explicit and provider-confirmed; and rejected unknown GitHub Issue actions before
application. Supported GitHub and Linear lifecycle events now retain only the
validated state, assignment, and label fields needed by the apply callback.
These checks preserve the provider-neutral contract without treating provider
credentials as authorization for every Work Item in a workspace.

The closing review also made Linear same-name project creation single-flight in
the local reference adapter, treated malformed pagination metadata as incomplete,
and normalized optional disposition reasons before durable append so whitespace
cannot make review history unreplayable.

The public pre-alpha remains unsupported. Browser-origin isolation, resilient
anchoring, capture privacy, bidirectional reconciliation, production identity
and shared storage, accessibility, upgrade tests, a complete private-consumer
review, and a human-approved release remain `v0.1.0` blockers.
