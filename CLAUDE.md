# CLAUDE.md

Guidance for Claude Code working in this repository.

## What Taproot is

A DB-backed, Astro-native CMS for a campus website with many non-technical departmental
contributors. [SCOPE.md](SCOPE.md) is the authoritative plan — read the relevant phase section
before starting work on it. Decisions recorded there are settled; don't relitigate them.

**Status:** Phases 1 and 2 are complete — block types, page composition, `BlockRenderer`, and
Reusable Blocks. Phase 3 (roles, departments, and workflow) is next; read its SCOPE.md section
before starting.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Dev server at :4321. Astro 7 daemonises it — `astro dev stop\|status\|logs` |
| `npm run db:seed` | Migrate and seed. Idempotent |
| `npm run db:reset` | Delete the local database and reseed |
| `npm test` | Vitest, 461 tests |
| `npm run typecheck` | Per-workspace tsc (see note below) |
| `npm run a11y` | axe-core over every admin route + numeric contrast check. Needs `npm run dev` running |
| `npm run preview` | Build and serve through `wrangler dev` — the real Workers runtime |

First run on a fresh clone: `npm install && cp .env.example apps/web/.env && npm run db:seed`.
Sign in at `/admin` with **admin@example.com** / **taproot**.

`npm run typecheck` delegates to each workspace rather than running a root `tsc --build`. There is
no root `tsconfig.json`, and the Astro projects can't be tsc project references because apps/web's
sources are `.astro`, which tsc has no resolver for. apps/web is type-checked by `npm run build`.

## Admin information architecture

**Each content type is its own sidebar destination**, not a filter on one shared list — editors
think of Pages and Events as different places. `/admin/content/type/{api_id}` rather than
`/admin/content/{api_id}`, because `/admin/content/{id}` already means a content item and one
segment cannot mean both. `/admin/content` survives as "All content" for searching across types.

Singletons get `/admin/singleton/{api_id}`, which resolves to the one item's editor and creates it
on first visit. The indirection buys a stable sidebar URL that cannot break if the item is deleted.

Sidebar order comes from `content_types.position`, reorderable in Settings. Settings is a hub over
Content types, Redirects, Users & access, and System — configuration that shapes the site rather
than its content.

Content lists share three pieces of presentation, each in one place so the screens cannot drift:
[status.ts](packages/astro/src/admin/status.ts) (labels, badge classes, which statuses the editor
offers), [StatusBadge.astro](packages/astro/src/admin/components/StatusBadge.astro), and
[Timestamp.astro](packages/astro/src/admin/components/Timestamp.astro). **Status colour is always
redundant with a text label** — that is what keeps the badges clear of WCAG 1.4.1, so a badge must
never become a bare colour swatch. Badge classes are written out as literal strings because
Tailwind 4 finds classes by scanning source text; `bg-status-${status}-subtle` would never be
generated.

The status filter is faceted: `countItemsByStatus` applies every filter **except** status, so each
count answers "what would I get if I switched to this?" rather than restating the rows already on
screen. `status` is excluded from its parameter type rather than by convention.

**Nothing in the CMS assumes a particular kind of site.** The demo is a college; the CMS must work
for anyone. Content types, taxonomies, and menus are all user-defined, and a site with none of them
must still render every admin screen without erroring.

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
25 routes, 0 violations, all 34 token pairs passing in both themes.

**A new colour token is not done until it has a pair in `a11y-contrast.mjs`.** The script mirrors
the `@theme` blocks by hand — jsdom resolves no custom properties, so there is no way to derive
them — which means a token added to the CSS alone is simply unchecked. The same applies to a new
*pairing* of existing tokens: `axe` runs with `color-contrast` disabled precisely because this
script is the authority, so a colour put on a background it has never been checked against is
unchecked no matter how many routes pass.

