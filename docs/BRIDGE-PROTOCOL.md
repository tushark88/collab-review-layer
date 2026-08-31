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
