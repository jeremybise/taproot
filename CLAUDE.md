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
refuse an incomplete item. `writePreviewDraft` is the only caller and must stay so.

**A preview token is a capability over one item, and `delivery/resolve.ts` enforces it by path.**
The preview branch used to ignore `path` entirely and answer with the token's item whatever was
asked for — invisible while the only caller was a 302 straight to `item.path`, and a real bug the
moment a frame can follow a link or an editor can type an address: every page on the site would
render as the item being edited. It also stops a token being a site-wide key to unpublished content.
A token-bearing URL is answered `no-store` even when it falls through to published content, because
the URL is a cache key carrying a credential.

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
learns to trust neither.

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
  list is zero for everything and quietly restores the bug.
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
