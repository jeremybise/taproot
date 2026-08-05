# CLAUDE.md

Guidance for Claude Code working in this repository.

## What Taproot is

A DB-backed, Astro-native CMS for a campus website with many non-technical departmental
contributors. [SCOPE.md](SCOPE.md) is the authoritative plan — read the relevant phase section
before starting work on it. Decisions recorded there are settled; don't relitigate them.

**Phase status lives in [SCOPE.md](SCOPE.md) and [README.md](README.md)** — each phase there is
marked complete or not. Two things about it are not recorded in either and are worth knowing here:

- **Phase 3 was smaller than SCOPE.md used to describe.** Departments are classification, which the
  Phase 1 taxonomy already provides, so there is no departments entity and no department-scoped
  role. Roles are flat and site-wide.
- **The Phase 4 content accessibility checker is not `npm run a11y`.** The checker is advisory and
  looks at what an editor writes (alt text, heading order, link text); `npm run a11y` checks the
  WCAG compliance of the admin itself. An editor can write an inaccessible page in a perfectly
  accessible editor, and the two have never been the same job.

The equivalence tests in `delivery.test.ts` compare the delivery layer against the *methods* the
embedded route used (`getItemByPath`, `getChildren`, `ancestorPaths`, `resolveSeo`, `resolveMenu`)
rather than against a second implementation, which is why they survived the embedded path being
deleted. They are the closest thing to a spec for the delivery contract — do not remove them without
replacing what they prove.

**[apps/docs](apps/docs) is the handbook** — Astro + Starlight, `npm run docs`, port 4322. It is
end-user documentation (editors, site admins, operators), not developer docs, and it is a separate
app so the demo site stays a demo. It declares **no `sharp`** and configures the passthrough image
service, because the default image service is a native dependency; `sharp` still arrives
transitively through Astro and wrangler, which is not something this repo controls, but nothing here
declares it.

## Commands

`package.json`'s scripts are the reference, and its `//`-prefixed keys carry the rationale — `//dev`
for the two dev servers and their ports, `//typecheck` for why it is per-workspace, `//docs` for the
handbook. Two things those do not say: `npm run a11y` needs `npm run dev` already running, and
`npm run preview` builds and serves through `wrangler dev`, the real Workers runtime.

First run on a fresh clone:
`npm install && cp .env.example apps/studio/.env && cp apps/web/.env.example apps/web/.env && npm run db:seed`.
Sign in at `localhost:4321/admin` with **admin@example.com** / **taproot**; the site is on :4323.

The seed creates a **fixed development API key** that `apps/web/.env.example` already carries, so the
consumer works from a fresh clone. Same status as the seeded password: development data, public
knowledge, and never created by anything but the seed — a real deployment makes its own under
Settings → API keys, where the token is random and shown once.

## Admin information architecture

**Each content type is its own sidebar destination**, not a filter on one shared list — editors
think of Pages and Events as different places. `/admin/content/type/{api_id}` rather than
`/admin/content/{api_id}`, because `/admin/content/{id}` already means a content item and one
segment cannot mean both. `/admin/content` survives as "All content" for searching across types.

Singletons get `/admin/singleton/{api_id}`, which resolves to the one item's editor, or to the form
that creates it. The indirection buys a stable sidebar URL that cannot break if the item is deleted.
It **does not write the row itself** — it used to call `createItem` with no `data`, which validates
only when every field is optional, so one required field made a singleton's own sidebar link 500
from a screen with no form on it. Same rule a reusable block follows: a row is only ever written
validated, and there is no "empty entry, fill it in later" path.

Sidebar order comes from `content_types.position`, reorderable in Settings. Settings is a hub over
Content types, Redirects, Users & access, and System — configuration that shapes the site rather
than its content.

Content lists share three pieces of presentation, each in one place so the screens cannot drift:
[status.ts](packages/studio/src/admin/status.ts) (labels, badge classes, which statuses the editor
offers), [StatusBadge.astro](packages/studio/src/admin/components/StatusBadge.astro), and
[Timestamp.astro](packages/studio/src/admin/components/Timestamp.astro). **Status colour is always
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

`packages/core` is the data layer, auth, content services and storage, with no framework;
`packages/studio` is the SERVER (admin panel, REST API, delivery API); `packages/astro` is the
CLIENT a site installs; `packages/create-taproot` is the scaffolder. `apps/studio` is the CMS
deployment that owns the database and runs the scheduler, `apps/web` the reference consumer, and
`apps/docs` the handbook.

**`create-taproot` scaffolds the server and only the server** — a website is a separate project that
installs `@taprootcms/astro`. See [packages/create-taproot/CLAUDE.md](packages/create-taproot/CLAUDE.md)
for the rules that govern it.

**The names are the architecture.** `@taprootcms/astro` is what a *site* installs, matching Wolly's
`@wollycms/astro`; the server is `@taprootcms/studio` and a site never installs it. Having those the
wrong way round was the Phase 0 misreading, and the 3.75b rename is what corrected it. The npm scope,
the unscoped scaffolder name, the shared version, and each package's `files` allowlist are covered by
the `releasing` skill — invoke it before publishing or renaming anything.

Routes are not files-on-disk in apps/studio — `@taprootcms/studio`'s integration entry
([index.ts](packages/studio/src/index.ts)) injects every admin and API route via `injectRoute`.
**Adding a screen or endpoint means adding it to the route table there**, not just creating the
file.

**The consumer must never pull the data layer into its bundle.** `@taprootcms/astro` imports
`@taprootcms/core/pure` at runtime — which compiles to a re-export of the crop arithmetic and nothing
else — and everything else as `import type`, erased at build. Importing core's main entry would drag
Kysely and the dialect loaders into a site that cannot use them. The check is concrete: the built
consumer is ~460K against the studio's 12M, and contains no `kysely`. Nothing with a `Kysely` import
may be added to `pure.ts`.

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
  locked-out attacker still costs 100,000 PBKDF2 iterations per request. The IP comes from
  `CF-Connecting-IP` only — `X-Forwarded-For` is client-settable, so trusting it would let an
  attacker reset their own counter and lock out an address they do not own.
- **Nobody sets somebody else's password.** An admin mints a single-use, hashed-at-rest,
  48-hour link and hands it over. The raw token exists only in that link and is returned through a
  short-lived cookie rather than a query string, because a URL lands in history, `Referer`, and
  access logs. Self-service reset now uses the same table and semantics with a null `created_by` —
  as predicted, it needed a sender and not a reshaping. Its emailed link *does* carry the token in
  the URL, which is not a contradiction: the cookie protects the **admin's** browser from holding a
  colleague's credential, and there is no way to put a link in an inbox other than as a link.
- **The first-run setup screen is the only unauthenticated write in the admin.** `createFirstAdmin`
  does its check and its insert in **one statement** (`INSERT ... SELECT ... WHERE NOT EXISTS`); a
  `count()` then `insert()` is a race, and the losing request must be told it lost rather than
  retried. **The password is hashed before that write, and the credential rides in the same atomic
  batch.** Hashing afterwards is what turned a runtime refusing the iteration count into an
  unrecoverable install: the user row landed, `setPassword` threw, and the deployment held an
  administrator with no credential — login cannot verify a password that was never stored, and the
  setup screen refuses to help because a user now exists. There is no screen that repairs that, so
  the rule is the same one `assertNotLastAdmin` protects: never leave a deployment in a state its
  own UI cannot reach. `firstAdmin.test.ts` mocks a failing hash and asserts nothing is written.
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

**An API key is a principal, not a user, and the two must never merge.** `Principal` in `guards.ts`
is `{ kind: 'user' }` or `{ kind: 'api_key' }`. A key has scopes and no role; `hasScope` is false
for a user principal *deliberately* — scopes narrow what a machine may do, so a route gated on one
is meant for machines, and an admin reaching it should be refused rather than quietly succeeding
through a path nobody tested. Things that follow:
- **The role guards still take `User | undefined`, and that is the design.** Making all of them take
  a principal means every guard grows a branch that only ever says "not this kind of thing", and
  forty admin call sites carry a wrapper they never inspect. Converting at the boundary gets the
  guarantee from the type system instead: `principalUser` returns `undefined` for a key, and there
  is no value of type `User` a key can produce.
- **`handle()` is session-only; `handleScoped()` is the opt-in.** A route that says nothing about
  keys does not accept one. That default is what keeps a `content:read` key out of the admin REST
  API — `handle` requires `taproot.user`, which is undefined for a key.
- **The middleware resolves a session first and never both.** A browser hitting an API route while
  signed in is a person, and letting the key win would credit a machine in the audit log.
- **`id` is the SHA-256 of the token**, as with sessions and reset links, so verification is one
  indexed lookup and a database dump holds nothing usable. The raw value exists once, returned
  through a short-lived cookie rather than a query string. Keys are **revoked, never deleted** —
  audit entries name them by id.

**Caching is opt-in, and a response that says nothing gets `private, no-store`.**
`applyDefaultCacheControl` in [responseCache.ts](packages/studio/src/runtime/responseCache.ts) is the
one place that holds, called from the middleware before anything else touches the response. The
inverse — silence meaning "do what you like" — is how a signed-in admin's HTML ended up in
Cloudflare's shared cache and was served to anonymous requests: measured as `CF-Cache-Status: HIT`,
`Age: 437`, on a request carrying no cookie, returning item titles, paths and ids. **The origin was
never wrong** and still 302s an unauthenticated request to the login screen; the edge was answering
before the origin was consulted, which is why every auth test passed throughout. Four things follow:
- **No admin screen may be made cacheable**, and the check is `has('cache-control')`, so a route that
  genuinely is cacheable — the delivery API, `media/file/[...key]`'s `immutable` — keeps its own
  header untouched. Setting one on an admin page is how this comes back.
