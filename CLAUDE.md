# CLAUDE.md

Guidance for Claude Code working in this repository.

## What Taproot is

A DB-backed, Astro-native CMS for a campus website with many non-technical departmental
contributors. The demo is a college; **the CMS must work for anyone** — content types, taxonomies and
menus are all user-defined, and a site with none of them must still render every admin screen without
erroring.

Three documents, three jobs:

- **This file** states every load-bearing constraint plus its reason in a line. Loaded every session.
- **[DECISIONS.md](DECISIONS.md)** is the long form: what was measured, what was rejected, and how each
  rule was originally got wrong. Not auto-loaded. **Read the relevant entry before changing, relaxing
  or "simplifying" anything below** — most of these read as fussiness until you know the failure
  behind them. Change a constraint and you change it in both.
- **[SCOPE.md](SCOPE.md)** is the plan and only the plan. Decisions recorded there are settled. Phase
  status is in SCOPE.md and [README.md](README.md).

Two things about what exists, both easy to get wrong twice:
- **There is no departments entity and no department-scoped role.** Departments are classification,
  which the taxonomy already provides. Roles are flat and site-wide. Do not add either.
- **The content accessibility checker is not `npm run a11y`.** The checker is advisory and looks at
  what an editor writes; `npm run a11y` checks the WCAG compliance of the admin itself. An editor can
  write an inaccessible page in a perfectly accessible editor.

**[apps/docs](apps/docs) is the handbook** — Astro + Starlight, `npm run docs`, port 4322. End-user
documentation, not developer docs. It declares **no `sharp`** and configures the passthrough image
service, because the default image service is a native dependency.

`delivery.test.ts`'s equivalence tests compare the delivery layer against the *methods* the embedded
route used, not against a second implementation. They are the closest thing to a spec for the delivery
contract — do not remove them without replacing what they prove.

## Commands

`package.json`'s scripts are the reference and its `//`-prefixed keys carry the rationale. Two things
those do not say: `npm run a11y` needs `npm run dev` already running, and `npm run preview` builds and
serves through `wrangler dev`, the real Workers runtime.

Fresh clone:
`npm install && cp .env.example apps/studio/.env && cp apps/web/.env.example apps/web/.env && npm run db:seed`.
Sign in at `localhost:4321/admin` with **admin@example.com** / **taproot**; the site is on :4323. The
seed creates a **fixed development API key** that `apps/web/.env.example` already carries — development
data, public knowledge, never created by anything but the seed.

## Layout

`packages/core` is the data layer, auth, content services and storage, no framework;
`packages/studio` is the SERVER (admin, REST API, delivery API); `packages/astro` is the CLIENT a site
installs; `packages/create-taproot` is the scaffolder. `apps/studio` is the CMS deployment that owns
the database and runs the scheduler, `apps/web` the reference consumer, `apps/docs` the handbook.

- **The names are the architecture.** `@taprootcms/astro` is what a *site* installs; the server is
  `@taprootcms/studio` and a site never installs it. Scope, scaffolder name, shared version and each
  package's `files` allowlist are the `releasing` skill's — invoke it before publishing or renaming.
- **`create-taproot` scaffolds the server and only the server.** See
  [packages/create-taproot/CLAUDE.md](packages/create-taproot/CLAUDE.md).
- **Routes are not files-on-disk in apps/studio.** [index.ts](packages/studio/src/index.ts) injects
  every admin and API route via `injectRoute`, so **adding a screen or endpoint means adding it to that
  route table**, not just creating the file.
- **The consumer must never pull the data layer into its bundle.** `@taprootcms/astro` imports
  `@taprootcms/core/pure` at runtime and everything else as `import type`. The built consumer is ~460K
  against the studio's 12M and contains no `kysely`. **Nothing with a `Kysely` import may enter
  `pure.ts`.**
- **`@taprootcms/studio` ships source, not a build**, compiled out of `node_modules` by the host's
  Vite. `.astro` imports resolve for tsc only via the ambient shim in
  [astro-modules.d.ts](packages/studio/src/astro-modules.d.ts), which does **not** check the file's
  contents — so **logic left inline in an `.astro` file is logic no suite can reach.** Extract it
  (`parentOptions.ts`, `fieldTree.ts`, `status.ts`).
- **The CMS deployment serves the admin and the API, and nothing else.** Its root 302s to `adminPath`
  (302 because that option is configurable) and there is deliberately **no public catch-all** — a
  second read path is what SCOPE rules out; `index.test.ts` asserts no injected pattern contains
  `[...path]`. `adminPath: '/'` **throws** rather than silently becoming `/admin`.

## Admin information architecture

- **Each content type is its own sidebar destination**, not a filter on one shared list — editors think
  of Pages and Events as different places. `/admin/content/type/{api_id}`, because
  `/admin/content/{id}` already means an item. `/admin/content` survives as "All content".
- **Singletons get `/admin/singleton/{api_id}`**, resolving to the one item's editor or to the form
  that creates it. It **does not write the row itself**: a row is only ever written validated, and
  there is no "empty entry, fill it in later" path.
- Sidebar order comes from `content_types.position`. Settings is a hub over Content types, Redirects,
  Users & access, and System.
- **`content_types.hide_from_nav` keeps a type out of the sidebar and out of nothing else.** Read
  through `isNavigable`. A hidden type keeps its list screen, its create screen, and its place in All
  content and search — **filtering a listing by it would be a delete that does not delete**, stranding
  every item in a deployment its own UI cannot reach. `navVisibility.test.ts` asserts four negatives.
- Content lists share three pieces of presentation, each in one place:
  [status.ts](packages/studio/src/admin/status.ts),
  [StatusBadge.astro](packages/studio/src/admin/components/StatusBadge.astro),
  [Timestamp.astro](packages/studio/src/admin/components/Timestamp.astro). **Status colour is always
  redundant with a text label** (WCAG 1.4.1) — never a bare colour swatch. Badge classes are literal
  strings because Tailwind 4 scans source text.
- **The status filter is faceted:** `countItemsByStatus` applies every filter **except** status, so
  each count answers "what would I get if I switched to this?". `status` is excluded from its
  parameter type rather than by convention.
- **Every capped list either pages or says it is capped**, because a `total` counted before the limit
  rendered above truncated rows says something false. `Pager` where an editor must reach the rows
  (media, audit log); `TruncationNotice` where they must *find* one (content lists, redirects,
  releases). The notice renders nothing when the list is complete. **A cap that *is* the feature gets
  neither** — Settings → Search asks for the top 50. Paging made an empty page (`?page=99`) and an
  empty *search* reachable, and both had to be written.
- **A `page`'s parent need not share its content type** — a tree spanning several types is one
  hierarchy and three schemas. It was a display bug, not a save bug, which is why it survived: a
  controlled `<select>` whose `value` matches no `<option>` renders blank. `<optgroup>` by content
  type in sidebar order, sorted **stably** so `path` ordering still makes each group read as a tree.
  The cap is 500 and truncation is the failure to fear; beyond it the answer is a searchable control
  on `RelationField`'s pattern, not a smaller number.

## Constraints that are easy to violate

Load-bearing decisions, not preferences. [DECISIONS.md](DECISIONS.md) has the full reason for each.

### Auth

**Email and password is the primary sign-in method; OAuth is optional.** The surviving guard refuses to
start when there is no way in *at all*; `TAPROOT_DEV_AUTH` **throws on sight** rather than being
ignored, because silently dropping it leaves an operator believing they had scoped something.

- **Sign-in is throttled per email *and* per client IP** (`auth/throttle.ts`) — per-account alone
  misses password spraying. The check runs **before** `verifyCredentials`, or a locked-out attacker
  still costs 100,000 PBKDF2 iterations a request. The IP comes from `CF-Connecting-IP` **only**:
  `X-Forwarded-For` is client-settable, so trusting it lets an attacker reset their own counter and
  lock out an address they do not own.
- **Nobody sets somebody else's password.** An admin mints a single-use, hashed-at-rest, 48-hour link,
  returned through a short-lived cookie rather than a query string, because a URL lands in history,
  `Referer` and access logs. Self-service reset uses the same table with a null `created_by`; its
  emailed link *does* carry the token in the URL — the cookie protects the **admin's** browser from
  holding a colleague's credential.
- **The first-run setup screen is the only unauthenticated write in the admin.** `createFirstAdmin`
  checks and inserts in **one statement** (`INSERT ... SELECT ... WHERE NOT EXISTS`); the loser of the
  race is told it lost rather than retried. **The password is hashed before that write and the
  credential rides in the same atomic batch** — hashing afterwards once left a deployment holding an
  administrator with no credential, which no screen can repair. `firstAdmin.test.ts` mocks a failing
  hash and asserts nothing is written.
- **The last active administrator cannot be demoted or deactivated.** A CMS with no admin cannot be
  administered back into having one.
- **Changing your own password asks for the current one**, and drops every *other* session.
- **Two-factor is a challenge, not a screen.** A correct password with TOTP enrolled produces a
  short-lived, single-use, revocable `login_challenges` row — never a session, or the password alone
  had already granted access. `totp_secrets.last_used_step` makes a code single-use *within* its
  window. The verify step shares the password step's throttle counters. Turning it off or reissuing
  recovery codes needs the password; cancelling an *unconfirmed* enrolment does not.
- **An admin can clear someone else's second factor and end their sessions, but not their own** — that
  would route around the account screen's password prompt. Signing *yourself* out everywhere keeps the
  current browser.

**An API key is a principal, not a user, and the two must never merge.** `Principal` in `guards.ts` is
`{ kind: 'user' }` or `{ kind: 'api_key' }`, and `hasScope` is false for a user principal
*deliberately*: a scoped route is meant for machines, so an admin reaching it should be refused rather
than quietly succeeding through a path nobody tested.
- **The role guards still take `User | undefined`** — converting at the boundary gets the guarantee
  from the type system, since `principalUser` returns `undefined` for a key.
- **`handle()` is session-only; `handleScoped()` is the opt-in.** That default keeps a `content:read`
  key out of the admin REST API.
- **The middleware resolves a session first and never both**, or a signed-in browser would credit a
  machine in the audit log.
