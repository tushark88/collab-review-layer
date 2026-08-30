# GitHub bootstrap receipt

## Intended target

- repository: `collab-review-layer`;
- owner: Tushar's verified personal GitHub profile (login must be read live);
- initial visibility: private;
- license: MIT;
- tracker: repository Issues plus a repository-linked GitHub Project;
- publication: prohibited until the publication gate in `LAUNCH.md` passes.

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
