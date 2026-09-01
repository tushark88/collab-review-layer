# Versioned cooperative bridge protocol

The bridge is the provider-neutral seam between a review host and a cooperative
live prototype. `BridgeSession` owns wire validation, handshake state, exact
origin binding, protocol and capability negotiation, contiguous sequence
enforcement, and message-size limits. `BrowserBridgeAdapter` connects the pure
session to `window.postMessage` through injected browser ports while binding one
expected peer window and one exact target origin.
`ReviewFrameHost` applies the browser security policy and owns frame creation,
readiness, replacement, and bridge teardown.

The protocol, browser transport, and shell state share one internal constraint
module for origin normalization, origin-relative Routes, Viewport dimensions,
and device-pixel ratio. Each public module maps failures to its own documented
error type and message; the internal module is not exported from the package
interface.

## Trust model

- Both endpoints receive a caller-generated session ID and unpredictable nonce.
- Each endpoint has an explicit allowlist of complete origins. Wildcards, opaque
  origins, credentials, paths, and plaintext non-loopback origins are rejected.
- The first valid handshake binds the session to one allowed peer origin.
- Every envelope repeats the protocol name, wire version, session ID, nonce, and
  a per-sender contiguous sequence number. Replays and gaps fail closed.
- Unknown envelope fields, message fields, capabilities in active messages, and
  invalid payload values fail closed. Future capability names may be advertised
  during the hello handshake and are ignored unless both endpoints implement
  them.
- No provider credential, review message, visitor identity, or analytics record
  belongs in a bridge envelope.

## Wire envelope and size metric

The exported `BridgeEnvelope`, `BridgeWireMessage`, handshake-message, and
operational-message types are the normative TypeScript schema for protocol
version 2.
Every envelope has exactly these fields:

| Field | Constraint |
|---|---|
| `protocol` | Literal `collab-review-layer.bridge`. |
| `wireVersion` | Literal `1`; versions the outer envelope shape. |
| `sessionId` | Non-empty identifier of at most 256 UTF-16 code units. |
| `nonce` | Caller-generated value from 16 through 256 UTF-16 code units. |
| `sequence` | Per-sender safe integer beginning at zero and increasing contiguously. |
| `message` | Exactly one `BridgeWireMessage` value described below. |

`wireVersion` and `protocolVersion` are deliberately separate. `wireVersion`
selects the envelope parser before a handshake exists. `protocolVersion` is
selected by `bridge.ready` and is repeated on every later operational message.
Protocol version 2 accepts no unknown envelope or active-message fields.

`maxMessageBytes` measures the UTF-8 byte length of the compact JSON projection
of an envelope, including JSON string escaping. This is a deterministic protocol
limit, not an estimate of browser structured-clone storage. Each peer configures
a value from 1 through 1,048,576 bytes (default 65,536). `bridge.hello` advertises
the host value and `bridge.ready` selects the smaller of both peers' values. The
selected value applies in both directions and is exposed in the session snapshot.
Handshake envelopes must fit the limit they advertise or select. Later inbound
and outbound envelopes are checked before state advances, so an outbound failure
does not consume a sequence number. The reference walker stops at the limit
without first materializing the complete JSON string and rejects cycles,
accessors, sparse arrays, non-finite numbers, non-plain records, and nesting
beyond 64 levels.

Origin verification is necessary but not sufficient in a browser. The browser
adapter also compares `MessageEvent.source` with the expected peer window, posts
only to a concrete `targetOrigin`, and removes or logically disables its listener
when the transport closes. `ReviewFrameHost` supplies that peer only after it
has applied its sandbox, referrer, and Permissions Policy and observed the
frame's first load.

## Handshake

1. The host calls `initiate()` and sends `bridge.hello` with its implemented
   protocol versions, requested capabilities, and configured message limit.
2. The prototype validates the envelope and origin. If protocol version 2 is
   supported, it returns `bridge.ready` with the intersection of requested and available
   capabilities and the smaller message limit. Otherwise it returns
   `bridge.reject`.
3. The host validates the selected version, capabilities, and message limit.
   Both endpoints are then active, bound to the peer origin, and constrained by
   the same limit.

Operational messages are rejected before the handshake completes or after a
rejected negotiation. A capability must be in the negotiated intersection before
either endpoint can send or receive its messages.

## Browser transport adapter

`BrowserBridgeAdapter` owns one `BridgeSession` behind four operations:
`start()`, `send(message)`, `close()`, and `snapshot()`. Callers inject the local
message event source, expected peer window, exact peer origin, and one event
callback. Native `Window` objects satisfy the two structural browser ports; tests
may provide local adapters without a DOM. The event callback is synchronous;
returning a promise is rejected and closes the adapter.

The prototype adapter must start before the host sends its hello. In a real shell,
start the host only after the framed prototype has loaded enough code to attach
its listener. The adapter installs its own listener before an initiating host
posts the hello, sends handshake replies automatically, and reports handshake
state, operational messages, and errors through the event callback. Synchronous
startup and transport failures are both reported through that callback and
thrown to the caller. If that error callback also throws, the public operation
still throws the classifiable original error type whose aggregate cause retains
both failures.
If a prototype sends from its active-state callback, the adapter defers that
operational envelope until `bridge.ready` has been posted; closing from the same
callback cancels both the reply and any deferred envelopes.

Incoming events from any other source window are ignored before their data is
read. Unrelated messages and envelopes for another bridge session are also
ignored, allowing the same window to use `postMessage` for other protocols. Once
an event claims this protocol and session, a protocol or origin failure closes
the adapter because the peer may already have consumed its outbound sequence.
Listener lifecycle and posting failures also close the adapter, and a consumer
callback exception closes it before the exception propagates. `close()` is
idempotent and makes a listener inert even if the browser port unexpectedly
refuses physical removal.

