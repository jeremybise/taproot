# Taproot

A DB-backed, Astro-native CMS aimed at a real-world case: a campus website with many non-technical
departmental contributors.

**Status: Phases 0, 1, and 2 complete.** Sign in, define a content type and its fields visually, write
content with a real rich text editor, classify it, put it in a menu, set its focal point, and see it
render at a real nested URL. See [SCOPE.md](SCOPE.md) for the full plan and
[what's next](#whats-next).

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
- **A visual content-type builder.** Add a field, pick its type, configure it in a form — with a
  live preview rendered through the same control the real editor uses, so it cannot drift. Text,
  richtext, number, boolean, date, select, media, taxonomy, relation, block, repeater.
- **Hierarchical URLs that actually nest.** `/admissions/apply` and `/financial-aid/apply` coexist,
  because slugs are unique among siblings rather than site-wide.
- **Cascading moves.** Renaming or re-parenting a page rewrites every descendant's path and writes
  a redirect for each one, atomically.
- **Revision history.** Every save appends a snapshot, with restore-to-any-revision. A restore runs
  through the normal update path, so restoring an older slug moves the subtree and writes the
  redirects rather than stranding the children.
- **Taxonomies.** Term trees any content type can use, attached by giving the type a taxonomy
  field. "Every item anywhere under this branch" is one indexed query rather than a scan over
  parsed JSON. Classification only — a term never decides who may edit content.
- **An admin shaped by your content model.** Every content type is its own sidebar entry in an
  order you set, singletons open straight into their editor, and Settings is a hub rather than one
  long scrolling page.
- **Content lists built for scanning.** Colour-coded status badges, a faceted status filter whose
  counts tell you what each option would return, and created/updated columns that tighten to a
  time for today's edits and widen to a year for old ones.
- **Page composition with blocks.** Block types are built with the same visual field builder as
  content types, because a block type *is* a user-defined schema with fields. Editors add, reorder,
  and edit blocks inline; reordering works by dragging and by buttons. Taproot ships no block
  templates — `BlockRenderer` takes a map from block name to your own Astro component, because a
  CMS that shipped a hero component would be shipping a design.
- **Reusable blocks.** Promote a block to a shared library and every page referencing it changes
  when you edit it once. A referencing page stores the reference and no copy, so there is never a
  question of which version is authoritative — and deleting a library entry is refused while
  anything still uses it.
- **Focal point and crop, stored as data rather than baked in.** Set one focal point and watch it
  play out in a wide banner, a social card, a square thumbnail, and a portrait card at once —
  because that is the decision being made, and it cannot be judged from a single frame. Drag it, or
  focus the image and use the arrow keys.
- **A rich text editor that cannot be used as an attack.** TipTap with an ARIA-pattern toolbar —
  one tab stop, arrow keys between buttons, `aria-pressed` state. Values are sanitised **on the
  server, on write**, through an allowlist serialiser, because the REST API accepts richtext from
  any client and the editor is therefore not the boundary.
- **An SEO sidebar with live previews.** Meta title, description, social image, and a noindex
  toggle — with a search-result and a shared-link preview beside them, resolved through the same
  code the public page uses, so the preview cannot drift from what actually ships. Social images
  fall back to a per-content-type default.
- **Menus that reference rather than record.** A menu item points at a page, so moving that page
  updates the navigation and unpublishing it removes the entry — without anyone editing the menu.
  Menu items can also point at taxonomy terms, though whether a term has a public page at all is
  the site's decision, not Taproot's.
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
| `npm test` | Unit tests (245 covering dialects, auth, paths, validation, revisions, taxonomies, menus, SEO, the field builder) |
| `npm run typecheck` | TypeScript across `@taproot/core` and `@taproot/astro` |
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
behaviour of the React islands, and screen-reader output. The field builder's drag-and-drop
reordering is layered on *alongside* its keyboard buttons rather than replacing them — that is the
pattern any future drag interaction should follow.

---

## Testing

```bash
npm test
```

418 tests. The ones worth knowing about:

- Both SQL dialects against a real database, including that `node:sqlite` rejects JS booleans — the
  driver coerces them, and there is a test that fails loudly if that regresses.
- Sibling-slug uniqueness in both the NULL-parent and non-NULL-parent cases. A plain unique index
  on `(parent_id, slug)` would let two root pages share a slug, because NULL never equals NULL.
- Cascading moves: descendant rewrites, redirect creation, redirect-chain collapse, cycle refusal,
  and that a rejected move leaves the tree untouched.
- Restoring a revision whose slug differs moves the subtree and writes the redirects — the case
  that would silently strand every child if a restore wrote the old row back directly.
- Restoring a revision restores its tags, which is the whole reason taxonomy assignments are a
  derived index rebuilt from `data` rather than the place tags actually live.
- TOTP against the RFC 6238 test vectors, so the implementation is verified correct rather than
  merely self-consistent.
- The status filter rejects `toString` and `constructor`, because testing membership with `in`
  rather than against a list would have let every inherited key through to the query.
- Status facet counts apply the same search as the list they label — they come from one shared
  filter builder, and the test is what says so.
- SEO resolution treats a whitespace-only meta title as unset, so `"  "` cannot blank out the
  title a page actually renders.
- Twenty-nine XSS vectors against the richtext sanitiser, written as attacks rather than examples —
  split tags, encoded schemes, control characters inside a URL, comment smuggling. Plus an
  idempotence check, because sanitised content is re-sanitised on every save.
- The richtext toolbar's keyboard contract, run in jsdom. The axe script cannot see it: ProseMirror
  needs a real DOM, so the server renders an empty placeholder and the toolbar only exists after
  hydration.
- The focal point's keyboard contract — arrows, Shift, Home/End, PageUp/PageDown, and that it
  clamps to the crop instead of wrapping to the far side of the image.
- Crop resolution across every combination of source orientation, target ratio, and focal position,
  asserting the result is always a real region inside a real image.
- That `listContentTypes` excludes block types by default — the behaviour the sidebar, the item
  picker, and the relation target list all depend on without asking for it.
- That richtext inside a block is sanitised exactly as it is at the top level, because block
  validation recurses through the same function.
- That editing one reusable block changes every page referencing it — the entire point of the
  feature, and the thing that silently stops working if a copy is ever stored alongside the
  reference.
- That deleting a block type checks the reusable library as well as content items: an entry no page
  references yet is invisible to the usage count, and deleting the type would strand it.
- Image headers built byte by byte rather than committed as binary files, so a diff shows exactly
  which bytes the parser depends on — including that width and height are not transposed, which is
  the likeliest bug and invisible on a square fixture.

---

## What's next

**Phase 3**, per [SCOPE.md](SCOPE.md): departments as a first-class entity with membership and
ownership, a scoped role model, the draft/review/schedule/publish workflow with role gates, and an
audit log. Departments are built there rather than earlier because nothing before it consumes them
— Phase 1's taxonomies classify content, they do not own it.

`repeater` is the one field type still with only its columns and a validation seam.

Phase 0 deliberately left seams rather than stubs that would need unpicking, and Phase 1 filled
every one of them — `fields` was already a real table, `content_items` already carried
`parent_id`/`path`/`depth`, the empty `seo` column is now the SEO sidebar, and the hotspot and crop
columns are now the focal point editor.

Known gaps: the TOTP enrolment UI is not built, though the core is implemented and tested. The SEO
panel and the hotspot editor both reach the media library through a select rather than a browser —
the real picker arrives with the `media` field type, and both move to it then.

The richtext editor needs JavaScript, unlike the rest of the admin. That is unavoidable for a
document editor, and the item editor around it is already an island; the trade is noted rather than
hidden. Underline is allowed by the sanitiser but has no toolbar button, because underlined text
that is not a link is a usability problem — pasted underlines survive, new ones are not encouraged. Content lists are ordered by path and cannot
be sorted by date — for a hierarchical type the path order *is* the tree, so a date sort would
leave the indentation describing a nesting the rows no longer follow.

`scheduled` is a real status with a colour and a filter option, but the editor does not offer it:
nothing yet flips a scheduled item live. The seed includes one so the gap is visible rather than
theoretical.