- **The stamp goes on before the refreshed session cookie is appended.** A `set-cookie` on a response
  a shared cache will store is not a content leak but an account handover, and ordering is the only
  thing that rules it out.
- **It returns a response rather than mutating one.** `Response.redirect()` builds immutable headers
  and `set` throws `TypeError: immutable` on them, which is why the rebuild exists — and why the
  `append` for the session cookie was latently unsafe on a redirect before this.
- **`vary` does not save you.** Cloudflare's cache honours `Vary` only for `Accept-Encoding`, so
  `vary: authorization` on a `public` response is documentation, not a cache key. Delivery survives
  that because published content is the same for every key, not because the header worked.

**A cache header does nothing on Cloudflare until the Worker opts in, and the ETag must be answered
before the page is resolved.** Both halves shipped wrong for a phase and both looked right.
`cache-control: public, max-age=0, s-maxage=60` had been on every delivery response and every
rendered page since the split, and **Cloudflare caches neither HTML nor JSON by default** — the
default cache is keyed on file extension, and a Worker's own response is never stored unless
`"cache": { "enabled": true }` is in its `wrangler.jsonc`. Separately, `notModified` sat at the
*bottom* of `resolve.ts`, after `resolveDelivery` had run every query, so a 304 cost exactly what a
200 did — it saved a payload, and payload egress is the part Cloudflare does not bill, while D1 bills
rows read. `getItemVersionByPath` answers the validator from one indexed lookup instead, and it
shares `visibleToPublic` with `getItemByPath` deliberately: a validator computed under a different
visibility rule than the payload would 304 against a version a visitor may not see. Four things
follow:
- **Tags travel in the payload as well as the header.** Two caches need them — the studio tags its
  cached JSON, and a consumer tags the HTML it renders from that JSON and *cannot derive the
  dependencies itself*: it has no way to know a breadcrumb came from an ancestor row, that a listing
  depends on a `type:` rather than the items it matched, or that a block was filled in from the
  library. `cacheTags.ts` lives where `pure.ts` can re-export it so both sides spell a tag the same
  way; a mismatch makes the purge succeed, report success, and clear nothing.
- **`type:` is the tag listings need and the one easy to omit.** Publishing a seventh event must
  purge the page showing "the six soonest", and that page's cached copy names the six that did *not*
  include it. Recorded even when a query matched nothing, because an empty listing is the case most
  needing it.
- **Purge runs in the middleware, after the response.** Same ordering rule `batchWrite` enforces for
  reads: purging inside a write path clears the cache while the old row is still committed, so a
  request arriving in between repopulates it with exactly what the purge was for. It also never
  throws, for `recordAuditEntry`'s reason — the write already happened and was already reported
  successful.
- **Do not build an ETag-keyed response cache in `@taprootcms/astro`.** The validator cannot see a
  reusable block edited in the library, so the tag keeps matching and a client-side body would go
  stale with *no bound at all*; `s-maxage` is what bounds that today. The client deduplicates
  concurrent requests for one resource and stops there, and `verifyApiKey` is likewise not memoised —
  it would delay revocation to save one indexed row read.

**Query plans are asserted, not assumed — `npm run query-count` and `queryPlans.test.ts` are why.**
Nothing in the suite counted round trips, so an `await` inside a loop or an unconditional lookup
passed every test, typecheck and build. Two real costs were found only by measuring: the five-minute
sweep ran **two full table scans** on unindexed columns forever, and `blockTypeRegistry` scanned
`content_types` on **every page view** including pages with no blocks. The sharpest lesson is in
`0020_perf_indexes`: indexing *both* sides of `purgeStaleResetTokens`' `or` changed the plan by
nothing at all — SQLite's OR-to-union optimisation does not fire for that delete — so the statement
had to be **split in two** to spend the indexes. Measured with `explain query plan` at 0 and 20,000
rows. An index that looks correct and a migration that runs clean are not evidence the scan is gone.

**The delivery API is the read contract, and it must answer a page in one round trip.**
`resolveDelivery` in `content/delivery.ts` returns the item, its type and fields, breadcrumbs (one
`in` query, not one per ancestor), visible children, blocks already dereferenced, resolved SEO, and
lookup maps for media, relations, and terms. It lives in core, not the route, for the same reason
`resolveSeo` does — the studio's own reads and the delivery API must not drift. Two rules:
- **References are lookup maps, never inlined into `data`.** Inlining would break the match between
  `data` and the field types the CMS validates against (and therefore the generated types),
  serialise a twice-used image twice, and make the payload unusable for a write.
- **A redirect is a 200 carrying `{ kind: 'redirect' }`, not a 30x.** The consumer must redirect its
  *own* visitor; a real 30x would redirect the server-side fetch and serve the wrong page's content
  under the requested URL.

**A listing and a `query` field's results are one shape, and `resultFields` is what keeps them one.**
`/delivery/items?include=data` answers `DeliveryListItem` — a `DeliveryItemRef` plus `slug` and the
two timestamps — so a consumer's card component is written once and rendered from either. That
promise holds only while both go through the same filter, which is why `resultFields`/`resultData`
are exported from `itemQueries.ts` rather than each caller writing `!== 'block'`.
`deliveryList.test.ts` asserts it by building both answers for one item and comparing them, not by
checking each against a list of expected keys — a list passes while the two drift. Five things
follow:
- **Summaries stay the default.** The opt-in is the whole design: a menu picker asking for two
  hundred candidates by title must not start paying for two hundred page bodies, and the doc comment
  on `listItemSummaries` is right. `include` is a comma list and an unknown entry is a **400**,
  because silently ignoring one is how somebody ships `include=fields` and concludes the feature does
  not work.
- **The maps are absent, not empty, without `data`.** There is nothing to look up in — a summary
  carries no ids — and `{}` would read as "asked, and this site has no media".
- **The cost is per page, not per item.** Every listed item's media, relation and term ids are
  collected across the whole page and loaded in one query each, and the content types once per
  *distinct* type. A listing narrowed to one type — which is what a directory is — loads exactly one.
- **A listed item's richtext is resolved.** `resolveDelivery` had only ever resolved the *host*
  item's, so a query result's prose still carried `taproot:item:{id}`; both go through
  `resolveRichTextData` now, because a marker in a card's summary field is exactly where nobody
  would notice it.
- **An unrecognised `sort` is refused rather than defaulted**, on `/items` and `/search` alike. The
  fallbacks elsewhere in Taproot — a query whose `dateFieldApiId` no longer names a date field — are
  for *stored rules that outlive what they name*, where a live page must not break for a
  configuration mistake made weeks earlier. A request parameter is a developer's typo, and a silent
  fallback is a sort that looks implemented and never was. `sort` was read by nothing at all before
  this, which is how it stayed unnoticed.

**A facet's counts have to describe the rows clicking it returns.** `deliverTaxonomyTerms` answers
`/delivery/taxonomy/{apiId}/terms` — the question nothing else could, which is *what departments
exist*, and without which a filter UI hard-codes the list and goes stale the moment an editor adds
one. Four things hold it up:
- **`itemCount` is branch-wide and de-duplicated.** A term filter means the whole branch everywhere
  else, so a count meaning "filed directly here" would label a checkbox with a number the grid then
  disagrees with. Summing children into parents is the obvious implementation and reports an item
  filed under both a parent and its child twice — which is exactly what a cross-appointment is, so
  it is wrong on the entries most likely to be looked at. The union is over item ids.
- **It takes the same `type` narrowing the listing does.** "Biology (12)" beside a grid of people
  showing one is the facet lying about its own filter.
- **Counts are opt-in**, because they are a second query over every visible assignment in the
  taxonomy, and a `<select>` that only needs names should not pay for it. `counts=0` reading as true
  is the classic version of that bug and is checked for.
- **Terms come back flat with `parentId`, depth-first.** Flat is what both renderings want: a
  `<select>` reads it in order and a checkbox tree nests it, where a nested answer makes the first
  one flatten somebody else's shape. An unknown taxonomy is a **404** rather than an empty list,
  since "no terms yet" is an ordinary state that would hide a misspelled `api_id` forever.

**A uuid a consumer cannot resolve is a dead end, and the schema is where that is fixed.** A
`taxonomy` field's `config` names its vocabulary by `taxonomyId` and a `relation`'s names its target
by `targetContentTypeId`, so a site reading the content model held ids with nothing on its side of
the wire to match them against — found by pointing the new terms endpoint at a real deployment and
getting a 404 for every name worth guessing. `DeliverySchema` now carries `taxonomies` and every
`DeliveryTypeSchema` carries `id`. Resolved **there and not into each field's config**, because
`toDeliveryField` also builds the `fields` array on every `resolve`: enriching it would put a
taxonomy lookup on the hot path of every page view to answer a question only a schema reader asks.
`deliverTaxonomyTerms` separately accepts an `api_id` **or** an id, the same way `?term=` accepts a
slug or an id — a slug and a uuid cannot be mistaken for each other.

**Several `term` parameters mean OR, and each is still its whole branch.** `ItemFilters.termIds` has
always been a list with those semantics; the route was narrowing it to one. The single-term `term`
echo in the response is unchanged and stays singular — it exists so a term *archive* can render the
editor's own capitalisation in its heading, and a multi-select facet already holds the names because
it got them from the terms endpoint. Two spellings of one fact is what that avoids.

**`resolveMenu`'s `termHref` callback cannot cross HTTP, and the answer is unresolved targets.**
`deliverMenu` returns `{ type: 'term', taxonomyApiId, slug, name }` and the consumer applies
`applyTermHrefs` with exactly the resolver it would have passed. The alternative — a server-side
setting for which taxonomies get pages — was rejected because which ones deserve URLs depends on the
routes a site serves, and moving it here would make Taproot assert something it cannot know. This is
the question SCOPE flagged to decide rather than discover; it is decided.

