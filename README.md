# Taproot

A DB-backed, Astro-native CMS aimed at a real-world case: a campus website with many non-technical
departmental contributors.

**Status: Phases 0, 1, and 2 complete.** Sign in, define a content type and its fields visually, write
content with a real rich text editor, pick images from a real media browser, classify it, relate it
to other content, put it in a menu, set its focal point, and see it render — cropped to that focal
point — at a real nested URL. See [SCOPE.md](SCOPE.md) for the full plan and
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

On a database with no accounts — a fresh deployment rather than a seeded clone — `/admin` sends you
to a setup screen that creates the first administrator instead.

There is no other setup step. No database to provision, no OAuth app to register, no build
toolchain — Taproot has zero native dependencies.

---

## What works today

- **Portable data layer.** One codebase on SQLite (dev), Cloudflare D1 (production), or Postgres.
- **A visual content-type builder.** Add a field, pick its type, configure it in a form — with a
  live preview rendered through the same control the real editor uses, so it cannot drift. Text,
  richtext, number, boolean, date, select, media, taxonomy, relation, and block all have real
  editing controls; `repeater` is the one that does not, and the builder says so rather than
  offering it as if it worked.
- **Hierarchical URLs that actually nest.** `/admissions/apply` and `/financial-aid/apply` coexist,
  because slugs are unique among siblings rather than site-wide.
- **Cascading moves.** Renaming or re-parenting a page rewrites every descendant's path and writes
  a redirect for each one, atomically.
- **Revision history.** Every save appends a snapshot, with restore-to-any-revision. A restore runs
  through the normal update path, so restoring an older slug moves the subtree and writes the
  redirects rather than stranding the children.
- **Taxonomies.** Term trees any content type can use, attached by giving the type a taxonomy
  field. "Every item anywhere under this branch" is one indexed query rather than a scan over
  parsed JSON — and it is what the content list's term filter runs, so filtering by "Academics"
  finds a page filed under "Sciences". Classification only: a term never decides who may edit
  content.
- **Relations, in both directions.** Point a field at another content type and pick items by title
  from a searchable list. The item being pointed *at* shows what depends on it, grouped under
  whatever the field calls that side — so you find out before deleting, not after.
- **Redirects you can write yourself.** Every path change still writes one automatically; the ones
  you add by hand are for URLs that were never Taproot pages, which is most of what a migration
  needs. Both take part in the same chain collapse, so `/old → /b → /c` becomes `/old → /c` rather
  than a hop the browser has to walk.
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
- **A media library you can actually browse.** One picker — a grid with search and upload in
  place — behind every field that chooses an asset, rather than a `<select>` of filenames that only
  helps someone who already knows what `quad-autumn-2.jpg` looks like. It is a listbox, so the
  whole grid is one tab stop with arrow keys inside it; multi-select keeps the order you chose in,
  and reordering works by buttons as well as by dragging. Uploading asks for alt text, because that
  is the moment you know what the image is for.
- **Focal point and crop, stored as data rather than baked in.** Set one focal point and watch it
  play out in a wide banner, a social card, a square thumbnail, and a portrait card at once —
  because that is the decision being made, and it cannot be judged from a single frame. Drag it, or
  focus the image and use the arrow keys. The site renders through it too: `TaprootImage` resolves
  the stored rectangle into a real `<img>`, so the crop the editor chose is the crop a visitor
  sees, with no derivative files and nothing to regenerate when a template changes shape.
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
- **Auth built around email and password.** Sessions are opaque tokens hashed at rest, passwords
  are PBKDF2-SHA256 through `crypto.subtle` — no native module, so the same code runs in Node and
  on Workers. Sign-in is throttled per address *and* per client IP, because limiting only the
  account leaves password-spraying untouched. OAuth (Google/GitHub/Microsoft) is optional and sits
  alongside it.
- **People, added without knowing their passwords.** An admin creates an account and gets a
  one-time link to hand over; the person sets their own. Nothing temporary is stored, and no
  administrator ever knows a colleague's password. A fresh install bootstraps through a setup
  screen that disables itself atomically the moment an account exists.
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
| `npm test` | Unit tests (694 covering dialects, auth, sign-in throttling, API routes, storage adapters, guards, paths, validation, revisions, taxonomies, menus, redirects, SEO, blocks, the field builder) |
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

### Email and password is the front door, not a back one

It began as a development-only provider that the app refused to boot with outside development, on
the reasoning that a password backdoor which is meant to be off and quietly is not is exactly the
bug that survives to production.

That was right about a *backdoor* and wrong about a *front door*. What made it dangerous was being
a hidden second way in, not the passwords — so it became the visible first way in, with the things
a front door owes: a throttle, a length minimum, single-use set-password links, and a first-run
screen that closes behind itself. OAuth stays wired and optional, because registering a provider
app is real setup a fresh clone cannot do, and that is the same reason this is the default.

The guard that survived is the one that still means something: a deployment with no way in at all
refuses to start.

---

## Accessibility

The admin itself must be WCAG 2.1 AA — separate from the content-accessibility checker that arrives
in Phase 4. Debt here compounds, so it is checked per phase rather than at the end:

```bash
npm run dev      # in one terminal
npm run a11y     # in another
```