- **`id` is the SHA-256 of the token**, so verification is one indexed lookup and a database dump holds
  nothing usable. Keys are **revoked, never deleted** — audit entries name them by id.

**Publish permission is one rule, in `guards.ts`.** `canChangeStatus(user, from, to)` answers every
"may this person do that", and the editor reads it through `statusChangeNeedsPublish` so a dropdown
cannot offer a status the boundary then refuses. Restoring a revision is a status change too.
`status.ts` is presentation only.

**The workflow is a graph in core, not a status column.** `content/workflow.ts` holds every legal
transition and the role it needs; `canChangeStatus` asks whether the move is legal at all (`archived →
published` is refused for an admin too, because a page returning from the archive goes through draft so
somebody reads it first) before asking who is asking. The editor renders `transitionsFrom` as named
buttons — "submit for review" is an act with a name.

### Caching and invalidation

**Caching is opt-in, and a response that says nothing gets `private, no-store`.**
`applyDefaultCacheControl` in [responseCache.ts](packages/studio/src/runtime/responseCache.ts) is the
one place that holds. The inverse is how a signed-in admin's HTML reached Cloudflare's shared cache and
was served to anonymous requests — **the origin was never wrong**, which is why every auth test passed.
- **No admin screen may be made cacheable.** The check is `has('cache-control')`, so a genuinely
  cacheable route keeps its own header.
- **The stamp goes on before the refreshed session cookie is appended** — a `set-cookie` on a stored
  response is an account handover, and ordering is the only thing ruling it out.
- **It returns a response rather than mutating one**, because `Response.redirect()` builds immutable
  headers.
- **`vary` does not save you.** Cloudflare honours it only for `Accept-Encoding`.

**A cache header does nothing on Cloudflare until the Worker opts in** — `"cache": { "enabled": true }`
in `wrangler.jsonc`. Cloudflare caches neither HTML nor JSON by default.

**The ETag must be answered before the page is resolved.** `getItemVersionByPath` answers from one
indexed lookup and shares `visibleToPublic` and `routableOnly` with `getItemByPath`, or a validator
computed under different rules 304s against a version the visitor may not see — or 304s a path the
full request answers 404 for.

**A 304 renews a cached copy's freshness, so a validator that cannot change is unbounded, not capped by
the TTL** (RFC 9111 §4.3.4). `deliveryCache` folds `reusableBlockLibraryVersion` into the ETag,
**global rather than per page**, because resolving which entries a page places is the work the cheap
lookup exists to avoid. Both validator sites must compute the same stamp or every conditional request
misses. `npm run query-count` **cannot see** that aggregate — it measures `resolveDelivery`, not the
route.

**`s-maxage` is 86400 and there is deliberately no `stale-while-revalidate`.** Cloudflare disables
stale-serving in the presence of `s-maxage`, so SWR beside it is inert — the worst option, because it
looks like it works. Getting SWR means `max-age`, which lets a **browser** hold a page for a day, and a
purge cannot reach a browser. The number lives once, in `DELIVERY_CACHE_CONTROL`.

**Cache tags travel in the payload as well as the header**, because a consumer tagging its own HTML
**cannot derive the dependencies itself** — it cannot know a breadcrumb came from an ancestor row.
`cacheTags.ts` lives where `pure.ts` re-exports it; a mismatch makes the purge succeed, report success,
and clear nothing.

**A tag nothing emits purges nothing, and the purge will report success.** The only defence is
asserting the tag is **on the wire**.
- **`type:` is what a listing carries**, not `item:`. Publishing a seventh event must purge the page
  showing "the six soonest", whose cached copy names the six that did *not* include it. Recorded **even
  when a query matched nothing**.
- **The taxonomy terms endpoint needs both axes** — vocabulary edits purge `SITE_TAG`, while the
  `itemCount` beside each term moves on an ordinary content write, which purges `type:`.
- **Media writes purge `SITE_TAG`**, because a media id lives inside `content_items.data` and there is
  no reverse index from an asset to the items placing it. An **upload** purges nothing, correctly.
- **Where a purge would clear nothing, do not add one.** Redirects only change `resolve`'s `not_found`
  and `redirect` branches, which carry no tag and cap at `s-maxage=30`; branding and `theme.ts` are
  admin-only. A purge added "for symmetry" is the same bug again.
- **Purge runs in the middleware, after the response.** Purging inside a write path clears the cache
  while the old row is still committed, so a request arriving in between repopulates it with exactly
  what the purge was for. It never throws — the write already happened and was reported successful.
- **A cron trigger has no `locals`.** It reaches `worker.ts`'s `scheduled` export, whose third argument
  *is* the `ExecutionContext`; `purgeFromExecutionContext` is the entry.

**Cloudflare scopes purging to the Worker that owns the cache, so clearing a consumer's HTML is an HTTP
call.** `sitePurge.ts` POSTs to an endpoint the site mounts from `createTaprootPurgeHandler`;
`PURGE_PATH` and `PURGE_SECRET_HEADER` live in `pure.ts` so both ends spell them once.
- **The consumer flushes everything rather than purging by tag**, because only `resolve` exposes
  `cacheTags` and tag-precision would silently never invalidate a listing.
- **Both config halves or neither.** A URL with no secret is treated as no configuration. Not derived
  from `TAPROOT_SITE_URL`, which names where a preview link points rather than enabling a write surface.
- **Unconfigured answers 404, not 401.**
- **The consumer's handler *does* report failure**, unlike every purge inside the CMS: there is no
  committed write to protect, and the caller's only way to replay is a response saying it failed.

**Two Workers on one Cloudflare account cannot reach each other without
`global_fetch_strictly_public`** — the `fetch()` is otherwise short-circuited internally and does not
route as a real request would, so the consumer's purge endpoint answered **404** to the CMS while
answering 401 to an identical `curl` from outside. Both `wrangler.jsonc` files carry the flag, and so
does the scaffolder. **Testing an endpoint from your laptop is not testing the caller.**

**Where two sides compare a shared secret, both trim or neither does.** One side trimming is the only
arrangement that is silently wrong.

**A dropped purge is silent, and silence is only affordable at a short TTL.** `pending_purges` plus the
five-minute sweep bounds it. The drain **branches on `target`**, or a queued site purge replays against
the CMS's own cache and is deleted as delivered; retries pass **no `db`**, or each failure enqueues
another row forever; and the outcome is **read, not caught**, because these functions never throw and a
`catch` would delete every row whether or not its purge landed.

### Webhooks

**A webhook queue enqueues *before* it attempts — the opposite of the purge queue.** A dropped purge
costs staleness `s-maxage` already bounds; an event is a fact about a moment that nothing regenerates.
That durability is what lets `INLINE_DISPATCH_LIMIT` exist. Only the backoff ladder is shared
(`retry.ts`).
- **The event says what changed and never carries the content**, which would be a second read contract
  with no key, no scope check and no visibility rules. `path` is **null wherever `typeHasItemPages` is
  false**, or a rebuild fetches an address the site answers 404 at.
- **The signing secret is the one secret stored recoverable** — an HMAC must be *produced*, not
  compared. Rotation has **no overlap window**.
- **The timestamp is inside the signed message, never merely beside it.** Signing the body alone and
  sending `t=` next to it is worthless: a captured request replays with a fresh stamp and the digest
  still verifies. Asserted by mutation in `signature.test.ts`. It also settles retries — the signature
  is computed per attempt.
- **`item.updated` and `item.published` both fire for one save, and publication is judged by crossing
  the boundary.** `publicationEvents` takes `from: ContentStatus | undefined`; asking
  `status === 'published'` instead calls `published → archived` an archive rather than an unpublish.
- **Redirects are a failure, and the response body is never read.** Following a 3xx re-sends a signed
  body wherever the receiver points; the body is an arbitrary host's, so reading it is a memory limit
  somebody else controls.
- **A delivered row is updated, not deleted** — the first question anybody asks is whether it arrived.
  `webhook_deliveries` is queue and log in one table, swept by age but **never while `pending`**.

### The delivery API

**The delivery API is the read contract, and it must answer a page in one round trip.** `resolveDelivery`
returns the item, its type and fields, breadcrumbs (one `in` query, not one per ancestor), visible
children, dereferenced blocks, resolved SEO, and lookup maps for media, relations and terms. It lives in
core so the studio's own reads and the delivery API cannot drift.

- **References are lookup maps, never inlined into `data`** — inlining breaks the match between `data` and
  the field types the CMS validates against, serialises a twice-used image twice, and makes the payload
  unusable for a write.
- **A redirect is a 200 carrying `{ kind: 'redirect' }`, not a 30x**, which would redirect the server-side
  fetch and serve the wrong page's content under the requested URL.
- **A listing and a `query` field's results are one shape, and `resultFields` keeps them one**, exported
  from `itemQueries.ts` rather than each caller writing `!== 'block'`. `deliveryList.test.ts` builds both
  answers for one item and compares them — a list of expected keys passes while they drift.
- **Summaries stay the default**: a picker asking for two hundred candidates by title must not start paying
  for two hundred page bodies. `include` is a comma list and an unknown entry is a **400**.
- **The maps are absent, not empty, without `data`** — `{}` would read as "asked, and this site has none".
- **The cost is per page, not per item**: every listed item's ids are collected across the page and loaded
  in one query each, content types once per *distinct* type.
- **A listed item's richtext is resolved** through the same `resolveRichTextData` as the host item's.
- **An unrecognised `sort` is refused rather than defaulted** — a request parameter is a developer's typo,
  where the fallbacks elsewhere are for *stored rules that outlive what they name*.
- **`ItemFilters.pathPrefix` is a range comparison and must never become a `like`.** Measured, `like` plans
  as `SCAN content_items` while `path > ? and path < ?` seeks the unique index; SQLite's LIKE optimisation
  needs a `NOCASE` index or `case_sensitive_like` and **D1 refuses PRAGMA**, so neither escape exists.
  `descendantPathRange` owns the bounds and it is **descendants only**, so the predicate needs no `or`.
  `queryPlans.test.ts` asserts the plan and keeps a negative control proving the `like` form scans.
