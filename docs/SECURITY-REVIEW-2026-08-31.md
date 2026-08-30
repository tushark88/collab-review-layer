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

This is contract/reference pre-alpha software, not a production system. Durable
delivery deduplication, browser origin isolation, capture privacy, authorization,
storage, accessibility, and upgrade safety remain release blockers because those
modules are not implemented. No `v0.1.0` release is authorized by this review.
