# CLAUDE.md

Guidance for Claude Code working in this repository.

## What Taproot is

A DB-backed, Astro-native CMS for a campus website with many non-technical departmental
contributors. [SCOPE.md](SCOPE.md) is the authoritative plan — read the relevant phase section
before starting work on it. Decisions recorded there are settled; don't relitigate them.

**Status:** Phase 0 (foundation), Phase 1A (visual content-type builder), revisions, taxonomies,
and menus are complete — every table Phase 1 needs now exists. The rest of Phase 1 is in progress:
SEO sidebar, singleton editing, a real richtext editor, and the media hotspot/crop editor.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Dev server at :4321. Astro 7 daemonises it — `astro dev stop\|status\|logs` |
| `npm run db:seed` | Migrate and seed. Idempotent |
| `npm run db:reset` | Delete the local database and reseed |
| `npm test` | Vitest, 150 tests |
| `npm run typecheck` | Per-workspace tsc (see note below) |
| `npm run a11y` | axe-core over every admin route + numeric contrast check. Needs `npm run dev` running |
| `npm run preview` | Build and serve through `wrangler dev` — the real Workers runtime |

First run on a fresh clone: `npm install && cp .env.example apps/web/.env && npm run db:seed`.
Sign in at `/admin` with **admin@example.com** / **taproot**.

`npm run typecheck` delegates to each workspace rather than running a root `tsc --build`. There is
no root `tsconfig.json`, and the Astro projects can't be tsc project references because apps/web's
sources are `.astro`, which tsc has no resolver for. apps/web is type-checked by `npm run build`.

## Layout

```
packages/core     @taproot/core   — data layer, auth, content services, storage. No framework.
packages/astro    @taproot/astro  — the Astro integration: admin panel, REST API, typed client
apps/web          the demo campus site
```

Routes are not files-on-disk in apps/web — `@taproot/astro`'s integration entry
([index.ts](packages/astro/src/index.ts)) injects every admin and API route via `injectRoute`.
**Adding a screen or endpoint means adding it to the route table there**, not just creating the
file.

## Constraints that are easy to violate

These are load-bearing decisions, not preferences. Each one has a reason worth knowing before
working around it.

**Zero native dependencies.** Both SQL drivers are written in-tree because Kysely ships no D1
dialect and `kysely-d1` is unmaintained. `npm install` must never need a C++ toolchain, and no
Node-only binary may reach the Workers bundle. Never add `bcrypt`, `argon2`, `better-sqlite3`, or
`sharp`. Hashing goes through `crypto.subtle` (PBKDF2-SHA256), which is identical in Node and
Workers.

**No read-your-own-writes inside a batch.** D1 has no interactive transactions, so `batchWrite()`
takes a *list of statements* — native batch on D1, real transaction on SQLite/Postgres. Do all
reads first, compute in memory, then write once. The cascading path move is the reference example:
one recursive CTE reads the subtree, every new path is computed in memory, and the whole thing goes
out as a single batch.

**Dev runs on Node, production on Workers.** Dev deliberately does *not* run SSR in workerd —
workerd has no `node:sqlite`, which would make `npm run db:seed` impossible without a running dev
server. `node:sqlite` is reached through a variable specifier and marked SSR-external so bundlers
can't resolve it statically. Use `npm run preview` to exercise the real Workers runtime.

**The admin is server-rendered Astro, not a SPA.** Every screen is an Astro page whose permission
check runs before any HTML is sent. React appears only where interaction genuinely demands it
(field builder, item editor). This is primarily an accessibility decision — client-side routing
needs hand-built focus management and route announcements to meet WCAG AA. Don't introduce
client-side routing.

**`@taproot/astro` ships source, not a build.** Astro's `injectRoute` compiles `.astro` entrypoints
out of `node_modules` through the host's Vite pipeline, the same way Starlight does. `.astro`
imports resolve for tsc only via the ambient shim in
[astro-modules.d.ts](packages/astro/src/astro-modules.d.ts); that shim makes the import resolve so
surrounding TypeScript gets checked, and does **not** check the `.astro` file's own contents.

## Accessibility is an acceptance criterion, not a review step

The admin itself must be WCAG 2.1 AA — separate from the Phase 4 content-accessibility checker.
Debt here compounds, so `npm run a11y` must pass before a phase is called done. It currently reports
11 routes, 0 violations, all token pairs passing in both themes.

