# @taprootcms/core

The framework-agnostic half of [Taproot](https://github.com/jeremybise/taproot): the data layer,
auth, content services, and storage adapters.

**Most people should not install this directly.** Run `npm create taproot` to scaffold a CMS server,
or install [`@taprootcms/astro`](https://www.npmjs.com/package/@taprootcms/astro) to build a website
that reads from one. This package is what those are built on.

## What is in it

- **A portable SQL layer** over Kysely — the same code on SQLite (development), Cloudflare D1
  (production), or Postgres. Both drivers are written in-tree, because Kysely ships no D1 dialect
  and the community one is unmaintained.
- **Content services**: hierarchical paths with cascading renames and automatic redirects,
  revisions, taxonomies, menus, blocks, reusable blocks, releases, the workflow graph, and the
  scheduler.
- **Auth**: PBKDF2-SHA256 through `crypto.subtle`, sessions and API keys hashed at rest, TOTP
  verified against the RFC 6238 vectors, and a throttle keyed per email *and* per client IP.
- **Validation**: the field-type registry, and an allowlist HTML sanitiser that re-emits only what
  it understands rather than filtering what it recognises.
- **Storage**: local disk and Cloudflare R2, behind one interface.

## Zero native dependencies

No `bcrypt`, no `argon2`, no `better-sqlite3`, no `sharp`. Hashing goes through `crypto.subtle`, the
development driver uses Node's built-in `node:sqlite`, and image dimensions are read from header
bytes rather than decoded. `npm install` never needs a C++ toolchain, and nothing Node-only can
reach a Workers bundle.

## Entry points

| | |
|---|---|
| `@taprootcms/core` | Everything. Pulls in Kysely — server-side only |
| `@taprootcms/core/pure` | Crop arithmetic and nothing else, for a client bundle |
| `/db`, `/auth`, `/content`, `/mail`, `/storage`, `/validation` | Individually |

`@taprootcms/astro` imports only `/pure` at runtime, which is what keeps a website's bundle free of
the data layer.

## Requirements

Node 22.12 or newer. `pg` is an optional peer dependency, needed only for Postgres.

## Documentation

See the [repository](https://github.com/jeremybise/taproot).

## License

MIT