**Generated types are a `.d.ts` and carry no runtime.** `typegen.ts` emits types only — a `.d.ts`
may declare but not implement, so a generated helper function in one is a syntax error rather than a
convenience. A repeater's sub-fields are read in the stored `FieldRow` shape (`api_id`), never the
delivery shape: reading them as `DeliveryField` silently emitted properties literally named
`undefined`, which type-checks and is nonsense. **A repeater row is emitted as its envelope,
`{ id, data: { …sub-fields } }`, not as the sub-fields flat** — that is what `buildValueSchema`
validates and what `resolveDelivery` sends, and emitting the inside of it let a consumer write
`row.headline` against a payload carrying only `row.data.headline`: it compiled, rendered nothing,
and errored nowhere. The rule generalises past this one case — **a generated type must describe the
payload Taproot actually sends**, which is why `media` and `relation` emit ids rather than resolved
objects and why `block` keeps its own envelope. Flattening *delivery* to match was the other way to
close the gap and is the wrong one: `data` has to keep the stored shape so the payload stays usable
for a write. Note the older test asserted only that the sub-field names appeared, which they do
either way — that is why this survived.

**A `query` field stores the rule and never the answer, and the answer has nowhere to live in
`data`.** `resolveItemQueries` runs the rules on every read, so "the six soonest Arts events" changes
when somebody publishes a seventh without anyone editing the page the listing sits on. Five things
hold it up:
- **Results land in a fourth top-level map, `queries`, not in `data[apiId]`.** That slot holds the
  saved rule and has to keep the stored shape — the payload stays usable for a write and the
  generated types keep describing what is sent. Overwriting it is worse than the rich-text
  exception: a rule replaced by its results does not round-trip at all.
- **The key is `${containerId}:${fieldApiId}`**, because a query field can sit on a block type and
  the same block placed twice on one page is two rules with two answers. Keyed by the field alone
  the second placement silently renders the first one's results — `itemQueries.test.ts` is the
  proof, and `queryKey` lives in its own module so `pure.ts` can re-export it to a consumer that
  must never see Kysely.
- **Queries run *after* `resolveItemBlocks` and *before* `collectReferences`.** After, so a query
  inside a reusable block is found at all; before, so each matched item's own media and term ids
  reach `collected` and ride the loaders that were going to run anyway. Cost is O(query fields), not
  O(results): one list query per field plus one memoised `getContentType` per distinct target type.
- **A result carries the item's whole `data` minus `block` and `query` fields.** Not a configurable
  subset — if an editor chose the fields, a template would render nothing the day somebody unticked
  "location". Excluding `query` is the recursion bound, and a sharper one than a depth counter: two
  types listing each other cannot fan out. Results merge into `references` *after* `loadItemRefs`,
  because an item that is both a relation target and a match must keep the entry carrying `data`.
- **A listing never shows a draft, even under a preview token**, where the rest of a preview
  deliberately does. A listing is a claim about what the page will look like once live, so including
  drafts would let an editor tune it to six results and watch four vanish at publish.

**Filtering or ordering by a value inside `data` goes through `content_item_values`, a derived index
rebuilt in the item's write batch.** `data` is TEXT holding JSON, so "events whose `starts_at` is
upcoming, soonest first" has no other SQL path — the only reads into `data` anywhere else are `LIKE`
prefilters verified afterwards in JS. Same status and same rules as `taxonomy_assignments`: not the
source of truth, rebuilt from `data`, so a restored revision restores it. Six things to know:
- **`json_extract` was the alternative and is worse.** It needs different syntax per dialect —
  the first dialect-branched query building in the repo — and is an unindexed scan unless an
  expression index exists per content type per field.
- **Three value columns, not one.** `'10' < '9'` is true as text, so a numeric ordering stored as
  text is wrong in a way that looks plausible. `indexedValueKind` picks the column from the field
  type; a caller guessing gets it silently wrong.
- **Dates are normalised through `Date` before storing.** A `date` field with `includeTime` off
  stores `2030-05-01`, which as raw text sorts *before* `2030-05-01T09:00:00Z` — dropping an
  all-day event out of a window it belongs in.
- **Nothing about status is denormalised in.** A listing joins back and applies `visibleToPublic`,
  or a scheduled item would go live only when something happened to reindex it.
- **The planner is not called on the cascading path-move path.** Descendants' `data` did not
  change, and that batch already carries a statement per descendant.
- **`npm run db:reindex` is a required step after migrations `0019` and `0021`, not a nicety.** Each
  table is created empty and a migration cannot fill it — that needs field definitions and a walk
  over stored JSON. Until it runs, every query field filtering or ordering by a value answers as
  though nothing matched, and search finds an item by its title and by nothing else.
  `reindexDerived` goes through `handle.batch` per item so an item is never left with its old rows
  deleted and its new ones unwritten.

**Search is a second derived table behind the same planner, and `planDerivedIndexes` is the only
entry a call site names.** `content_item_text` holds one row per item carrying its prose flattened
with `htmlToText`; `ItemFilters.search` matches it with the repo's lowercased `LIKE` beside title
and path. Not FTS5 or `tsvector` — one migration set has to run unbranched on all three dialects,
and a second index implementation is a search that answers differently depending on where it is
deployed. Seven things hold it up:
- **The table materialises the text; it does not make it indexed.** `like '%needle%'` is a scan on
  every dialect, so an index on `text` would be paid for on every write and spent on nothing. What
  it buys is that the scan reads one flattened column instead of parsing every item's JSON, and that
  the walk happens once per save rather than once per query.
- **One predicate, not one per caller.** The clause lives in `applyItemFilters` — shared byte for
  byte with the status facets — so the admin's cross-type search, `delivery/items?q=`, and
  `delivery/search` narrow identically. A second query for the consumer is a search that finds a
  page the CMS cannot, discoverable from neither screen.
- **The walk recurses where the value walk does not.** Prose sits inside blocks (bounded by
  `MAX_BLOCK_DEPTH`) and repeater rows, so a top-level-only walk misses most of a composed homepage
  while looking correct on a simple one. Only `text` and `richtext` contribute: a `select` stores an
  option value an editor never sees, and `media`/`relation`/`link`/`taxonomy` store ids.
- **The block registry has to be loaded on the save that changes nothing.** `updateItem` rebuilds
  from stored `data` on every save, and the registry was fetched only on the branch validating new
  content — so a publish walked the blocks with no schemas and wrote an index missing every block's
  prose. Loaded once per write and gated on *placed* blocks, the same data-driven gate
  `resolveDelivery` uses.
- **A reusable block contributes nothing**, and that is a stated limit rather than an oversight: the
  page stores `{ id, type, ref }`, reaching the entry needs a read inside a synchronous planner, and
  the entry's text would have to be rebuilt across every referencing page on each library edit.
- **`relevance` is not in `ITEM_SORTS`.** That set is the query field's sort menu — validated into
  saved queries, rendered in the builder, emitted into the generated types — and offering "most
  relevant" to a listing with no term answers an editor by ignoring them. A search with no named
  order ranks; naming one always wins.
- **The row is written even when an item holds no prose.** An empty string is "indexed, holds
  nothing" and a missing row is "never indexed" — the state a database sits in between the migration
  and the reindex, which otherwise looks exactly like a search that legitimately found less.
  `searchIndexStatus` is what Settings → System reports it from.

**"Upcoming" is stored as an intent and resolved against the clock on every read.** `dateFilter` is
`'any' | 'upcoming' | 'past'`, never a timestamp: a stored bound would be frozen at whatever moment
somebody last pressed save, so a page would quietly stop listing anything the day after it was
edited — the same booby trap a stale `publish_at` is. The *preview* endpoint resolves it the same
way and does its own lookup of the nominated date field rather than trusting the parameter, because
the editor's count and the published page must not diverge exactly when the configuration is wrong.
A `dateFieldApiId` that no longer names a `date` field drops the bound and falls back to `path`
rather than erroring — a query outlives the type it points at, and a live page must not break for a
configuration mistake made weeks earlier on another screen.

**`listItems` sorts by a named set, never a caller-supplied column.** `ITEM_SORTS` lives in its own
importless module because `items.ts` and `validation/fields.ts` already point at each other. A column
name from a caller means the delivery API publishes the schema as its sort vocabulary; a named order
is also free to be a different expression, which `newest` needs — it is
`coalesce(published_at, created_at)`, so an item awaiting its sweep does not sort as though it had no
date, and so NULL ordering cannot differ between SQLite and Postgres. Every order ends with `path` as
a tiebreak, or two items sharing a timestamp swap between pages and one is shown twice. The sort goes
on `listItems` and **not** on `applyItemFilters`, which is typed pre-`select` and shared byte for
byte with the status facets — a facet count has no ordering to pay for.

**A preview token's draft snapshot is a rendering input, not a version.** Phase 4.5's split view
needs the editor's *unsaved* state to reach a consumer that renders server-side, so `preview_tokens`
carries nullable `title`, `slug`, `data`, `seo`, and `draft_updated_at`, and `resolvePreviewToken`
merges them last — live row, then a release's staged version, then the draft, which is the order an
editor experiences and which keeps `releaseId` non-null when both are present. This does **not**
break "a release is the only place a content item can have a version that is not live", and the
distinction is the thing to hold onto: a release row is addressable, editable, and publishable, with
a screen, a pre-flight, and a path into `content_items` via `updateItem`. A snapshot has none of
those, is never listed or diffed, and dies with its token. Three things keep that true:
- **Nothing may ever read a snapshot back into the editor.** The moment something offers "restore
  your unsaved changes", this is a draft store and Content Releases is what it duplicates badly.
  Do not surface its durability either — no "changes preserved" message, no restore prompt.
