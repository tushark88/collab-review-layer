# Accessible review shell renderer

Browser consumers import `ReviewShellView` from `collab-review-layer/browser`
and load the scoped stylesheet from `collab-review-layer/styles.css`. The
renderer is framework-neutral and creates no global custom elements.

```ts
import {
  REVIEW_SHELL_CHANGE_EVENT,
  ReviewShellController,
  ReviewShellView,
} from "collab-review-layer/browser";
import "collab-review-layer/styles.css";

const controller = new ReviewShellController(config);
const preview = document.createElement("div");
const view = new ReviewShellView({ root, controller, preview, headingLevel: 2 });
view.mount();

root.addEventListener(REVIEW_SHELL_CHANGE_EVENT, (event) => {
  const change = (event as CustomEvent).detail;
  // Reconcile change.bridgeRequests with the active frame when supported.
});
```

## Interface and ownership

The renderer owns four lifecycle operations: `mount()`, `refresh()`,
`snapshot()`, and terminal `destroy()`. It owns only the shell DOM it appends to
the supplied root. The preview element must be detached and from the same
Document; the renderer mounts it inside the selected Viewport and detaches it
again during teardown. A direct iframe created by `ReviewFrameHost` fills this
preview container, while frame policy remains outside the rendering interface.
The component creates no page-level `main` landmark, so it can be mounted inside
an existing application landmark or more than once on a page. Its title defaults
to heading level 2; consumers may set `headingLevel` from 1 through 6 to match
the host document's hierarchy.

`refresh()` reads the current `ReviewShellController` snapshot and does not emit
a change or live-region announcement. Successful user actions dispatch one
bubbling `collab-review-layer:change` event whose frozen detail contains the
semantic action, the new shell snapshot, and the matching bridge requests.
Initialization, no-op mode selection, failed validation, refresh, and teardown
do not dispatch it.

## Controls and focus

Prototype, Revision, Variant, Route, Viewport, custom dimensions, and Pointer or
Comment mode use labelled native form controls and buttons. The renderer updates
options in place rather than replacing their Select element, so a Prototype or
Revision change does not move keyboard focus. Mode buttons use `aria-pressed`
and a visible check mark that is hidden from the accessibility tree; selection
therefore does not depend on color.

Committed changes are announced through one polite atomic status region. The
preview scroller is a labelled keyboard-focusable region. The preview content
box and a directly hosted iframe keep the exact declared CSS-pixel dimensions;
decorative borders sit outside that box. The surrounding shell chrome uses its
own container width and reflows at 320 CSS pixels without outer two-dimensional
scrolling, even when embedded in a wide page. The stylesheet supplies 44 CSS-pixel
control heights, a three-pixel focus indicator, and forced-colors overrides.
The renderer introduces no animation or transition,
and its shell focus styles do not cascade into consumer preview controls.