- **A facet's counts have to describe the rows clicking it returns.** `deliverTaxonomyTerms` answers the
  question nothing else could — what terms exist — without which a filter UI hard-codes the list.
  - **`itemCount` is branch-wide and de-duplicated**, because a term filter means the whole branch
    everywhere else, and summing children into parents double-counts a cross-appointment. Union over ids.
  - **It takes the same `type` narrowing the listing does**, or "Biology (12)" sits beside a grid of one.
  - **Counts are opt-in**, being a second query over every visible assignment; `counts=0` reading as true
    is checked for.
  - **Terms come back flat with `parentId`, depth-first** — a `<select>` reads it in order and a checkbox
    tree nests it. An unknown taxonomy is a **404**, or a misspelled `api_id` hides forever.
- **Several `term` parameters mean OR, and each is still its whole branch.** The single-term `term` echo
  stays singular, so a term archive can render the editor's own capitalisation in its heading.
- **A uuid a consumer cannot resolve is a dead end**, so `DeliverySchema` carries `taxonomies` and every
  `DeliveryTypeSchema` carries `id` — resolved **there and not into each field's config**, because
  `toDeliveryField` also runs on every `resolve`. `deliverTaxonomyTerms` accepts an `api_id` **or** an id.
- **`resolveMenu`'s `termHref` callback cannot cross HTTP, and the answer is unresolved targets** —
  `deliverMenu` returns `{ type: 'term', taxonomyApiId, slug, name }` and the consumer applies
  `applyTermHrefs`. A server-side setting for which taxonomies get pages was rejected: that depends on the
  routes a site serves, which Taproot cannot know.

**A search log cannot be built by counting requests, because every layer of the read path is cached** — it
would undercount in proportion to how **popular** a term is, so "top searches" would rank the terms nobody
repeats, plausibly. `POST /api/taproot/search-log` exists for that and is deliberately not under
`/delivery`.
- **`search:write` is the first scope that is not a read**, admitting one appended row and nothing else. A
  key made before it existed does not have it, which is why the screen's empty state says so.
- **Only the consumer knows intent** — `source` keeps a submit, a chosen suggestion and an abandoned query
  distinguishable, and an `abandoned` row may be half a word, so the screen excludes it by default.
- **"Found nothing" judges the *latest* search for a term**, never the worst or the mean, or the report
  keeps accusing an editor of a gap they have already fixed.
- **Grouping folds with `foldSearchText`, never SQL's `lower()`**, which folds ASCII and stops — quietly
  splitting `Peña` from `pena`, two terms where search sees one.
- **Nothing identifying is stored.** The reason is the content: "withdrawal deadline", "financial aid
  appeal". The cost is that the report counts searches rather than people.
- **Retention is opt-in per log, and unset means keep forever** — two periods, because an audit log is kept
  so somebody can reconstruct who changed what while a search log's value decays in weeks. An unusable
  value **disables that log's purge and is reported on Settings → System** rather than throwing, since
  silence would leave an operator believing purging happens. Both purges are **batched**
  (`LOG_PURGE_BATCH`), selecting ids first because `delete … limit` needs a flag D1 cannot be asked about.

### Queries, indexes and derived tables

**Query plans are asserted, not assumed — `npm run query-count` and `queryPlans.test.ts` are why.** An
`await` inside a loop or an unconditional lookup passes every test, typecheck and build. The sharpest
lesson is `0020_perf_indexes`: indexing *both* sides of an `or` changed the plan by nothing, so the
statement had to be **split in two** to spend the indexes. **An index that looks correct and a migration
that runs clean are not evidence the scan is gone.**

**Filtering or ordering by a value inside `data` goes through `content_item_values`, a derived index
rebuilt in the item's write batch.** Same status and rules as `taxonomy_assignments`: not the source of
truth, rebuilt from `data`, so a restored revision restores it.
- **`json_extract` was the alternative and is worse** — per-dialect syntax, and an unindexed scan unless
  an expression index exists per content type per field.
- **Three value columns, not one**, because `'10' < '9'` is true as text. `indexedValueKind` picks the
  column; a caller guessing gets it silently wrong.
- **Dates are normalised through `Date` before storing**, or `2030-05-01` sorts *before*
  `2030-05-01T09:00:00Z` and an all-day event drops out of a window it belongs in.
- **Nothing about status is denormalised in** — a listing joins back and applies `visibleToPublic`, or a
  scheduled item goes live only when something happens to reindex it.
- **The planner is not called on the cascading path-move path**: descendants' `data` did not change.
- **`npm run db:reindex` is a required step after `0019` and `0021`.** Each table is created empty and a
  migration cannot fill it; until it runs, every value-filtered query answers as though nothing matched
  and search finds an item by its title and nothing else.

**Search is a second derived table behind the same planner; `planDerivedIndexes` is the only entry a call
site names.** `content_item_text` holds each item's prose flattened with `htmlToText`;
`content_item_fts` is an FTS5 index over it, and `0025_item_text_fts` carries the reasoning.
- **The table materialises the text; the FTS index makes it searchable.** `content_item_text` is the
  durable half — excerpts and `searchIndexStatus` read it, and a virtual table cannot be exported.
- **`searchTokens` is shared with the consumer, and that is not tidiness.** The server builds the `MATCH`
  expression from it and the client highlights the excerpt from it, so a second copy marks the wrong words
  on a page of correct results. `highlightTerms` returns **segments rather than markup**, because the term
  arrives in `?q=` and a highlighter emitting HTML is a reflected XSS. Everything in `searchTerms.ts` was
  measured against FTS5: `unicode61` folds *Peña* to `pena`, and neither `ø` nor `ß`.
- **One predicate, not one per caller** — the clause lives in `applyItemFilters`, shared byte for byte
  with the status facets, so the admin's search and both delivery endpoints narrow identically.
- **The walk recurses where the value walk does not**: prose sits inside blocks (bounded by
  `MAX_BLOCK_DEPTH`) and repeater rows. Only `text` and `richtext` contribute.
- **The block registry has to be loaded on the save that changes nothing** — `updateItem` rebuilds from
  stored `data` every save, and loading the registry only when validating new content wrote an index
  missing every block's prose.
- **A reusable block contributes nothing**, a stated limit: the page stores `{ id, type, ref }`, and the
  entry's text would have to be rebuilt across every referencing page on each library edit.
- **`relevance` is not in `ITEM_SORTS`**, the query field's sort menu: offering "most relevant" to a
  listing with no term answers an editor by ignoring them.
- **The row is written even when an item holds no prose** — an empty string is "indexed, holds nothing"
  and a missing row is "never indexed", the state between the migration and the reindex.

**`listItems` sorts by a named set, never a caller-supplied column.** `ITEM_SORTS` is its own importless
module because `items.ts` and `validation/fields.ts` already point at each other. A caller-supplied column
publishes the schema as the sort vocabulary; a named order is also free to be a different expression,
which `newest` needs — `coalesce(published_at, created_at)`. **Every order ends with `path` as a
tiebreak**, or two items sharing a timestamp swap between pages and one is shown twice. The sort goes on
`listItems`, **not** `applyItemFilters`, which is typed pre-`select` and shared with the facets.

**"Upcoming" is stored as an intent and resolved against the clock on every read.** `dateFilter` is
`'any' | 'upcoming' | 'past'`, never a timestamp, or the bound freezes at whatever moment somebody last
pressed save. The *preview* endpoint resolves it the same way and looks up the nominated date field
itself rather than trusting the parameter. A `dateFieldApiId` that no longer names a `date` field drops
the bound and falls back to `path` rather than erroring.

**A `query` field stores the rule and never the answer.** `resolveItemQueries` runs the rules on every
read, so "the six soonest Arts events" changes when somebody publishes a seventh.
- **Results land in a fourth top-level map, `queries`, not in `data[apiId]`** — that slot holds the saved
  rule and must keep the stored shape; a rule replaced by its results does not round-trip at all.
- **The key is `${containerId}:${fieldApiId}`**, because a query field can sit on a block type and the
  same block placed twice is two rules with two answers. `queryKey` is its own module so `pure.ts` can
  re-export it.
- **Queries run *after* `resolveItemBlocks` and *before* `collectReferences`** — after, so a query inside
  a reusable block is found; before, so matched items' ids ride the loaders already running.
- **A result carries the item's whole `data` minus `block` and `query` fields.** Not a configurable
  subset: if an editor chose the fields, a template renders nothing the day somebody unticks "location".
  Excluding `query` is the recursion bound, sharper than a depth counter.
- **A listing never shows a draft, even under a preview token** — it is a claim about what the page will
  look like once live.

**Copying a subtree remaps five reference-carrying field types, not one.** Stopping at `relation` leaves a
`link` field's button, a rich-text `taproot:item:` marker, and either nested inside a block or repeater
row pointing back at the source — none of which breaks visibly. The walk is structural rather than
definition-driven; rich text goes through `tokenize`, never a regex. `media`, `taxonomy` and
`query.termIds` are left alone deliberately. Block and repeater ids are **re-minted on a copy and left
alone on a repair** (`remapData` takes `mintIds`), or the repair pass could never decide nothing changed.
Copies land as **drafts with `publish_at` cleared**, and it is resumable with **no bookkeeping table** —
an item counts as copied when something exists at its mapped path. Note what copy-forward does **not**
freeze: anything resolved at read time from a shared row still points at one central row.

**A relation can carry its target's field values, and `includeData` is off by default.** Hydration runs
*before* the reference loaders so a target's ids ride queries already running. **Two independent gates
keep a draft out** — the hydration query filters on `visibleToPublic`, and the merge only attaches `data`
to an id `loadItemReferences` already returned — so removing either alone leaves the tests green.

**`reorderSiblings` puts one sibling group in a new order, and takes a whole level.** `position` had no
write path at all before it, so the order a consumer is handed a page's children in was permanently
creation order. A *partial* level hands rows positions others already hold and leaves duplicates ordered
by the `title` tiebreak — dragging appearing to work on some rows and not others. Exactness also settles
concurrency: a stale list is refused rather than shuffling a row into a level it was never part of.
- **No path rewrite, which is why this is its own function** rather than a key on `UpdateItemInput`:
  reordering writes one integer per row, while re-parenting rewrites this item's path, every
  descendant's, and a redirect for each.