- `preview.test.ts` asserts a snapshot write leaves `content_items` and `release_items`
  byte-identical. That test is the argument, not decoration.
- The flag column is `draft_updated_at`, not `updated_at`, and the merge asks it rather than
  `data !== null` — "a snapshot exists" is one fact, and deriving it from four nullable columns is
  four chances to disagree.

**`requireComplete: false` relaxes three rules and sanitising is not among them.** The snapshot is
rendered by a consumer with `set:html`, so it is a write path in the sense this file means, and it
goes through `validateItemData` like every other one. The option turns off `required`, a text
field's `minLength`, and a repeater's `minItems` — **a minimum is a claim about completeness and a
maximum is a bound on what the system will carry**, and only the first kind is a question a
half-typed form may fail. It works because both recursions already forward `options` unchanged, so
blocks and repeater rows behave identically for free. The richtext transform sits outside every
`required` branch and runs first, which is the property the whole feature rests on;
`validation/fields.test.ts` asserts it at all three walk sites and asserts the write paths still
refuse an incomplete item. `writePreviewDraft` is the only *external* caller and must stay so —
`validateItemData` now also derives it per field for a conditionally hidden one, which is reuse of
the same three-rule relaxation rather than a second way in.

**A conditionally hidden field is not required, and its value is not dropped.** `visible_when` is a
nullable column on `fields` — not a key in `config`, because a condition means the same thing for
every field type and `config` would carry twelve identical copies; `repeaterSubField` holds the same
key because a sub-field has no row, and block types need nothing because a block type is a content
type. `validation/visibility.ts` is the one evaluator, called by `validateItemData` **and** by the
three editor render sites, for the reason `resolveSeo` lives in core: two implementations disagreeing
here is a field an editor cannot see and cannot save without. Four things hold it up:
- **The condition is evaluated against the raw `input`, never the accumulating `parsed`.** The loop
  fills `parsed` in field order, so a controlling checkbox positioned *after* its dependent is not
  there yet — the dependent would come out hidden, stop being required, and the rule would silently
  depend on the order somebody dragged the fields into. Proven by mutation: flipping it to `parsed`
  fails exactly one test.
- **A hidden field's value is kept.** Dropping it makes `validateItemData` a destructive transform
  driven by a rule an admin edits on a different screen — adding a condition would wipe that field
  across every item on its next save, with no revision showing an author doing it. Keeping it is
  also why unticking and reticking a box brings the text back.
- **A dangling condition fails open.** `evaluateVisibility` takes the sibling `api_id`s from the
  *schema* precisely so a condition naming a deleted or renamed field renders the dependent visible.
  Failing closed makes an input permanently unreachable with nothing able to explain why. Absent
  *data* on a field that exists is a different thing and evaluates normally — a checkbox nobody
  ticked is unticked, not unknown.
- **"Sibling" is always the same level**, and it costs nothing to enforce because every walk already
  has exactly that in hand: `validateBlocks` recurses with the block's own fields and data,
  `validateRepeater` with the row's. So one repeater row can hide what another shows. A condition
  reaching across levels would have to name a path, which is a different feature.

Two consequences elsewhere. `typegen` emits a conditional field **optional whatever `required`
says**, because "required" on one means "required when shown" and a non-optional emit would be the
CMS promising something it does not enforce. And the editor filters hidden fields in the *parent*
rather than passing siblings into `FieldControl` — which keeps `FieldControl` a component that
renders one field and knows nothing about its neighbours, and means a hidden richtext editor is
never mounted and torn down as somebody ticks a box.

**A preview token is a capability over one item, and `delivery/resolve.ts` enforces it by path.**
The preview branch used to ignore `path` entirely and answer with the token's item whatever was
asked for — invisible while the only caller was a 302 straight to `item.path`, and a real bug the
moment a frame can follow a link or an editor can type an address: every page on the site would
render as the item being edited. It also stops a token being a site-wide key to unpublished content.
A token-bearing URL is answered `no-store` even when it falls through to published content, because
the URL is a cache key carrying a credential.

**"Can this be previewed" is `previewPathFor`, not a question about `kind`.** The pane, both mint
endpoints, and the editor's path link all ask it, and it answers `item.path` for a page or
collection and `content_types.preview_path` for a singleton. `kindHasPublicPath` used to stand in
for it and refused every singleton — right about `/__singleton/{api_id}` being a URL nobody
requests, wrong about singletons, since a homepage assembled from blocks is one and is often the
page a site cares most about. Three things hold it up:
- **Null is the default and means no preview.** A settings singleton holding an address and social
  links has no page, and a preview framing the front page while claiming to be that record is the
  same failure `resolveSeo` living in core exists to prevent, one level up.
- **Nothing about delivery moved.** The consumer still asks `resolve` for `/__singleton/{api_id}`,
  which is what the token is a capability over, so the path check below still matches. The column
  says only which address the *admin* opens. Making it a delivery route would be Taproot asserting
  how a site routes, which is what the `termHref` callback exists to avoid.
- **The column is nulled for every kind that is not a singleton**, in both write paths, exactly as
  `url_prefix` is nulled for everything that is not a collection — so changing a type's kind cannot
  strand a path nothing reads, and `previewPathFor` never consults it for a page.

**The editor's path is a link only when it goes somewhere.** It was a bare relative `<a href>` on
`item.path`, which resolves against the **CMS's** origin — the deployment that serves the admin and
the API and deliberately has no public catch-all — so every one of those links landed on a 404 on
the wrong host and read as a broken site rather than a broken link. It now needs both halves, an
address (`previewPathFor`) and a `TAPROOT_SITE_URL` to put it on, and renders the path as plain
`<code>` otherwise: knowing the URL an item *will* have is useful before a site exists, it is just
not somewhere to click.

**The preview pane goes after `<form>` in the DOM, and that is not a layout preference.** An
`<iframe>` puts everything inside it into the sequential tab order and **no attribute takes it back
out** — `tabindex="-1"` removes the element, not its contents. With the pane between the fields and
the sidebar, tabbing out of the Title input lands an editor in the previewed site's navigation. Last
in the DOM, placed right by the grid, is the only arrangement where "edit, then look" is also the
focus order. Related: the frame is sandboxed **without** `allow-top-navigation`, so a stray
`target="_top"` in the site's own markup cannot throw somebody out of an unsaved form; and it is
remounted by React `key` rather than by assigning `.src`, which pushes a session history entry and
turns the admin's Back button into a walk through preview reloads.

**The width rule for the open pane is deliberately unlayered — do not move it into `@layer base`.**
`#main` carries Tailwind's `max-w-5xl`, a `utilities` class, and **cascade layers beat specificity
outright**: Tailwind's order is `theme, base, components, utilities`, so a `base` rule loses to that
utility however specific it is. It sat in `base` for exactly one commit and did nothing — the
attribute was on `<html>`, the selector matched, and the width never changed. The lesson generalises:
verifying that an attribute is in the HTML is not verifying that it had an effect. Measure the
computed value.

**The pane's open state is `data-preview` on `<html>`, with one writer.** The cookie is read on the
server so the width is right in the first HTML the browser parses, exactly like `data-theme`. The
eye icon in the editor's sticky bar writes the attribute and the cookie; `ItemEditor` *observes* the
attribute with a `MutationObserver` rather than holding a second copy. That toggle is one of the few
places in the admin that changes state **without a round trip**, and the reason is specific: it sits
above a form that may hold an hour of unsaved writing, so the `ThemeSwitcher` pattern of posting and
redirecting would discard it. A `?split=1` parameter has the same problem plus three redirect targets
in `save()` to thread it through.

**`@taprootcms/astro`'s `<TaprootPreviewBridge />` is optional by design**: a site that already
forwards the token gets a working pane, and the bridge only upgrades a frame remount to a reload
from inside, which is what keeps scroll position. Requiring it would make the first run a setup
error. The shared `PREVIEW_MESSAGE` vocabulary lives in `pure.ts` for the same reason
`PREVIEW_PARAM` does — a mismatched name fails silently in one direction.

**Revision history, incoming references, and the danger zone live in sheets, and the sheet is a
native `<dialog>`.** Not a React dialog, and the reason is what is inside them: three server-rendered
Astro components whose contents are links, tables, and real form POSTs. `RevisionHistory` says in its
own comment why it is not an island — a restore that is a real form submission works before
hydration and needs no hand-built focus management — and wrapping it in React would have meant
re-implementing all three in TSX or portalling server HTML into a client tree. `showModal()` supplies
the focus trap, Escape, the inert background, and top-layer stacking from the platform. Two things
follow:
- **`scripts/a11y-audit.mjs` opens every `dialog.taproot-sheet` before running axe.** A closed
  `<dialog>` is `display: none`, so axe skips its contents — three panels that were audited on every
  run while they sat inline would silently stop being checked and the run would still report zero.
  Measured: 2 rules evaluated inside the history sheet closed, 21 open. It sets the `open` attribute
  rather than calling `showModal()`, which would make the rest of the page inert and hide it from
  the same run.
- **Delete is separated from the other icons rather than a fourth peer.** Its old placement at the
  bottom of the page was a speed bump by design, and an equal icon beside two harmless ones makes
  destruction the most discoverable action on the screen. The typed confirmation is still checked on
  the server, so nothing here is load-bearing for safety — this is about not inviting the click.