What it does **not** cover, and what needs a real browser and a human: post-hydration behaviour of
the React islands, and screen-reader output. Custom interactions are where WCAG failures actually
creep in — off-the-shelf Radix primitives rarely fail. **Drag-and-drop must always be added
alongside keyboard controls, never instead of them**; the field builder's reorder buttons are the
pattern to follow.

## Conventions

**Zod 4, not 3.** Two traps that have already cost real bugs here:
- `.strict()` takes no arguments. A message passed to it is accepted and silently discarded — use
  `z.strictObject(shape, { error })` with an error map scoped to `unrecognized_keys`.
- `.partial()` makes keys optional but does **not** strip a `.default()`. Deriving a PATCH schema
  from an input schema this way let `config: {}` through on every request and wiped stored field
  options. Write PATCH schemas explicitly.

**Vitest** defaults to the `node` environment because the core suites talk to a real database.
Files that render React opt in per-file with a `@vitest-environment jsdom` docblock — Vitest 4
removed `environmentMatchGlobs`.

**Comments explain why, not what.** The existing code documents the fork in the road at the point
where someone would otherwise "simplify" it wrongly. Match that: a comment earns its place by
recording a constraint or a rejected alternative.

**Terminology is locked** (SCOPE.md): *Content Item* (never "Page" — a page is one type among
many), *Block*, *Reusable Block*, *Content Type*.

## Data model notes

- **Slugs are unique among siblings, not site-wide.** That's what lets `/admissions/apply` and
  `/financial-aid/apply` coexist. A plain unique index on `(parent_id, slug)` is *not* enough —
  NULL never equals NULL, so two root pages would slip through. There are tests for both cases.
- **`path` is a denormalised materialised path**, indexed and unique; the public catch-all resolves
  it in one lookup. `depth` is redundant with it but makes tree ordering an indexed sort.
- **Every path change writes a redirect automatically.** Never make this opt-in.
- **Content type `kind`** is `page` (nests under a parent), `collection` (flat, `url_prefix`-based),
  or `singleton` (exactly one item, no create/delete).
- **Field values live in `content_items.data`** keyed by field `api_id`, validated against the type.
- **Taxonomies carry no authority.** A term classifies content — what it is about — and never
  determines who may edit it. Departments-as-permissions are a separate Phase 3 model, on purpose:
  classification is editable by contributors and ownership must not be, so tying them would let
  someone tag a page for discoverability and silently hand another department edit rights. Do not
  reintroduce permission checks that read taxonomy terms.
- **`taxonomy_assignments` is a derived index, not the source of truth.** Tags are authored into
  `data` like every other field and the table is rebuilt from them inside the same atomic batch as
  the item write. This looks like redundancy worth removing — it isn't. Storing tags only in the
  join table would make a restored revision silently lose them, because revisions snapshot `data`.
  What the index buys is filtering a content list by term without scanning every row and parsing
  its `data` blob.
- **Menu items reference their target, never store a URL.** That is the entire point: a moved page
  keeps its place in the navigation and an unpublished one leaves it, with no menu edit. A deleted
  target nulls the reference rather than cascading, so the broken entry stays visible in the admin
  instead of silently editing the site's navigation. Public rendering skips it either way.
- **Terms have no materialised path**, unlike content items. Content items need one because a
  request URL must resolve in one indexed lookup on the hot path; terms have no public URL, and
  their only tree query is a recursive CTE off `parent_id`. Adding a path would mean a second
  cascading-rewrite implementation serving no read.
- `block` and `repeater` field types have columns and validation seams but no editing UI until
  Phase 2. Media hotspot/crop columns exist with no editor yet.

## Definition of done for a phase

From SCOPE.md, treated as a standing requirement rather than cleanup:

1. `npm run dev` works end to end from a fresh clone with only `npm install`, a copied `.env`, and
   `npm run db:seed`. If a phase adds a required env var or service dependency, fixing the
   zero-setup story is part of *that* phase.
2. Seed data is realistic enough to see the feature working, and reseeding stays idempotent.
3. `npm test`, `npm run typecheck`, and `npm run a11y` all pass.
4. [DEPLOYMENT.md](DEPLOYMENT.md) is still accurate.
5. [README.md](README.md)'s status and "what's next" reflect reality.
