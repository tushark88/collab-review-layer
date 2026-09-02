# Sandboxed review frame host

Browser consumers import `ReviewFrameHost` from
`collab-review-layer/browser`. The browser subpath contains only browser-safe
bridge, frame-host, shell-state, and domain modules; the package root also
exports server-side persistence and tracker modules.

`ReviewFrameHost` owns one cooperative Prototype frame behind four operations:
`open(config)`, `send(message)`, `snapshot()`, and terminal `close()`. Calling
`open` again validates the complete replacement first, then closes the prior
bridge, invalidates its generation, removes its listeners and frame where the
browser permits, and mounts the new frame. The host never exposes the frame's
`WindowProxy` as package state, and snapshots omit the source URL fragment so a
fragment bootstrap nonce does not leak into routine state or event logging.

When `draft` is negotiated, the shell must also load
`collab-review-layer/frame-host.css` and configure synchronous
`onDraftSubmit`. `ReviewFrameHost` then owns the composer DOM, styling, Escape,
Ctrl/Command+Enter submission, viewport clamping, and attachment to the framed
target. A missing callback is rejected before mounting; a missing owned style
asset fails closed when a draft opens. The callback receives the validated
request ID, trimmed body, and current Anchor, all in the shell document.
Child attachment coordinates are projected from the iframe's content viewport,
not its outer border box. The reference host accounts for frame padding,
borders, and positive axis-aligned CSS scaling before clamping the composer in
shell space.
Rotation, skew, reflection, perspective, and other non-axis-aligned transforms
on the frame or its composed ancestor chain are unsupported and hide the
composer instead of presenting a false attachment. The visible content bounds
are also intersected with composed overflow and paint-containment clips; hidden,
fully transparent, clip-path, and mask states hide the composer with the framed
content. If the frame belongs to an active modal dialog, the composer is mounted
inside that dialog so browser top-layer inertness cannot make its controls
unusable. The composer itself uses viewport-fixed coordinates. A shell `body`
or active modal that establishes another fixed-position containing block (for
example with transform, perspective, filter, containment,
`transform-style: preserve-3d`, or a corresponding `will-change`) is unsupported
and hides the composer rather than applying the shell coordinates twice. A
`container-type` declaration alone does not establish that containing block and
remains supported.

## Required configuration

Every `open` call supplies an absolute source, exact peer origin, accessible
frame title, session ID, unpredictable nonce, and bridge capabilities. The
source must match the peer origin exactly. The peer must be cross-origin from
the review host: combining `allow-scripts` and `allow-same-origin` for a
same-origin child would let that child remove its own sandbox attribute.
On the first load, the host also fails closed if the resulting Document is
readable by the parent, covering a configured cross-origin URL that redirects
to the shell origin. The shell origin must never serve untrusted executable
content; this post-load check is defense in depth, not an XSS boundary.

The Prototype must receive the same session ID and nonce through a
consumer-owned bootstrap channel before its document finishes loading. Prefer a
server-injected bootstrap record or a URL fragment; do not put a nonce in a
query string, logs, analytics, captures, or tracker context. The host creates
its bridge only after the frame's first `load`, allowing a cooperative Prototype
to attach its listener first.

## Sandbox and browser policy

The default `cooperative` profile sets:

- `sandbox="allow-same-origin allow-scripts"`;
- `referrerpolicy="no-referrer"`;
- an explicit Permissions Policy denying sensitive capabilities including
  camera, microphone, geolocation, display capture, clipboard access, payment,
  USB, fullscreen, and WebAuthn delegation.

The capability-increasing `cooperative-forms` profile adds only `allow-forms`.
It must be selected explicitly. Custom sandbox tokens or Permissions Policy
delegations are not accepted by this reference host; a future capability needs
its own reviewed profile and browser tests.

## Navigation and failure behavior

Host-directed Revision or peer changes call `open` with a fresh session identity.
An unplanned in-frame navigation or reload produces `unexpected_navigation`,
closes the bridge, and removes the frame; the caller must explicitly reopen it
with a fresh identity. This avoids reusing a nonce across Documents that share a
stable `WindowProxy`.

Every browser message is still checked by `BrowserBridgeAdapter` for the exact
source window, exact origin, protocol/session identity, and contiguous sequence.
Messages from sibling frames, unrelated protocols, and other sessions are
ignored. A malformed message that claims the active protocol/session or a
claimed message from a changed origin fails closed.

Draft attachment reports are correlated to one active request. Escape, Cancel,
submission, or an unavailable target retires that request. Because an ordered
`postMessage` attachment update may already be in flight when the shell sends
dismissal, the host keeps a bounded set of retired request IDs and ignores only
late updates for those IDs; an unknown or mismatched ID still fails closed.
Overlay instances in one Prototype document allocate request IDs from a shared
document-lifetime sequence, so replacing an overlay cannot reopen a request ID
that the same frame-host session already retired. A late shell dismissal is
idempotent at the overlay and cannot close a newer request or tear down its
bridge. A throwing child lifecycle callback does not commit its update or
dismissal as delivered; a later `refresh()` or repeated teardown retries the
same latest event before a subsequent draft may open. Delivery is tentatively
advanced while the synchronous callback runs and rolled back only on failure,
so a callback may reenter `refresh()` without recursion and a genuinely newer
reentrant lifecycle state wins over the older attempt.

Browser APIs do not acknowledge `postMessage` delivery. The adapter therefore
cannot distinguish delivery from a silent `targetOrigin` drop. It closes and
replaces on known navigation instead of treating a successful call as proof of
receipt.

Cleanup is logical before it is physical: state and generation references are
invalidated before listener or DOM removal. If browser cleanup throws, the host
reports `cleanup_failure`, but retained listeners and stale frames remain inert.
If that synchronous error callback opens another generation or closes the host,
an operation-generation guard cancels the superseded outer replacement instead
of overwriting the callback's lifecycle decision.
Chromium-backed tests exercise handshake ordering, bidirectional traffic,
sibling and attacker messages, malformed and wrong sessions, hostile
navigation, reload, replacement, cleanup failures, shell-owned draft privacy,
and normal/sticky/fixed draft attachment using synthetic pages on three
loopback origins.

## Remaining limits

This is a cooperative-frame reference implementation, not an isolation system
for arbitrary hostile pages. It does not proxy network traffic, archive a
Revision, inject bridge code, bypass frame-ancestor policy, or make an
uncooperative page reviewable. Consumer Content Security Policy, hosting,
identity bootstrap, capture controls, and retention remain separate concerns.
