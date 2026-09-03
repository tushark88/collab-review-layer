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
The class must be constructed by code executing in the container's owning
window. A container from another same-origin realm is rejected because
`postMessage` would identify the constructor's window—not the foreign owner—as
the message source and violate the exact peer-window binding.
Containers across a closed Shadow DOM boundary are also rejected because the
shell cannot prove or restore deep focus through an opaque root. Open Shadow
DOM remains supported when each composer-hosting tree loads the owned asset.

When `draft` is negotiated, the shell must also load
`collab-review-layer/frame-host.css` in the shell document and in every open
Shadow DOM tree that may contain an active modal composer host, then configure
synchronous `onDraftSubmit`. `ReviewFrameHost` then owns the composer DOM, styling, Escape,
Ctrl/Command+Enter submission, viewport clamping, and attachment to the framed
target. A missing callback is rejected before mounting; a missing owned style
asset in the active composer's tree scope fails closed before the draft is
attached. A child `open` request also requires current transient user
activation; a negotiated peer cannot create and focus shell-owned input merely
by sending an unsolicited bridge message. The callback receives the validated
request ID, trimmed body, and current Anchor, all in the shell document. It must
return synchronously; a Promise-like result has its rejection consumed before
the host fails closed.
If an already-open draft would move into a modal tree without the owned asset,
the host parks focus on that shell modal and dismisses the draft in both peers;
it does not leave inert controls behind the modal or poll for styles forever.
Child attachment coordinates are projected from the iframe's content viewport,
not its outer border box. The reference host accounts for frame padding,
borders, positive axis-aligned transforms, and one- or two-axis `scale`
longhands before clamping the composer in shell space.
Rotation, skew, reflection, perspective, and other non-axis-aligned transforms
on the frame or its flattened composed ancestor chain—including assigned slots
and their shadow-tree wrappers—are unsupported and hide the composer instead of
presenting a false attachment. The visible content bounds
are also intersected with the frame's applicable overflow and paint-containment
clip chain. `overflow: clip` and paint containment applied to visible overflow
honor the computed visual-box origin and expanded `overflow-clip-margin`, while
scrollable clips retain their padding edge. A
browser-native painted-point check accounts for rounded clips;
hidden, fully transparent (including `filter: opacity(0)`), active legacy `clip`,
clip-path, and mask states hide the composer with the framed content. That
painted-point check descends through nested open Shadow DOM roots instead of
mistaking a retargeted shadow host for an unpainted frame. Pointer-inert frames
and ancestors remain painted and therefore do not hide an otherwise supported
composer; pointer-inert rounded overflow or paint clips fail closed when native
hit testing cannot prove the curved painted point. A border radius without a
descendant clip does not hide painted frame content. Body overflow propagated by
a visible root is not reapplied as either a rectangular or rounded local frame
clip, including when hit testing is unavailable for a pointer-inert frame. A
viewport-fixed frame is not clipped by unrelated overflow
ancestors before its actual fixed-position containing block. If the frame's
associated dialog enters or leaves the modal top layer while a draft is open,
the composer moves between that dialog and `body`, restoring its focused
control. If placement becomes unavailable while focus is inside the composer,
focus is parked on a visually clipped shell-owned sentinel; it returns to the
same composer control only when placement recovers before the user focuses
elsewhere. While an active draft is hidden, the host continues to reclaim focus
from the Prototype frame on its bounded refresh loop. Prototype-reported
unavailability or dismissal cannot destroy a non-empty reviewer draft: the
composer moves to an explicit unattached state, preserves its body in shell DOM,
and disables submission until a valid attachment returns. Only a trusted shell
action such as Cancel, Escape, or successful submission may discard the draft
or restore the element that held focus before it opened. The composer uses the
maximum browser stacking level so an ordinary positioned frame context cannot
paint above its protected controls. The composer itself uses
viewport-fixed coordinates. Coordinate-affecting CSS applied directly to that
owned composer is unsupported and hides it rather than shifting it away from the
framed target. A shell `body`
or active modal that establishes another fixed-position containing block (for
example with transform, perspective, filter, containment,
`transform-style: preserve-3d`, or a corresponding `will-change`) is unsupported
and hides the composer rather than applying the shell coordinates twice. A
`container-type` declaration alone does not establish that containing block and
remains supported.

## Required configuration

Every `open` call supplies an absolute source, exact peer origin, accessible
frame title, session ID, unpredictable nonce, bridge capabilities, and the
shell-owned Review/Prototype/Revision/Viewport/Variant/Route/Device/Surface
Anchor Context. A prototype draft whose validated Anchor Context differs in any
field fails closed before shell-owned draft UI opens. The
immutable Review/Prototype/Revision/Viewport/Variant/Route correlation fields
may retain bounded legacy values that predate current identifier and route
syntax for read-only legacy frame sessions. The `draft` capability is rejected
for such a session because every newly captured Anchor must carry a complete
current-write context. Device and Surface identify the current host boundary and
must satisfy the current identifier contract. These correlation routes are never
used for navigation. The
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
