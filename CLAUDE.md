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

**Phase 3 is complete** and was **smaller than SCOPE.md used to describe**: departments are
classification, which the Phase 1 taxonomy already provides, so there is no departments entity and
no department-scoped role. Roles are flat and site-wide. User management, workflow transitions with
role gates, the scheduler, and the audit log all shipped, along with self-service password reset and
a Cloudflare cron trigger for the publishing sweep.

**Phase 3.5 — Content Releases — is complete.**

**Phase 3.75a is complete**: API keys, principals, the delivery API, ETags, and type generation.
`apps/web` is deliberately **unchanged** and still reads the database directly — both paths work,
which is what makes the equivalence tests in `delivery.test.ts` possible. **3.75b is next**: rename
`packages/studio` → `packages/studio`, create a thin consumer `@taproot/studio`, rewrite `apps/web`
against HTTP, add cross-origin preview (covering both drafts *and* a release's staged version), then
delete the embedded path. That comparison stops being available the moment 3.75b lands, so do not
remove those tests without replacing what they prove.

**[apps/docs](apps/docs) is the handbook** — Astro + Starlight, `npm run docs`, port 4322. It is
end-user documentation (editors, site admins, operators), not developer docs, and it is a separate
app so the demo site stays a demo. It declares **no `sharp`** and configures the passthrough image
service, because the default image service is a native dependency; `sharp` still arrives
transitively through Astro and wrangler, which is not something this repo controls, but nothing here
declares it. Phase 3.75 will invalidate parts of the operator section — the split changes install
and deployment — so update it in that phase rather than leaving it describing the old shape.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Dev server at :4321. Astro 7 daemonises it — `astro dev stop\|status\|logs` |
| `npm run db:seed` | Migrate and seed. Idempotent |
| `npm run db:reset` | Delete the local database and reseed |
| `npm test` | Vitest, 949 tests |
| `npm run docs` | The handbook at :4322. `npm run docs:build` to build it |
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

```
packages/core     @taproot/core   — data layer, auth, content services, storage. No framework.
packages/studio    @taproot/studio  — the Astro integration: admin panel, REST API, typed client
apps/web          the demo campus site
```

Routes are not files-on-disk in apps/web — `@taproot/studio`'s integration entry
([index.ts](packages/studio/src/index.ts)) injects every admin and API route via `injectRoute`.
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
  access logs. Self-service reset now uses the same table and semantics with a null `created_by` —
  as predicted, it needed a sender and not a reshaping. Its emailed link *does* carry the token in
  the URL, which is not a contradiction: the cookie protects the **admin's** browser from holding a
  colleague's credential, and there is no way to put a link in an inbox other than as a link.
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
`undefined`, which type-checks and is nonsense.

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

**The Worker entry is `apps/web/src/worker.ts`, not the adapter's.** `@astrojs/cloudflare` fills in
`main` only when the wrangler config does not (`main: config.main ?? '@astrojs/cloudflare/entrypoints/server'`),
and the entry it would supply is exactly `{ fetch: handle }`. Naming our own therefore costs the
adapter's behaviour nothing and buys a `scheduled` export, which is the only way a Cloudflare cron
trigger can reach the publishing sweep — the alternative was a second Worker existing solely to make
one authenticated HTTP request into the first. `main` must point at **source**, never at anything
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

**`@taproot/studio` ships source, not a build.** Astro's `injectRoute` compiles `.astro` entrypoints
out of `node_modules` through the host's Vite pipeline, the same way Starlight does. `.astro`
imports resolve for tsc only via the ambient shim in
[astro-modules.d.ts](packages/studio/src/astro-modules.d.ts); that shim makes the import resolve so
surrounding TypeScript gets checked, and does **not** check the `.astro` file's own contents.

## Accessibility is an acceptance criterion, not a review step

The admin itself must be WCAG 2.1 AA — separate from the Phase 4 content-accessibility checker.
Debt here compounds, so `npm run a11y` must pass before a phase is called done. It currently reports
32 routes, 0 violations, all 36 token pairs passing in both themes.

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
id>` and `aria-labelledby`, not a `<label for>`** — [FieldControl](packages/studio/src/admin/islands/fields/FieldControl.tsx)'s
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
([RichTextEditor.test.tsx](packages/studio/src/admin/islands/fields/RichTextEditor.test.tsx),
[MediaPicker.test.tsx](packages/studio/src/admin/islands/media/MediaPicker.test.tsx)).
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
