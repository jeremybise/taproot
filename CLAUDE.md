# CLAUDE.md

Guidance for Claude Code working in this repository.

## What Taproot is

A DB-backed, Astro-native CMS for a campus website with many non-technical departmental
contributors. [SCOPE.md](SCOPE.md) is the authoritative plan — read the relevant phase section
before starting work on it. Decisions recorded there are settled; don't relitigate them.

**Status:** Phases 0–2 are complete, including a gap-closing pass that finished the pieces they
had been declared complete without — the relation field's editing control and reverse lookup,
delete for content items and media, manual redirects, the admin's term filter, and rendering the
focal point the hotspot editor had always stored and nothing read.

Phase 3 is next and is **smaller than SCOPE.md used to describe**: departments are classification,
which the Phase 1 taxonomy already provides, so there is no departments entity and no
department-scoped role. Roles are flat and site-wide. User management shipped ahead of the phase,
pulled forward by making email/password the primary sign-in method — so what remains is workflow
transitions with role gates, a scheduler, and the audit log. Read the Roles & permissions section
of SCOPE.md before starting.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Dev server at :4321. Astro 7 daemonises it — `astro dev stop\|status\|logs` |
| `npm run db:seed` | Migrate and seed. Idempotent |
| `npm run db:reset` | Delete the local database and reseed |
| `npm test` | Vitest, 734 tests |
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

**Email and password is the primary sign-in method; OAuth is optional.** It used to be a dev-only
provider that `resolveAuthConfig` refused to boot with outside development. That guard was right
about a *backdoor* and wrong about a *front door* — what made it dangerous was being a hidden
second way in. The guard that survives refuses to start when there is no way in *at all*
(`TAPROOT_PASSWORD_AUTH=0` and no provider), and `TAPROOT_DEV_AUTH` now throws on sight rather than
being ignored, because silently dropping it would leave an operator believing they had scoped
something. Things that follow, none of them optional now that this is the front door:
- **Sign-in is throttled per email *and* per client IP** (`auth/throttle.ts`). Per-account alone
  misses password spraying entirely. The check runs **before** `verifyCredentials`, or a
  locked-out attacker still costs 210,000 PBKDF2 iterations per request. The IP comes from
  `CF-Connecting-IP` only — `X-Forwarded-For` is client-settable, so trusting it would let an
  attacker reset their own counter and lock out an address they do not own.
- **Nobody sets somebody else's password.** An admin mints a single-use, hashed-at-rest,
  48-hour link and hands it over. The raw token exists only in that link and is returned through a
  short-lived cookie rather than a query string, because a URL lands in history, `Referer`, and
  access logs. `password_reset_tokens.created_by` is nullable so email-delivered self-service reset
  is a sender away, not a reshaping.
- **The first-run setup screen is the only unauthenticated write in the admin.** `createFirstAdmin`
  does its check and its insert in **one statement** (`INSERT ... SELECT ... WHERE NOT EXISTS`); a
  `count()` then `insert()` is a race, and the losing request must be told it lost rather than
  retried.
- **The last active administrator cannot be demoted or deactivated.** A CMS with no admin cannot be
  administered back into having one — every screen that could fix it is behind the role that just
  went away, and the setup screen refuses because users exist.
- **Changing your own password asks for the current one**, which is what stops an unattended
  browser becoming a permanent takeover, and drops every *other* session while reissuing this one.
- **Two-factor is a challenge, not a screen.** A correct password with TOTP enrolled produces a
  short-lived, single-use, revocable `login_challenges` row — never a session. Issuing the session
  and checking the code afterwards would mean the password alone had already granted access.
  `totp_secrets.last_used_step` makes a code single-use *within* its acceptance window, or one
  observed over a shoulder works again for ninety seconds. The verify step is throttled with the
  same counters as the password step, because six digits is a million possibilities. Turning it off
  or reissuing recovery codes needs the password; cancelling an *unconfirmed* enrolment does not,
  because an unconfirmed secret protects nothing.