**There is one preview control, not two.** The header's old "Preview page" link opened the site in a
new tab against the *saved* row; the pane offers the same thing from its toolbar with the unsaved
draft applied. Two buttons with nearly the same name doing nearly the same thing is how somebody
learns to trust neither. The pane's **"Back to editing"** is not a second one and must not be
removed by citing this rule: below `xl` the form and the pane *swap*, and the eye icon lives in the
editor's sticky bar — inside the form — so opening a preview on a phone hid its own off switch and
Save along with it, leaving a frame of the site and no route back short of navigating away and
losing the edit. It is `xl:hidden` against the same breakpoint that hides the form, so at every
width exactly one of the two is reachable (measured, not asserted from the class). The general rule
it stands for is worth more than the button: **a control that is the only way out of a state must
not live inside what that state hides.**

**The preview pane's "cannot reach your site" warning is a `no-cors` probe, not a timer and not
`onLoad`.** It has been wrong in both directions. A timer never learned the frame had loaded, so it
accused a healthy site every time; wiring it to the iframe's `onLoad` killed it entirely, because
Chrome fires `load` for a connection-refused error page too. A `no-cors` request resolves opaque when
anything answered and rejects when the connection is refused, which is exactly the question being
asked — and nothing about the response needs reading. It is silent when the probe cannot run at all,
because a hint that is unsure is worse than none. Note for tests: `new Response(null, { status: 0 })`
throws, so an opaque response cannot be constructed; any resolved value stands in.

**The preview card takes a definite `h-`, never `max-h-`.** A max bounds it without giving it a
height, so it still sizes to its content and `flex-1` on the frame has no leftover space to claim —
which is a short pane pinned in a tall empty column, the exact bug the sticky work was meant to fix.

**Cross-origin preview is a token, and the token is the capability.** `?preview=1` worked only
because the site and the CMS shared an origin, so the session cookie came along and the route checked
the *session* rather than the parameter — that distinction was the whole security property, and it
disappears with the split. `preview_tokens` replaces it: a row, following `login_challenges`, because
it must be short-lived and revocable and a self-contained signed value stays valid however the
account changes. A row also avoids inventing a signing secret, which would need a working default for
`npm run dev` — and a default signing secret is not a secret. `resolvePreviewToken` answers
`undefined` for absent, malformed, unknown, and expired alike, so it cannot be probed; it is
deliberately **not** single-use, because a link that dies on first read breaks reload and the back
button, and the short expiry is the bound instead. **One mechanism covers a draft and a release's
staged version** — Phase 3.5 added the second thing worth previewing, and a separate token for it is
how two nearly-identical paths drift until one stops checking something.

**The CMS deployment serves the admin and the API, and nothing else.** Its root redirects to
`adminPath` (302, because that option is configurable and a cached 301 would outlive a change to
it), and there is deliberately **no public catch-all**. A `publicRoutes` option used to inject one
and it was a pre-split leftover: it read `taproot.db.db` directly, and rendered each field as a
heading and a paragraph with no block resolution, no reusable-block dereferencing, and `item.seo`
read raw so none of `resolveSeo`'s fallbacks applied. That is the second read path SCOPE rules out
under "one contract, one set of docs, nothing to drift", and it had already drifted. `index.test.ts`
asserts no injected pattern contains `[...path]`. The admin also keeps its own path segment —
`adminPath: '/'` **throws** rather than silently coming back as `/admin`, which is what it used to
do — because root-mounting would claim the whole top level (`/content`, `/media`, `/settings`…) for
admin screens and leave the CMS host unable to serve anything else.

**Rich text stores a reference, never a path — and delivery resolves it.** `taproot:item:{id}` in an
`href` is the same rule menus follow: a page that moves keeps every link pointing at it and nobody
edits the prose. `taproot:media:{id}` does the same for a file. Four things hold it up:
- **`taproot:` is on `SAFE_SCHEMES` but is not an open scheme.** `serializeAnchor` accepts only
  `taproot:item:<uuid>` and `taproot:media:<uuid>`; anything else spelled `taproot:` is dropped
  exactly as `javascript:` is. Admitting the scheme must not admit a payload.
- **`collectReferences` needs a `richtext` case, and `collectLoose` a second path.** The top-level
  walk is definition-driven and used to fall through to `default`; the loose walk inside blocks gates
  on an *anchored* uuid — deliberately, so prose is never a lookup key — which an id inside an
  attribute inside markup can never match. Both parse with `tokenize`, never a regex over markup, for
  the reason `sanitizeHtml` states.
- **Resolution inlines a reference into `data`, which the delivery rules otherwise forbid.** The
  reasons that rule exists are generated types matching stored shape, double serialisation, and the
  payload staying usable for a write. Here the alternative is worse: a marker left in place ships
  `taproot:item:…` to a visitor the moment a consumer forgets a helper, and delivery is read-only
  (`content:read`), so nothing round-trips it back. The ids stay in `references` and `media`.
- **`loadLinkTargets` follows `includeUnpublished`; `loadItemRefs` never does.** A relation must not
  name a draft, but an editor assembling a section links between drafts, and unwrapping all of them
  would make the preview a worse picture than the editor already had. Outside a preview an
  unresolvable target **unwraps** — the `<a>` goes, the text stays — mirroring a menu skipping a
  target it cannot show.

**`img` is absent from the richtext allowlist, and that was reconsidered rather than inherited.** A
reference-only `<img data-taproot-media>` filled at delivery would have kept alt text in the library,
which is half the original reason — but not the hotspot, because `set:html` cannot produce a
`TaprootImage`, so a picture in prose would be the one image on the site ignoring its focal point. An
image in a paragraph is a block's job.

**TipTap 3 does not re-render on transactions, so anything read from the editor in a render body is
frozen.** `editor.isActive(…)` straight in JSX was evaluated once: the H2 button stayed lit wherever
the caret went, the list buttons never lit, and Unlink was offered on plain text. Nothing errors —
the toolbar just stops telling the truth. `useEditorState` with a **flat, primitive-only** selector
is the fix; anything nested defeats its equality check and re-renders on every keystroke anyway,
which is the whole reason to prefer it over turning blanket re-rendering back on.

**`rel` is author-controllable but only from a fixed set, and `noopener noreferrer` cannot be
removed.** `ALLOWED_REL` is the list; a `target="_blank"` link always gets the protective pair added
last, whatever the author sent. That is what makes "open in a new tab" and "nofollow" safe to expose
as checkboxes.

**Every path that applies a link has to handle a collapsed caret.** `setLink` marks the *selection*;
with nothing selected it succeeds and produces nothing visible, which from the outside is exactly
"I pressed apply and no link appeared". Typing an address, choosing a page, and choosing a file all
route through one function that branches on `selection.empty` — three copies is three chances for one
of them to miss it, and two of them already had.

**Three things break a link the editor appears to create, and none of them raise an error.** All
three shipped at once, so the feature was inert while every test passed:
- **TipTap validates hrefs against `Link.configure({ protocols })`.** `taproot` has to be on that
  list — with `optionalSlashes`, since a reference has no `//` — or the mark is dropped between the
  click and the document. Proven by removing it and watching two tests fail.
- **`insertContent` with an HTML string escapes it.** `<a href=…>` arrived as visible text. Insert a
  text node carrying a `link` mark instead.
- **`HTMLAttributes` merges with TipTap's defaults rather than replacing them**, and its default
  includes `target: '_blank'`. Overriding only `rel` left *every* link this editor has ever made
  opening in a new tab, including internal ones. `target: null` is load-bearing.

**Every link goes through `LinkDialog`, and the range is captured when it opens.** It replaced an
inline form wrapped into the toolbar strip, for two reasons that are both worth keeping in view. The
editor column is ~400px with the preview pane open, and an address box, a page search, two checkboxes
and two buttons will never fit across it. And the form could not say where an existing link *pointed*
— `taproot:item:{uuid}` is correct and unreadable, so the id is exchanged for a title through the
same endpoints the relation and media fields use. Four things hold it up:
- **A modal takes focus, and the browser's selection goes with it.** `savedRange` is captured in
  `openLinkDialog` and every apply path works from it. Without that, "select a phrase, choose a
  page" silently becomes "insert a page title beside it". This also replaced the old
  `mousedown`-cancelling in the result list — there is no selection left to protect by the time the
  list exists. What has *not* changed is that the act belongs on `click`: Enter and Space raise one
  with no `mousedown` before it, so acting on the press makes a control reachable by pointer and by
  nothing else.
- **`closeLinkDialog` clears the range, and that is what keeps one `removeLink` honest.** The
  toolbar's unlink button and the dialog both call it, meaning different positions — now, and where
  the caret was. A range left behind makes the toolbar button act on a position from the last time
  the dialog was open.
- **Radix portals to `document.body`, but React propagates events through the React tree.** The
  dialog's `<form>` is nowhere near the item editor in the DOM and directly beneath it in React, so
  Apply submitted *both*: the page saved, redirected, and the link never landed. `stopPropagation`
  in the submit handler is the fix; `MediaPicker`'s upload form had the same latent bug.
- **The mode selector is a radio group drawn as tabs.** Hand-built tabs mean a roving tabindex and
  the tab/panel wiring written by hand and kept written; a radio group is the same interaction from
  the platform. The house rule about custom widgets settles it.

**There is one link button in the toolbar, not a separate one for files.** A paperclip opened the
same dialog on its file panel, which was worth having while the alternative was a cramped inline
form and stopped being worth having the moment files became one of three panels: two icons for one
dialog is two things to learn and one of them redundant. Same rule as "there is one preview control,
not two". `openLinkDialog` derives the panel from the href, and `LinkDialog` keeps `initialMode`
because it is still the thing that decides which panel opens.

**Asserting a control exists is not asserting it works.** The link search had tests for its input,
its label and its place in the toolbar's tab order, and shipped unable to create a single link. A
test for a feature has to make the feature happen and inspect what came out —
`RichTextEditor.test.tsx`'s "a chosen link actually becomes a link" block is the shape to copy.
Where jsdom genuinely cannot help — it has no selection model, so wrapping a selection is unprovable
there — say so in the test file and verify that branch in a browser.

