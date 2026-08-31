# Agent contribution boundary

- Never merge a pull request or enable auto-merge. Stop after opening or updating
  the pull request and verifying its checks; a human maintainer merges in GitHub.
- A request to finish, publish, release, deploy, or proceed autonomously does not
  authorize a merge.
- Do not call GitHub REST, GraphQL, CLI, MCP, or app operations that merge a pull
  request or enable automatic merging.
- Use synthetic or explicitly redacted fixtures. Do not add consumer-private
  code, data, assets, routes, credentials, deployment settings, or tracker content.
- When writing GitHub Markdown through a CLI or API, send real newline characters
  through a body file/stdin or a correctly encoded JSON string. Never insert
  literal `\n` text as formatting. Read the saved body back and fail if literal
  newline escape sequences remain.