**A `<label for>` must point at a labelable element** — button, input, meter, output, progress,
select, textarea. Anything else is silently inert: the control is still named through
`aria-labelledby` or a `<legend>`, so a screen reader sounds correct, axe passes, and only
click-to-focus is missing. That is why the audit checks it directly; axe's `label` rule asks
whether a control has a name, not whether a label has a target. **A custom control gets a `<span
id>` and `aria-labelledby`, not a `<label for>`** — [FieldControl](packages/astro/src/admin/islands/fields/FieldControl.tsx)'s
`labelsAControl()` is the worked example, and it is the audit rather than review that keeps it in
step with the branches it mirrors.

**The audit's dynamic routes must be chosen by what they exercise, not by what sorts first.** It
picks the item editor by field count, because taking `items[0]` took the alphabetically-first path
— the weather-banner singleton, three plain inputs — and left the densest screen in the admin the
one route never audited. Seven inert labels sat there through four phases as a result. Note that
`/api/taproot/content-types` returns types *without* their fields, so a count derived from that
list is zero for everything and quietly restores the bug.

What it does **not** cover, and what needs a real browser and a human: post-hydration behaviour of
the React islands, and screen-reader output. Custom interactions are where WCAG failures actually
creep in — off-the-shelf Radix primitives rarely fail. **Drag-and-drop must always be added
alongside keyboard controls, never instead of them**; the field builder's reorder buttons are the
pattern to follow.

Where a widget only exists after hydration — the richtext toolbar, since ProseMirror needs a real
DOM and the server renders an empty placeholder; the media picker, which is a dialog that has to be
opened — the audit cannot see it at all. Those get a jsdom test that runs axe on the hydrated tree
plus its keyboard contract
([RichTextEditor.test.tsx](packages/astro/src/admin/islands/fields/RichTextEditor.test.tsx),
[MediaPicker.test.tsx](packages/astro/src/admin/islands/media/MediaPicker.test.tsx)).
Scope axe to the render container, not `document`: in isolation there is no landmark around the
component, and the resulting `region` violation is an artifact of the test. **Radix dialogs are the
exception** — they portal to `document.body`, so the render container is empty and axe must be
scoped to the dialog element itself.

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
- **Richtext is sanitised on write, inside `validateItemData`.** It is stored as HTML and rendered
  with `set:html`, so an unsanitised value is stored XSS against every visitor and every editor.
  **The editor is not the boundary — the REST API is**, because it accepts richtext from any client
  holding a session. Never move sanitising to render time, and never add a write path that skips
  validation. `sanitizeHtml` is an allowlist *serialiser*: it re-emits only what it understands, so
  anything unparseable becomes nothing rather than itself.
- **`h1` and `img` are deliberately absent from the richtext allowlist.** The page's `h1` is its
  title, so body headings start at `h2` or the document outline breaks (WCAG 1.3.1). Images belong
  to the media library, where they carry alt text and a hotspot.
- **Richtext length is measured on visible text, not markup.** An empty editor emits `<p></p>`, so
  a `.min(1)` on the HTML would let a required field be satisfied by nothing.
- **SEO fallbacks are resolved in core, never in a template.** `resolveSeo` is called by both the
  admin's live preview and the public route, because a preview that resolves its own fallbacks is
  a preview of a page nobody will ever see, and the mismatch only surfaces weeks later in a shared
  link. The chain is item override → content type default (OG image only) → the item's own title.
  There is deliberately **no excerpt fallback for the description** — a truncated first sentence
  reads like a machine wrote it, and a search engine picks a better snippet than a truncation.
- **SEO length guidance is guidance, not validation.** Search engines truncate by pixel width, so
  no character count is exactly right; the editor warns past ~60/~160 and the server stores what it
  is given. `SEO_GUIDANCE` is the one place those numbers live.
