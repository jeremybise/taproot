# Taproot

A DB-backed, Astro-native CMS aimed at a real-world case: a campus website with many non-technical
departmental contributors.

**Status: Phases 0 through 4.6 complete, Phase 5A–5D, and Phase 5.5.** Sign in, define a content type and its fields visually,
write content with a real rich text editor, pick images from a real media browser, classify it,
relate it to other content, put it in a menu, set its focal point, and see it render — cropped to
that focal point — at a real nested URL, **on your own site, beside the editor, as you type**. Then
move it through a review workflow, schedule it, batch it with a dozen other pages into a release
that goes live all at once, search it by any phrase it contains, find out which pages are hard to
use with a screen reader, and read back who did what in the audit log. See [SCOPE.md](SCOPE.md) for the full plan and
[what's next](#whats-next).

**The handbook is in [`apps/docs`](apps/docs)** — `npm run docs` — and covers using the CMS,
administering a site, and running the server.

---

## Quick start

**Starting your own CMS:**

```bash
npm create taproot my-cms
cd my-cms && npm install && npm run db:migrate && npm run dev
```

It asks whether to start blank or with a minimal starter, then <http://localhost:4321> takes you to
a setup screen that creates the first administrator. What that scaffolds is the **server**; the
website is a separate project that installs `@taprootcms/astro` and reads over HTTP.

**Running this repository**, which is the demo and the reference consumer:

```bash
npm install
cp .env.example apps/studio/.env
cp apps/web/.env.example apps/web/.env
npm run db:seed
npm run dev
```

That starts **two** servers, which is the architecture rather than an inconvenience: the CMS at
<http://localhost:4321> (sign in at `/admin` with **admin@example.com** / **taproot**) and the site
that reads from it at <http://localhost:4323>. The site holds an API key and talks to the CMS over
HTTP; it has no database and no admin panel.

On a database with no accounts — a fresh deployment rather than a seeded clone — `/admin` sends you
to a setup screen that creates the first administrator instead.

There is no other setup step. No database to provision, no OAuth app to register, no build
toolchain — Taproot has zero native dependencies.

---

## What works today

- **Portable data layer.** One codebase on SQLite (dev), Cloudflare D1 (production), or Postgres.
- **A visual content-type builder.** Add a field, pick its type, configure it in a form — with a
  live preview rendered through the same control the real editor uses, so it cannot drift. Text,
  richtext, number, boolean, date, select, media, taxonomy, relation, block, and repeater — every
  one of them with a real editing control.
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
- **Two-factor authentication.** TOTP, with a QR code and a typeable key, ten single-use recovery
  codes shown once, and a challenge between the password and the session — so a correct password
  alone is not a way in. A spent code cannot be replayed inside its own window, which is what stops
  one read over a shoulder working twice.
- **People, added without knowing their passwords.** An admin creates an account and gets a
  one-time link to hand over; the person sets their own. Nothing temporary is stored, and no
  administrator ever knows a colleague's password. A fresh install bootstraps through a setup
  screen that disables itself atomically the moment an account exists.
- **A delivery API that answers a page in one round trip**, and a thin Astro client that reads it.
  The item, its type, breadcrumbs, children, blocks already dereferenced, resolved SEO, and lookup
  maps for media, relations, and terms — one request, with an ETag. Types for your own content
  types are generated from the live model, so the consumer is typed over what it actually receives
  rather than over table rows.
- **API keys that are principals rather than users.** A key carries scopes and no role, and the
  admin's own REST API refuses one outright — narrowing what a machine may do only means something
  if the machine cannot reach the screens people use.
- **A checker that reads your content, not just your admin.** Missing alt text, headings that skip
  a level, links reading "click here" — in a panel beside the editor that updates as you type, and
  in a report covering the whole site so an existing backlog is something you can work through
  rather than merely be told about. It never blocks a save or a publish: an author who cannot
  publish because a checker disagrees learns to route around the CMS. Decorative images are a state
  of their own, because "nobody has described this" and "this needs no description" look identical
  in an empty box and mean opposite things.
- **An accessible admin.** WCAG 2.1 AA, verified by `npm run a11y` — a separate thing from the
  checker above, and both matter: an editor can write an inaccessible page in a perfectly
  accessible editor.

---

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Both servers: the CMS on :4321, the site on :4323. Astro 7 daemonises each — stop one with `astro dev stop --root apps/studio` (or `apps/web`) |
| `npm run dev:studio` / `dev:web` | One at a time |
| `npm run db:seed` | Migrate and seed. Idempotent — safe to re-run |
| `npm run db:reset` | Delete the local database and re-seed |
| `npm run db:migrate` | Apply pending migrations locally |
| `npm run db:migrate:remote` | Apply them to deployed D1 |
| `npm run docs` | The handbook at :4322 — Starlight, no database, builds on its own |
| `npm test` | Unit tests (1015 covering dialects, auth, sign-in throttling, password reset and mail, API routes, storage adapters, guards, paths, validation, revisions, releases, the delivery API and type generation, taxonomies, menus, redirects, SEO, blocks, the field builder, the accessibility checker) |
| `npm run typecheck` | TypeScript across `@taprootcms/core` and `@taprootcms/studio` |
| `npm run a11y` | axe-core audit of every admin screen, plus a contrast check |
| `npm run preview` | Build and serve through `wrangler dev` — the real Workers runtime |
| `npm run deploy` | Build and `wrangler deploy` (see [DEPLOYMENT.md](DEPLOYMENT.md)) |

---

## Layout

```
packages/core            @taprootcms/core    data layer, auth, content services, storage
packages/studio          @taprootcms/studio  the SERVER: admin panel, REST API, delivery API
packages/astro           @taprootcms/astro   the CLIENT a site installs. No database; ~460K built
packages/create-taproot  create-taproot      npm create taproot
apps/studio              the CMS deployment — owns the database, runs the scheduler
apps/web                 the reference consumer — holds an API key, reads over HTTP
apps/docs                the handbook
```

The names are the architecture. `@taprootcms/astro` is what a *site* installs; the server is
`@taprootcms/studio` and a site never installs it. Having those the wrong way round was the Phase 0
misreading that Phase 3.75 corrected.

The consumer must never pull the data layer into its bundle, and the check is concrete: the built
consumer is ~460K against the server's 12M, and contains no `kysely`. `@taprootcms/astro` imports
`@taprootcms/core/pure` at runtime — crop arithmetic and nothing else — and everything else as
`import type`, erased at build.

`@taprootcms/studio` ships TypeScript and `.astro` **source** rather than a build. Astro's
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

The admin itself must be WCAG 2.1 AA. That is a different thing from the content-accessibility
checker described above, and both are needed — an editor can write an inaccessible page in a
perfectly accessible editor, and a checker that reports on content says nothing about the screen it
is reported on. Debt here compounds, so it is checked per phase rather than at the end:

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

1015 tests. The ones worth knowing about:

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
  slip through a lockout and a locked-out attacker cannot spend the server's CPU on 100,000 PBKDF2
  iterations per request.
- That a set-password link cannot be used twice, and that two concurrent uses leave exactly one
  winner rather than one password silently overwriting another.
- That the last active administrator cannot be demoted or deactivated, including the case where the
  only other admin is already deactivated.
- That the storage adapters refuse a key escaping the upload directory — on reads and existence
  checks as well as writes, which is where they used to disagree with each other.
- The API routes themselves: the 401-versus-403 distinction, that a refused delete is a 409 rather
  than a 500, and that an unexpected error never returns its own message to the client.
- That the accessibility checker treats `h2 → h3 → h2` as legal. Going back *up* a level is a new
  section, not a skip — and calling it one is the most common way this rule is got wrong.
- That an image marked decorative is not reported and an undescribed one is. The two are the empty
  string and null, and every screen that used to ask `!altText` could not tell them apart.
- That the checker's panel fetches an asset outside the media library's first page instead of
  reporting it as undescribed, and asks for it exactly once — a re-request per keystroke is what
  the naive version does.

---

## What's next

**Phase 5 is under way** — editing, querying, and assistance, in seven parts. Integrations moved to
Phase 6 and the form builder to Phase 10; see [SCOPE.md](SCOPE.md) for the whole band and why it is
ordered the way it is.

**5A — expand and collapse — is done.** Blocks have collapsed to a summary row since Phase 2 and
repeater entries never did, so a staff list of thirty rows buried every field below it. Both now
collapse the same way, with an "Expand all" / "Collapse all" pair once there is more than one.

Two things came out of building it that were not visible from the plan. The default has to stay
expanded, and not because it reads better: `npm run a11y` audits the server-rendered markup, and a
collapsed panel is `hidden`, which axe skips — so collapsing long lists by default would quietly
drop every field inside every block from the run while it still reported zero. And the audit was
already missing both editors, for a reason worth writing down: it picks the item editor by **field
count**, which is a fact about the content type, while composition is a fact about the **item** — the
field-count winner on the seeded database had no blocks placed and no repeater entries at all. It now
also picks the block-heaviest and row-heaviest items, counted separately, because they are different
items and one combined score leaves repeaters unaudited.

**5B — conditional fields — is done.** A field can now say when it appears: *show the message only
when the banner is switched on*. The seeded weather banner already had exactly that shape and showed
its message and severity whether or not anybody had enabled it, which is the whole case in one
screen.

The two decisions worth knowing, because both could reasonably have gone the other way. A hidden
field is **not required** — otherwise somebody is blocked by an input they cannot see. And a hidden
field's value is **kept**, not cleared: clearing would mean adding a condition on the content-type
screen silently wiped that field across every item the next time anyone saved one, with nothing in
the revision history showing an author doing it. Untick the box and tick it again and your text is
still there. What your site renders is still its own decision — Taproot ships no templates.

**5C — the query field — is done.** A block can hold a *rule* instead of a hand-picked list: *events
still to come, soonest first*; *faculty in this department*. Publishing a new event adds it to every
listing that matches, with nobody editing a page. The editor shows what the rule currently returns —
the count and the first few titles — because a rule you cannot see the effect of is a form you have
to publish to test. The seeded **Visit** page carries one, and `apps/web` renders it as cards with
dates and locations.

Three decisions shape it. The admin fixes *what may be asked* — which content type, which taxonomy,
which date decides "still to come", how many at most — and each editor placing the block picks their
own term, window and count, which is what lets one "Faculty" block serve twenty department pages. A
query stores the rule and **never** the answer, so restoring an old revision restores the rule and
the rule answers with today's content. And "still to come" is stored as an intention rather than a
date: it is worked out against the clock every time the page is read, so a listing does not quietly
stop working the day after somebody edits it.

Sorting by an event's *own* start date rather than by when it was published needed a small index
behind the scenes, rebuilt whenever an item is saved. **If you are upgrading an existing site, run
`npm run db:reindex` once** — until you do, listings that filter or order by a field value will
behave as though nothing matches. Nothing is lost; it just has not been indexed yet.

**5D — search — is done.** A site can search its own content, and so can the admin. `taproot.search('financial aid')`
returns ranked results with a plain-text excerpt around the match, and `apps/web` has a worked
`/search` page — a plain form, no JavaScript, the query in the URL so a result page can be shared.
The admin's "All content" box searches the same way, so an editor can find a page by a phrase buried
in it rather than only by its title.

What it searches is an item's *prose*: every text and rich-text value it holds, including the ones
inside blocks and repeater rows, flattened to plain words when the item is saved. Markup never
matches — searching for "strong" does not find every page with bold text in it.

Deliberately not FTS5 or `tsvector`. Either would buy sharper ranking and cost the thing this repo
has protected since Phase 0: one migration set that runs unbranched on SQLite, D1 and Postgres.
Ranking is five bands — an exact title, a title beginning with the term, a title containing it, the
path, the body — because that is what a `LIKE` genuinely knows, and arithmetic on top of it would be
a score that looks principled and is not.

Two limits, both stated rather than papered over. Text that lives *only* in a reusable block is not
found through the pages that show it: the page stores a reference and no copy, and pulling the
library's content in would mean rebuilding every referencing page's index each time that entry was
edited. And **an existing site must run `npm run db:reindex` once** — the same command 5C added, now
rebuilding both indexes. Until it does, search finds items by title and by nothing else, which is
why Settings → System now reports how many items have never been indexed.

**Next in the band:** media multi-upload (5E), menu link-picking (5F) and AI-assisted alt text (5G),
all independent of each other.

**Phase 5.5 — performance and caching — is done.** The caching SCOPE deferred until there was a
boundary to invalidate against, now that Phase 3.75 has provided one.

The uncomfortable finding first: the cache headers had never done anything. Delivery responses and
rendered pages had been sending `cache-control: public, max-age=0, s-maxage=60` since the delivery
split, and **Cloudflare caches neither JSON nor HTML by default** — its default cache is keyed on file
extension, and a Worker's own response is not cached unless the Worker asks. `"cache": { "enabled":
true }` in both `wrangler.jsonc` files is what turns them on; a hit now serves a page with no CPU
billed, no request to the CMS, and no database work anywhere. The general lesson is the one the
preview pane already taught: confirming a header is present is not confirming it had an effect.

The ETag had the same shape of problem. It was computed *after* `resolveDelivery` had run every
query, so a 304 cost exactly what a 200 did — it saved a payload, which is the part Cloudflare does
not charge for. A conditional request is now answered from one indexed lookup before anything
resolves. `Cache-Tag` closes the gap the validator was documented as unable to see: a page names its
dependencies (`item:`, `type:`, `block:`, `menu:`) in the header **and** in the payload, because a
consumer has to tag the HTML it renders and cannot derive those dependencies itself.

Then the things that were simply costing money. The five-minute housekeeping sweep was running **two
full table scans on unindexed columns**, forever, on a deployment where nobody had signed in;
`blockTypeRegistry` scanned `content_types` on **every page view**, including pages with no blocks on
them. `listItems` was hydrating full `data` and `seo` JSON blobs for callers that render a list of
links. The site's layout fetched the navigation, which Astro cannot start until the page's own fetch
has finished — a serial round trip to the CMS on every page view, now one `Promise.all` in the page.

**Two of those were found by measuring and would not have been found by reading.** `npm run
query-count` reports database queries per page view against the seeded database and fails over
budget; `queryPlans.test.ts` asserts the sweep's predicates use an index rather than merely that they
run. That second one earned its place immediately: adding an index to each side of an `or` changed
the query plan by *nothing at all*, because SQLite's OR-to-union optimisation does not fire for that
delete — the statement had to be split in two before the indexes were spent. Green migration,
correct-looking index, unchanged scan.

**If you are upgrading, run `npm run db:migrate`** for `0020_perf_indexes`. Nothing breaks without
it; the sweep just keeps scanning.

Left for Phase 6, deliberately: purging a *consumer's* cached HTML. The CMS purges its own cache
in-process, but reaching into a site's cache means an authenticated outbound call to an endpoint the
site mounts, which is the outbound-HTTP layer Phase 6 already owns. Until then a site's HTML is
bounded by its own `s-maxage`, exactly as before.

**Phase 5.6 — responsive images — is done.** `TaprootImage` shipped one `<img>` at the source's full
width, so a phone got whatever an editor dragged in. It now emits a `srcset` and the CMS media route
resizes to match. Measured on one real page: four images went from 2,182 KB to 195 KB, and sharper.

Setup is one binding — `"images": { "binding": "IMAGES" }` — and **no domain of your own**; it works
on a `workers.dev` subdomain. Without it nothing breaks, because the route serves the stored original,
which is also why Node development needs nothing. Sites get the benefit by passing `sizes`, and more
of it with `crop="server"`, which asks the CMS for the cropped rectangle so no hidden pixels are
downloaded. That mode degrades to a hotspot-framed original wherever the transform cannot happen, so
its worst case is an approximate crop rather than the wrong picture.

Four things went wrong on the way and every one was found by measuring rather than by a test, which
is the same lesson the cache headers taught. **The encoding quality was never set**, and the binding
defaults to near-lossless — a 170 KB JPEG came back as a 610 KB WebP, so the feature meant to make
pages lighter was making them heavier, silently, for three releases. **`sizes` was rescaled by
splitting on the last space**, which takes `57px)` out of `calc(50vw - 57px)` and scales one term:
valid CSS computing the wrong number, and only visible in rendered HTML. **The ladder capped a crop
at the rung below it**, discarding a quarter of the detail that existed. And **`npm install @latest`
resolved a stale version**, so one deploy shipped the previous release's code and looked like a
Cloudflare bug.

**If you set `TAPROOT_MEDIA_URL` to an R2 custom domain, media bypasses the Worker route and the
resizing goes with it, silently.** Pick one or the other — see [DEPLOYMENT.md](DEPLOYMENT.md).

**Phase 4.6 — the admin UI pass — is done.** Part A: one sticky action bar per screen, status
transitions behind a promoted action plus a menu, add-to-release moved into the Publishing panel
where it no longer throws away unsaved edits, and a sidebar user menu.

Part B: **an editor links to a page by picking it, not by typing its address.** The reference is what
gets stored, so renaming or moving that page updates every link to it across the site without anyone
editing any content — and a link whose target is unpublished or deleted arrives as plain text rather
than pointing at a 404. Files link the same way. Your site does nothing for any of it: the HTML it
receives already has ordinary `href`s.

The controls for that started as a row of fields wrapped into the editor's toolbar strip, which at
the ~400px the editor column becomes with the preview pane open was unusable — and which could not
answer the first question anyone asks of an existing link, *where does this currently point?* A
reference is correct and unreadable, so the id is now exchanged for a title. One dialog covers a
page, a file, and a web address; it opens on the kind of link that is already there and names it,
with a way to go and look at it and a way to remove it. Three things came out of building it:

- **A modal is not free.** It takes focus, and the browser's selection inside the editor goes with
  it, so the caret's range is captured on open and restored on apply — otherwise "select a phrase,
  choose a page" silently becomes "insert a page title next to it".
- **Radix portals to `document.body`, but React events propagate through the React tree.** Apply
  submitted the item editor's form as well as the dialog's: the page saved, redirected, and the link
  never landed. Every test passed, because they all render the editor on its own. There is now one
  that renders it inside a form.
- **`Ctrl/Cmd + K` did nothing**, and had been documented for as long as the handbook has existed.

Part C: **the CMS wears your name.** Title, logo, and an accent per palette, in Settings → Branding —
none of it reaching your website, all of it reaching the people who sign in. One colour is chosen and
the hover shade, the label on a solid button, and the tint behind the current sidebar item are
derived from it, because a button label is a question with a right answer and offering it as a choice
is offering a way to make Save unreadable. What is genuinely the colour's own property — whether it
is dark enough to be link text — is measured live against the WCAG thresholds and reported rather
than blocked.

The derivation is checked over the whole hue circle rather than on the one colour anybody would try,
and that sweep found a real defect immediately: moving the hover shade *away from the surface* is the
obvious rule and it is wrong. For a pale accent the label is dark, so a darker hover walks the
label's contrast down until the button fails on hover while passing at rest. Hover moves away from
the *label* instead. The audit also gained two pairs it had never checked — the accent is link text
inside the rich-text editor, and that had only ever been thought of as a button background.

**Phase 4.5 is done.** A live split-view preview: your site rendered beside the editor, following
what you type, with no in-place editing and no bespoke integration. Four things about it:

- **The CMS still renders nothing.** Taproot ships no templates, so it has nothing to draw a page
  with — the rendering stays on your site, which resolves the page server-side as it always did.
  What crosses the gap is the editor's unsaved form state, parked on the preview token that already
  existed and merged over the live row exactly as a release's staged version already was.
- **The snapshot is a rendering input, not a version.** It has no status, no path, no parent; it is
  never listed, restored, or published, and it dies with its token in thirty minutes. There is a
  test asserting a snapshot write leaves `content_items` and `release_items` byte-identical, because
  "a release is the only place a content item can have a version that is not live" has to stay true
  rather than become narrowly worded.
- **Sanitising is not relaxed; completeness is.** The draft goes through `validateItemData` like
  every other write, with one option turning off exactly three rules — `required`, text
  `minLength`, repeater `minItems`. A minimum is a claim about completeness and a maximum is a
  bound on what the system will carry, and only the first is a question a half-typed form may fail.
- **A preview token is a capability over one item**, now enforced. The delivery route applied the
  override to any path the token was carried to — invisible while the only caller was a redirect
  straight to the item's own URL, and a bug the moment a frame could follow a link.

Two lines on your site (`<TaprootPreviewBridge />`) upgrade the refresh from a frame remount to a
reload from inside, which keeps the scroll position. It works without them.

**The admin is responsive**, which it had never been — a fixed 240px sidebar left 16px of content at
a 320px viewport. That is WCAG 1.4.10 Reflow, a Level **AA** criterion, so it was a conformance gap
rather than a polish item, and it survived four phases because `npm run a11y` structurally cannot see
it: jsdom computes no layout and the audit never loads the CSS. The nav is now one element that
slides off-canvas below `lg`, and `npm run a11y` gained a hazard check — narrow on purpose, because a
first draft flagged three things that measurement proved fine.

Two of the defects were invisible to inspection: a grid child missing `min-w-0`, and visually hidden
text escaping a scroll container because `position: absolute` with no positioned ancestor is not
clipped by `overflow-x: auto` — a 1px span inside a wide table dragged the page 437px sideways.

**Phase 4 is done.** The content accessibility checker: alt text, heading order, and link text, in
a panel beside the editor and in a site-wide report. Three things about it are worth knowing:

- **It never blocks anything.** Not a save, not a publish. A gate on publishing was the obvious
  alternative and is the wrong shape — an author who cannot publish because a checker disagrees
  routes around the CMS, and every false positive becomes an outage.
- **`alt_text` has three states, not two.** Null is "nobody has said" and the empty string is
  "somebody marked it decorative". Without that distinction the rule is unusable, because every
  divider and icon in the library is a permanent complaint and a panel that is always red is one
  nobody reads.
- **Heading order is checked within one rich text value.** Taproot ships no templates, so it does
  not know what order a site renders a type's fields in — the outline a visitor receives is not
  knowable from here, and claiming otherwise would mean inventing findings.

It reads *content*. The WCAG compliance of the admin itself is a different job, has been an
acceptance criterion since Phase 0, and is what `npm run a11y` checks.

**Phase 3.75 before it, and it is the one that changed the shape of the project.** Taproot is now a
CMS server plus a thin Astro client — which is what SCOPE always described and what Phases 0–2 built
the opposite of, because the original plan misread Wolly's architecture and had the admin panel
injected into the host site's own project. `npm run dev` starting two servers is that correction,
not an inconvenience.

Four things it settled:

- **The delivery API answers a page in one round trip.** `resolveDelivery` returns the item, its
  type and fields, breadcrumbs, visible children, blocks already dereferenced, resolved SEO, and
  lookup maps for media, relations, and terms. It lives in core rather than in the route, for the
  same reason `resolveSeo` does: the server's own reads and the delivery API must not drift.
- **References are lookup maps, never inlined.** Inlining would break the match between `data` and
  the field types the CMS validates against, serialise a twice-used image twice, and make the
  payload unusable for a write.
- **A redirect is a 200 carrying `{ kind: 'redirect' }`, not a 30x.** The consumer has to redirect
  its *own* visitor — a real 30x would redirect the server-side fetch and serve the wrong page's
  content under the requested URL.
- **An API key is a principal, not a user.** A key has scopes and no role, and `handle()` stays
  session-only with `handleScoped()` as the opt-in, so a route that says nothing about keys does not
  accept one. That default is what keeps a `content:read` key out of the admin REST API.

Cross-origin preview moved with it. `?preview=1` used to work only because the site and the CMS
shared an origin, so the session cookie came along — that was the whole security property, and it
disappears with the split. Preview is now a short-lived revocable token row, and one mechanism
covers both a draft and a release's staged version.

**Phase 3.5 before it.** Content Releases: a named batch of content staged to go live together,
which is the first place in Taproot a content item can have a version that is not live. Editing a
published page still publishes immediately — a release is what you use when it must not.

Three decisions are worth knowing before touching it:

- **A staged version carries its own content rather than pointing at a revision.** Revisions record
  what the live item *has been*, so staging by reference would write a line into the history of a
  page that never showed it.
- **Pre-flight instead of atomicity.** SCOPE asked what happens when item 4 of 12 fails at publish
  time; it cannot be answered with a transaction, because D1 has none spanning N item updates and
  each item's publish is already its own batch of path rewrites, redirects, and a revision. So every
  staged version is validated *before* anything is written. `release_items.published_at` makes the
  residue of a genuinely unexpected failure resumable.
- **Staging is not publishing.** Contributors stage, editors publish — which answers the permission
  question SCOPE left open, and falls out of the workflow graph rather than being a new rule, since
  every transition into `published` already needs the editor role.

The one asymmetry to remember: a scheduled *page* goes live whether or not a sweep runs, because
visibility is computed on read. A scheduled *release* does not — its content has to be applied, and
no page view can do that. Settings → System says so, and so does the handbook.

**Phase 3 was smaller than it used to be.** The plan called for departments as a first-class entity — with
membership, ownership of content items, and role assignments scoped to them — and that turned out
to be the wrong reading of what a department is here. A department is *what a page is about*, which
is what a taxonomy does, and the Phase 1 `department` taxonomy already does it. With no ownership
dimension, there is nothing for a scoped role to scope, so roles are flat and site-wide: Admin,
Editor, Contributor, Viewer.

The honest cost of flat roles is that a contributor who can edit one page can edit them all. The
answer if that starts to bite is a role × content-type matrix, which is a small retrofit precisely
because there is no ownership to model.


Phase 0 deliberately left seams rather than stubs that would need unpicking, and Phase 1 filled
every one of them — `fields` was already a real table, `content_items` already carried
`parent_id`/`path`/`depth`, the empty `seo` column is now the SEO sidebar, and the hotspot and crop
columns are now the focal point editor.

Self-service password reset shipped with it. Taproot sends exactly one message — the reset link —
and **still needs no external service to run**: with nothing configured the mailer writes to the
server log and the "Forgot your password?" link is hidden, so `npm run dev` works from a fresh
clone. Real delivery is a webhook taking flat JSON, deliberately vendor-neutral. Scheduled
publishing runs as a Cloudflare cron trigger on the CMS's own Worker — the scheduler belongs to the
server, which owns the database; the consumer has no cron and nothing to sweep. So it needs no
second service and no shared secret, and the HTTP endpoint remains for platforms with no cron of
their own.

The richtext editor needs JavaScript, unlike the rest of the admin. That is unavoidable for a
document editor, and the item editor around it is already an island; the trade is noted rather than
hidden. Underline is allowed by the sanitiser but has no toolbar button, because underlined text
that is not a link is a usability problem — pasted underlines survive, new ones are not encouraged. Content lists are ordered by path and cannot
be sorted by date — for a hierarchical type the path order *is* the tree, so a date sort would
leave the indentation describing a nesting the rows no longer follow.
