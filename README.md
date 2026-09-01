# Collab Review Layer

An open-source collaborative review layer for live web prototypes and deploy previews. Enables Figma-style collaborative feedback for live prototypes, anywhere.

It is intentionally independent of any product, deployment provider, identity
provider, storage engine, or work tracker.

> Status: public pre-alpha. The contracts and reference kernel are available for
> evaluation and contribution, but there is no supported release yet. See
> [LAUNCH.md](./LAUNCH.md) for the separate `v0.1.0` release gate.

## First slice

- immutable review, prototype, revision, viewport, variant, and capture context plus versioned document-space Anchors with explicit recovery state;
- append-only event history and a deterministic in-memory reference store;
- durable thread lifecycle: create, reply, edit, delete, resolve, reopen, and generation-safe owner-authorized Anchor Replacement;
- explicit fail-closed review authorization with a local static-grant adapter;
- a versioned cooperative bridge protocol with exact-origin binding, capability negotiation, contiguous sequencing, and validated navigation, focus, viewport, variant, and anchor messages;
- a browser bridge adapter with exact source-window checks, concrete target origins, automatic handshake replies, and deterministic listener teardown;
- a cross-origin iframe host with reviewed sandbox profiles, explicit browser policies, generation-safe replacement, and Chromium attack coverage;
- an accessible framework-neutral shell renderer with responsive viewport chrome, native controls, focus-preserving navigation, and scoped styles;
- an explicit per-document review overlay with Pointer/Comment modes, document-space pins, in-bounds composers, nested-frame ownership, and unavailable-location re-placement;
- append-only file persistence with sequence, identity, corruption, and size checks;
- redacted JSON and NDJSON export;
- a provider-neutral work-tracker seam;
- deterministic four-tier issue matching that prefers duplicates over unsafe attachment;
- Linear and GitHub Issues HTTP adapters with injectable transports;
- signed webhook processing with retry-safe durable delivery reservations.

Not implemented yet: threaded browser panels,
production database adapters, capture providers, and production-ready provider integrations.
No TourHero code or data is included. The protocol and browser transport contract is in
[docs/BRIDGE-PROTOCOL.md](./docs/BRIDGE-PROTOCOL.md); reference-adapter
guarantees and limitations are in
[docs/REFERENCE-ADAPTERS.md](./docs/REFERENCE-ADAPTERS.md).

## Development

Requires Node.js 22.6 or newer (for TypeScript type stripping).

```sh
npm ci --ignore-scripts
npx playwright install --only-shell chromium
npm run check
npm audit
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a pull request and
[SECURITY.md](./SECURITY.md) before reporting a vulnerability.

## License

[MIT](./LICENSE)

The tracker topology and synchronization contract are documented in
[docs/TRACKERS.md](./docs/TRACKERS.md).
The framework-neutral Prototype, Revision, Variant, Route, Interaction Mode, and
Viewport state contract is documented in
[docs/SHELL-STATE.md](./docs/SHELL-STATE.md).
The sandboxed cross-origin frame lifecycle and browser threat boundary are in
[docs/IFRAME-HOST.md](./docs/IFRAME-HOST.md).
The responsive browser renderer, stylesheet, event, and accessibility contract
are in [docs/RENDERER.md](./docs/RENDERER.md).