- **`content_types.default_og_image_id` is inherited, not copied.** Changing it updates every item
  that has not set its own — copying onto items at creation would silently freeze the old value.
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
- **Taproot has no opinion about term URLs.** Whether a taxonomy's terms get public pages is the
  host site's decision, passed to `resolveMenu` as a `termHref` callback — most taxonomies (review
  status, internal owner, audience segment) classify content without deserving a page each, so the
  default is no URL. `termArchivePath` is a convention offered, not applied; nothing in core calls
  it. `apps/web/src/site.ts` is the worked example, and both the catch-all route and the menu
  resolver read the same set so they cannot disagree.
- **Menu items reference their target, never store a URL.** That is the entire point: a moved page
  keeps its place in the navigation and an unpublished one leaves it, with no menu edit. A deleted
  target nulls the reference rather than cascading, so the broken entry stays visible in the admin
  instead of silently editing the site's navigation. Public rendering skips it either way.
- **Terms have no materialised path**, unlike content items. Content items need one because a
  request URL must resolve in one indexed lookup on the hot path; terms have no public URL, and
  their only tree query is a recursive CTE off `parent_id`. Adding a path would mean a second
  cascading-rewrite implementation serving no read.
- **Hotspot and crop are stored normalised and resolved on demand**, never baked into a file. One
  asset drives a 16:9 hero, a square thumbnail, and a portrait card; `resolveCrop` takes the crop
  first, then fits the target ratio inside it and slides that frame to centre the hotspot, clamped.
  Baking a crop per use would mean re-cropping every image whenever a template changes, and an
  image reused in an unanticipated shape would simply be wrong.
- **Image dimensions are read from header bytes on upload**, not decoded — the crop maths needs the
  source's real proportions, and every library that could decode is a native dependency. An
  unrecognised format returns null and the editor degrades rather than the upload failing.
- **One media picker, used by every place an asset is chosen.** `MediaField` is the control and
  `MediaPicker` the dialog; the `media` field, the SEO panel's social image, and a content type's
  default social card all mount the same pair. Three `<select>`s of filenames shipped first
  precisely so there would be one picker to build rather than three to replace — don't add a
  fourth bespoke chooser.
  - **The grid is a listbox, not a checkbox per card.** A checkbox each gives every asset its own
    tab stop, so reaching the twelfth image costs twelve presses. One tab stop with arrow keys
    inside it is the pattern a screen-reader user already expects for "choose from a set".
  - **Arrow-key row movement is measured from layout, and degrades to linear when it cannot be.**
    The grid is responsive, so the column count belongs to a breakpoint; hardcoding it here would
    drift the moment the CSS changed. Under jsdom every `offsetTop` is 0, so `columnCount` returns
    1 and Up/Down move by one — every card stays reachable and no key does nothing.
  - **Selection is resolved against every asset the dialog has shown**, not the page on screen.
    Select an image, search for a second, and the first is no longer among the results; resolving
    from the visible page dropped it silently while the footer still counted it.
  - **The picker honours a `media` field's `accept` list**, so a field configured for documents can
    reach one. Every call site used to be handed an images-only list regardless, because the only
    list on hand was the one the SEO panel needed. `mediaMatchesAccept` is shared by the client
    filter and the SQL one so the first page cannot offer what a search would hide.
  - **Upload-in-place asks for alt text.** That is the moment someone knows what the image is for,
    and an upload path that never asks is how a library fills with images nobody can describe.
- **A media field's stored shape follows its own config** — an array when it allows several files,
  a bare id when it does not. `MediaField` works in ordered arrays either way and `FieldControl`
  converts, rather than the control learning two shapes. Order is the stored order, which for a
  gallery is the order it renders in.