**Render a component where it actually lives, or the test cannot see its context.** Every richtext
test rendered the editor on its own, and all of them passed while Apply saved the whole content item
and navigated away — the bug only exists because there is a `<form onSubmit>` above it in the real
screen. The regression test now renders it inside one. Same class of blind spot as auditing a closed
`<dialog>`: the thing being tested was never in the tree.

**The richtext toolbar's roving tabindex is derived, never counted by hand.** The unlink button only
exists while the cursor is in a link, so every index after it moves; a literal index left a hole, and
a button missing from `buttonCount` was reachable by mouse and by nothing else. The pattern's whole
promise is that one tab stop reaches every control.

**The accessibility checker is advisory and lives off the write path.** `checkItemAccessibility` in
`content/accessibility.ts` never refuses a save or a publish, and no route calls it before writing.
That is a decision, not an omission: an author who cannot publish because a checker disagrees routes
around the CMS, and a false positive in a rule would become an outage. `validateItemData` is where a
rule that *must* hold goes. Four things follow:
- **The rules are pure and the resolution is a different file.** `accessibility.ts` takes fields,
  data, and a lookup context with no database handle — which is what lets the editor's island run it
  on every keystroke — and `accessibilityReport.ts` is the half that finds content and resolves what
  the rules read. Same argument as `resolveSeo`: the panel and the site-wide report must not drift.
- **The walk mirrors `validateItemData`'s**, through blocks (bounded by `MAX_BLOCK_DEPTH`) and
  repeater rows (through `repeaterRowFields`). A value validation reaches and this does not is a
  value nobody is checking. `referencedMediaIds` uses the same walk, or a media field it missed
  would report every one of its images as undescribed.
- **`media.alt_text` has three states.** `null` is "nobody has said", `''` is "somebody marked it
  decorative", and the distinction is what makes the rule usable rather than a permanent complaint
  about every divider and icon. Ask through **`needsAltText`**, never `!altText` — which is also
  true of `''`, and which is how the library banner, the picker, and the media field all asked
  before. Blank form inputs normalise to `null` (`formValue`); only the Decorative checkbox writes
  `''`.
- **Alt text is resolved from the item's stored data, not from the library's first page.**
  `referencedMediaOptions` exists for that: `mediaOptions` answers "the most recent 60", so an item
  pointing at an older asset would have every one of its images reported as undescribed. Same trap
  `relationTargetsForFields` already avoids, and the panel fetches anything still unresolved rather
  than guessing — an id it cannot resolve is **not reported**, because that is a broken reference
  rather than a missing description.

**Heading order is checked within one richtext value, not across the page**, and the report is a
scan rather than an indexed query. Both are limits worth knowing before "fixing" them. Taproot ships
no templates, so it cannot know what order a site renders a type's fields in — a document-wide
outline is not knowable here, only within one value. And the report reads every item's `data` and
walks it, so it paginates and states what it checked ("Checked 50 of 312 items") instead of offering
a site-wide issue total: a true total means reading every row, and a quietly capped one is worse
than none. Undescribed *images* are asked separately as a real query, which is also the only way to
catch an image uploaded and not yet placed on any page.

**The workflow is a graph in core, not a status column.** `content/workflow.ts` holds every legal
transition and the role each needs, and `canChangeStatus` asks it two questions in order: is this
move legal *at all* (which does not depend on who is asking — `archived → published` is refused for
an admin too, because a page coming back from the archive goes through draft so somebody reads it
first), and only then may *you* make it. The item editor renders `transitionsFrom` as named buttons
rather than a status `<select>`, because "submit for review" is an act with a name and "set the
status to in_review" is how it used to be spelled — which is why nobody could find it.

**Scheduling is two halves and needs both.** Visibility is computed on read (`visibleToPublic` in
`items.ts`), so a page goes live at its moment whether or not a sweep has run — that is what makes
the feature work on a deployment where nobody wired up a cron, which is every deployment on day
one. `publishDueItems` then makes the *stored* status agree. Only the sweep would let a missed cron
silently hold a launch; only the read rule would leave the CMS lying about its own content.
`publish_at` is cleared whenever the status leaves `scheduled`, in **both** write paths — a stale
time is a booby trap, because rescheduling later inherits a moment in the past, which means
immediately. On `updateItem` the value distinguishes `undefined` ("not provided", keep it) from
`null` ("clear it"); `??` collapses the two and silently ignored a request to remove the date, the
same shape as a `.partial()` PATCH schema keeping a `.default()`. Revisions deliberately do **not**
snapshot it — a scheduled moment is an intention about the future, so restoring an old revision
lands in `scheduled` with no date: invisible, never swept, and shown as an empty required field.
Fails closed and says so.

**A release is the only place a content item can have a version that is not live.** `content_items`
holds one row per item, so editing a published page changes what visitors see at the moment of the
save — there is no draft of a live page, and Content Releases is what fills that gap rather than
merely batching publishes. Four things hold it up, and each has a simpler-looking alternative:
- **`release_items` carries its own `title`, `slug`, `data`, and `seo`** rather than referencing a
  revision. Revisions are an append-only record of what the *live* item has been, so staging by
  reference would write a line into the history of a page that never showed it — and a staged
  version has to be editable, which a revision is not. `parent_id` is deliberately not staged,
  matching what revisions capture: re-parenting is a change to the tree, and a release must not
  rearrange the site's hierarchy as a side effect of a copy change.
- **Pre-flight replaces atomicity, because atomicity is unavailable.** A release publish is N item
  updates, each already its own batch of path rewrites, redirects, and a revision, and D1 has no
  transaction spanning them. `releasePreflight` validates every staged version *before* anything is
  written — against the content type **as it is now**, since a release can sit open for weeks and a
  newly-required field is exactly what turns a staged version unsavable. It is recomputed on every
  render, never stored: a cached list of reasons still accuses somebody an hour after they fixed it.
  `release_items.published_at` is what makes a genuinely unexpected mid-flight failure resumable.
- **Publishing goes through `updateItem`, never around it.** A staged slug change has to cascade to
  descendants and write its redirects exactly as a rename does; a direct row write would be a second
  implementation of the part people get wrong.
- **Staging is contributor, publishing is editor.** Staging reaches nobody, which makes it the same
  shape as submitting for review — gating it higher would stop content authors assembling their own
  launch. Publishing is editor because every transition into `published` already is, and a release
  must not be a route to a change `canChangeStatus` would refuse one item at a time. The staged
  endpoint therefore refuses `status` outright.

**A scheduled release needs the sweep; a scheduled item does not.** An item's visibility is computed
on read (`visibleToPublic`), so it goes live with no cron wired up. A release's content lives in
`release_items` and has to be *applied*, which no page view can do. Do not "fix" this by teaching
the read path about releases — that would mean resolving staged content on the hot path of every
public request. The asymmetry is stated on Settings → System and in the handbook because it is the
one place "scheduling works with no cron" stops being true. `publishDueReleases` claims a release by
**clearing `publish_at`** rather than adding a `publishing` status: the clear is a rule that already
had to hold in every path off `scheduled`, so reusing it as the claim leaves no state to strand if
the process dies — what a crash leaves is a release reading `scheduled` with no date, visibly wrong
and never swept again. Items sweep **before** releases, or a page that is both scheduled and staged
loses its own moment when `updateItem` clears `publish_at`.

**`blocked` exists only for the unattended case.** A scheduled release refused at 3am has nobody to
tell, and leaving it `scheduled` would sweep the same broken content every minute forever, writing
an audit entry each time. A release refused while somebody is looking at the screen is *not* moved
to `blocked` — they are right there, and the screen recomputes the reasons anyway.

**Deleting an item staged in an unpublished release is blocked, not warned.** `release_items`
cascades on `content_item_id`, so the delete would take the staged version with it and the release
would publish without that page — no broken row, no message, nobody notices until the launch is
missing something. That is the line the blocker/warning split turns on: a menu entry and an incoming
relation *degrade visibly*, which is why they only warn. The query lives inline in `items.ts` rather
than calling `openReleasesForItem`, because `releases.ts` imports `items.ts` and the dependency must
run one way — same reason `visibleToPublic` lives in `items.ts` and not `scheduler.ts`.

**The audit log is append-only and nothing may make it aimable.** `recordAuditEntry` never throws:
the action it describes has already happened, and failing it would report a failure that did not
occur. `actor_email` and `subject_label` are copied at write time rather than joined, because a log
records what was true *then* — an entry about a deleted page stays readable, where a join renders
two nulls. `subject_id` has no foreign key for the same reason: a cascade would delete the evidence
along with the subject. Retention is a dated sweep; "delete entries about me" is the capability an
audit log must not have.

**An admin can clear someone else's second factor and end their sessions, but not their own.**
Losing a phone *and* the recovery codes used to mean a database console while the sign-in screen
said "ask an administrator". Your own two-factor goes through the account screen, which asks for
your password — offering it on the users screen would route around that and turn an unattended
admin session into a way to strip the protection off the account it belongs to. Signing *yourself*
out everywhere keeps the current browser, because being logged out for taking a precaution teaches
people not to take it.

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
`sharp`. Hashing goes through `crypto.subtle` (PBKDF2-SHA256), which is *reachable* in both Node and
Workers — but read the next paragraph before assuming that means the same thing.

