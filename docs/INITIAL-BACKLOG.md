# Initial GitHub Project backlog

Create these as repository Issues only after authenticated owner/repository checks
pass. Do not create them in TourHero Linear.

| Order | Proposed issue | Exit condition |
|---|---|---|
| 1 | Establish CI and clean-install verification | Locked dependencies; tests and strict typecheck pass from a clean checkout. |
| 2 | Implement durable reference persistence | Append-only events and immutable identities survive process restart. |
| 3 | Define versioned bridge protocol | Cooperative iframe handshake, origin allowlist, navigation and anchor messages are documented and tested. |
| 4 | Build desktop/mobile/custom viewport shell | Pointer/comment modes and viewport navigation pass keyboard and accessibility tests. |
| 5 | Implement resilient anchoring | Current document-space Anchors are enforced; legacy or orphaned locations report recovery state instead of misplacing pins. |
| 6 | Add capture-provider seam | Immutable manifests and digests bind captures to full review context. |
| 7 | Complete Linear adapter contract tests | Search order, issue creation, comment sync, disposition mapping and signed webhook replay protection pass. |
| 8 | Complete GitHub Issues adapter contract tests | Same provider-neutral contract passes against GitHub semantics. |
| 9 | Implement completion synthesis | Decisions, conflicts and duplicates produce an auditable summary and optional implementation issues. |
| 10 | Integrate private TourHero consumer at pinned tag | No public-source contamination; exact release pin and private configuration verified. |
| 11 | Run complete TourHero review | End-to-end review, tracker sync, disposition, evidence and export verified. |
| 12 | Run v0.1 publication gate | Provenance, secrets, licenses, security, accessibility, install, upgrade and export pass. |