**Publish permission is one rule, in `guards.ts`.** `canChangeStatus(user, from, to)` answers every
"may this person do that" about a status, and both the API routes and the item editor's select read
it — the editor through `statusChangeNeedsPublish`, which is the same predicate with the user taken
out, so a dropdown can never offer a status the boundary then refuses. It was implemented three
separate times before, each hardcoding `status === 'published'`, so `scheduled` and `archived` were
gated in the dropdown and open at the API, and **un-publishing was free**: a contributor could take
a live page to draft and it vanished from the site. Restoring an old revision is a status change
too, and goes through the same function. `status.ts` is presentation only — it once carried a
`needsPublish` flag that read correctly, was tested, and was enforced by nothing.

**A delete guard lives in core and the screen reads it, never the other way round.**
`contentTypeDeleteBlockers`, `itemDeleteImpact`, and `mediaDeleteImpact` each return the reasons a
delete would fail, and `DangerZone.astro` renders them. A screen that works out for itself whether
a delete would succeed drifts the moment a blocker is added, and the failure mode is a button that
is offered and then refused. `deleteItem` enforces its own blockers, so the REST API cannot do what
the admin declines. Blockers stop the delete; **warnings** describe consequences and do not — an
item with children blocks (`parent_id` is `ON DELETE SET NULL`, so the delete would strand them at
paths that no longer describe where they sit), while a menu entry or an incoming relation warns,
because both already degrade visibly by design.

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
25 routes, 0 violations, all 36 token pairs passing in both themes.

**A new colour token is not done until it has a pair in `a11y-contrast.mjs`.** The script mirrors
the `@theme` blocks by hand — jsdom resolves no custom properties, so there is no way to derive
them — which means a token added to the CSS alone is simply unchecked. The same applies to a new
*pairing* of existing tokens: `axe` runs with `color-contrast` disabled precisely because this
script is the authority, so a colour put on a background it has never been checked against is
unchecked no matter how many routes pass.

**Light, dark, and system are one `color-scheme` declaration, not a class.** Every colour token is
a `light-dark()` pair in the single `@theme` block, so the entire switch is three rules in
`admin.css`: `html` follows the OS, `html[data-theme='light'|'dark']` overrides it. A second
`@theme` inside a `prefers-color-scheme` media query — which is what this had before — cannot be
overridden by an attribute or a class at all, so the switcher would have nothing to switch. Setting
`color-scheme` also hands the UA its half of the work (form controls, scrollbars, the canvas behind
the page), which a class-based dark mode has to restate by hand and usually misses.

**The choice is a cookie, read on the server, and `system` is stored by deleting it.** The layout
stamps `data-theme` on `<html>` before any CSS is sent, which is why there is no inline blocking
script and no flash of the wrong palette. `localStorage` cannot do that — the server cannot see it.
`system` writes no cookie and renders no attribute, because "never chose anything" and "chose
System" must be the same state; a third value would be a second encoding of one thing, free to
drift. `resolveTheme` sends anything unrecognised back to `system` for the same reason.

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
- **Every path change writes a redirect automatically.** Never make this opt-in. Authors can also
  write redirects by hand, for URLs that were never Taproot pages — `source: 'manual'`. Manual rows
  take part in the same chain collapse automatic ones do (reuse `buildRedirectStatements`, never
  reimplement it), and are **exempt from the sweep** that deletes redirects leaving a path a live
  item has just filled: the table has always documented them as "never GC'd", and keeping them is
  safe because the catch-all resolves an item before it consults the redirect table.
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
  determines who may edit it. Classification is editable by any contributor, so deriving a
  permission from it would let someone tag a page for discoverability and silently hand another
  group edit rights — and let any contributor change who else can edit. Roles are flat and
  site-wide, which makes this rule simpler rather than harder to keep: nothing anywhere derives a
  permission from a term, and there is no ownership model that might tempt you to. Do not
  reintroduce permission checks that read taxonomy terms. The `department` taxonomy is a
  *classification* of what a page is about; it is not a permission scope and never was.
