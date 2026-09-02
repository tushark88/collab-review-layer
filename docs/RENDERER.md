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
  onSubmit: ({ body, anchor }) => createThread(body, anchor),
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

An anchorable prototype element carries a unique, stable
`data-collab-review-id`. A click on that element or one of its descendants
creates a schema-version-2 Anchor with the element selector and identity,
element-local offsets, document coordinates and dimensions, and the immutable
Review/Prototype/Revision/Viewport/Variant/Route/Device/Surface context supplied
at construction. No ratio-only fallback is generated. Available thread pins are
resolved back to exactly one matching element. Ordinary scrolling targets use
raw browser-native document placement, so their pins move with the page without
chasing scroll through animation frames. A target inside an actively sticky or
fixed surface uses browser-native viewport placement; a sticky target remains
in document space until it reaches its sticky threshold, then its pin and open
composer switch to viewport space. Only targets with sticky ancestry participate
in scroll-time threshold classification; ordinary and fixed pins require no
scroll-time computed-style reads. Resize, layout, and placement-affecting
animation observations recompute element-local attachment. Opening a visible
pin invokes the callback without scrolling the document and supplies its current
document- or viewport-space attachment point so consumer-owned thread UI can use
the same coordinate space. `onThreadAttachmentChange` reports later attachment
movement, coordinate-space switches, unavailable locations, and loss of a
trustworthy placement; an already-open consumer thread can therefore remain
attached without polling or taking ownership of pin geometry.

This first resolver is intentionally deterministic: it accepts exactly one
matching stable marker and otherwise reports the location unavailable. It does
not guess from text or geometry. Deterministic semantic/text/geometry recovery
and archived-snapshot resolution remain follow-up work under resilient
anchoring. Previously accepted Review Context correlation values remain bounded
and are preserved verbatim; a legacy-invalid device or surface value is rebound
to the current document identity only through the explicit replacement flow.
When the bound Review Context no longer satisfies the current new-write scalar
contract, Comment mode still owns ordinary user input: unmarked clicks are
blocked, and stable rendered marker clicks are consumed without opening a
new-thread composer. Boxless explicit markers remain prototype-owned because
they cannot produce a trustworthy element-local location; exceptional
existing-thread recovery remains available.

Pointer mode leaves prototype pointer, touch, keyboard, and click activation
non-intercepting. For rendered or unmarked prototype targets, Comment mode owns
trusted pointer, mouse, and touch press/release events before prototype handlers,
then consumes the click and opens an in-bounds composer only when it can capture
a trustworthy Anchor. Enter and Space capture a focused rendered marker at its
center before prototype key handlers run. Boxless explicit markers and
script-generated activation remain prototype-owned, and IME composition remains
untouched. Pins are interactive in Comment mode. Escape closes a composer or
cancels an armed relocation; Control+Enter and Command+Enter submit a non-empty
comment.

`setThreads()` accepts either complete current Anchors or explicit unavailable
read-model Anchors. An unavailable Anchor never renders a pin. Comment mode shows
a compact needs-attention entry that opens the existing thread; it does not put a
relocation action below every comment. Consumer-owned thread UI may expose
`Relocate pin` or `Attach to new element` only after authorizing the owner, set
`canReplaceAnchor: true`, and call `beginAnchorReplacement(threadId)`. The
replacement callback retains the existing `threadId` and `anchorGeneration` and
supplies only a newly captured current Anchor. The embedding must re-authorize
and persist that request through the kernel—the UI flag and public method are not
authorization boundaries.

`onPlacementDiagnostic` distinguishes durable `anchor_unavailable` outcomes
(`identity_unresolved` or `target_not_rendered`) from a `placement_bug` caused by
an unsupported coordinate projection. Placement bugs render no misleading pin,
but they never enable relocation or call `onAnchorUnavailable`; relocation is
exceptional recovery, not a fallback for current placement defects. Consumers
can count the two diagnostic kinds separately as a placement-quality signal.
The overlay never owns messages, lifecycle state, event history, authorization,
diagnostic persistence, or comment persistence.
