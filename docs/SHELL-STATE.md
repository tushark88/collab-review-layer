# Review shell state contract

`ReviewShellController` is the DOM-free state boundary for prototype navigation,
revision and variant selection, pointer/comment interaction, and viewport
presentation. It deliberately does not render UI, create frames, own transport,
persist review history, or import analytics.

## Catalog and selection

A shell catalog contains one or more Prototypes. Every Prototype declares its
Revisions and one initial Revision. Every Revision declares its Variants, one
initial Variant, and one origin-relative initial Route. Viewports are independent
of Prototype selection and use the bridge protocol's dimensions: 1 through
16,384 CSS pixels and a device-pixel ratio from 0.1 through 10.

The controller applies these deterministic transition rules:

- selecting a Prototype selects that Prototype's initial Revision, Variant, and
  Route;
- selecting a Revision selects that Revision's initial Variant and Route;
- selecting a Variant preserves the current Route;
- selecting a Viewport or Interaction Mode survives Prototype and Revision
  changes;
- resizing a custom Viewport selects it and retains its stable Viewport ID;
- invalid input or an unavailable selection leaves the prior state unchanged.

Prototype IDs are unique within a catalog. Revision IDs are unique within a
Prototype, and Variant IDs are unique within a Revision; their durable context
is therefore the tuple already used by `ReviewContext`. Viewport IDs are unique
across the shell catalog.

Configuration is copied during construction. `snapshot()` returns frozen
selection and option records so a renderer cannot mutate controller state by
retaining either its input objects or a prior snapshot.

## Bridge reconciliation

`bridgeRequests()` returns named, frozen navigation, variant, and viewport
requests that conform to the public bridge message types. The object does not
imply a transport send order. A shell sends the requests only after its framed
prototype is ready and the needed capabilities have been negotiated. Replacing
or navigating a frame remains responsible for closing the old transport and
creating a new one.

## Renderer action and accessibility boundary

A renderer maps user input to the controller's semantic actions rather than
embedding state changes in event handlers:

- activate pointer or comment Interaction Mode;
- select a Prototype, Revision, Variant, or Viewport by stable ID;
- navigate to an origin-relative Route;
- set the dimensions of a declared custom Viewport.

The rendering slice must expose those actions through labelled native controls
or an appropriate ARIA composite pattern, preserve a visible focus indicator,
keep focus order consistent with visual order, and announce selection changes
without moving focus unexpectedly. Arrow keys belong only to composite widgets
that advertise them; Escape may cancel an in-progress comment-placement gesture
but must not silently change durable review state. The state controller neither
captures keyboard events nor owns focus and live-region behavior.

## Non-goals

This module does not decide visual design, frontend framework, iframe sandbox
tokens, prototype readiness, reconnect policy, anchor placement, comment
persistence, capture policy, analytics ingestion, or work-tracker behavior.
