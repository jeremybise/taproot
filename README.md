# Taproot

A DB-backed, Astro-native CMS aimed at a real-world case: a campus website with many non-technical
departmental contributors.

**Status: Phase 0 (Foundation) complete.** The model works end to end — sign in, define a content
type and its fields, create content, and see it render at a real nested URL. See
[SCOPE.md](SCOPE.md) for the full plan and [what's next](#whats-next).

---

## Quick start

```bash
npm install
cp .env.example apps/web/.env
npm run db:seed
npm run dev
```

Then open <http://localhost:4321> — or <http://localhost:4321/admin> and sign in with
**admin@example.com** / **taproot**.

There is no other setup step. No database to provision, no OAuth app to register, no build
toolchain — Taproot has zero native dependencies.

---

## What works today

- **Portable data layer.** One codebase on SQLite (dev), Cloudflare D1 (production), or Postgres.
- **Content types with real fields**, not hand-written JSON — text, richtext, number, boolean,
  date, select, media, taxonomy, relation, block, repeater.
- **Hierarchical URLs that actually nest.** `/admissions/apply` and `/financial-aid/apply` coexist,
  because slugs are unique among siblings rather than site-wide.
- **Cascading moves.** Renaming or re-parenting a page rewrites every descendant's path and writes
  a redirect for each one, atomically.
- **Auth.** OAuth (Google/GitHub/Microsoft) plus a dev-only password provider that cannot be
  enabled in production.
- **REST API** with a typed client.
- **An accessible admin.** WCAG 2.1 AA, verified by `npm run a11y`.

---

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Dev server at :4321 (Astro 7 daemonises it — `astro dev stop\|status\|logs`) |
| `npm run db:seed` | Migrate and seed. Idempotent — safe to re-run |
| `npm run db:reset` | Delete the local database and re-seed |
| `npm run db:migrate` | Apply pending migrations locally |
| `npm run db:migrate:remote` | Apply them to deployed D1 |
| `npm test` | Unit tests (103 covering dialects, auth, paths, validation) |
| `npm run a11y` | axe-core audit of every admin screen, plus a contrast check |
| `npm run preview` | Build and serve through `wrangler dev` — the real Workers runtime |
| `npm run deploy` | Build and `wrangler deploy` (see [DEPLOYMENT.md](DEPLOYMENT.md)) |

---

## Layout

```
packages/core     @taproot/core   — data layer, auth, content services, storage. No framework.
packages/astro    @taproot/astro  — the Astro integration: admin panel, REST API, client
apps/web          the demo campus site
```

`@taproot/astro` ships TypeScript and `.astro` **source** rather than a build. Astro's
`injectRoute` compiles `.astro` entrypoints out of `node_modules` through the host's Vite pipeline
— the same approach Starlight uses. Publishing to npm will need a build step for the integration
entry only.

---

## Notable decisions

Each of these was a fork in the road; the reasoning matters more than the choice.

### Both SQL drivers are written in-tree

Kysely ships no D1 dialect, and the community `kysely-d1` was last published in April 2025 — an
unmaintained dependency on the critical path to the production database. The dev driver uses Node's
built-in `node:sqlite` rather than `better-sqlite3`.

Together that means **zero native dependencies**: `npm install` never needs a C++ toolchain, and
there is no Node-only binary that can accidentally end up in the Workers bundle. Only the ~200 lines
of driver are custom; the adapter, introspector, and query compiler are Kysely's own.

### Atomic writes are statement lists, not transaction callbacks

D1 has no interactive transactions — Cloudflare's reasoning being that one Worker request anywhere
in the world could otherwise block the whole database. What D1 does have is `batch()`, which is
atomic. So `batchWrite()` takes a list of statements: on D1 it maps to the native batch, on SQLite
and Postgres to a real transaction.

The constraint this imposes is real: **you cannot read your own writes mid-batch.** Do the reads
first, compute, then write once. A cascading path move reads the subtree with one recursive CTE,
computes every new path in memory, and writes them as one batch.

### Dev runs on Node, production on Workers

`@astrojs/cloudflare` v14 runs SSR inside workerd during dev, which is excellent for parity — but
workerd has no `node:sqlite`, so the local database would have to be Miniflare's emulated D1, whose
file lives at an undocumented internal path the seed script cannot reliably write to. That would
mean no `npm run db:seed` without a running dev server.

Zero-setup development won. The data layer is portable by design and both dialects are unit-tested;
`npm run preview` exercises the real Workers runtime when you want it.

### The admin is server-rendered Astro, not a SPA

Every admin screen is an Astro page whose permission check runs before any HTML is sent. React
appears only where interaction demands it — the field builder and the item editor.

This is mostly an accessibility decision. Client-side routing needs hand-built focus management and
route announcements to meet WCAG AA, and that is exactly the kind of hand-built interaction that
fails in practice. Real navigation gets it for free.

### Passwords use PBKDF2, not bcrypt or argon2

Both of those are native modules that cannot run on Workers. PBKDF2-SHA256 via `crypto.subtle` is
available identically in Node and on Workers, so there is one implementation for every environment.
The iteration count travels with each hash, so it can be raised later without invalidating
existing passwords.

---

## Accessibility

The admin itself must be WCAG 2.1 AA — separate from the content-accessibility checker that arrives
in Phase 4. Debt here compounds, so it is checked per phase rather than at the end:

```bash
npm run dev      # in one terminal
npm run a11y     # in another
```

`a11y:axe` runs axe-core against every admin route's server-rendered HTML. `a11y:contrast` checks
the design tokens numerically, because jsdom cannot compute contrast — it caught five failing pairs
during Phase 0, including input borders at 1.81:1 against a 3:1 requirement.

Two things these do **not** cover, and which need a real browser and a human: post-hydration
behaviour of the React islands, and screen-reader output. The keyboard paths in the field builder
are deliberately buttons rather than drag-and-drop; when drag-and-drop arrives in Phase 1 it must be
added *alongside* them, not instead.

---

## Testing

```bash
npm test
```

103 tests. The ones worth knowing about:

- Both SQL dialects against a real database, including that `node:sqlite` rejects JS booleans — the
  driver coerces them, and there is a test that fails loudly if that regresses.
- Sibling-slug uniqueness in both the NULL-parent and non-NULL-parent cases. A plain unique index
  on `(parent_id, slug)` would let two root pages share a slug, because NULL never equals NULL.
- Cascading moves: descendant rewrites, redirect creation, redirect-chain collapse, cycle refusal,
  and that a rejected move leaves the tree untouched.
- TOTP against the RFC 6238 test vectors, so the implementation is verified correct rather than
  merely self-consistent.

---

## What's next

Phase 1, per [SCOPE.md](SCOPE.md): the visual content-type builder with live preview, rich-text
editing, the media hotspot/crop editor, taxonomies, menus, revisions, the SEO sidebar, and
singleton editing.

Phase 0 deliberately left seams for these rather than stubs that would need unpicking — `fields` is
a real table, `content_items` already carries `parent_id`/`path`/`depth`, and every media asset
already has hotspot and crop columns.

Known gaps closing in Phase 1: the richtext field edits as a plain textarea (values round-trip
correctly), the TOTP enrolment UI is not built though the core is implemented and tested, and image
dimensions are not read on upload.