The adapter does not create the iframe, choose sandbox tokens, wait for prototype
readiness, acknowledge browser delivery, or reconnect after navigation. Browsers
silently drop a post when the peer no longer matches `targetOrigin`.
`ReviewFrameHost` owns those frame concerns: a caller opens a fresh generation
for intentional replacement, while an unplanned navigation or reload fails
closed and requires a fresh session identity. See
[`IFRAME-HOST.md`](./IFRAME-HOST.md).

## Message schemas

Handshake messages have these exact fields:

| Type | Required fields | Constraint |
|---|---|---|
| `bridge.hello` | `supportedVersions`, `capabilities`, `maxMessageBytes` | Versions are unique integers from 1 through 65,535. Capability names are unique, non-empty strings of at most 64 code units; unknown names may be advertised for forward negotiation. The message limit is an integer from 1 through 1,048,576 and the hello must fit it. |
| `bridge.ready` | `protocolVersion`, `capabilities`, `maxMessageBytes` | Version must be `2`. Capabilities must be a unique subset implemented by both peers. The message limit is the smaller configured value, cannot exceed the host advertisement, and must contain the ready envelope. |
| `bridge.reject` | `reason` | The current protocol supports only `unsupported_version`. |

Every operational wire message contains `type`, `mode`, and
`protocolVersion: 2`. `mode` is `request` or `report`; the same payload schema is
used in either direction except where the Anchor row says otherwise.

| `type` | Payload fields and constraints |
|---|---|
| `navigation` | `route`: origin-relative path of at most 2,048 code units. Backslashes, ASCII controls, network-path references, and values that resolve to another origin are rejected. |
| `focus` | `focused`: boolean. Optional `anchorId`: non-empty identifier of at most 256 code units. |
| `viewport` | `viewportId`: identifier; `width` and `height`: integers from 1 through 16,384 CSS pixels; `devicePixelRatio`: finite number from 0.1 through 10. |
| `variant` | `variantId`: non-empty identifier of at most 256 code units. |
| `anchor` | `threadId`: stable Thread identity; `anchorGeneration`: positive safe integer naming its current placement; `anchor`: versioned Anchor read-model value. A placement request requires an available current schema version 2 Anchor and has no `status`; an `attached` report carries that same current form, while an `orphaned` report carries only an explicit unavailable/recovery value. |

A current Anchor requires `schemaVersion: 2`, `locationAvailability: "available"`,
`recoveryState: "not_required"`, immutable Review Context plus `deviceId` and
`surfaceId`, a stable element selector and identity with element-local offsets,
and document-space coordinates and dimensions. Semantic and text evidence is
optional. Bridge validation rejects incomplete values and unknown fields. Text
evidence may contain line breaks but not NUL; identifiers, selectors, and
semantic values reject NUL, CR, and LF.

Raw schema version 1 ratio-only Anchors are rejected on the wire. Their read-
model projection contains only `schemaVersion: 1`,
`locationAvailability: "unavailable"`, and
`recoveryState: "legacy_replacement_required"`; that form may only be reported
as `orphaned`. An orphaned schema version 2 location uses the analogous
`orphaned_replacement_required` recovery state and retains its immutable Anchor
Context while omitting placement data. The persistence boundary also
rejects raw legacy Anchors for new Threads and Anchor Replacements, so a legacy
ratio can never silently become a visible pin or leave trusted history through
the bridge.

Every Anchor request/report carries the non-empty `threadId` (at most 256 code
units) whose location is being resolved and its positive safe-integer
`anchorGeneration`. Sequence numbers order envelopes but do not identify a
Thread or Anchor placement. Consumers must authorize an orphan report and
persist it only when both stable identities match the current Thread state; a
delayed report for a superseded generation fails closed.

Protocol version 2 is intentionally incompatible with version 1: version 2
requires a stable Thread ID, current versioned Anchor forms, and Anchor
Generation correlation. A version-1-only peer is rejected during negotiation
instead of failing on its first Anchor message.

## Version 2 capabilities

| Capability | Message | Purpose |
|---|---|---|
| `navigation` | origin-relative route request/report | Coordinate route or view changes without allowing cross-origin navigation. |
| `focus` | focus request/report plus optional Anchor ID | Coordinate keyboard and comment focus. |
| `viewport` | viewport ID, CSS width/height, device-pixel ratio | Apply or report the live prototype viewport. |
| `variant` | variant ID request/report | Select or report a prototype variant. |
| `anchor` | versioned Anchor request or attached/orphaned report | Resolve review evidence without silently moving an ambiguous Anchor. |

Every operational message has a `request` or `report` mode. The protocol carries
validated intent and state; it does not manipulate DOM, history, or review data
itself. Those effects belong behind the browser and shell modules that consume
this interface.

## Analytics separation

Analytics integrations are not bridge capabilities. GA4 or another analytics
adapter may provide aggregate device-category and screen-resolution distributions
to help the shell suggest viewport presets. The active bridge viewport remains
the authoritative current-session value. User IDs, device IDs, session IDs,
IP-derived location, raw events, and replay content must not cross either seam.

## Reference limitations

The protocol session remains side-effect free. The browser adapter has synthetic
transport coverage, and the frame host adds Chromium coverage for sandbox
policy, readiness, exact source/origin binding, concrete-target enforcement,
handshake flow, teardown failure, replacement, hostile navigation, and reload.
Browsers still provide no delivery acknowledgement, and compatibility with an
uncooperative or frame-blocked page remains outside the reference implementation.