**workerd caps PBKDF2 at 100,000 iterations, and `DEFAULT_ITERATIONS` is that cap.** Above it,
`crypto.subtle.deriveBits` throws `NotSupportedError`; it does not clamp. This is the runtime's
ceiling rather than a security choice — OWASP asks for more, and `crypto.subtle` is the only KDF
available to a CMS that ships zero native dependencies. It sat at 210,000 through every phase, and
the consequence was total: a Cloudflare deployment could not create its first administrator (the
setup screen 500s), and every sign-in for an address that does not exist 500s too, because that path
derives against `DUMMY_HASH` to equalise timing. **Node has no cap, so nothing local reproduces
it** — the tests, `npm run dev`, and every local sign-in all pass. Two things follow: the count is
one number for every environment, because a per-platform count leaves a database that moves between
them holding passwords nobody can verify; and `DUMMY_HASH` interpolates the same constant rather
than spelling a number out, which is how the two drifted apart in the first place.

**D1 refuses PRAGMA, so the D1 dialect carries its own introspector.** Kysely's
`SqliteIntrospector` reads column metadata through `pragma_table_info`, and D1's authorizer answers
`not authorized: SQLITE_AUTH` (error 7500) to anything touching PRAGMA. That is not a niche loss:
`Migrator` calls `getTables()` to decide whether its bookkeeping tables exist **before** creating
them, so inheriting the stock introspector meant `db:migrate:remote` failed on the very first
statement it sent, with zero migrations applied — and the error names authorization, so it reads as
a bad API token and sends you to re-check your Cloudflare credentials. `D1Introspector` answers from
`sqlite_master` instead and returns **empty columns**, which is honest for its only caller. Do not
"restore" the inherited introspector, and do not build anything needing real column metadata on it.
`d1.test.ts` pins the property that matters — no PRAGMA ever reaches the wire — with a fake that
refuses PRAGMA the way D1 does, since a real SQLite never will.

**No read-your-own-writes inside a batch.** D1 has no interactive transactions, so `batchWrite()`
takes a *list of statements* — native batch on D1, real transaction on SQLite/Postgres. Do all
reads first, compute in memory, then write once. The cascading path move is the reference example:
one recursive CTE reads the subtree, every new path is computed in memory, and the whole thing goes
out as a single batch.

**Dev runs on Node, production on Workers.** Dev deliberately does *not* run SSR in workerd —
workerd has no `node:sqlite`, which would make `npm run db:seed` impossible without a running dev
server. `node:sqlite` is reached through a variable specifier and marked SSR-external so bundlers
can't resolve it statically. Use `npm run preview` to exercise the real Workers runtime.

**Kysely is pinned to one chunk, and a green build says nothing about whether workerd will run
it.** Left alone the bundler splits Kysely's SQLite dialect from its core into two chunks that
import each other — `sqlite-adapter` wants `DefaultQueryCompiler` and `DialectAdapterBase`, the core
chunk wants `SqliteAdapter` back. Node tolerates the cycle; workerd evaluates it in an order where
the base class is still undefined at `class … extends`, and **Cloudflare refuses the upload**
(`Class extends value undefined`, error 10021) after `astro build` has reported success and the
assets have already gone up. The `manualChunks` rule in `astro.config.mjs` is what prevents it, in
`apps/studio` **and** in the scaffolder's byte-identical copy. The general lesson is the one
`npm run preview` exists for: building is not evaluating, and this class of failure is invisible to
every test, typecheck and build in the repo.

**The Worker entry is `apps/studio/src/worker.ts`, not the adapter's.** `@astrojs/cloudflare` fills in
`main` only when the wrangler config does not (`main: config.main ?? '@astrojs/cloudflare/entrypoints/server'`),
and the entry it would supply is exactly `{ fetch: handle }`. Naming our own therefore costs the
adapter's behaviour nothing and buys a `scheduled` export, which is the only way a Cloudflare cron
trigger can reach the publishing sweep — the alternative was a second Worker existing solely to make
one authenticated HTTP request into the first. This belongs to the *studio*: the consumer has no
scheduler, no database, and no cron. `main` must point at **source**, never at anything
under `dist/`: that file does not exist until after a build, and naming it makes `astro dev` fail
before it starts. `POST /api/taproot/scheduler/run` and `TAPROOT_CRON_SECRET` remain for platforms
with no cron of their own; nothing on Cloudflare needs either.

**Taproot sends one email, and works with none.** The standing constraint used to read "nothing
sends any email" — right in instinct, one step too far in statement. What has to hold is that
`npm run dev` needs no external service, and self-service password reset has no non-email form, so
the constraint moved rather than blocking the feature. With nothing configured `resolveMailer`
returns the log mailer, whose `delivers` is **false**, and that flag is load-bearing: the login
page's "Forgot your password?" link, the forgot-password screen, and the API route all gate on it,
because a form whose success message is a lie is worse than no form. Delivery is a webhook taking
flat JSON — **do not add a vendor SDK or a per-provider adapter**; four payload shapes and four
error semantics is exactly the maintenance a CMS that ships no block templates should not take on.
Reset requests throttle in their own keyspace (`resetEmailKey`, not `emailKey`), or asking to reset
someone's password would be a way to lock them out of signing in.

**The admin is server-rendered Astro, not a SPA.** Every screen is an Astro page whose permission
check runs before any HTML is sent. React appears only where interaction genuinely demands it
(field builder, item editor). This is primarily an accessibility decision — client-side routing
needs hand-built focus management and route announcements to meet WCAG AA. Don't introduce
client-side routing.

**`@taprootcms/studio` ships source, not a build.** Astro's `injectRoute` compiles `.astro` entrypoints
out of `node_modules` through the host's Vite pipeline, the same way Starlight does. `.astro`
imports resolve for tsc only via the ambient shim in
[astro-modules.d.ts](packages/studio/src/astro-modules.d.ts); that shim makes the import resolve so
surrounding TypeScript gets checked, and does **not** check the `.astro` file's own contents.

## Accessibility is an acceptance criterion, not a review step

The admin itself must be WCAG 2.1 AA — separate from the Phase 4 content-accessibility checker.
Debt here compounds, so **`npm run a11y` must pass before a phase is called done**, with zero
violations, zero inert labels, zero reflow hazards, and every token pair passing in both themes.

**The implementation detail behind that rule lives in
[packages/studio/CLAUDE.md](packages/studio/CLAUDE.md)** — the responsive nav, sticky positioning,
the colour tokens and contrast mirrors, `<label for>` on labelable elements, and what the audit
cannot see. Read it before touching admin markup or `admin.css`. Three things stay here because they
are about the audit scripts at the repo root rather than the admin itself:

- **`scripts/a11y-audit.mjs` force-opens `dialog.taproot-sheet` *and* `[data-menu-panel]` before
  running axe**, because a closed one is `display: none` and axe skips it — a run would stay green
  while the account link, the theme buttons and sign-out quietly stopped being checked.
- **The audit's dynamic routes must be chosen by what they exercise, not by what sorts first.** It
  picks the item editor by field count, because taking `items[0]` took the alphabetically-first path
  — the weather-banner singleton, three plain inputs — and left the densest screen in the admin the
  one route never audited. Seven inert labels sat there through four phases as a result. Note that
  `/api/taproot/content-types` returns types *without* their fields, so a count derived from that
  list is zero for everything and quietly restores the bug. The same trap one screen along: the
  content type settings form renders a different control per kind, so it audits `contentTypes[0]`
  **and** the first singleton — auditing only the first type leaves whichever kind sorts second
  unchecked while the run still reports zero. And a third time, one axis along: **field count is a
  fact about the content type, composition is a fact about the item.** The field-count winner on the
  seeded database had zero blocks placed and zero repeater entries, so every collapsible panel in
  the admin — and every field inside one — was absent from the run. `composedRows` picks the
  block-heaviest and row-heaviest items as well, counting the two envelopes **separately** because
  they sit on different items and one combined score leaves repeaters unaudited.

**Blocks and repeater rows default to expanded, and that default is what keeps them auditable.**
`useCollapsible` is shared by `BlockListEditor` and `RepeaterField`, and the audit runs with
`runScripts: 'outside-only'` — so what axe sees is the island's *server-rendered* markup with that
initial state. A collapsed panel carries `hidden`, which is `display: none`, and axe skips its
contents entirely. Defaulting to collapsed for long lists is the obvious ergonomic improvement and
would silently drop every field inside every block from the audit while the run still reported zero.
Nothing persists the state either: the only flash-free precedent is a cookie read on the server
(`data-theme`, `data-preview`), and per-row state keyed by block instance id is far too fine-grained
to spend one on. Related: a repeater row's disclosure is a **button and deliberately not a heading**,
where a block's is an `<h3>` — a block is a section of the page being composed, while a repeater's
rows are one field's value, and a repeater nested inside a block would have to guess a heading level
from a depth the component cannot see.
- **A new colour token or a new *pairing* of existing tokens is not done until it has a pair in
  `a11y-contrast.mjs`.** `axe` runs with `color-contrast` disabled precisely because that script is
  the authority, so a colour put on a background it has never been checked against is unchecked no
  matter how many routes pass.

