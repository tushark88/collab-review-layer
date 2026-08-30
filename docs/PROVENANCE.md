# Provenance and clean-room extraction inventory

## Boundary

The TourHero Centralized Quotes checkout is reference-only provenance. No file
from that checkout may be copied into this project. Concepts may be independently
reimplemented only after being restated in brand-neutral domain language and
covered by synthetic tests.

Reference observed read-only on 2026-08-30:

- checkout: `tourhero-centralized-quotes-real-ui`;
- commit: `24d7280bf9d9c604f4924a72f78abeba5c04d498`;
- pre-existing dirty state: modified `Gemfile.lock`; untracked
  `bin/centralized-quotes-prototype.command`;
- relevant reference areas: one Vue prototype view, one Vue live-comments view,
  two Rails models, one controller, one migration, and two model specs.

The reference checkout was not modified by this extraction.

## Clean extraction inventory

| Capability | Generic concept allowed | Public implementation rule | TourHero-private material excluded | State |
|---|---|---|---|---|
| Review frame | viewport and variant presentation | new shell built from public contract | routes, copy, visual identity, fonts, assets | clean design |
| Commenting | pointer/comment modes and threaded discussion | independent state machine and synthetic fixtures | existing Vue/Rails source and database schema | kernel implemented |
| Anchoring | semantic + text + geometry + route evidence | new versioned anchor bundle | TourHero selectors, page structure, URLs | schema implemented |
| Revisions | immutable revision and archived capture identity | digest-bearing public records | Heroku apps, commit provisioning, Review Home | schema implemented |
| Captures | immutable evidence metadata | capture interface; no real media | screenshots, recordings, customer data | metadata implemented |
| Agent access | redacted JSON/NDJSON | allowlisted projection | prompts, orchestration, private policy | implemented |
| Trackers | generic Work Container/Work Item | provider-neutral seam plus generic adapters | workspace IDs, team IDs, labels, tokens | adapter core implemented |
| Auth/storage | capability and persistence interfaces | safe reference implementations | TourHero SSO, credentials, production DB | deferred |
| Consumer | package + bridge contract | pinned tagged dependency | TourHero adapter/configuration | deferred/private |

## Independence controls

1. Only synthetic identifiers, routes, authors, text, and captures are used.
2. TourHero is referenced only where provenance, consumer separation, or release
   gates require it; no TourHero implementation material is present.
3. No copied code is accepted; provenance review compares public files against the
   reference before publication.
4. Secret, license, and generated-artifact scans are publication gates.
5. The private consumer pins an exact signed/tagged release; it does not vendor
   public source or publish private configuration upstream.

## Tracker provenance separation

The tracker decision is operational input, not source-code provenance. Public
code may express Linear, GitHub, and later Plane through generic provider
contracts, but must not contain TourHero workspace/project/team identifiers,
private issue text, or credentials. The OSS implementation tracker is GitHub;
TourHero Linear is used only for private consumer integration after authenticated
actor and target-project verification.