- **The parent's `updated_at` moves too**, because its delivery response carries these children in this
  order and `getItemVersionByPath` answers a conditional request from `updated_at` alone. A no-op reorder
  writes nothing, for the same reason in reverse.
- **No revision** — revisions snapshot `title`, `slug`, `status`, `data` and `seo`, so one written here
  would record nothing and restore nothing.
- There is currently **no admin screen for it**; `POST /api/taproot/items/{id}/children/reorder` is the
  only caller, and root-level items are unreachable through it because there is no parent id for the path,
  though `reorderSiblings` itself accepts `null`.

### Preview

**A preview token is a capability over one item, and `delivery/resolve.ts` enforces it by path.** The
branch used to ignore `path` and answer with the token's item whatever was asked for, so every page on
the site would render as the item being edited. A token-bearing URL is answered `no-store` even when it
falls through to published content, because the URL is a cache key carrying a credential.

**Cross-origin preview is a token, and the token is the capability.** `?preview=1` worked only because
the site and the CMS shared an origin, so the route checked the *session*. `preview_tokens` is a row —
short-lived, revocable, and avoiding a signing secret that would need a working `npm run dev` default.
`resolvePreviewToken` answers `undefined` for absent, malformed, unknown and expired alike, so it cannot
be probed, and is deliberately **not** single-use, because a link that dies on first read breaks reload
and Back. **One mechanism covers a draft and a release's staged version.**

**A preview token's draft snapshot is a rendering input, not a version.** `resolvePreviewToken` merges
live row, then a release's staged version, then the draft — the order an editor experiences, which keeps
`releaseId` non-null when both are present.
- **Nothing may ever read a snapshot back into the editor.** The moment something offers "restore your
  unsaved changes", this is a draft store and Content Releases is what it duplicates badly. Do not
  surface its durability either.
- `preview.test.ts` asserts a snapshot write leaves `content_items` and `release_items` byte-identical.
  That test is the argument.
- The flag column is `draft_updated_at`, and the merge asks it rather than `data !== null` — deriving
  "a snapshot exists" from four nullable columns is four chances to disagree.

**"Can this be previewed" is `previewPathFor`, not a question about `kind`.** It answers `item.path` for
a page or collection and `content_types.preview_path` for a singleton; `kindHasPublicPath` used to stand
in and refused every singleton, which is wrong because a homepage assembled from blocks is one. Null is
the default and means no preview. **Nothing about delivery moved** — the consumer still asks `resolve`
for `/__singleton/{api_id}`, and the column says only which address the *admin* opens. The column is
nulled for every kind that is not a singleton, in both write paths.

**The editor's path is a link only when it goes somewhere.** A bare relative `<a href>` on `item.path`
resolves against the **CMS's** origin, which deliberately has no public catch-all, so every one of those
links landed on a 404 on the wrong host. It now needs both an address and a `TAPROOT_SITE_URL`, and
renders as plain `<code>` otherwise.

**The preview pane goes after `<form>` in the DOM, and that is not a layout preference.** An `<iframe>`
puts everything inside it into the tab order and **no attribute takes it back out** — `tabindex="-1"`
removes the element, not its contents. Last in the DOM, placed right by the grid, is the only arrangement
where "edit, then look" is also the focus order. The frame is sandboxed **without**
`allow-top-navigation`, so a stray `target="_top"` cannot throw somebody out of an unsaved form, and it is
remounted by React `key` rather than by assigning `.src`, which would turn Back into a walk through
preview reloads.

**The width rule for the open pane is deliberately unlayered — do not move it into `@layer base`.**
`#main` carries Tailwind's `max-w-5xl`, a `utilities` class, and **cascade layers beat specificity
outright**; it sat in `base` for one commit and did nothing. **Verifying that an attribute is in the HTML
is not verifying that it had an effect — measure the computed value.**

**The pane's open state is `data-preview` on `<html>`, with one writer.** The cookie is read on the server
so the width is right in the first HTML the browser parses, like `data-theme`. `ItemEditor` *observes* the
attribute with a `MutationObserver` rather than holding a second copy. That toggle changes state **without
a round trip**, because it sits above a form that may hold an hour of unsaved writing.

**`<TaprootPreviewBridge />` is optional by design** — a site that forwards the token gets a working pane,
and the bridge only upgrades a frame remount to a reload from inside, which keeps scroll position.
Requiring it would make the first run a setup error. `PREVIEW_MESSAGE` lives in `pure.ts` for the reason
`PREVIEW_PARAM` does: a mismatched name fails silently in one direction.

**There is one preview control, not two.** Two buttons with nearly the same name is how somebody learns to
trust neither. The pane's **"Back to editing"** is not a second one: below `xl` the form and pane *swap*
and the eye icon lives inside the form, so opening a preview on a phone hid its own off switch and Save.
**A control that is the only way out of a state must not live inside what that state hides.**

**The pane's "cannot reach your site" warning is a `no-cors` probe, not a timer and not `onLoad`.** A timer
never learned the frame had loaded; `onLoad` fires for a connection-refused error page too. A `no-cors`
request resolves opaque when anything answered and rejects when refused. Silent when the probe cannot run
at all. For tests: `new Response(null, { status: 0 })` throws, so any resolved value stands in.

**The preview card takes a definite `h-`, never `max-h-`** — a max bounds it without giving it a height, so
`flex-1` on the frame has no leftover space to claim.

### Releases and scheduling

**A release is the only place a content item can have a version that is not live**, because
`content_items` holds one row per item.
- **`release_items` carries its own `title`, `slug`, `data` and `seo`** rather than referencing a
  revision: revisions record what the *live* item has been, so staging by reference writes a line into
  the history of a page that never showed it — and a staged version has to be editable. `parent_id` is
  deliberately not staged; a release must not rearrange the hierarchy as a side effect.
- **Pre-flight replaces atomicity, because atomicity is unavailable.** `releasePreflight` validates every
  staged version *before* anything is written, against the content type **as it is now**, and is
  recomputed on every render rather than stored — a cached list of reasons still accuses somebody an hour
  after they fixed it. `release_items.published_at` makes a mid-flight failure resumable.
- **Publishing goes through `updateItem`, never around it**, so a staged slug change cascades to
  descendants and writes its redirects.
- **Staging is contributor, publishing is editor.** Publishing must not be a route to a change
  `canChangeStatus` would refuse one item at a time, so the staged endpoint refuses `status` outright.

**Scheduling is two halves and needs both.** Visibility is computed on read (`visibleToPublic`), so a page
goes live at its moment whether or not a sweep has run — which is what makes the feature work where nobody
wired up a cron. `publishDueItems` then makes the *stored* status agree.
- **`publish_at` is cleared whenever the status leaves `scheduled`, in both write paths.** A stale time is
  a booby trap: rescheduling later inherits a moment in the past, which means immediately.
- On `updateItem` the value distinguishes `undefined` ("keep it") from `null` ("clear it"); `??` collapses
  them and silently ignores a request to remove the date.
- **Revisions deliberately do not snapshot it** — restoring one would land in `scheduled` with no date:
  invisible, never swept, shown as an empty required field. Fails closed and says so.

**A scheduled release needs the sweep; a scheduled item does not**, because a release's content lives in
`release_items` and has to be *applied*, which no page view can do. Do not "fix" this by teaching the read
path about releases. `publishDueReleases` claims a release by **clearing `publish_at`** rather than adding
a `publishing` status, so a crash leaves it reading `scheduled` with no date — visibly wrong rather than
stranded. Items sweep **before** releases, or a page that is both scheduled and staged loses its moment.

**`blocked` exists only for the unattended case.** A scheduled release refused at 3am has nobody to tell,
and leaving it `scheduled` would sweep the same broken content every minute forever. A release refused
while somebody is looking at the screen is *not* moved to `blocked`.

### Deletes and the audit log

**A delete guard lives in core and the screen reads it, never the other way round.**
`contentTypeDeleteBlockers`, `itemDeleteImpact` and `mediaDeleteImpact` return the reasons a delete would
fail and `DangerZone.astro` renders them; a screen that works it out for itself drifts the moment a blocker
is added, and the failure mode is a button offered and then refused. `deleteItem` enforces its own
blockers, so the REST API cannot do what the admin declines.

**Blockers stop the delete; warnings describe consequences and do not.** An item with children blocks
(`parent_id` is `ON DELETE SET NULL`, so the delete strands them at paths that no longer describe where
they sit); a menu entry or an incoming relation warns, because both degrade visibly by design.

**Deleting an item staged in an unpublished release is blocked, not warned.** `release_items` cascades on
`content_item_id`, so the delete takes the staged version with it and the release publishes without that
page — no broken row, no message, nobody notices until the launch is missing something. The query lives
inline in `items.ts` rather than calling `openReleasesForItem`, because `releases.ts` imports `items.ts`
and the dependency must run one way.

**Delete is separated from the other icons rather than a fourth peer** — an equal icon beside two harmless
ones makes destruction the most discoverable action on the screen. The typed confirmation is still checked
on the server, so this is about not inviting the click rather than about safety.

**The audit log is append-only and nothing may make it aimable.** `recordAuditEntry` never throws: the
action it describes has already happened. `actor_email` and `subject_label` are copied at write time rather
than joined, because a log records what was true *then*, and `subject_id` has no foreign key for the same
reason — a cascade would delete the evidence along with the subject. Retention is a dated sweep; "delete
entries about me" is the capability an audit log must not have.

### Validation and content safety

**Richtext is sanitised on write, inside `validateItemData`.** It is stored as HTML and rendered with
`set:html`, so an unsanitised value is stored XSS against every visitor and every editor. **The editor is
not the boundary — the REST API is.** Never move sanitising to render time, and never add a write path that
skips validation. `sanitizeHtml` is an allowlist *serialiser*: it re-emits only what it understands, so
anything unparseable becomes nothing rather than itself.

**`requireComplete: false` relaxes three rules and sanitising is not among them.** It turns off `required`,
a text field's `minLength` and a repeater's `minItems` — **a minimum is a claim about completeness and a
maximum is a bound on what the system will carry**, and only the first kind is a question a half-typed form
may fail. Both recursions forward `options` unchanged, so blocks and repeater rows behave identically for
free. The richtext transform sits outside every `required` branch and runs first, which is the property the
whole feature rests on. `writePreviewDraft` is the only *external* caller and must stay so.

