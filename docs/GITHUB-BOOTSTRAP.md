# GitHub bootstrap receipt

## Intended target

- repository: `collab-review-layer`;
- owner: Tushar's verified personal GitHub profile (login must be read live);
- initial visibility: private;
- license: MIT;
- tracker: repository Issues plus a repository-linked GitHub Project;
- initial creation: private; public pre-alpha visibility requires the separate
  readiness gate in `LAUNCH.md`; `v0.1.0` remains independently gated.

## Required pre-mutation checks

1. `gh auth status` succeeds for the active account.
2. `gh api user` returns the intended personal login and immutable account ID.
3. The owner explicitly matches Tushar's intended personal owner; never infer it
   from a cached login or repository URL.
4. `OWNER/collab-review-layer` returns 404 and a repository search confirms there
   is no conflicting owned repository.
5. Repository creation parameters are read back before creating Project or Issues.

## Current receipt

Checked 2026-08-31 with live network access:

- authenticated login: `tushark88`;
- immutable GitHub account ID: `41539975`;
- credential source: keyring; active; Git protocol HTTPS;
- required repository/workflow scopes: present;
- `tushark88/collab-review-layer`: HTTP 404 before creation, confirming name
  availability for the verified owner;
- intended creation parameters: private repository, MIT license already present,
  Issues enabled, visibility change prohibited before the publication gate.
- repository created: `https://github.com/tushark88/collab-review-layer`;
- creation read-back: owner `tushark88`, visibility `private`, Issues enabled,
  default branch `main`, detected license `MIT`;
- initial backlog: Issues `#1` through `#12` created;
- GitHub Project: `https://github.com/users/tushark88/projects/1`, private and
  linked to `tushark88/collab-review-layer`;
- Project backlog: open Issues `#2` through `#12`, all in `Todo`, with Phase,
  Area, and Priority values assigned; Issue `#1` remains closed with CI evidence;
- Project views: the supported default table view is present. GitHub's Project
  API/CLI does not expose view creation or layout/filter configuration.

Earlier sandbox-only authentication failures were network false negatives and
must not be interpreted as credential invalidity. Live GitHub operations require
network-enabled execution.

## GitHub Markdown write safety

Programmatic Issue, pull-request, and comment bodies must contain real newline
characters. Use `--body-file`/stdin or a correctly encoded JSON request rather
than embedding literal `\n` text in a shell argument. After every write, read the
saved body back and reject the operation if literal newline escape sequences
remain. This applies to bootstrap scripts, agents, and one-off CLI commands.

## Public pre-alpha receipt

Verified 2026-08-31:

- repository visibility: public; package status: `0.0.0-prealpha`; no release tag;
- mixed implementation Project: remains private because it includes TourHero-only
  consumer milestones; repository Issues are the public contribution front door;
- CI and CodeQL: successful on publication commit `45ee489ef6be5716a7d94ff24c217573107b83f9`;
- GitHub code-scanning, secret-scanning, and Dependabot alert counts: zero;
- secret scanning, push protection, Dependabot security updates, and private
  vulnerability reporting: enabled where supported by GitHub Free;
- Actions: read-only default token, GitHub-owned actions only, immutable SHA pins
  required;
- active `Protect main` ruleset: pull requests, strict `check` and `CodeQL`,
  linear history, resolved threads, no deletion, and no force-push.

This receipt authorizes public pre-alpha collaboration only. Issue `#12` remains
the independent `v0.1.0` release gate.
