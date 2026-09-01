# Launch plan and gates

Statuses: **verified** = evidenced now; **partial** = useful local output exists;
**blocked** = needs a material choice or external authority; **deferred** = gated
by an earlier phase.

| Phase | Status | Evidence / exit condition |
|---|---|---|
| 1. Implementation tracker | verified | GitHub Project `Collab Review Layer` is linked to the repository with Issues #2-#12 and configured Phase, Area, and Priority fields. Linear is only an adapter and the private tracker for TourHero-specific integration. |
| 2. Public pre-alpha repository | verified | `tushark88/collab-review-layer` is public under the verified personal owner, detects MIT, and uses protected `main`. Public-readiness audit, security hardening, active ruleset, exact commit, CI, and CodeQL passed; no supported release or tag exists. |
| 3. Provenance inventory | verified | `docs/PROVENANCE.md`; reference checkout inspected read-only with its fixed revision and pre-existing worktree state retained only in the private audit. |
| 4. Generic review kernel | partial | Domain records, explicit authorization, versioned current-Anchor admission and owner replacement, legacy-location recovery state, bridge protocol and browser transport, sandboxed cross-origin frame host, accessible responsive shell renderer, in-memory and durable append-only file stores, thread lifecycle, redacted export, locked dependencies, strict typecheck, Node and Chromium tests, and CI workflow. DOM reattachment, in-prototype comment placement, threaded browser panels, and production persistence remain. |
| 5. Work-tracker interface | partial | Provider-neutral seam, ordered four-tier search, confidence policy, stable-context parsing, and sync contracts are tested. Bidirectional reply reconciliation remains. |
| 6. Linear adapter | partial | Generic injectable HTTP adapter, four-tier candidate behavior, signed webhook verification, and durable delivery replay seam; live OAuth/API proof deferred. |
| 7. GitHub Issues adapter | partial | Generic injectable HTTP adapter, four-tier candidate behavior, disposition mapping, signed webhook verification, and durable delivery replay seam; live App/API proof deferred. |
| 8. TourHero pinned integration | deferred | Requires a tagged integration-candidate prerelease, maintainer access decision, and private consumer changes. |
| 9. Complete live TourHero review | deferred | Must prove creation, comments, sync, disposition, completion synthesis, and evidence export. |
| 10. Remove assumptions and publish v0.1 | deferred | Requires phase 9 and every publication check below. |

## External mutation gates

- GitHub: read authenticated identity first; create only under the explicitly
  confirmed personal owner and chosen name; repository starts private.
- Tracker: verify workspace/team/container and actor before creating or updating
  records. No tracker writes until the tracker decision is made.
- TourHero: preserve the dirty reference checkout and never merge its PR. Private
  integration changes require a fresh checkout/status/authority check.
- Publication: public pre-alpha visibility is separately authorized after its
  readiness gate. A supported `v0.1.0` release still requires the full gate below.

## Public pre-alpha gate

Before making the repository public, verify clean-room provenance, full-history
secret scanning, dependency licenses/signatures, webhook and transport security,
public contribution/security documentation, clean install, strict typecheck,
tests, least-privilege CI, immutable Action pins, security scanning, and branch
rules. Label the project pre-alpha and make no supported-release claim.

## `v0.1.0` release gate

Do not tag or publish `v0.1.0` until one complete TourHero review succeeds and
both Linear and GitHub Issues prove the provider seam. Then re-run provenance,
secrets, dependency licenses, security, accessibility, clean install, pinned
upgrade, redacted agent export, and release artifact integrity checks.

Any supported production integration must retain the sandboxed frame-host and
real-browser security suite; replacing them requires equivalent exact-origin,
generation, teardown, and hostile-navigation evidence.

## Decisions needed later

1. The precise TourHero maintainer principal before granting repository access.
2. Verified Linear actor/workspace/project scope only when private TourHero
   consumer integration begins.
3. Production identity, storage, hosting, retention, and cost choices.

## Tracker operating model

- **Public pre-alpha project:** GitHub Issues and a GitHub Project are the native
  implementation, contribution, and bug front door for `collab-review-layer`.
- **TourHero integration:** TourHero-only consumer and product work remains in
  TourHero Linear and never becomes the OSS project's implementation tracker.
- **Later compatibility:** Plane Community is an adapter/fixture target, not
  infrastructure for running this project. Do not self-host it absent a separate
  data-custody requirement and operating budget.
- **Canonical history:** trackers are projections. The shell retains anchors,
  captures, dispositions, event history, and synchronization receipts.
