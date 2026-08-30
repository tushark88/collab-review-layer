# Collab Review Layer

Figma-style collaborative feedback for live prototypes, anywhere.

This is a brand-neutral review layer for cooperative live web prototypes and
deploy previews. It is intentionally independent of any product, deployment
provider, identity provider, storage engine, or work tracker.

> Status: pre-release private incubation. The public repository does not exist
> yet. See [LAUNCH.md](./LAUNCH.md) for the gated launch sequence.

## First slice

- immutable review, prototype, revision, viewport, variant, anchor, and capture context;
- append-only event history and a deterministic in-memory reference store;
- durable thread lifecycle: create, reply, edit, delete, resolve, and reopen;
- redacted JSON and NDJSON export;
- a provider-neutral work-tracker seam;
- deterministic issue matching that prefers duplicates over unsafe attachment;
- Linear and GitHub Issues HTTP adapters with injectable transports;
- signed webhook verification primitives.

The browser shell, persistent database adapters, capture providers, and private
consumer integration are later phases. No TourHero code or data is included.

## Development

Requires Node.js 22.6 or newer (for TypeScript type stripping).

```sh
npm test
npm run typecheck
```

## License

[MIT](./LICENSE)

The tracker topology and synchronization contract are documented in
[docs/TRACKERS.md](./docs/TRACKERS.md).
