# Collab Review Layer

An open-source collaborative review layer for live web prototypes and deploy previews. Enables Figma-style collaborative feedback for live prototypes, anywhere.

It is intentionally independent of any product, deployment provider, identity
provider, storage engine, or work tracker.

> Status: public pre-alpha. The contracts and reference kernel are available for
> evaluation and contribution, but there is no supported release yet. See
> [LAUNCH.md](./LAUNCH.md) for the separate `v0.1.0` release gate.

## First slice

- immutable review, prototype, revision, viewport, variant, anchor, and capture context;
- append-only event history and a deterministic in-memory reference store;
- durable thread lifecycle: create, reply, edit, delete, resolve, and reopen;
- explicit fail-closed review authorization with a local static-grant adapter;
- a versioned cooperative bridge protocol with exact-origin binding, capability negotiation, contiguous sequencing, and validated navigation, focus, viewport, variant, and anchor messages;
- append-only file persistence with sequence, identity, corruption, and size checks;
- redacted JSON and NDJSON export;
- a provider-neutral work-tracker seam;
- deterministic four-tier issue matching that prefers duplicates over unsafe attachment;
- Linear and GitHub Issues HTTP adapters with injectable transports;
- signed webhook processing with retry-safe durable delivery reservations.

Not implemented yet: the browser shell and `postMessage` adapter, production
database adapters, capture providers, and production-ready provider
integrations. No TourHero code or data is included. The protocol contract is in
[docs/BRIDGE-PROTOCOL.md](./docs/BRIDGE-PROTOCOL.md); reference-adapter
guarantees and limitations are in
[docs/REFERENCE-ADAPTERS.md](./docs/REFERENCE-ADAPTERS.md).

## Development

Requires Node.js 22.6 or newer (for TypeScript type stripping).

```sh
npm test
npm run typecheck
npm audit
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a pull request and
[SECURITY.md](./SECURITY.md) before reporting a vulnerability.

## License

[MIT](./LICENSE)

The tracker topology and synchronization contract are documented in
[docs/TRACKERS.md](./docs/TRACKERS.md).
