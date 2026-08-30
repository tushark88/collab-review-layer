# Contributing

This project is private during clean-room incubation. Contribution instructions
become active when the repository passes the publication gate.

## Development contract

- Use synthetic or explicitly redacted fixtures only.
- Do not add consumer branding, routes, data, credentials, deployment settings,
  business logic, screenshots, recordings, or private tracker content.
- Keep provider behavior behind the work-tracker interface.
- Preserve append-only review history and immutable revision/capture identity.
- Prefer a duplicate Work Item over an ambiguous automatic attachment.
- Add focused tests for behavior changes and run `npm run check`.

## Reporting work

Generic implementation and bugs use this repository's GitHub Issues and Project.
Consumer-specific work belongs in that consumer's private tracker and must not be
copied into public issues.
