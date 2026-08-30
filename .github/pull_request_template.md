<!--
Pull request conventions

TITLE: <type>(<scope>): <summary>
Examples: fix(kernel): preserve immutable event payloads
          feat(github): add deterministic issue matching

Use a focused type such as feat, fix, docs, test, refactor, perf, or chore.
Keep the headings below. Delete optional sections only when they genuinely do
not apply. Never omit Security, privacy & provenance.
-->

## What & why

<!-- Explain the problem, motivation, and linked Issue or evidence. -->

## What changed

<!-- Group concrete code, test, and documentation changes by area. -->

-

## Review notes

**Problem / context:**

**This change:**

**Risk:** <!-- low / medium / high, plus what could break -->

**Where to focus:** <!-- the one or two most important files or areas -->

**Skim:** <!-- generated, mechanical, or low-risk changes -->

## Testing

<!-- List exact commands and outcomes. State plainly what is not yet verified. -->

-

## Security, privacy & provenance

- [ ] Fixtures are synthetic or explicitly redacted.
- [ ] No consumer-private code, data, assets, routes, credentials, deployment
      settings, tracker content, or business logic is included.
- [ ] New external input and persistence boundaries fail closed and have tests.
- [ ] The package surface and agent export remain intentionally bounded.
- [ ] I reviewed the diff for secrets and unexpected generated or binary files.

## Versioning

<!-- State the package version change and release impact, or explain why none applies. -->

n/a — no package version or release changed

## Follow-ups

<!-- Optional deferred work, rollout steps, or merge-order notes. -->

-

<!-- A human maintainer merges in GitHub. Do not enable auto-merge. -->
