# Security policy

## Supported versions

There is no supported release yet. The public `main` branch is pre-alpha and may
change without notice. Security reports are still welcome and will be triaged.

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/tushark88/collab-review-layer/security/advisories/new).
Do not file suspected vulnerabilities in public Issues or discussions. If the
private reporting form is unavailable, contact the repository owner through the
verified contact method on their GitHub profile without including exploit details
in an initial public message.

Never include tokens, credentials, private URLs, captures, comments, or customer
data in a report. Use synthetic reproduction material.

Protected comment drafts belong in shell-owned DOM. Cooperative embedded
prototypes exchange only validated Anchor context, content-free placement
metadata, and an opaque request ID; they must never receive the textarea, draft
body, author identity, or submission credentials. The shell must load the
package-owned frame-host stylesheet rather than delegate composer DOM or styling
to the prototype or consumer fixture. Every frame generation is bound to the
shell-owned complete Anchor Context supplied to `ReviewFrameHost.open`; a child
draft with different Review, Prototype, Revision, Viewport, Variant, Route,
Device, or Surface identity is rejected before its composer opens.
The frame host additionally requires current transient user activation for a
draft open, rejects containers across closed Shadow DOM boundaries, keeps its
composer above ordinary frame stacking contexts, and preserves any non-empty
shell-owned body when the peer reports dismissal or an unavailable attachment.
Hidden active drafts continue to reclaim focus from the embedded Prototype.

Expect an acknowledgement within seven days. Timelines for remediation and
disclosure will be agreed based on severity and exploitability; there is no bug
bounty program.

The `v0.1.0` release gate includes threat-model, webhook-signature,
authorization, secret, dependency, and export-redaction checks.