- **A block type is a content type with `kind: 'block'`.** A block type is a user-defined schema
  with fields, which is exactly what a content type is — so it reuses the same table, field builder,
  field API, and validation rather than growing a parallel set of all four. `kind` already answers
  "how are this type's instances addressed", and "they are not" is a coherent fourth answer
  alongside page, collection, and singleton.
  - **`listContentTypes` excludes blocks by default.** That default is load-bearing: the sidebar,
    the "new content item" picker, and the relation target list all call it, and none should ever
    offer a block. Showing them is what you opt into, via `includeBlocks` or `listBlockTypes`.
  - **`createItem` refuses a block type**, because a POST carrying one would otherwise create an
    item with no URL, invisible in every list that filters blocks out.
- **Block instances live in `content_items.data`, not in rows of their own.** They are content,
  versioned by the item's revisions. The cost is that "which items use this block type" is a `LIKE`
  over the data blob rather than an indexed join — acceptable because it only runs when deleting a
  block type, which is refused while any item still places it.
- **Two blocks of the same type share one `FieldRow`.** `FieldControl` therefore takes an
  `idPrefix`; without it both render inputs with the same DOM id and a label focuses the wrong one.
- **Taproot ships no block templates.** `BlockRenderer` takes a map from block `api_id` to an Astro
  component, supplied by the host site — a CMS that shipped a hero component would be shipping a
  design. `apps/web/src/blocks/index.ts` is the worked example.
- **A reusable block's content belongs to the library, not the page.** A page stores only
  `{ id, type, ref }` and no copy — two copies would raise the question of which is authoritative,
  and the stale one would win on whichever page nobody reopened. `resolveBlockReferences` fills the
  data in at read time, and is called by the public route *and* the admin so both see the same
  content.
  - A referencing page's revision records **that** it referenced the entry, not what the entry said
    at the time. Restoring an old revision restores the reference, and the reference resolves to
    today's content — correct for shared content, since a restored page must not resurrect last
    month's opening hours, but a real difference from ordinary blocks.
  - Referenced blocks skip field validation on the page, because the library row already validated
    it. Requiring a page that stores no content to satisfy a required field would make the
    reference unsavable.
  - Deleting an entry is **refused** while anything references it. A reference with no target
    renders as a gap on exactly the pages nobody is watching — which is why the content was shared.
  - Deleting a block *type* also checks the library, because `countBlockUsage` only sees blocks
    written into a content item and an entry no page references yet is invisible to it.
- **Every reason a content type cannot be deleted comes from `contentTypeDeleteBlockers`**, and both
  the guard and the admin screen read it. `deleteContentType` throws the first entry; the settings
  screen renders the list and only offers the delete form when it is empty. A screen that worked out
  for itself whether a delete would succeed drifts the moment a blocker is added, and the failure
  mode is a button that is offered and then refused. Blockers are phrased as standalone clauses so
  they read correctly both bulleted and after the error's `Cannot delete X:` prefix.
  - **A relation field on another type counts as usage**, even with zero items. `targetContentTypeId`
    lives in another type's JSON `config`, which no FK sees and no cascade cleans up — deleting
    anyway leaves a picker offering nothing and stored ids resolving to no type. Fields belonging to
    the type being deleted are excluded, or a self-referencing "related pages" relation would make
    its own type permanently undeletable.
  - The delete is confirmed by typing the `api_id`, **checked on the server**: a disabled submit
    button is bypassed by turning JavaScript off, and this admin is server-rendered precisely so it
    does not depend on that.
- `repeater` has columns and a validation seam but no editing UI.

## Definition of done for a phase

From SCOPE.md, treated as a standing requirement rather than cleanup:

1. `npm run dev` works end to end from a fresh clone with only `npm install`, a copied `.env`, and
   `npm run db:seed`. If a phase adds a required env var or service dependency, fixing the
   zero-setup story is part of *that* phase.
2. Seed data is realistic enough to see the feature working, and reseeding stays idempotent.
3. `npm test`, `npm run typecheck`, and `npm run a11y` all pass.
4. [DEPLOYMENT.md](DEPLOYMENT.md) is still accurate.
5. [README.md](README.md)'s status and "what's next" reflect reality.