**A conditionally hidden field is not required, and its value is not dropped.** `visible_when` is a nullable
column on `fields`, not a key in `config`, because a condition means the same thing for every field type.
`validation/visibility.ts` is the one evaluator, called by `validateItemData` **and** by the three editor
render sites — two implementations disagreeing here is a field an editor cannot see and cannot save without.
- **The condition is evaluated against the raw `input`, never the accumulating `parsed`.** The loop fills
  `parsed` in field order, so a controlling checkbox positioned *after* its dependent is not there yet.
  Proven by mutation: flipping it fails exactly one test.
- **A hidden field's value is kept**, or `validateItemData` becomes a destructive transform driven by a rule
  an admin edits on a different screen.
- **A dangling condition fails open** — `evaluateVisibility` takes sibling `api_id`s from the *schema* so a
  condition naming a deleted field renders the dependent visible. Absent *data* evaluates normally.
- **"Sibling" is always the same level**, which costs nothing to enforce because every walk already has
  exactly that in hand. Reaching across levels would have to name a path.

Two consequences: `typegen` emits a conditional field **optional whatever `required` says**, because
"required" there means "required when shown"; and the editor filters hidden fields in the *parent* rather
than passing siblings into `FieldControl`, keeping it a component that renders one field.

**Generated types are a `.d.ts` and carry no runtime**, so a generated helper function is a syntax error. A
repeater's sub-fields are read in the stored `FieldRow` shape (`api_id`), never the delivery shape — reading
them as `DeliveryField` silently emitted properties literally named `undefined`. **A repeater row is emitted
as its envelope, `{ id, data: { …sub-fields } }`**, which is what `buildValueSchema` validates and what
`resolveDelivery` sends. The rule generalises: **a generated type must describe the payload Taproot actually
sends**, which is why `media` and `relation` emit ids. Flattening *delivery* to match is the wrong fix.

**The accessibility checker is advisory and lives off the write path.** `checkItemAccessibility` never
refuses a save or a publish: an author who cannot publish because a checker disagrees routes around the CMS,
and a false positive becomes an outage. `validateItemData` is where a rule that *must* hold goes.
- **The rules are pure and the resolution is a different file.** `accessibility.ts` takes fields, data and a
  lookup context with no database handle, which is what lets the editor's island run it on every keystroke;
  `accessibilityReport.ts` finds content and resolves what the rules read.
- **The walk mirrors `validateItemData`'s**, through blocks and repeater rows. `referencedMediaIds` uses the
  same walk, or a media field it missed reports every one of its images as undescribed.
- **`media.alt_text` has three states**: `null` is "nobody has said", `''` is "somebody marked it
  decorative". Ask through **`needsAltText`**, never `!altText`. Blank inputs normalise to `null`
  (`formValue`); only the Decorative checkbox writes `''`.
- **Alt text is resolved from the item's stored data, not the library's first page**
  (`referencedMediaOptions`). An id it cannot resolve is **not reported** — that is a broken reference
  rather than a missing description.

**Heading order is checked within one richtext value, not across the page**, because Taproot ships no
templates and cannot know what order a site renders a type's fields in. The report is a scan, so it paginates
and states what it checked ("Checked 50 of 312 items") rather than offering a site-wide total: a true total
means reading every row and a quietly capped one is worse than none. Undescribed *images* are asked
separately as a real query, the only way to catch an image uploaded and not yet placed.

### AI assist

**AI assist is suggestions only, and `available` is the whole safety model.** `ai/` holds three `fetch`
adapters behind one `AiProvider`; `resolveAssistant` pairs the environment's keys with the `settings` row.
- **Nothing generated is written to a row, structurally rather than by policy.** Both routes return a
  string; neither has a path to `media.alt_text` or `content_items.seo`. A machine writing `''` would mark
  an image **decorative**, and no prompt care makes an empty completion safe to store.
- **`available` is the mailer's `delivers` again**: true only when a provider is chosen, its key is in the
  environment, **and** that feature's toggle is on. Every affordance gates in the template rather than
  discovering it on submit. Two toggles, because they are different decisions.
- **Adapters, not a webhook — the opposite of mail.** There is no generic shape for "describe this image".
  No SDKs, because three vendor dependency trees in `core` is three things reaching a Workers bundle.
- **Keys in the environment, provider and model in `settings`.** A key column would be the first secret at
  rest, needing encryption, needing a key, needing a working `npm run dev` default. Provider is *not*
  derived from whichever key is present — that picks for an operator with several set, and makes
  "configured but deliberately off" unsayable.
- **Alt text takes bytes through the storage adapter, never a URL.** A provider fetching `publicUrl` is a
  request from *its* network to ours, failing for reasons this deployment cannot see.
- **The SEO input is `content_item_text`, not a fresh walk**, so what the model reads is what search
  matches. Capped at `MAX_PROSE`. A **missing** row is "not indexed yet", not summarised as empty.
- **`output_config.effort` goes only to models that accept it, via an allowlist that fails towards
  omission.** It **errors** on Haiku 4.5 and Sonnet 4.5 — the models somebody picks for a bulk alt-text
  run. An allowlist because omitting `effort` costs some tokens while sending it where it is refused costs
  the whole feature. Do not make it a denylist, and do not validate the model field against a hardcoded
  list on the settings form — that refuses a model newer than the code.
- **A parse failure throws rather than falling back**, because putting the whole blob in the title field
  would look like the feature working. Same reason `describeImage` checks `stop_reason: 'refusal'` before
  reading `content`: a refusal is a **200** with empty content.

### Mail

**Taproot sends one email, and works with none** — `npm run dev` needs no external service. With nothing
configured `resolveMailer` returns the log mailer, whose `delivers` is **false**, and that flag is
load-bearing: the login page's "Forgot your password?" link, the forgot-password screen and the API route
all gate on it, because a form whose success message is a lie is worse than no form. Delivery is a webhook
taking flat JSON — **do not add a vendor SDK or a per-provider adapter.** Reset requests throttle in their
own keyspace (`resetEmailKey`), or asking to reset someone's password locks them out of signing in.

### Runtime and platform

**Zero native dependencies.** Both SQL drivers are written in-tree because Kysely ships no D1 dialect and
`kysely-d1` is unmaintained. `npm install` must never need a C++ toolchain. **Never add `bcrypt`, `argon2`,
`better-sqlite3`, or `sharp`.** Hashing goes through `crypto.subtle` (PBKDF2-SHA256).

**workerd caps PBKDF2 at 100,000 iterations, and `DEFAULT_ITERATIONS` is that cap** — above it
`crypto.subtle.deriveBits` throws `NotSupportedError` rather than clamping. **Node has no cap, so nothing
local reproduces it**: at 210,000 a Cloudflare deployment could not create its first administrator and every
sign-in for a nonexistent address 500s, while the tests and `npm run dev` all passed. One number for every
environment, or a database that moves between them holds passwords nobody can verify. `DUMMY_HASH`
interpolates the same constant.

**D1 refuses PRAGMA, so the D1 dialect carries its own introspector.** Kysely's `SqliteIntrospector` reads
`pragma_table_info` and D1 answers `not authorized: SQLITE_AUTH`; `Migrator` calls `getTables()` *before*
creating its bookkeeping tables, so the stock introspector made `db:migrate:remote` fail on the very first
statement, with an error naming authorization. `D1Introspector` answers from `sqlite_master` and returns
**empty columns**, honest for its only caller. Do not "restore" the inherited introspector, and do not build
anything needing real column metadata on it. `d1.test.ts` pins the property with a fake that refuses PRAGMA
the way D1 does, since a real SQLite never will.

