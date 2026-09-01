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
const view = new ReviewShellView({ root, controller, preview });
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
an existing application landmark or more than once on a page.

`refresh()` reads the current `ReviewShellController` snapshot and does not emit
a change or live-region announcement. Successful user actions dispatch one
bubbling `collab-review-layer:change` event whose frozen detail contains the
semantic action, the new shell snapshot, and the matching bridge requests.
Initialization, failed validation, refresh, and teardown do not dispatch it.

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
