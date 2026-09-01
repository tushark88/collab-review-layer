# Contributing

`collab-review-layer` is public pre-alpha software. Issues and pull requests are
welcome, but maintainers may change interfaces before `v0.1.0` and cannot yet
promise production support.

## Start here

1. Search existing Issues and the public Project before filing new work.
2. Fork the repository and create a focused branch from current `main`.
3. Install with `npm ci --ignore-scripts`, install the local browser fixture with
   `npx playwright install --only-shell chromium`, and run `npm run check`.
4. Add synthetic tests for behavior changes.
5. Open a pull request that explains the problem, security/privacy impact, and
   verification performed.

Keep the repository pull request template headings. In particular, give
reviewers a compact problem/change/risk/focus summary, list exact verification
results, and complete the security, privacy, and provenance checklist. State
anything that is not yet verified instead of implying completion.

Pull request merging is always a human maintainer action. Agents and automation
may prepare a pull request and verify its checks, but must not merge it or enable
auto-merge.

Do not put vulnerability details in an Issue. Follow [SECURITY.md](./SECURITY.md).

## Development contract

- Use synthetic or explicitly redacted fixtures only.
- Do not add consumer branding, routes, data, credentials, deployment settings,
  business logic, screenshots, recordings, or private tracker content.
- Keep provider behavior behind the work-tracker interface.
- Preserve append-only review history and immutable revision/capture identity.
- Prefer a duplicate Work Item over an ambiguous automatic attachment.
- Add focused tests for behavior changes and run `npm run check`.
- Keep commits reviewable and do not bypass CI or repository rulesets.

## Reporting work

Generic implementation and bugs use this repository's GitHub Issues and Project.
Consumer-specific work belongs in that consumer's private tracker and must not be
copied into public issues.

By participating, you agree to follow [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).