These choices follow [WCAG 2.2](https://www.w3.org/TR/WCAG22/) and use native
controls instead of recreating the directional keyboard behavior described by
the [WAI-ARIA toolbar pattern](https://www.w3.org/WAI/ARIA/apg/patterns/toolbar/).

## Validation and limits

Route and custom-dimension mutations go through `ReviewShellController`.
Invalid submissions leave controller state unchanged, dispatch no change event,
and expose native validation state. A later render restores the controller's
valid route and clears the stale error. Labels and options are written as text,
not HTML.

The renderer does not open frames, invent session credentials, send bridge
messages, place anchors, persist comments, capture evidence, call analytics, or
apply consumer branding. Consumers retain those concerns at their existing
seams. The provided stylesheet is brand-neutral and scoped below `.crl-shell`;
consumers may override its custom color properties without replacing semantic
or focus behavior.

## In-document review overlay

Prototype documents import `ReviewDocumentOverlay` from
`collab-review-layer/browser` and load `collab-review-layer/overlay.css` as an
explicit asset. The shell stylesheet does not contain or imply overlay styles.
Every document that hosts review controls, including each cooperative nested
iframe, must load the overlay stylesheet and mount its own overlay instance.
Mounting fails with `missing_styles` when the owned stylesheet sentinel is not
present in that document.

```ts
import { ReviewDocumentOverlay } from "collab-review-layer/browser";
import "collab-review-layer/overlay.css";

const overlay = new ReviewDocumentOverlay({
  document,
  context: anchorContext,
  onDraftEvent: (event) => publishContentFreeDraftEvent(event),
  onOpenThread: (threadId, attachment) => openThread(threadId, attachment),
  onThreadAttachmentChange: (threadId, attachment) => {
    updateOpenThreadAttachment(threadId, attachment);
  },
  onAnchorUnavailable: ({ threadId, anchorGeneration }) => {
    reportUnavailable(threadId, anchorGeneration);
  },
  onReplaceAnchor: ({ threadId, anchorGeneration, anchor }) => {
    replaceAnchor(threadId, anchorGeneration, anchor);
  },
  onPlacementDiagnostic: (diagnostic) => countPlacementOutcome(diagnostic),
});

overlay.mount();
overlay.setThreads(threads);
overlay.setInteractionMode("comment");
```

Prototype documents are not a safe place for protected draft text: scripts in
that document can read ordinary DOM and closed shadow roots do not create a
security boundary. Embedded documents must therefore use `onDraftEvent` and
send its content-free `open`, attachment `update`, and `dismiss` lifecycle
through the negotiated `draft` bridge capability. The shell's
`ReviewFrameHost` owns the textarea, styles, keyboard behavior, body, author
context, and submission. The child reports viewport-relative attachment points
while one draft is open so the host composer follows normal, sticky, and fixed
targets without moving every persisted pin through JavaScript. Draft request
identity is unique across overlay replacement within the same child Document;
late dismissals are idempotent and cannot close a newer draft. The host projects
the child point from the iframe content viewport through frame borders and
positive axis-aligned CSS scaling before positioning the shell composer, and
fails closed for non-axis-aligned transforms or invisible/clipped framed
content. An active modal associated with the frame hosts the composer inside its
top layer. Because the shell-owned composer is viewport-fixed, transformed or
otherwise fixed-containing-block `body` and modal hosts—including
`transform-style: preserve-3d`—fail closed instead of double-applying viewport
coordinates. Throwing child lifecycle callbacks
preserve undelivered update or dismissal state for retry rather than advancing
the local delivery snapshot;
tentative in-flight state also makes synchronous callback re-entry finite. The
bridge schema rejects draft bodies and stale Anchor versions.

A standalone top-level document may use the built-in composer only when every
script in that document is explicitly trusted to read review drafts. That mode
requires both `trustDocumentForDrafts: true` and `onSubmit`; it is rejected for
all embedded documents, including same-origin frames. Do not enable it merely
to avoid implementing the shell-owned composer.

An anchorable prototype element carries a unique, stable
`data-collab-review-id`. A click on that element or one of its descendants
creates a schema-version-3 Anchor with the element selector and identity,
element-local offsets, document coordinates and dimensions, and the immutable
Review/Prototype/Revision/Viewport/Variant/Route/Device/Surface context supplied
at construction. Schema-version-3 element-local offsets are bounded and signed
so visible protruding descendants remain anchorable; historical schema-
version-2 offsets remain readable but must be nonnegative. SVG graphics offsets
are relative to the current geometry-box origin, allowing geometry-attribute
changes to move an existing pin with its shape. No ratio-only fallback is
generated. Document `x` evidence uses a nonnegative left-origin coordinate even
when an RTL scrolling document exposes a negative browser `scrollX`. Available
thread pins are resolved back to exactly one matching element. Ordinary
scrolling targets use raw browser-native document placement, so their pins move
with the page without chasing scroll through animation frames. A target inside
an actively sticky or fixed surface uses browser-native viewport placement; a
sticky target remains in document space until it reaches its sticky threshold,
then its pin and any locally trusted open
composer switch to viewport space. Shell-owned composers consume the validated
draft request and remain under shell layout control. Only targets with sticky ancestry participate
in scroll-time threshold classification; ordinary and fixed pins require no
scroll-time computed-style reads. Pure visual translations between a sticky
surface and its scrollport are removed from threshold geometry; other visual
transforms that prevent an exact threshold classification fail closed as a
placement bug rather than making the overlay chase scroll. Document-space
composers retain native page movement but update their bounded edge offset on
viewport scroll while the anchor point remains visible. Overflow visibility is
checked in each axis against the browser's padding-box clipping edge, or the
expanded overflow clip edge for `overflow: clip`; borders are not treated as
visible content and `overflow-clip-margin` does not expand scrollable overflow.
The target's own overflow clip is evaluated before its ancestors, so a signed
offset outside a self-clipped marker renders neither a misleading pin nor a
locally trusted composer. HTML box clips and SVG viewport clips are evaluated in their own local
coordinate systems so transforms do not turn borders or default SVG overflow
into false visibility. A browser-native intersection observer performs one
bounded revalidation when an ordinary target enters the viewport, covering
off-screen CSSOM or intrinsic layout movement without polling every document
pin during scroll. A resolved but unrendered target remains in bounded resize
and intersection observation so layout- or intersection-changing CSSOM
restoration can sometimes recover it; missing identities are not polled.
Stylesheet CSSOM edits do not have a complete browser observer signal: a
within-viewport transform can preserve intersection geometry, and paint-only
changes such as `visibility` preserve size. After a consumer makes any CSSOM
edit that may affect a placed target's visibility or geometry, it must call
`overlay.refresh()` once. Resize, layout, and placement-affecting CSS animation
and transition observations recompute element-local attachment. The Web
Animations API has no document-level animation-start signal: after a consumer
starts an imperative `Element.animate()` on a placed target or one of its
ancestors, it must likewise call `overlay.refresh()` once. These bounded
handshakes register relevant running animations and follow them frame by frame
without polling unrelated document animations while the overlay is idle. Opening a
visible pin invokes the callback without scrolling the document and supplies
its current document- or viewport-space attachment point so consumer-owned
thread UI can use the same coordinate space. `onThreadAttachmentChange` reports
later attachment movement, coordinate-space switches, unavailable locations,
and loss of a trustworthy placement; an already-open consumer thread can
therefore remain attached without polling or taking ownership of pin geometry.
If that optional callback throws, placement remains authoritative and the
latest undelivered attachment retries on the next explicit `refresh()`;
automatic animation frames do not retry an unchanged failed notification. The
overlay observes the stable document root, reattaches after body replacement,
and retargets body-specific resize observation without changing its mounted
identity.

This first resolver is intentionally deterministic: both the persisted selector
and its `data-collab-review-id` must resolve to the same single marker. A
duplicate identity is unavailable even when a narrower selector still finds one
element. The resolver does not guess from text or geometry. Deterministic
semantic/text/geometry recovery and archived-snapshot resolution remain
follow-up work under resilient anchoring. Previously accepted Review Context
correlation values remain bounded and are preserved verbatim; a legacy-invalid
device or surface value is rebound to the current document identity only through
the explicit replacement flow.
When the bound Review Context no longer satisfies the current new-write scalar
contract, Comment mode still owns ordinary user input: unmarked clicks are
blocked, and stable rendered marker clicks are consumed without opening a
new-thread composer. Boxless explicit markers remain prototype-owned because
they cannot produce a trustworthy element-local location; exceptional
existing-thread recovery remains available.

Pointer mode leaves prototype pointer, touch, keyboard, and click activation
non-intercepting. For rendered or unmarked prototype targets, Comment mode owns
trusted pointer, mouse, and touch press/release events before prototype handlers
and cancels their native defaults. A rendered marker is captured only when the
same primary gesture begins and ends on it; its release coordinates open an
in-bounds composer, and a later compatibility click is consumed without a second
placement. Enter and Space capture a focused rendered marker at its center before
prototype key handlers run. Boxless explicit markers and script-generated
activation, including synthetic Escape events, remain prototype-owned, and IME
composition remains untouched. Pins are interactive in Comment mode. The shell
owns Escape and submission shortcuts for shell-owned composers. In the explicit
trusted top-level mode, Escape closes the local composer or cancels an armed
relocation; Control+Enter and Command+Enter submit a non-empty comment.

`setThreads()` accepts either complete current Anchors or explicit unavailable
read-model Anchors. Current Anchors are rebuilt from validated fields, including
bounded semantic and text evidence held in enumerable own data fields of plain
records, before entering overlay state. An
unavailable Anchor never renders a pin. Comment mode shows a compact
needs-attention entry that opens the existing thread; it does not put a
relocation action below every comment. Consumer-owned thread UI may expose
`Relocate pin` or `Attach to new element` only after authorizing the owner, set
`canReplaceAnchor: true`, and call `beginAnchorReplacement(threadId)`. The
replacement callback retains the existing `threadId` and `anchorGeneration` and
supplies only a newly captured current Anchor. The embedding must re-authorize
and persist that request through the kernel—the UI flag and public method are not
authorization boundaries.

`onPlacementDiagnostic` distinguishes durable `anchor_unavailable` outcomes
(`identity_unresolved` or `target_not_rendered`) from a `placement_bug` caused by
an unsupported coordinate projection. The current HTML projection accepts one
rendered element box plus supported transform and zoom geometry; fragmented
inline boxes and CSS motion paths fail closed instead of approximating a local
point that can drift after reflow or path progress. Placement bugs render no
misleading pin, but they never enable relocation or call `onAnchorUnavailable`;
relocation is exceptional recovery, not a fallback for current placement
defects. Consumers can count the two diagnostic kinds separately as a
placement-quality signal. Computed `transform-style: preserve-3d` is treated as
flat when a CSS grouping property forces the browser's used value to flatten.
The owned manual popover is also re-promoted when a later prototype popover
opens, preserving the same root identity while keeping pins and composers
visible and interactive. The overlay never owns messages, lifecycle state,
event history, authorization, diagnostic persistence, or comment persistence.