**Migrations are append-only, and a removed feature's migration stays.** Kysely throws `corrupted
migrations: previously executed migration <name> is missing` when a database has run one the registry no
longer lists, so deleting a file breaks `db:migrate` on every deployment that applied it. Superseding is the
only route — `0037_drop_book_columns` drops what `0034`/`0035` added and both keep their entries. Never
renumber or change what a shipped migration *does*.

**No read-your-own-writes inside a batch.** D1 has no interactive transactions, so `batchWrite()` takes a
*list of statements*. Do all reads first, compute in memory, then write once. The cascading path move is the
reference example: one recursive CTE reads the subtree, every new path is computed in memory, and the whole
thing goes out as a single batch.

**Dev runs on Node, production on Workers.** Dev deliberately does *not* run SSR in workerd, which has no
`node:sqlite` — that would make `npm run db:seed` impossible without a running dev server. `node:sqlite` is
reached through a variable specifier and marked SSR-external. Use `npm run preview` for the real runtime.

**Kysely is pinned to one chunk, and a green build says nothing about whether workerd will run it.** Left
alone the bundler splits Kysely's SQLite dialect from its core into two chunks importing each other; Node
tolerates the cycle, workerd evaluates it with the base class still undefined at `class … extends`, and
**Cloudflare refuses the upload** (error 10021) after `astro build` reported success. The `manualChunks` rule
in `astro.config.mjs` prevents it, in `apps/studio` **and** in the scaffolder's byte-identical copy.
**Building is not evaluating**, and this failure is invisible to every test, typecheck and build here.

**The Worker entry is `apps/studio/src/worker.ts`, not the adapter's.** `@astrojs/cloudflare` fills in `main`
only when the wrangler config does not, and would supply exactly `{ fetch: handle }` — so naming our own
costs nothing and buys a `scheduled` export, the only way a Cloudflare cron trigger reaches the publishing
sweep. `main` must point at **source**, never at anything under `dist/`.
`POST /api/taproot/scheduler/run` and `TAPROOT_CRON_SECRET` remain for platforms with no cron.

### The admin shell

**The admin is server-rendered Astro, not a SPA.** Every screen is an Astro page whose permission check runs
before any HTML is sent; React appears only where interaction demands it (field builder, item editor). This
is primarily an accessibility decision — client-side routing needs hand-built focus management and route
announcements to meet WCAG AA. **Don't introduce client-side routing.**

**Revision history, incoming references and the danger zone live in sheets, and the sheet is a native
`<dialog>`.** Inside them are server-rendered Astro components whose contents are links, tables and real
form POSTs — a restore that is a real form submission works before hydration and needs no hand-built focus
management. `showModal()` supplies the focus trap, Escape, the inert background and top-layer stacking.

## Accessibility is an acceptance criterion, not a review step

The admin itself must be WCAG 2.1 AA. Debt here compounds, so **`npm run a11y` must pass before a phase is
called done**, with zero violations, zero inert labels, zero reflow hazards, and every token pair passing in
both themes.

**The implementation detail lives in [packages/studio/CLAUDE.md](packages/studio/CLAUDE.md)** — the
responsive nav, sticky positioning, the colour tokens and contrast mirrors, `<label for>` on labelable
elements, and what the audit cannot see. Read it before touching admin markup or `admin.css`. Three things
stay here:

- **`scripts/a11y-audit.mjs` force-opens `dialog.taproot-sheet` *and* `[data-menu-panel]` before running
  axe**, because a closed one is `display: none` and axe skips it — a run would stay green while the account
  link, the theme buttons and sign-out quietly stopped being checked.
- **A control that only exists on page two needs page two in `ROUTES`.** `Pager` renders only when there is
  somewhere to go, so auditing `/admin/media` on a seeded database checks a screen whose navigation is not in
  the DOM. `?page=2` is deliberately past the end of the seed data, which also renders the empty-page state.
  **Markup that appears only in a state the seed never reaches is markup the audit cannot see.**
- **The audit's dynamic routes must be chosen by what they exercise, not by what sorts first.** It picks the
  item editor by field count, because `items[0]` took the alphabetically-first path and left the densest
  screen in the admin the one route never audited. Note `/api/taproot/content-types` returns types *without*
  their fields, so a count derived from that list is zero for everything and quietly restores the bug. Same
  trap one screen along: the settings form renders a different control per kind, so it loops over the kinds.
  And a third time, one axis along — **field count is a fact about the content type, composition is a fact
  about the item**: `composedRows` picks the block-heaviest and row-heaviest items too, counting the two
  envelopes **separately** because they sit on different items and one combined score leaves repeaters
  unaudited.

**Blocks and repeater rows default to expanded, and that default is what keeps them auditable.** The audit
runs with `runScripts: 'outside-only'`, so axe sees the island's *server-rendered* markup with that initial
state, and a collapsed panel carries `hidden` (`display: none`). Defaulting to collapsed for long lists is
the obvious ergonomic improvement and would silently drop every field inside every block while the run still
reported zero. Nothing persists the state either. Related: a repeater row's disclosure is a **button and
deliberately not a heading**, where a block's is an `<h3>` — a block is a section of the page being composed,
while a repeater's rows are one field's value.

**A new colour token, or a new *pairing* of existing tokens, is not done until it has a pair in
`a11y-contrast.mjs`.** `axe` runs with `color-contrast` disabled precisely because that script is the
authority, so a colour on a background it has never been checked against is unchecked however many routes
pass.

**Drag-and-drop must always be added alongside keyboard controls, never instead of them**; the field
builder's reorder buttons are the pattern.

## Conventions

**Zod 4, not 3.** Two traps that have cost real bugs:
- `.strict()` takes no arguments — a message passed to it is silently discarded. Use
  `z.strictObject(shape, { error })` with an error map scoped to `unrecognized_keys`.
- `.partial()` makes keys optional but does **not** strip a `.default()`. Deriving a PATCH schema that way
  let `config: {}` through on every request and wiped stored field options. **Write PATCH schemas
  explicitly.**

**Vitest** defaults to the `node` environment because the core suites talk to a real database. Files that
render React opt in per-file with a `@vitest-environment jsdom` docblock — Vitest 4 removed
`environmentMatchGlobs`.

**Comments explain why, not what.** A comment earns its place by recording a constraint or a rejected
alternative, at the point where somebody would otherwise "simplify" the code wrongly.

**Terminology is locked** (SCOPE.md): *Content Item* (never "Page" — a page is one type among many), *Block*,
*Reusable Block*, *Content Type*.

**Asserting a control exists is not asserting it works.** The link search had tests for its input, its label
and its place in the tab order, and shipped unable to create a single link. A test has to make the feature
happen and inspect what came out. Where jsdom genuinely cannot help — it has no selection model — say so in
the test file and verify that branch in a browser.

**Render a component where it actually lives, or the test cannot see its context.** Every richtext test
rendered the editor alone and all passed while Apply saved the whole content item and navigated away; the
bug only exists because there is a `<form onSubmit>` above it in the real screen.

**Source files are UTF-8**, and `sourceEncoding.test.ts` keeps them that way — scan for the character
signature, not for double-encoded bytes.

## Data model notes

### Paths, slugs and content types

- **Slugs are unique among siblings, not site-wide** — that is what lets `/admissions/apply` and
  `/financial-aid/apply` coexist. A plain unique index on `(parent_id, slug)` is *not* enough, because NULL
  never equals NULL and two root pages would slip through. There are tests for both cases.
- **`path` is a denormalised materialised path**, indexed and unique. `depth` is redundant with it but makes
  tree ordering an indexed sort.
- **Every path change writes a redirect automatically. Never make this opt-in.** Hand-written redirects
  (`source: 'manual'`) take part in the same chain collapse (reuse `buildRedirectStatements`, never
  reimplement it) and are **exempt from the sweep** that deletes redirects leaving a path a live item filled.
- **Content type `kind`** is `page` (nests under a parent), `collection` (flat, `url_prefix`-based), or
  `singleton` (exactly one item, no create/delete, optional `preview_path`).
- **A collection's items can have no pages of their own, and `content_types.item_pages` is how.** A staff
  directory is the case: the people are real content and none of them is a URL.
  - **A column, not a fourth kind** — `kind` answers *how are instances addressed*, and a routeless
    collection is addressed exactly as a collection is. A kind forks every screen that switches on kind.
  - **The path stays**: it is how the admin addresses the row and what the setting would restore.
  - **`typeHasItemPages` is the one question**, never the column, which is meaningful only for a collection.
  - **`resolveDelivery` answers `not_found`, and the exclusion is in the SQL** — `getItemByPath` takes
    `routableOnly` so the check costs no extra round trip. A miss still falls through to the redirect table.
  - **A listing excludes it only when the caller did not name the type; search excludes it always.** An
    index of everything is a list of links, while `type=person` is how a directory is built — and a search
    result whose URL 404s is worse than not finding it.
  - **No preview, and deliberately not a redirect to the listing.** `previewPathFor` answers null and the
    editor says so in words, because no link and no pane is otherwise indistinguishable from a
    misconfiguration.
- **`api_id` and `url_prefix` accept disjoint character sets, so one may never fill the other unslugified.**
  `api_id` is `^[a-z][a-z0-9_]*$`; `url_prefix` uses `isValidSlug`'s `^[a-z0-9]+(?:-[a-z0-9]+)*$`, the exact
  inverse. They agree only while a name is one word, which is how `createContentType`'s bare
  `?? input.api_id` survived: every multi-word type created with a blank prefix stored a value the schema
  then **rejected**, so its settings form could never be submitted again *for any change at all*.
  - **This is "never leave a deployment in a state its own UI cannot reach" from the one direction care at
    the input cannot cover.** When code derives one validated column from another, the derivation is a write
    path and owes the same guarantee.
  - **The fix is the fallback, never the validator** — admitting `_` would allow `/alum_profile/jane-doe`.
  - **`0030_url_prefix_slug` freezes its own repair rather than importing `slugify`**, so a deployment
    migrating later cannot get a different answer. It does **not** rewrite existing item paths.
  - **The two screens have to say which convention they want**; `title` on the input replaces the browser's
    message, which names neither the rule nor the character that broke it.
- **`content_types.default_og_image_id` is inherited, not copied** — copying onto items at creation would
  silently freeze the old value.

### Fields and content

- **Field values live in `content_items.data`** keyed by field `api_id`, validated against the type.
- **`h1` and `img` are absent from the richtext allowlist.** The page's `h1` is its title, so body headings
  start at `h2` or the outline breaks (WCAG 1.3.1); images belong to the library, where they carry alt text
  and a hotspot `set:html` could never apply.
- **Richtext length is measured on visible text, not markup** — an empty editor emits `<p></p>`.
- **SEO fallbacks are resolved in core, never a template**, or a preview resolves fallbacks for a page
  nobody will see. Chain: item override → content type default (OG image only) → the item's title. There is
  deliberately **no excerpt fallback for the description**.
- **SEO length guidance is guidance, not validation** — engines truncate by pixel width. `SEO_GUIDANCE`
  holds the numbers.
- **A block type is a content type with `kind: 'block'`**, reusing the same table, builder, API and
  validation. **`listContentTypes` excludes blocks by default**, because the sidebar, the new-item picker
  and the relation target list all call it; **`createItem` refuses a block type**, which would otherwise be
  an item with no URL, invisible in every list that filters blocks out.
- **Block instances live in `content_items.data`, not rows of their own** — they are content, versioned by
  the item's revisions. The cost is that block-type usage is a `LIKE` over the blob, paid only on delete.
- **Two blocks of the same type share one `FieldRow`**, so `FieldControl` takes an `idPrefix`; without it
  both render inputs with the same DOM id and a label focuses the wrong one.
- **A block type may hold a `block` field, and the editor must pass its context down.** `BlockListEditor`
  forwards `blockTypes`, `reusableBlocks` and `ancestorTypes` into each nested `FieldControl`. The nested
  picker gets the **unfiltered catalogue**, since the outer field's `allowedBlocks` is not the inner
  field's; **ancestors are excluded rather than depth counted**, which forbids exactly the cycles and
  leaves Section → Card alone; and `MAX_BLOCK_DEPTH` backstops it in `validateItemData`, because the
  boundary must refuse a request the editor never made.
- **Taproot ships no block templates.** `BlockRenderer` takes a map from block `api_id` to a host-supplied
  component — a CMS that shipped a hero would be shipping a design.
- **A reusable block's content belongs to the library, not the page.** A page stores only
  `{ id, type, ref }`, because two copies raises which is authoritative and the stale one wins wherever
  nobody reopened. So: a revision records **that** it referenced the entry, not what the entry said;
  referenced blocks skip field validation on the page, because **a library row is only ever written
  validated** (creating one collects its content first, through the same editor); deleting an entry is
  **refused** while anything references it; and deleting a block *type* also checks the library, since
  `countBlockUsage` only sees blocks written into an item.
- **Every reason a content type cannot be deleted comes from `contentTypeDeleteBlockers`**, read by both
  the guard and the screen, phrased as standalone clauses so they read correctly bulleted and after the
  error's prefix. **A relation field on another type counts as usage** even with zero items, because
  `targetContentTypeId` lives in another type's JSON `config` that no FK sees; fields of the type being
  deleted are excluded, or a self-referencing relation makes its own type undeletable. The confirmation
  types the `api_id` and is **checked on the server**.
- **`relation` is a first-class field type, both directions.** `RelationField` is inline rather than a
  modal, because a list of items is read by title where a media library is browsed by eye. Candidates are a
  server-resolved first page and the control searches past it; the resolver is handed the item's stored
  data so an id outside that page still renders a title.
  - **A content type's field list is only the top level, and `fieldTree.ts` reaches the rest.** **The
    options walk is over the *schema* (`reachableFields`), never the item's data**, because an editor adds
    a block *after* the page rendered — a data-driven walk is correct wherever somebody is revising and
    dead wherever somebody is composing. `walkStoredValues` is the data-driven half, for resolving stored
    ids only. Consequence: block registries load **before** both resolvers.
  - **`itemsReferencing` is the reverse side**, grouped by `reverseLabel`, and two queries on purpose: the
    relation *fields* that could point here come from the `fields` table first, and only then is `data`
    searched — a bare `LIKE` would also match the id in a body or a media reference.
- **`link` is a field type because a relation cannot be a button** — a relation names an item and cannot
  express an external address, a file, or "open in a new tab".
  - **The control *is* `LinkDialog`**, the one rich text uses; a second interface for the same act is how
    somebody ends up trusting neither.
  - **It stores `{ kind, id | href }`, not rich text's `taproot:item:{id}` marker**, which would put a
    string a consumer must parse where an id and a lookup belong. Rich text accepts that trade because
    `set:html` cannot perform a lookup; a structured field has no such excuse.
  - **The `url` kind goes through `safeUrl`, the sanitiser's own export** — a second opinion about
    `javascript:` will disagree with itself once. `taproot:` is excluded there, or an internal target has
    two spellings and one is invisible to `collectReferences`.
  - **No `multiple`, deliberately** — several links is a repeater of a link field, which composes because
    each row can carry its own heading.
- **A repeater's sub-fields live in its own config, not the `fields` table.** They have no independent
  existence, and rows would mean every query loading a type's fields learning to exclude them.
  `repeaterRowFields` synthesises `FieldRow`s on demand, and `REPEATER_SUB_FIELD_TYPES` excludes `block`
  and `repeater` — a table of tables is a data model rather than a field, and that exclusion in *core* is
  what makes the config form's recursion terminate.
- **A repeater can keep its own rows in order, off by default because order is often the meaning.**
  `sortBy`/`sortDirection` applied **on write** inside `validateRepeater`, so stored order is delivered
  order and the payload still round-trips. It compares with `Intl.Collator({ numeric: true })`, or
  `RAD 1096` sorts before `RAD 196`; a row missing the key sorts **last in both directions**; the sort is
  stable; a key naming a removed sub-field does nothing. Not the default, because a program plan's blank
  `term` means "same as the row above" and nothing can detect that.
- **Every field type has an editing control or is listed in `DEFERRED_FIELD_TYPES`**, asserted by
  `fieldControls.test.tsx`. The list is a **fact about what exists**, not a plan; currently empty, kept so
  a type added later without a control can say so.
- **Rich text stores a reference, never a path — and delivery resolves it.** `taproot:item:{id}` follows
  the rule menus follow; `taproot:media:{id}` does the same for a file.
  - **`taproot:` is on `SAFE_SCHEMES` but is not an open scheme** — `serializeAnchor` accepts only
    `taproot:item:<uuid>` and `taproot:media:<uuid>`, and anything else spelled `taproot:` is dropped as
    `javascript:` is. **Admitting the scheme must not admit a payload.**
  - **`collectReferences` needs a `richtext` case, and `collectLoose` a second path**, because the loose
    walk gates on an *anchored* uuid so prose is never a lookup key. Both parse with `tokenize`, never a
    regex over markup.
  - **Resolution inlines a reference into `data`, which the delivery rules otherwise forbid**, because a
    marker left in place ships `taproot:item:…` to a visitor the moment a consumer forgets a helper, and
    delivery is read-only so nothing round-trips it back. The ids stay in `references`.
  - **`loadLinkTargets` follows `includeUnpublished`; `loadItemRefs` never does** — a relation must not
    name a draft, but an editor assembling a section links between drafts. Outside a preview an
    unresolvable target **unwraps**: the `<a>` goes, the text stays.
- **There is no raw HTML field, and `embed` is what was built instead.** A stored value rendered with
  `set:html` is stored XSS, so a field whose purpose is skipping sanitising would be the first write path
  here that does — and would hand script execution to `contributor`, the lowest role there is.
  - **The value is `{ url, title }` and never markup**, so `sandbox`, `title`, `referrerpolicy` and the
    host are facts `<TaprootEmbed>` guarantees rather than things an author remembered.
  - **An empty `allowedHosts` admits nothing**, inverting `media.accept` and `link.allowedKinds`: those
    bound a picker over content the CMS holds, this is the boundary against framing an arbitrary origin.
    Defaulting to video hosts is not Taproot's opinion to hold, so the form offers presets.
  - **`embedHostAllowed`'s suffix test is `.${allowed}` with the dot**, or `evil-youtube.com` passes; a
    trailing dot is stripped, because `youtube.com.` is the same host to a browser.
  - **`title` is required, and the a11y checker takes the half validation cannot** — an `<iframe>`'s
    accessible name is all that is announced (WCAG 4.1.2). `embed-name` catches what
    `requireComplete: false` let through; `embed-title` catches "Video".
  - **`sizing` is three modes on the *field's* config**, not one ratio and not per-value, because a ratio
    describes exactly one of the three things people embed. So a video block and a form block are two
    block types, which is right.
  - **Under `auto`, Taproot owns the security and the site owns the parse** — no standard message shape
    exists, so `<TaprootEmbed>` dispatches `taproot:embed:message` with a clamping `setHeight` and falls
    back to `parseEmbedHeight`. The identity check is **`event.source`, not `event.origin` alone**, since
    two embeds from one provider share an origin; an unreadable message leaves the frame where it is.
  - **`allow-scripts allow-same-origin` is dropped when the embed is same-origin**, where the pair equals
    no sandbox — stated consequence: `auto` then cannot size it. Accepting `"null"` would accept it from
    any sandboxed frame anywhere.
  - **An embed with a *protocol* rather than a URL is a block component, not this field** — in
    `BLOCK_COMPONENTS`, in git, where a developer wrote it. That escape hatch is why the field is strict.

### Taxonomies and menus

- **Taxonomies carry no authority.** A term classifies content and never determines who may edit it.
  Classification is editable by any contributor, so deriving a permission from it lets someone tag a page for
  discoverability and silently hand another group edit rights. Roles are flat and site-wide. **Do not
  reintroduce permission checks that read taxonomy terms.**
- **`taxonomy_assignments` is a derived index, not the source of truth.** Tags are authored into `data` like
  every other field and the table is rebuilt from them in the same atomic batch — storing them only in the
  join table would make a restored revision silently lose them. What the index buys is filtering by term
  without scanning every row: `ItemFilters.termIds` is a correlated `EXISTS` shared by the list and its
  facets, `EXISTS` rather than a join so an item carrying three terms in the branch counts once. **A term
  filter always means the whole branch** (`termIdsForBranch`), because filing under "Sciences" has to be
  found by filtering "Academics". An *empty* `termIds` array matches nothing rather than everything.
- **Taproot has no opinion about term URLs** — whether a taxonomy's terms get public pages is the host site's
  decision, passed to `resolveMenu` as a `termHref` callback. `termArchivePath` is a convention offered, not
  applied; nothing in core calls it. `apps/web/src/taproot.ts` is the worked example, and both the catch-all
  route and the menu resolver read the same set so they cannot disagree.
- **Terms have no materialised path**, unlike content items: a request URL must resolve in one indexed lookup
  on the hot path, while terms have no public URL and their only tree query is a recursive CTE off
  `parent_id`. A path would mean a second cascading-rewrite implementation serving no read.
- **Menu items reference their target, never store a URL** — a moved page keeps its place in the navigation
  and an unpublished one leaves it, with no menu edit. A deleted target nulls the reference rather than
  cascading, so the broken entry stays visible in the admin instead of silently editing the navigation.
- **`rel` is composed in core and travels as a string**, because two consumers independently got it wrong,
  both writing `rel="noopener"` with no `noreferrer` — not a wrong `rel`, a *nearly* right one that looks
  deliberate. `rel.ts` holds `ALLOWED_REL`, `NEW_TAB_REL` and `menuRel`; `sanitizeHtml.ts` imports the first
  two rather than keeping its own copy.
  - **The flags travel too, and that is not redundancy**: `openInNewTab`/`noFollow` are what the admin edits
    and what round-trips into a write, while `rel` is what goes in the markup and carries one pair no flag
    corresponds to.
  - **`noopener noreferrer` gets no column and no checkbox** — not a decision an editor makes, and a control
    for it is a control somebody can untick. `nofollow` is genuinely editorial, which is why it is stored.
  - **Two columns rather than a free-text `rel`**, because the vocabulary is short and security-relevant.
  - **`MenuLink` carries it to the last step**, or every site goes back to assembling it.
  - **A checkbox on a PATCH needs a presence marker** (`patchFlag`): an unticked box is simply not posted, so
    on a *create* presence is the value while on a patch "absent" means either "unticked" or "this form does
    not offer the control".

### Media

- **Hotspot and crop are stored normalised and resolved on demand**, never baked into a file, because one
  asset drives a 16:9 hero, a square thumbnail and a portrait card. `resolveCrop` takes the crop first,
  fits the target ratio inside it, then slides that frame to centre the hotspot, clamped.
- **Rendering goes through `TaprootImage`, not `object-fit: cover`** — for two phases the editor stored a
  focal point nothing read. It scales a real `<img>` by the inverse of the resolved rectangle inside an
  `aspect-ratio` box (`cropFrame`), keeping alt text, `srcset` and crawler visibility, and **owns its
  wrapper on purpose**: the maths only avoids distortion if the box carries the ratio the rectangle was
  resolved for.
- **`ratio` is optional, and without one it renders a bare `<img>` it does not own**, keeping the focal
  point as `object-position` (`coverPosition`). The mode exists because two layouts reached for a plain
  `<img>` to escape the ratio and gave up the **resize** on the way out — **skipping the crop was never a
  reason to skip the resize.** So `class` lands on the `<img>`, and **no `object-fit` is set**, because
  `cover` and `contain` are both right for different callers.
- **The media route resizes, and `imageVariants.ts` is the vocabulary both sides spell**, living where
  `pure.ts` re-exports it — a disagreement is **silent**: every visitor served the original while the page
  looks right and every test passes.
  - **The width ladder is closed and the ratio quantised, as cost control** — Cloudflare bills a unique
    transformation per parameter set. A width between rungs snaps **up**, since snapping down answers a
    reasonable request with a blurrier picture; `ar` is quantised on the way *out* as well as in, or every
    candidate misses the cache while still rendering correctly.
  - **The ladder also offers the ceiling itself — but only *below* the top rung**, because above it there
    is nothing left to clamp, so the top candidate was byte-identical to the one beside it at a width the
    browser sized its choice against wrongly. The property test asserts
    `min(parseMediaVariant(w), naturalWidth) === w` for every rung offered.
  - **Format is in the URL and never negotiated from `Accept`**, honoured in that shared cache only for
    `Accept-Encoding` — an `f=auto` serves the first visitor's format to everyone behind them.
  - **`OUTPUT_QUALITY` is not optional**: unset, the binding encodes near-lossless and **a resize comes
    back larger than the source**. Set whether or not a format was named, because a resize re-encodes.
  - **The output must always *name* a format.** The binding **rejects** an `output()` with no `format`, and
    `resizeImage` catches every failure and serves the stored bytes — so every variant that asked only to
    be resized answered the full-size original. The fake in `images.test.ts` now **rejects a format-less
    output the way the real binding does**.
  - **AVIF ships through `<picture>`, and that is not the `f=auto` this file rejects** — each `<source>`
    names one format in its own URL, so each is its own cache key and the **browser** chooses before
    requesting anything. WebP stays on the `<img>`; the element is `display: contents`.
  - **`resizeImage` fails open, always** — no binding, an unresizable type, an allowance reached, a throw:
    every one serves the stored original. Heavier pages, never broken ones; SVG and GIF stay untouched.
  - **`sizes` describes the container and `scaleSizes` bridges it to the element**, because under
    `crop:css` the `<img>` is blown up by `1 / rect.width` and an unmodified `sizes` picks one rung too
    soft exactly where the crop was doing most work. It lives in **core** because it shipped wrong:
    splitting an entry on its last space breaks `calc(50vw - 57px)`. **String arithmetic inside a component
    is reachable by no suite in this repo.**
  - **`immutable` was a lie on a `?ar=` variant, and `cropStamp` makes it true again.** A storage key's
    bytes never change, but a server-cropped variant's rectangle resolves from columns an editor changes,
    with no remediation available (no `cache-tag`, and no purge reaches a browser). The stamp moves the
    *address* instead: **only beside `ar`**, **quantised to thousandths**, and **`parseMediaVariant`
    deliberately never reads it**.
  - **`crop="server"` is opt-in and `object-fit: cover` is its safety net, not its mechanism**, so the
    failure mode is an approximate crop rather than a wrong picture. The rectangle is applied as a pixel
    `trim` **before** the resize, because the order is the point; `fit: 'crop'` with a `gravity` focal
    point would be fewer lines and would quietly ignore the crop an editor dragged.
- **`TAPROOT_MEDIA_URL` and the Images binding are mutually exclusive, and nothing warns** — pointing it at
  an R2 custom domain makes media bypass the Worker route, and the resize lives *in* that route.
- **Image dimensions are read from header bytes on upload**, not decoded, because every library that could
  decode is a native dependency. An unrecognised format returns null and the editor degrades.
- **One media picker, used by every place an asset is chosen** — `MediaField` the control, `MediaPicker`
  the dialog. **Don't add a fourth bespoke chooser.**
  - **The grid is a listbox, not a checkbox per card**, which would give every asset its own tab stop.
  - **Arrow-key row movement is measured from layout, and degrades to linear when it cannot be** — under
    jsdom every `offsetTop` is 0, so `columnCount` returns 1 and every card stays reachable.
  - **Selection is resolved against every asset the dialog has shown**, not the page on screen.
  - **The picker honours a `media` field's `accept` list**; `mediaMatchesAccept` is shared by the client
    filter and the SQL one, so the first page cannot offer what a search would hide.
  - **`/api/taproot/media/file/[...key]` serves R2 objects** and is what `publicBaseUrl` defaults to;
    `TAPROOT_MEDIA_URL` still wins. Content type comes from the `media` row rather than the key, because
    the key derives from a user-chosen name and `image/svg+xml` here is same-origin script; `nosniff` and a
    sandbox CSP back it up.
  - **Upload-in-place asks for alt text**, the moment somebody knows what the image is for.
  - **One POST carries several files** — `MAX_UPLOAD_FILES` 10, `MAX_BATCH_BYTES` 60 MB, deliberately *not*
    count × per-file; N client-side POSTs would fork the no-JS path permanently. **The two batch caps
    refuse the whole request; a per-file failure does not**, because a cap describes the request while a
    browser cannot reselect a partial file list. **A multi-file batch is written with `alt_text: null`**
    whatever the request carried, so the library form has no alt box and the question moves to
    `/admin/media/describe?ids=` — the batch just written, because re-querying opens a grid of strangers.
    There, **blank means `null` and only the Decorative checkbox writes `''`** (and **a typed description
    beats a leftover tick**), and **a row whose field is absent is skipped, not nulled**, distinguished by
    `form.has` before `formValue` can collapse them.
  - **`MediaFilters.undescribed` is the shared predicate the report reads too**: `alt_text is null` **and
    not** `= ''`, narrowed to `image/`. In `applyMediaFilters` because two screens ask it, and a grid
    disagreeing with the number that sent somebody to it is the faceted-count bug one feature along.
- **A media field's stored shape follows its own config** — an array when it allows several files, a bare
  id when it does not. `MediaField` works in ordered arrays either way and `FieldControl` converts.

### Rich text editing

- **TipTap 3 does not re-render on transactions, so anything read from the editor in a render body is
  frozen.** `editor.isActive(…)` straight in JSX was evaluated once: the H2 button stayed lit wherever the
  caret went and Unlink was offered on plain text. Nothing errors — the toolbar just stops telling the truth.
  `useEditorState` with a **flat, primitive-only** selector is the fix; anything nested defeats its equality
  check and re-renders on every keystroke anyway.
- **`rel` is author-controllable but only from a fixed set, and `noopener noreferrer` cannot be removed.** A
  `target="_blank"` link always gets the protective pair added last, whatever the author sent — that is what
  makes "open in a new tab" and "nofollow" safe to expose as checkboxes.
- **Every path that applies a link has to handle a collapsed caret.** `setLink` marks the *selection*; with
  nothing selected it succeeds and produces nothing visible. Typing an address, choosing a page and choosing
  a file all route through one function that branches on `selection.empty`.
- **Three things break a link the editor appears to create, and none raise an error.** TipTap validates
  hrefs against `Link.configure({ protocols })`, so `taproot` has to be on that list — with `optionalSlashes`,
  since a reference has no `//` — or the mark is dropped between the click and the document; `insertContent`
  with an HTML string escapes it, so insert a text node carrying a `link` mark instead; and `HTMLAttributes`
  **merges** with TipTap's defaults rather than replacing them, whose default includes `target: '_blank'`, so
  `target: null` is load-bearing.