**Drag-and-drop must always be added alongside keyboard controls, never instead of them**; the field
builder's reorder buttons are the pattern to follow.

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
  or `singleton` (exactly one item, no create/delete, optional `preview_path`).
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
  it. `apps/web/src/taproot.ts` is the worked example — `PUBLIC_TERM_TAXONOMIES` and `termHref` —
  and both the catch-all route and the menu resolver read the same set so they cannot disagree.
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
- **The media route resizes, and `imageVariants.ts` is the vocabulary both sides spell.** It lives
  where `pure.ts` re-exports it for the reason `cacheTags.ts` does: the consumer builds `?w=`/`?ar=`
  /`?f=` and the route parses them, and a disagreement is **silent** — every visitor served the
  full-size original while the page looks right and every test passes. Seven things hold it up, and
  four of them were bugs first:
  - **The width ladder is closed and the ratio is quantised, as cost control rather than taste.**
    Cloudflare bills a unique transformation per image per parameter set against 5,000 free a month,
    so a URL taking any integer or any float is a URL where one crawler burns the allowance and
    fills the edge cache with near-identical entries. A width between rungs snaps **up** — snapping
    down answers a reasonable request with a silently blurrier picture. `ar` is quantised on the way
    *out* as well as in, or a consumer sending `16/9` unrounded builds `ar=1.7777777777777777`, the
    route answers `1.78`, and every candidate misses the cache while still rendering correctly.
  - **The ladder also offers the ceiling itself.** Rungs are round numbers and a real image is not:
    a 3.5:1 photo cropped to 4:3 leaves 605 usable pixels whose largest rung is 480, so a quarter of
    the detail that exists would never be offered. Deterministic per asset and ratio, so it costs
    one cache entry rather than opening the width up.
  - **Format is in the URL and never negotiated from `Accept`.** These responses are stored in a
    shared cache keyed on the URL, and `Vary` is honoured there only for `Accept-Encoding` — an
    `f=auto` would serve the first visitor's format to everyone behind them, which is the admin-HTML
    cache leak one level down.
  - **`OUTPUT_QUALITY` is not optional.** Left unset the binding encodes near-lossless and **a
    resize comes back larger than the source**: a 170 KB JPEG measured 610 KB re-encoded at 1536
    wide, about one byte per pixel against the source's 0.23. Nothing errors and the picture looks
    right, so it is invisible without weighing bytes — it shipped in three releases. Set whether or
    not a format was named, because a resize alone re-encodes in the source's own format.
  - **`resizeImage` fails open, always.** No binding, an unresizable type, an allowance reached, a
    throw — every one serves the stored original. That is what makes the whole feature safe on Node
    and on any Worker without the binding: heavier pages, never broken ones. SVG and GIF stay on the
    untouched path deliberately — rasterising an SVG throws away the thing it is good at and is the
    one type here whose bytes are also a script vector, and a GIF resize flattens an animation.
  - **`sizes` describes the container and `scaleSizes` bridges it to the element.** Under `crop:css`
    the `<img>` is blown up by `1 / rect.width`, so a caller's `sizes` passed through unmodified
    picks one rung too soft on exactly the layouts where the crop was doing the most work. It lives
    in **core**, not the `.astro` file, because it shipped wrong: splitting an entry on its last
    space takes `57px)` out of `calc(50vw - 57px)` and scales one term, which is valid CSS computing
    the wrong number. String arithmetic inside a component is reachable by no suite in this repo —
    the same blind spot as auditing a closed `<dialog>`.
  - **`crop="server"` is opt-in and `object-fit: cover` is its safety net, not its mechanism.** A
    cropped file already carries the box's ratio so cover is a no-op; when the transform did not
    happen the original arrives and `object-position` frames it on the hotspot. So the failure mode
    is an approximate crop, never a wrong picture — which is the only reason the mode can be offered
    at all. The route resolves the rectangle with the same `resolveCrop` the admin preview uses and
    applies it as a pixel `trim` **before** the resize, two chained transforms because the order is
    the point; `fit: 'crop'` with a `gravity` focal point would have been fewer lines and would
    quietly ignore the crop an editor dragged.
- **`TAPROOT_MEDIA_URL` and the Images binding are mutually exclusive, and nothing warns.** Pointing
  it at an R2 custom domain makes media bypass the Worker route — the whole point of it — and the
  resize lives *in* that route, so setting it silently returns to full-size originals. The binding
  needs no domain and works on `workers.dev`; only URL-based `/cdn-cgi/image/` needs a zone.
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
  - **`/api/taproot/media/file/[...key]` serves R2 objects**, and is what `publicBaseUrl` now
    defaults to. It used to default to `/media`, which nothing served, so an R2 deployment without
    a custom domain on the bucket produced successful uploads and 404ing images — a configuration
    gap presenting as a broken picture. A custom domain via `TAPROOT_MEDIA_URL` still wins and is
    still faster: it serves from the edge without waking a Worker per image. The route takes its
    content type from the `media` row rather than the key, because the key is derived from a name a
    user chose and `image/svg+xml` on this origin is same-origin script; `nosniff` and a sandbox CSP
    back that up.
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
  - **A library row is only ever written validated**, which is what lets a referencing page skip
    field validation. Creating one from scratch therefore collects its content first, through the
    *same* `ReusableBlockEditor` an existing entry uses — there is no "empty entry, fill it in
    later" path, because that row would break the invariant the whole feature rests on.
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
  - **A content type's field list is only the top level, and `fieldTree.ts` is what reaches the
    rest.** A relation or taxonomy field inside a block type or a repeater row is just as editable
    and was invisible to both `relationTargetsForFields` and `termOptionsForFields`, so the control
    rendered "Items of the target type are listed here in the item editor" — a sentence naming the
    screen the editor was already looking at. `media` escaped it only because `mediaOptions` loads
    the library wholesale rather than per field. **The options walk is over the *schema*
    (`reachableFields`), never over the item's data**: an editor adds a block *after* the page has
    rendered, and the control inside it has to work when they do — a data-driven walk looks correct
    on every screen where somebody is revising and is dead on every screen where somebody is
    composing. `walkStoredValues` is the separate, data-driven half, and is only for resolving ids
    already stored. Consequence for the pages: the block registries have to be loaded **before**
    both resolvers, which is a reordering, not a new query.
  - **`itemsReferencing` is the reverse side**, rendered by `ReferencedBy.astro` and grouped by the
    field's `reverseLabel` — a config value the builder had collected since the field type was
    designed and nothing had ever read. It is two queries on purpose: the relation *fields* that
    could point here come from the `fields` table first, and only then is `data` searched. A bare
    `LIKE` for the id across every item would also match it sitting in a body or a media
    reference, and report a relationship that does not exist.
- **`link` is a field type because a relation cannot be a button.** A relation names a content item
  and has no way to express an external address, a file, or "open in a new tab" — which between
  them are most of what a call-to-action is. Four things hold it up:
  - **The control *is* `LinkDialog`**, the one rich text already uses. An editor who has linked a
    word in a paragraph has learned this dialog; a second interface for the same act is how
    somebody ends up trusting neither, the same argument as "there is one preview control, not
    two". `LinkField` is the translation and nothing else.
  - **It stores `{ kind, id | href }`, not the `taproot:item:{id}` marker rich text stores.**
    Storing the marker would have made the control nearly free, since the dialog already speaks it —
    and it puts a string a consumer has to parse where an id and a lookup belong, so every consumer
    that forgot would ship `taproot:item:…` to a visitor. Rich text accepts that trade because
    `set:html` cannot perform a lookup; a structured field has no such excuse. The `item` and
    `media` kinds are therefore references resolved through the delivery maps, exactly as `relation`
    and `media` fields are — which is what makes `collectReferences` needing a `link` case
    load-bearing rather than tidy.
  - **The `url` kind goes through `safeUrl`, which is the sanitiser's own export.** This is a write
    path whose value lands in an `href`, so it is exactly as exposed as rich text — a second opinion
    about `javascript:` is a rule that will disagree with itself once. `taproot:` is excluded there
    even though `safeUrl` admits it, or an internal target would have two spellings and one of them
    would be invisible to `collectReferences`.
  - **No `multiple`, deliberately.** Several links is a row of buttons, which is a repeater of a
    link field — and that composes, because each row can then carry its own heading. `link` is in
    `REPEATER_SUB_FIELD_TYPES` for exactly that reason. A `multiple` would be a second spelling with
    a stored shape that follows the config for no gain.
- **Every field type has an editing control or is listed in `DEFERRED_FIELD_TYPES`**, and
  `fieldControls.test.tsx` asserts the list matches what `FieldControl` actually renders.
  `fieldConfigForms.test.ts` had always checked that every type has a *config* form; the absence of
  its counterpart is why `relation` went two phases with a config form, server-side validation, and
  a placeholder promising an editor "in Phase 1" — a phase that had already been declared complete.
  The list is a **fact about what exists**, not a plan: it replaced an `availableIn` phase number
  that the builder rendered as a "Phase N" badge on rich text, media, taxonomy, and blocks long
  after all four shipped. Plan vocabulary does not belong in a CMS a campus editor uses.
- **A repeater's sub-fields live in its own config, not in the `fields` table.** They have no
  independent existence — nothing refers to them, and giving them rows would mean every query that
  loads a content type's fields learning to exclude the ones that are really part of another field.
  `repeaterRowFields` synthesises `FieldRow`s on demand, which is what gets a repeater the same
  controls, the same validation, and the same richtext sanitising as a top-level field without
  anything knowing repeaters exist. `REPEATER_SUB_FIELD_TYPES` excludes `block` and `repeater` — a
  table of tables is a data model rather than a field, and that exclusion in *core* is also what
  makes the config form's one-level recursion terminate.
- **`DEFERRED_FIELD_TYPES` is empty**: every field type the builder offers can be authored. The
  mechanism stays because a type added later without a control has to be able to say so, and
  `fieldControls.test.tsx` fails until it either has one or is listed.

## Definition of done for a phase

From SCOPE.md, treated as a standing requirement rather than cleanup:

1. `npm run dev` works end to end from a fresh clone with only `npm install`, a copied `.env`, and
   `npm run db:seed`. If a phase adds a required env var or service dependency, fixing the
   zero-setup story is part of *that* phase.
2. Seed data is realistic enough to see the feature working, and reseeding stays idempotent.
3. `npm test`, `npm run typecheck`, and `npm run a11y` all pass.
4. [DEPLOYMENT.md](DEPLOYMENT.md) is still accurate.
5. [README.md](README.md)'s status and "what's next" reflect reality.
