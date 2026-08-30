# Pre-alpha threat model

## Protected assets

- review messages, identities, anchors, captures, and immutable event history;
- provider credentials and webhook signing secrets;
- tracker assignment, priority, and workflow state;
- redacted agent exports and their provenance;
- consumer-private configuration and data kept outside this repository.

## Trust boundaries

1. The browser shell and a cooperative framed prototype communicate only through
   a versioned bridge with explicit origin and capability checks.
2. Tracker adapters run server-side. Provider tokens and signing secrets never
   enter browser bundles, captures, exports, fixtures, logs, or error messages.
3. Webhook handlers verify the exact raw body before parsing, reject oversized or
   malformed requests, validate replay context where the provider supplies it,
   and deduplicate provider delivery IDs in durable storage.
4. Capture and storage adapters treat review content as untrusted, potentially
   sensitive input. Renderers must isolate active content and enforce retention.
5. Agent exports are allowlisted projections, not database serialization.

## Principal threats and required controls

| Threat | Required control | Current state |
|---|---|---|
| Forged or replayed tracker webhook | HMAC-SHA256 raw-body verification; Linear one-minute timestamp window; durable delivery-ID deduplication | Verification implemented; durable deduplication pending persistence |
| Credential exfiltration through endpoint redirect or plaintext HTTP | HTTPS outside loopback, redirect refusal, bounded requests, server-side configuration | Implemented in reference HTTP transport |
| Cross-origin prototype control or data access | Exact origin allowlist, sandboxed iframe, capability handshake | Required for bridge SDK; not implemented |
| Anchor attached to wrong UI element | Multi-signal confidence and explicit orphan state | Contract defined; implementation pending |
| Capture leaks secrets or personal data | Explicit capture policy, masking, immutable manifest, access control and retention | Capture adapter pending |
| Tracker misattachment | Ordered search and deterministic high-confidence reuse; ambiguous cases create duplicates | Implemented and tested |
| Export leaks private fields | Explicit redaction policy and allowlisted schema | Reference redaction implemented; policy expansion pending |
| Dependency or CI compromise | Lockfile, minimal dependencies, immutable Action SHAs, read-only default permissions, dependency review, CodeQL and Dependabot | Configured for public pre-alpha |
| History contains private consumer material | Full-history provenance and secret scans before visibility changes and releases | Required at every publication gate |

## Out of scope for pre-alpha

There is no hosted service, browser UI, durable database, capture worker, or
production authentication implementation yet. Their security cannot be claimed
until those modules exist and receive dedicated review.
