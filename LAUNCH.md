# Launch plan and gates

Statuses: **verified** = evidenced now; **partial** = useful local output exists;
**blocked** = needs a material choice or external authority; **deferred** = gated
by an earlier phase.

| Phase | Status | Evidence / exit condition |
|---|---|---|
| 1. Implementation tracker | partial | Twelve initial GitHub Issues exist in the private repository. GitHub Project creation is blocked only by the live token's missing `project` and `read:project` scopes. Linear is only an adapter and the private tracker for TourHero-specific integration. |
| 2. Private personal repository | verified | `tushark88/collab-review-layer` exists, is private, has Issues enabled, detects MIT, and uses `main`. Exact commit and CI are verified after each push. |
| 3. Provenance inventory | verified | `docs/PROVENANCE.md`; reference checkout inspected read-only with dirty state recorded. |
| 4. Generic review kernel | partial | Domain records, append-only event store, thread lifecycle, redacted export, locked dependencies, strict typecheck, tests, and CI workflow. Browser UI/bridge and durable DB remain. |
| 5. Work-tracker interface | partial | Provider-neutral seam, search tiers, confidence policy, and sync contracts exist locally. |
| 6. Linear adapter | partial | Generic injectable HTTP adapter and signed webhook primitive; live OAuth/API proof deferred. |
| 7. GitHub Issues adapter | partial | Generic injectable HTTP adapter and signed webhook primitive; live App/API proof deferred. |
| 8. TourHero pinned integration | deferred | Requires private repo release, maintainer access decision, and private consumer changes. |
| 9. Complete live TourHero review | deferred | Must prove creation, comments, sync, disposition, completion synthesis, and evidence export. |
| 10. Remove assumptions and publish v0.1 | deferred | Requires phase 9 and every publication check below. |

## External mutation gates

- GitHub: read authenticated identity first; create only under the explicitly
  confirmed personal owner and chosen name; repository starts private.
- Tracker: verify workspace/team/container and actor before creating or updating
  records. No tracker writes until the tracker decision is made.
- TourHero: preserve the dirty reference checkout and never merge its PR. Private
  integration changes require a fresh checkout/status/authority check.
- Publication: changing repository visibility requires explicit approval after
  all gates pass.

## Publication gate

Remain private until one complete TourHero review succeeds and GitHub Issues
proves the provider seam. Before `v0.1.0` becomes public, verify provenance,
secrets, dependency licenses, security, accessibility, clean install, pinned
upgrade, redacted agent export, and release artifact integrity.

## Decisions needed later

1. The precise TourHero maintainer principal before granting repository access.
2. Verified Linear actor/workspace/project scope only when private TourHero
   consumer integration begins.
3. Auth/storage reference implementation and hosting/cost choices.

## Tracker operating model

- **Private incubation and public project:** GitHub Issues and a GitHub Project
  are the native implementation, contribution, and bug front door for
  `collab-review-layer` from inception. The repository remains private until the
  publication gate passes.
- **TourHero integration:** TourHero-only consumer and product work remains in
  TourHero Linear and never becomes the OSS project's implementation tracker.
- **Later compatibility:** Plane Community is an adapter/fixture target, not
  infrastructure for running this project. Do not self-host it absent a separate
  data-custody requirement and operating budget.
- **Canonical history:** trackers are projections. The shell retains anchors,
  captures, dispositions, event history, and synchronization receipts.
