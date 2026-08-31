# Pre-alpha threat model

## Protected assets

- review messages, identities, anchors, captures, and immutable event history;
- provider credentials and distinct webhook, tracker-context, and comment
  signing secrets;
- tracker assignment, priority, and workflow state;
- redacted agent exports and their provenance;
- consumer-private configuration and data kept outside this repository.

## Trust boundaries

1. The browser shell and a cooperative framed prototype communicate only through
   a versioned bridge with explicit origin and capability checks.
2. Tracker adapters run server-side. Provider tokens and signing secrets never
   enter browser bundles, captures, exports, fixtures, logs, or error messages.
3. Webhook handlers verify the exact raw body before parsing, reject oversized or
   malformed requests, validate provider-specific schemas and repository scope,
   project only consumed fields, validate replay context where the provider
   supplies it, and deduplicate provider delivery IDs in durable storage.
4. Capture and storage adapters treat review content as untrusted, potentially
   sensitive input. Renderers must isolate active content and enforce retention.
5. Agent exports are allowlisted projections, not database serialization.

## Principal threats and required controls

| Threat | Required control | Current state |
|---|---|---|
| Forged, replayed, cross-repository, or lost tracker webhook | HMAC-SHA256 raw-body verification; strict supported-event schemas and repository binding; Linear one-minute timestamp window; retry-safe crash-durable delivery processing | Verified apply callbacks plus in-memory and fsynced atomic-file delivery ledgers implemented; production shared transactional storage pending |
| Credential exfiltration through endpoint redirect or plaintext HTTP | HTTPS outside loopback, redirect refusal, bounded requests, server-side configuration | Implemented in reference HTTP transport |
| Cross-origin prototype control or data access | Exact origin allowlist, sandboxed iframe, capability handshake | Required for bridge SDK; not implemented |
| Anchor attached to wrong UI element | Multi-signal confidence and explicit orphan state | Contract defined; implementation pending |
| Capture leaks secrets or personal data | Explicit capture policy, masking, immutable manifest, access control and retention | Capture adapter pending |
| Tracker misattachment or forged tracker context | Complete bounded fuzzy search; Work Item ID-bound HMAC context; separate product/repository signals; scoped container lookup; deterministic high-confidence reuse; ambiguous, unauthenticated, or incomplete tiers are not automatically reused | Implemented and tested |
| Duplicate Work Items after partial provider creation | Idempotency-key fingerprinting; coalesced process-local creation; retry against retained provider ID; unknown outcomes require reconciliation; pressure eviction limited to safe idle records | Reference coordinator implemented; shared durable production coordination pending |
| Duplicate outbound tracker comments | Provider- and Work Item-bound HMAC marker; preflight and post-failure bounded provider reconciliation; coalesced process-local mutation | Implemented in both adapters; shared durable production coordination pending |
| Shell-originated tracker comment loops | Work Item-bound HMAC outbound sync marker; verified marked deliveries complete without inbound apply | Implemented in both adapters |
| Signing-key boundary collapse | Distinct required webhook-verification, tracker-context, and outbound-comment secrets | Enforced by both adapter constructors |
| Export leaks private fields | Explicit redaction policy and allowlisted schema | Unknown strings fail closed through redaction; policy expansion remains required as schemas grow |
| Mutable in-memory references rewrite append-only history | Never return the object retained by an event store | Reference store returns structured clones and has regression coverage |
| Unauthorized review mutation | Explicit review/action grants, optionally Thread-scoped, checked before kernel state changes; promise-returning authorizers rejected; inbound provider actor/comment identity retained for consumer authorization | Fail-closed synchronous authorization interface and static-grant reference adapter implemented; production identity adapter pending |
| Corrupt, conflicting, or locally exposed persisted history | Atomic reader/writer exclusion, contiguous sequences, unique event IDs, bounded file size, owner-only file and containing directory, file and creation-directory fsync | Durable local file reference adapter implemented; production database adapter pending |
| Dependency or CI compromise | Lockfile, minimal dependencies, immutable Action SHAs, read-only default permissions, dependency review, CodeQL and Dependabot | Configured for public pre-alpha |
| History contains private consumer material | Full-history provenance and secret scans before visibility changes and releases | Required at every publication gate |

## Out of scope for pre-alpha

There is no hosted service, browser UI, production database, capture worker, or
production identity implementation yet. Their security cannot be claimed until
those modules exist and receive dedicated review.