- **`taxonomy_assignments` is a derived index, not the source of truth.** Tags are authored into
  `data` like every other field and the table is rebuilt from them inside the same atomic batch as
  the item write. This looks like redundancy worth removing — it isn't. Storing tags only in the
  join table would make a restored revision silently lose them, because revisions snapshot `data`.
  What the index buys is filtering a content list by term without scanning every row and parsing
  its `data` blob — `ItemFilters.termIds` is that read, a correlated `EXISTS` shared by the list
  and its status facets. It is `EXISTS` rather than a join so an item carrying three terms in the
  branch still counts once, and a **term filter always means the whole branch**: `termIdsForBranch`
  expands it, because filing something under "Sciences" has to find it when someone filters by
  "Academics". An *empty* `termIds` array matches nothing rather than everything, following
  `listMedia` — `in ()` is a syntax error, so the tempting fallthrough is the dangerous one.
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
  - **Rendering goes through `TaprootImage`, not `object-fit: cover`.** For two phases the editor
    stored a focal point that nothing read, because the demo templates centre-cropped — an editor
    could place a face carefully and watch the site cut it out. The component scales a real `<img>`
    by the inverse of the resolved rectangle inside an `aspect-ratio` box (`cropFrame`), which
    keeps alt text, `srcset`, and crawler visibility that a background image loses. It **owns its
    wrapper on purpose**: the maths only avoids distorting the image if the box carries the same
    ratio the rectangle was resolved for, so a caller setting its own `aspect-ratio` would
    letterboxed the image inside a frame it was not cropped for.
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
- **A block type may hold a `block` field, and the editor has to pass its context down.**
  `BlockListEditor` forwards `blockTypes`, `reusableBlocks`, and `ancestorTypes` into each nested
  `FieldControl`; it originally forwarded none of them, so a nested block field reported "No block
  types are available for this field. Create some under Settings → Block types" — advice that could
  not help, because the list was empty for a reason unrelated to how many block types existed.
  - The nested picker gets the **unfiltered catalogue** (`allBlockTypes`), because the outer
    field's `allowedBlocks` has nothing to do with the inner field's.
  - **Ancestors are excluded rather than depth being counted**: it forbids exactly the cycles
    (A in A, A in B in A) and leaves genuine nesting like Section → Card alone.
  - `MAX_BLOCK_DEPTH` backstops it in `validateItemData`, because the boundary has to refuse a
    request the editor never made. The old comment claimed depth was "bounded in practice by the
    editor", which was never true — the field builder renders every field type for a block type.
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
- **`relation` is a first-class field type, both directions.** `RelationField` is inline rather
  than a modal, which is where it deliberately differs from the media picker: a media library is
  browsed by eye and rewards a grid, while a list of content items is read by title, so a dialog
  would add a focus trap and a portal for nothing. Candidates arrive as a server-resolved first
  page (`relationTargetsForFields`) and the control searches past it through the items API — and
  that resolver is handed the item's stored data so an id outside the first page still renders a
  title rather than a raw uuid. Stored shape follows the config, matching `media`: a bare id when
  single, an ordered array when multiple.
  - **`itemsReferencing` is the reverse side**, rendered by `ReferencedBy.astro` and grouped by the
    field's `reverseLabel` — a config value the builder had collected since the field type was
    designed and nothing had ever read. It is two queries on purpose: the relation *fields* that
    could point here come from the `fields` table first, and only then is `data` searched. A bare
    `LIKE` for the id across every item would also match it sitting in a body or a media
    reference, and report a relationship that does not exist.
- **Every field type has an editing control or is listed in `DEFERRED_FIELD_TYPES`**, and
  `fieldControls.test.tsx` asserts the list matches what `FieldControl` actually renders.
  `fieldConfigForms.test.ts` had always checked that every type has a *config* form; the absence of
  its counterpart is why `relation` went two phases with a config form, server-side validation, and
  a placeholder promising an editor "in Phase 1" — a phase that had already been declared complete.
  The list is a **fact about what exists**, not a plan: it replaced an `availableIn` phase number
  that the builder rendered as a "Phase N" badge on rich text, media, taxonomy, and blocks long
  after all four shipped. Plan vocabulary does not belong in a CMS a campus editor uses.
- `repeater` is the one field type still with only columns and a validation seam — no config form,
  no editing UI.

## Definition of done for a phase

From SCOPE.md, treated as a standing requirement rather than cleanup:

1. `npm run dev` works end to end from a fresh clone with only `npm install`, a copied `.env`, and
   `npm run db:seed`. If a phase adds a required env var or service dependency, fixing the
   zero-setup story is part of *that* phase.
2. Seed data is realistic enough to see the feature working, and reseeding stays idempotent.
3. `npm test`, `npm run typecheck`, and `npm run a11y` all pass.
4. [DEPLOYMENT.md](DEPLOYMENT.md) is still accurate.
5. [README.md](README.md)'s status and "what's next" reflect reality.