- **Every link goes through `LinkDialog`, and the range is captured when it opens.** The editor column is
  ~400px with the preview pane open and an inline form will never fit across it — and it could not say where
  an existing link *pointed*, since `taproot:item:{uuid}` is correct and unreadable.
  - **A modal takes focus, and the browser's selection goes with it**, so `savedRange` is captured in
    `openLinkDialog` and every apply path works from it. What has *not* changed is that the act belongs on
    `click`: Enter and Space raise one with no `mousedown` before it.
  - **`closeLinkDialog` clears the range, and that is what keeps one `removeLink` honest** — a range left
    behind makes the toolbar button act on a position from the last time the dialog was open.
  - **Radix portals to `document.body`, but React propagates events through the React tree.** The dialog's
    `<form>` is directly beneath the item editor in React, so Apply submitted *both*: the page saved,
    redirected, and the link never landed. `stopPropagation` in the submit handler is the fix;
    `MediaPicker`'s upload form had the same latent bug.
  - **The mode selector is a radio group drawn as tabs**, because hand-built tabs mean a roving tabindex and
    the tab/panel wiring written by hand and kept written.
- **There is one link button in the toolbar, not a separate one for files** — two icons for one dialog is two
  things to learn and one of them redundant. `openLinkDialog` derives the panel from the href; `LinkDialog`
  keeps `initialMode` because it still decides which panel opens.
- **The richtext toolbar's roving tabindex is derived, never counted by hand.** The unlink button only exists
  while the cursor is in a link, so every index after it moves; a button missing from `buttonCount` was
  reachable by mouse and by nothing else.

## Definition of done for a phase

From SCOPE.md, a standing requirement rather than cleanup:

1. `npm run dev` works end to end from a fresh clone with only `npm install`, a copied `.env`, and
   `npm run db:seed`. If a phase adds a required env var or service dependency, fixing the zero-setup story
   is part of *that* phase.
2. Seed data is realistic enough to see the feature working, and reseeding stays idempotent.
3. `npm test`, `npm run typecheck`, and `npm run a11y` all pass.
4. [DEPLOYMENT.md](DEPLOYMENT.md) is still accurate.
5. [README.md](README.md)'s status and "what's next" reflect reality.