`a11y:axe` runs axe-core against every admin route's server-rendered HTML, plus one check axe does
not make: that every `<label for>` points at an element that can actually be labelled. `a11y:contrast`
checks the design tokens numerically, because jsdom cannot compute contrast — it caught five failing
pairs during Phase 0, including input borders at 1.81:1 against a 3:1 requirement.

The label check found seven inert labels on its first run, all pointing at custom controls that had
replaced a plain input. None was a WCAG failure — each control was still named correctly — but the
markup was invalid and clicking the label did nothing. It also surfaced why they had gone unseen:
the audit picked its item editor with `items[0]`, which meant the alphabetically-first path, which
meant a singleton with three plain inputs. It now picks by field count.

Two things these do **not** cover, and which need a real browser and a human: post-hydration
behaviour of the React islands, and screen-reader output. The field builder's drag-and-drop
reordering is layered on *alongside* its keyboard buttons rather than replacing them — that is the
pattern any future drag interaction should follow.

Widgets that only exist after hydration get a jsdom test running axe on the hydrated tree instead —
the richtext toolbar and the media picker, neither of which the audit can reach. One thing even
that cannot check: the picker's two-dimensional arrow navigation reads the grid's real layout, and
jsdom computes none, so under test it degrades to walking the list one card at a time. The
degradation is asserted; the measured behaviour needs eyes.

---

## Testing

```bash
npm test
```

694 tests. The ones worth knowing about:

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
- The media picker's keyboard contract and its selection semantics, in jsdom — including that a
  selection survives a search that no longer returns it. That one was written as a guess and found
  a real bug: the footer still counted the image, so the only evidence was the page afterwards.
- That `listMedia` with an empty id list returns nothing rather than the whole library. `in ()` is
  a syntax error, so the tempting fallthrough is the dangerous one.
- That two concurrent first-run setups produce one administrator, not two. The check and the insert
  are one statement for exactly this reason — it is the only unauthenticated write in the admin.
- That the sign-in throttle refuses *before* verifying the password, so a correct password does not
  slip through a lockout and a locked-out attacker cannot spend the server's CPU on 210,000 PBKDF2
  iterations per request.
- That a set-password link cannot be used twice, and that two concurrent uses leave exactly one
  winner rather than one password silently overwriting another.
- That the last active administrator cannot be demoted or deactivated, including the case where the
  only other admin is already deactivated.
- That the storage adapters refuse a key escaping the upload directory — on reads and existence
  checks as well as writes, which is where they used to disagree with each other.
- The API routes themselves: the 401-versus-403 distinction, that a refused delete is a 409 rather
  than a 500, and that an unexpected error never returns its own message to the client.

---

## What's next

**Phase 3**, per [SCOPE.md](SCOPE.md): user management, the draft/review/schedule/publish workflow
with role gates, a scheduler, and an audit log.

It is smaller than it used to be. The plan called for departments as a first-class entity — with
membership, ownership of content items, and role assignments scoped to them — and that turned out
to be the wrong reading of what a department is here. A department is *what a page is about*, which
is what a taxonomy does, and the Phase 1 `department` taxonomy already does it. With no ownership
dimension, there is nothing for a scoped role to scope, so roles are flat and site-wide: Admin,
Editor, Contributor, Viewer.

That model is already built and enforced on every screen and every route, and **user management
shipped early** — it had to, because email and password became the primary sign-in method and a CMS
you cannot add a second person to is not much of a CMS. So what Phase 3 actually still owes is the
workflow: role-gated transitions between draft, review, scheduled, and published; something that
flips a scheduled item live; and an audit log.

The honest cost of flat roles is that a contributor who can edit one page can edit them all. The
answer if that starts to bite is a role × content-type matrix, which is a small retrofit precisely
because there is no ownership to model.

`repeater` is the one field type still with only its columns and a validation seam — the builder
labels it "No editor yet" rather than offering it as though it worked.

Phase 0 deliberately left seams rather than stubs that would need unpicking, and Phase 1 filled
every one of them — `fields` was already a real table, `content_items` already carried
`parent_id`/`path`/`depth`, the empty `seo` column is now the SEO sidebar, and the hotspot and crop
columns are now the focal point editor.

Known gaps: two-factor authentication is not available. The TOTP implementation in core is complete
and verified against the RFC 6238 test vectors, but nothing enrols anyone and sign-in never
challenges for a second factor, so the module is currently unreachable. There is also no
self-service password reset — an admin generates a link — and no email is sent anywhere, which is
why Taproot still needs no external service to run.

The richtext editor needs JavaScript, unlike the rest of the admin. That is unavoidable for a
document editor, and the item editor around it is already an island; the trade is noted rather than
hidden. Underline is allowed by the sanitiser but has no toolbar button, because underlined text
that is not a link is a usability problem — pasted underlines survive, new ones are not encouraged. Content lists are ordered by path and cannot
be sorted by date — for a hierarchical type the path order *is* the tree, so a date sort would
leave the indentation describing a nesting the rows no longer follow.

`scheduled` is a real status with a colour and a filter option, but the editor does not offer it:
nothing yet flips a scheduled item live. The seed includes one so the gap is visible rather than
theoretical.
