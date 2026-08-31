# Versioned cooperative bridge protocol

The bridge is the provider-neutral seam between a review host and a cooperative
live prototype. `BridgeSession` owns wire validation, handshake state, exact
origin binding, protocol and capability negotiation, contiguous sequence
enforcement, and message-size limits. A later browser adapter will connect this
pure module to `window.postMessage` and bind the expected `WindowProxy`.

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
operational-message types are the normative TypeScript schema for version 1.
Every envelope has exactly these fields:

| Field | Version 1 constraint |
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
Version 1 accepts no unknown envelope or active-message fields.

`maxMessageBytes` measures the UTF-8 byte length of the compact JSON projection
of an envelope, including JSON string escaping. This is a deterministic protocol
limit, not an estimate of browser structured-clone storage. The default is
65,536 bytes and a session may configure a value from 1 through 1,048,576 bytes.
Both inbound and outbound envelopes are checked; an outbound failure does not
consume a sequence number. The reference walker stops at the limit without
first materializing the complete JSON string and rejects cycles, accessors,
sparse arrays, non-finite numbers, non-plain records, and nesting beyond 64
levels.

Origin verification is necessary but not sufficient in a browser. The pending
browser adapter must also compare `MessageEvent.source` with the expected frame,
set a concrete `targetOrigin`, sandbox the iframe, and remove listeners when the
session ends.

## Handshake

1. The host calls `initiate()` and sends `bridge.hello` with its implemented
   protocol versions and requested capabilities.
2. The prototype validates the envelope and origin. If version 1 is supported,
   it returns `bridge.ready` with the intersection of requested and available
   capabilities. Otherwise it returns `bridge.reject`.
3. The host validates the selected version and capabilities. Both endpoints are
   then active and bound to the peer origin.

Operational messages are rejected before the handshake completes or after a
rejected negotiation. A capability must be in the negotiated intersection before
either endpoint can send or receive its messages.

## Message schemas

Handshake messages have these exact fields:

| Type | Required fields | Constraint |
|---|---|---|
| `bridge.hello` | `supportedVersions`, `capabilities` | Versions are unique integers from 1 through 65,535. Capability names are unique, non-empty strings of at most 64 code units; unknown names may be advertised for forward negotiation. |
| `bridge.ready` | `protocolVersion`, `capabilities` | Version must be `1`. Capabilities must be a unique subset implemented by both peers. |
| `bridge.reject` | `reason` | Version 1 supports only `unsupported_version`. |

Every operational wire message contains `type`, `mode`, and
`protocolVersion: 1`. `mode` is `request` or `report`; the same payload schema is
used in either direction except where the Anchor row says otherwise.

| `type` | Payload fields and constraints |
|---|---|
| `navigation` | `route`: origin-relative path of at most 2,048 code units. Backslashes, ASCII controls, network-path references, and values that resolve to another origin are rejected. |
| `focus` | `focused`: boolean. Optional `anchorId`: non-empty identifier of at most 256 code units. |
| `viewport` | `viewportId`: identifier; `width` and `height`: integers from 1 through 16,384 CSS pixels; `devicePixelRatio`: finite number from 0.1 through 10. |
| `variant` | `variantId`: non-empty identifier of at most 256 code units. |
| `anchor` | `anchor`: schema version 1 value. A request has no `status`; a report requires `status` equal to `attached` or `orphaned`. |

An Anchor requires `schemaVersion: 1`, `geometry`, and `scroll`; each ratio object
contains finite `xRatio` and `yRatio` values from zero through one. `semantic` is
optional and may contain `role` (256), `accessibleName` (2,048), and `testId`
(256). `text` is optional but, when present, requires `exact` (4,096) and may
contain `prefix` and `suffix` (1,024 each). Text-anchor values may contain line
breaks but not NUL; identifier and semantic values reject NUL, CR, and LF.

## Version 1 capabilities

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

The current module is deliberately side-effect free and has synthetic contract
coverage. It does not yet implement browser event listeners, iframe sandboxing,
source-window checks, teardown, reconnect policy, or compatibility with an
uncooperative page. Those controls remain required before a production host can
claim cross-origin isolation.
