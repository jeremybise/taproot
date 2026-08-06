# Taproot — Scoping Doc v0.1

**Project name: Taproot.** No known collision with any existing CMS or web-dev tool. Heads up for context: there's an unrelated, older Bitcoin protocol upgrade also called Taproot (crowds npm/GitHub search results with cryptocurrency libraries, but no product competition), and a real 501(c)(3) nonprofit called the Taproot Foundation (skills-based volunteering, unrelated field). Neither is a legal blocker.

**npm naming, decided:** packages publish under **`@taprootcms`** — `@taprootcms/core`, `@taprootcms/studio`, `@taprootcms/astro` — plus the **unscoped `create-taproot`**, which is what makes `npm create taproot` work (npm resolves that command to `create-<name>`; the scoped form would be the uglier `npm create @taprootcms`). This doc originally said `@taproot`, and the reason it changed is in the paragraph above: the Bitcoin upgrade crowds npm and GitHub search with `taproot-*` cryptocurrency libraries, so `@taprootcms/core` is unmistakably this project where `@taproot/core` is a guess until you look. A scope disambiguates only once you can see the `@`, and search results, a talk, and word of mouth do not carry it. The unscoped `taproot` was never available regardless — it has been a tree-manipulation library since 2012 — while `create-taproot` was free and is the name that actually matters, because it is the first thing anyone types.

## What this is

A DB-backed, Astro-native CMS. WollyCMS's block page-building and content-modeling breadth, EmDash's portable-database philosophy, Directus's visual schema authoring, plus a built-in accessibility checker — aimed at a real-world use case (a campus website with many non-technical departmental contributors), not just a personal blog.

Git-based storage (Markdoc/MDX-in-repo) is explicitly ruled out for this use case: campus staff won't use GitHub, and an editing UI with real accounts, revisions, and a visual schema builder needs an app-level data layer rather than repo ACLs. (An earlier draft leaned on per-department permissions as the decisive argument. Departments turned out to be classification rather than authority — see Roles & permissions — so that particular reason no longer carries weight, and the rest of the case is what stands.)

## Developer experience: local dev, seeding, deployment

This is a standing requirement across every phase, not a one-time setup task — it's easy for a coding agent to keep shipping features while letting the "can someone else actually run this" story quietly rot.

- **`npm run dev` must work end to end** against the local SQLite adapter (per the Phase 0 architecture decision), with no manual setup steps beyond `npm install` and maybe copying a `.env.example`. If a phase adds something that breaks this (a new required env var, a new service dependency), fixing it is part of that phase, not a cleanup task for later.
- **A seed script** (`npm run db:seed` or similar) that populates enough realistic data to actually see the system working — a default admin login, a couple of sample content types (e.g. Page, Event) with real fields, a few sample content items demonstrating the hierarchical path structure, some taxonomy terms, and a sample media asset or two. The goal is that a fresh clone + install + seed gets you a site that looks like something, not an empty shell you have to hand-populate every time.
- **Idempotent and resettable** — running the seed script twice shouldn't duplicate data, and there should be an easy way to wipe and reseed (`npm run db:reset` or similar) when the schema changes during development.
- **Deployment directions are real, written documentation** (a `DEPLOYMENT.md` or similar in the repo), not tribal knowledge — covering: provisioning the Cloudflare D1 database, running migrations against it, setting up the R2 bucket for media, configuring required secrets/environment variables (OAuth credentials, etc.), and the actual `wrangler deploy` (or equivalent) command sequence. This should be written and kept current as part of Phase 0/1, since it's much easier to document deployment while building it than to reconstruct it later.
- **Treat this as a per-phase acceptance criterion**: a phase isn't done if `npm run dev` doesn't work cleanly with seeded data afterward, even if the feature itself is complete.

## Cross-cutting constraints (apply to every phase, not a phase themselves)

- **Admin UI accessibility**: the admin app itself must be WCAG 2.1 AA compliant — this is separate from the content-accessibility checker feature (which audits _published_ content, not the editing tool). Accessibility debt compounds, so audit each phase's UI as it's built rather than at the end. There's an accessibility-review process available for exactly this — run it against each new admin screen before calling a phase done, especially the non-standard interactions (drag-and-drop block reordering, tree views for taxonomies/nested content types, data tables) since those are hand-built and are where WCAG failures actually creep in, off-the-shelf components rarely fail here.
- **Admin UI library**: shadcn/ui is a solid pick and worth keeping — it's Radix UI underneath, and Radix's primitives already handle a lot of the hard a11y work (focus management, keyboard nav, ARIA roles) for standard components like dialogs, dropdowns, and comboboxes. That said, it doesn't guarantee AA compliance for anything you build custom on top of it (see above) — treat it as a strong foundation, not a substitute for the audit step.

## Terminology decisions (locked)

- **Content Item**, not "Page" — a page is just one content type among many (post, event, staff profile, department, etc.)
- **Block** — the general composition primitive placed into a page's block fields (hero, CTA, gallery, rich text, etc.)
- **Reusable Block** — a Block instance promoted to a shared library, referenced by ID from multiple content items, usage-tracked so it warns/blocks on deletion while still referenced
- **Content Type** — user-defined schema (fields, not raw JSON) that content items conform to

## Core architecture decisions

- **Data layer — Kysely against one dialect, SQLite locally and Cloudflare D1 in production.** This bullet originally read _"portable SQL adapter (Kysely-style) so the same codebase runs on SQLite (dev), Postgres, or Cloudflare D1 — matches your comfort with either Node or Cloudflare, don't lock to one"_, and the Postgres half was removed after five phases in which nothing tested it, nothing documented it, no deployment used it, and `pg` was not even a devDependency — so the branch could not be reached from the test environment at all. Note that SQLite and D1 are **not** two dialects: both compile through Kysely's `SqliteQueryCompiler`, so the SQL is byte-identical and there is no per-dialect branching anywhere in query building. What the promise of a third engine *did* cost was real: it is the reason 5D rejected FTS5 (see below), since a second engine means two search implementations that must agree. Cutting it is what bought ranked full-text search in `0025_item_text_fts`. Recorded rather than overwritten so the portability argument is not re-made without also re-making the search trade it was paying for.
- **Media storage**: S3-compatible interface (local disk in Node, R2 on Cloudflare; the S3 adapter is designed for and not yet written). R2 objects are served through a route by default, with a bucket custom domain as the faster opt-in.
- **Framework integration — a standalone server plus a thin Astro client, not one package.** Taproot ships a CMS server that owns the database, the admin UI, and the API as its own deployment; a site installs a separate Astro package and reads content from it over HTTP. This bullet originally read _"Astro integration package exposing admin panel, REST API, typed client, and a `BlockRenderer` component — same shape as Wolly's `@wollycms/astro`"_, which misread Wolly: `@wollycms/astro` is only the consumer half, and the server is scaffolded and deployed separately (`npm create wolly`). Phases 0–2 were built to that misreading, which is why the admin and API are currently injected into the host site's own Astro project. Correcting it is Phase 3.75 below. The misreading is recorded here rather than quietly overwritten so that nobody "simplifies" the two packages back into one.
- **Auth**: **email and password is the primary method**, with OAuth (Google/GitHub/Microsoft) optional alongside it. This reverses an earlier decision that had OAuth as the only production method and passwords as a dev-only convenience the app refused to boot with elsewhere. That reasoning was right about a *backdoor* and wrong about a *front door*: what made it dangerous was being a hidden second way in, not the passwords. As the visible first way in it carries what a front door owes — a per-email and per-IP throttle, a length minimum, single-use set-password links, and a first-run setup screen that closes behind itself atomically. Registering an OAuth app is also real setup a fresh clone cannot do, which is the other half of why this is the default. TOTP is built: enrolment with a QR code, a challenge between the password and the session, single-use recovery codes, and replay protection within a code's own acceptance window.
- **Hosting target**: Cloudflare Workers + D1, and now the *only* target rather than the first one. This originally added "keep the data adapter portable regardless"; see the data-layer bullet for why that clause was dropped and what it was costing.
- **Single site, no multi-tenancy**: one site per deployment, not separate site instances per department. Removes a whole class of routing and deployment complexity.
- **Permissions never read taxonomy terms**: an earlier draft scoped role assignments to taxonomy branches. That conflates two different questions — _what is this content about_ (classification, editable by contributors) and _who may change it_ (authority, not theirs to grant). Tying them means adding a tag for discoverability silently hands another group edit rights, and any contributor who can edit an item can change who else can. Roles ended up flat and site-wide instead, which makes the rule simpler rather than harder: nothing anywhere derives a permission from a term. Taxonomies stay purely about classification.

## Data model sketch

**Field types (v1 set):**
text, richtext, number, boolean, date, select, media, taxonomy reference, **relation** (single or multi-reference to other content items, with reverse lookup), block, repeater/array. *All eleven are built, with editing controls.* A repeater's sub-fields are limited to the value-shaped types — no blocks, no nested repeaters — because a table of tables is a data model rather than a field.

The relation field is a named gap in Wolly — make it a first-class field type from day one, not an afterthought.

**Other entities**, matching what you said you want to keep:

- Taxonomies — content-type-agnostic trees, attachable to any content type. Classification only: they describe what content is about and never determine who may edit it (see Roles & permissions). This is where *departments* live — "this page is about Admissions" — and the demo seeds exactly that tree
- Menus — items point to content items, taxonomy terms, or external URLs
- Media library — assets with alt text and a focal point (alt text feeds the accessibility checker). **No stored variants**: the focal point and crop are data, resolved to a rectangle on demand, so one asset drives every shape without a derivative per use — see the media section below
- Webhooks, API keys, tracking script manager, audit log — standard admin-config entities, low complexity, defer to later phase
- **Email**: Taproot sends exactly one message, the self-service password reset link, and **needs no mail service to run**. The standing constraint was recorded as "nothing sends any email", which was a correct instinct stated one step too far: what has to hold is that `npm run dev` needs no external service, not that no message can ever leave. Self-service reset has no non-email form — an admin handing over a link is the flow that already existed, and it is not self-service — so the constraint moved to where it actually bites. With nothing configured the mailer writes to the server log and the "Forgot your password?" link is hidden, because offering a form whose success message is a lie is worse than not offering one. Delivery is a webhook (`TAPROOT_MAIL_WEBHOOK_URL`) taking flat JSON, and **no vendor is built in**: Resend, Postmark, SES and SendGrid each have their own payload shape and error semantics, and a CMS that ships no block templates should not maintain four mail adapters. Reset requests are throttled in their own keyspace, separate from sign-in, or asking to reset someone's password would be a way to lock them out of it. As predicted, this needed a sender and not a schema change — `password_reset_tokens.created_by` was already nullable and self-service links record nobody
- Accessibility checker — starts with alt-text presence, heading-order validation in richtext/blocks, and link-text quality; contrast checking against your defined theme tokens is a good v2 add. *Built in Phase 4, and it does check inside blocks and repeater rows — the walk mirrors `validateItemData`'s, because a value validation reaches and the checker does not is a value nobody is checking. Contrast stayed out for the reason the phase entry gives: the checker reads content, and the colours belong to templates it cannot see*
- **Revisions** — every save on a content item creates an append-only revision (author, timestamp, diff-able snapshot), with restore-to-previous. Cheap to build in from the start, painful to retrofit onto existing content later, so it belongs in Phase 1 rather than deferred.
- **SEO sidebar** — per-content-item panel: meta title/description, OG image (falls back to a default per content type if unset), and live search-result / social-card previews. This is really just a structured field group plus a preview renderer, so it can ride along with Phase 1's content editing work rather than needing its own phase.

## Visual content-type builder

Directus-style: add a field, pick its type from a list, configure options (label, required, relation target, etc.) in a form with a live preview — not hand-written JSON. This is a genuine differentiator over Wolly and worth prioritizing early, since it's also the thing that makes the rest of the admin usable for non-technical campus staff.

## Roles & permissions model

- **Base roles**: Admin, Editor, Contributor, Viewer. **Flat and site-wide** — a role is not scoped to anything, and that is the settled answer rather than a first step.
- **Departments are classification, not authority.** An earlier draft of this section built departments as their own entity, with membership, ownership of content items, and role assignments scoped to them. That was a misreading of what "departments" meant here: they describe *what a page is about*, which is exactly what a taxonomy does — and the `department` taxonomy shipped in Phase 1 already does it, with a term tree, an admin UI, and public archives. There is no ownership dimension to narrow a role against, so there is nothing for a scoped model to scope.
- **What this costs, stated honestly**: a contributor who can edit one page can edit every page. For a campus with many departmental contributors that is a real limitation, and the answer if it starts to bite is a **per-content-type permission matrix** — Directus's model, a role × content type table read inside the existing guard helpers. That is a genuine retrofit but a small one: no ownership, no membership, and no rules about who may reassign what.
- **Workflow states** per content item: Draft → In Review → Scheduled → Published → Archived, with role gates on transitions (Contributor can create/edit Draft and submit to Review; Editor approves and publishes; Admin bypasses).
- **Field-level permissions**: explicitly a stretch goal, not MVP. Wolly doesn't do this either, and it's a meaningfully bigger lift (per-field write checks at the API layer) — don't let it block v1.

Note that the flat role model is **already built**: `packages/astro/src/runtime/guards.ts` ranks the four roles behind named capability helpers used by every admin screen and every API route. The screens to administer it are built too — creating users, changing roles, deactivating, and set-password links — pulled forward out of Phase 3 by the switch to email/password sign-in, which left a deployment with no way to add a second person. What Phase 3 still owes is workflow transitions, a scheduler, and the audit log.

One rule worth keeping when the workflow arrives: **the last active administrator cannot be demoted or deactivated**. A CMS with no admin cannot be administered back into having one, and the first-run setup screen refuses to help because users exist.

**Phase 3 must not assume the CMS and the site share a process.** Phase 3.75 splits them apart, and these are close to free while the role model is being worked on and expensive once it already exists:

- **Permission checks take a principal, not a user row.** An API key is a non-human principal holding scopes, and it arrives in Phase 3.75. Guards written against `User` — the current `canEditContent(taproot.user)` shape — would then have to be rewritten wholesale or handed a forged user, so give them a principal from the start. The MCP note under the phase plan wants exactly the same thing.
- **"What may this requester see" is one function in core, called by every reader.** Today it is a single `publishedOnly` boolean. Draft, review, and scheduled make it a real question, and the delivery API will have to answer it identically — a permission rule implemented twice is a security bug with a long fuse. Same argument as SEO fallbacks resolving in core so that a preview and the published page cannot disagree. This has already bitten once inside the admin: publish permission was implemented three separate times, and each copy checked `status === 'published'` and therefore missed both `scheduled` and un-publishing.
- **Scheduled publishing needs to be readable by a future scheduler.** A scheduled item currently just becomes visible when its timestamp passes, evaluated per request against the database, with nothing anywhere to invalidate. Once the site is a separate deployment reading cached HTTP, "goes live at 9am" needs a purge or a short TTL. Phase 3 doesn't have to fire the webhook, but it should store publish-at somewhere one can later find it.

## Content Releases (batched, coordinated publishing)

The Sanity-style feature: stage changes across many content items into a named batch (a "Release"), then publish the whole batch at once — manually or on a schedule. This is the right feature for "tuition changes across a dozen pages" or "a big event that touches the homepage, an events page, and three department pages, all going live at 9am on the same day."

It's more complex than a single item's scheduled publish, worth naming clearly:

- A content item can simultaneously have a **live published version** and a **pending version staged in one or more open Releases**. That means the data model needs to track versions-per-release, not just current-vs-draft.
- Publishing a Release means atomically (or as close to atomically as the platform allows) publishing every item's staged version in that batch — partial-failure handling matters here (what happens if item 4 of 12 fails validation at publish time?).
- Depends on Revisions and the Draft/Review/Scheduled workflow already being solid — build this _after_ Phase 3, not alongside it, since it's a coordination layer on top of both.
- Permissions question worth deciding when you get here: can a Contributor add their department's item to a Release someone else created, or only an Editor/Admin?

Given the dependency on revisions + workflow + scheduling all being stable first, and that it's a genuinely large feature, it gets its own phase below rather than being folded into Phase 3.

**Built, in Phase 3.5.** Every bullet above survived contact; see the phase entry for what each turned into. The one framing worth correcting here: this section describes a release as a coordination layer over revisions and workflow, which undersold it. Until releases existed there was **nowhere for a pending version of a live page to wait at all** — `content_items` holds one row per item, so editing a published page changed what visitors saw at the moment of the save. That, rather than the batching, is what the feature adds; batching is what makes it worth a screen.

## URL structure & path resolution

Explicitly solving what Wolly (and most flat-page CMSes) don't: content should be able to nest under URLs like `/admissions/how-to-apply`, not land as siblings of everything else.

- **Hierarchical content types** get a self-referential `parent` field. Not every content type needs this — decide per type whether it's Page-like (nests under a parent) or Collection-like (flat, type-prefixed URL, e.g. `/events/spring-open-house`).
- **Materialized path**: store a denormalized `path` column (parent's path + own slug), indexed and unique. Sibling slugs only need to be unique under the same parent, not site-wide — that's what lets `/admissions/apply` and `/financial-aid/apply` coexist.
- **Cascading renames/moves**: renaming or re-parenting a node has to update every descendant's path. A recursive CTE (`WITH RECURSIVE`, works in SQLite/D1 and Postgres) can pull the whole subtree and bulk-update it in one query. This is the part that makes people avoid building this feature — it needs to actually be implemented, not special-cased away.
- **Auto-redirects on path change**: every path change should write a redirect record (old path → new path) automatically, not rely on someone remembering to add one manually. This is where the Redirects feature (liked from Wolly) earns its keep — move it out of the later integrations bucket and build it alongside hierarchy in Phase 1, since it's the same underlying mechanism.

**Delivering this to Astro**: since content is DB-backed and hosted on Workers, there's no need for a full static rebuild per publish (a real advantage over the git-based approach ruled out earlier). One catch-all Astro route (`[...path].astro`) resolves the request path via a single indexed lookup against the `path` column at request time (SSR), then renders through the matched content type's template + `BlockRenderer`.

**Caching was a blind 60-second edge TTL** (`cache-control: s-maxage=60`), deferred deliberately rather than overlooked: an invalidation scheme needs something to invalidate *against*, and the cache boundary genuinely moved in Phase 3.75 when the site became a separate deployment reading the delivery API over HTTP. That blocker cleared, and **Phase 5.5 is where the deferred work landed**. Drafts are `no-store` regardless, and the TTL survives as the backstop rather than as the only mechanism.

What replaced it is tags rather than the Cache API or KV this section originally imagined. A delivery response now names what the page depends on — `item:`, `type:`, `block:`, `menu:` — in a `Cache-Tag` header *and* in the payload, because two caches need the list: the studio tags its own cached JSON, and a consumer tags the HTML it renders from that JSON and cannot derive the dependencies itself. Writes declare what they invalidated and the middleware purges once, after the response, which is after the write committed.

Two things learned doing it, both worth keeping in view:

- **The headers had never done anything on the target platform.** Cloudflare caches no HTML or JSON by default, and a Worker's own response is not cached unless the Worker opts in (`"cache": { "enabled": true }` in `wrangler.jsonc`). `s-maxage` had been shipping since the split and had stored nothing. Verifying a header is present is not verifying it had an effect — the same lesson the preview-pane width rule records, one layer down.
- **The ETag was saving the wrong resource.** It was computed *after* `resolveDelivery` had run every query, so a 304 cost exactly what a 200 did; it saved a payload, and payload egress is the part Cloudflare does not bill. The validator is now answered from one indexed lookup before anything resolves.

Phase 3.75 moves that lookup behind the delivery API. The catch-all still resolves a path in one round trip, but the round trip is HTTP to the Taproot server and the indexed lookup happens there — which is what turns the cache in front of it from an optimisation into the thing keeping every page render off the network.

## Singletons / global options

Drupal's "options page" pattern (weather closure banner, site-wide announcements) has no Wolly equivalent — worth adding as its own content model concept, not bolted onto an existing content type.

- **Singleton**: a content type flagged so exactly one item ever exists — no create/delete, just edit. Uses the same field-type system as regular content types, so a "Weather Banner" singleton is just fields (enabled, message, severity/style, optional link, optional expiry). Favor several independent singletons (Weather Banner, Site Announcement, Footer Info) over one big options blob, so each stays independently permissioned and fast to fetch.
- **Delivery uses the same pipeline as everything else.** A couple minutes' latency for a rebuild is acceptable for this use case, so singletons don't need special-case dynamic delivery (KV/Server Island) — publish a singleton, it triggers a rebuild like any other content change. Keep the dynamic-sliver approach in mind only as a future optimization if rebuild times ever grow large enough to matter; it's not a Phase 1 requirement.
- **Workflow is a per-content-type setting, not tied to singleton-ness.** Whether a type requires draft/review before publish should be configurable per type (including singletons) in Phase 3's workflow model — a small campus might want the weather banner to publish immediately with no review, while a larger deployment with more contributors might want oversight even on singletons. Don't hardcode "singletons skip review."
- **Singletons should be stageable in Content Releases too** — a release bundling a footer-info change alongside a batch of regular content changes for coordinated launch is a reasonable use case. Make sure the Content Releases data model (Phase 3.5) treats singletons as just another item type it can stage, not a special case it excludes.

## Media: focal point & multi-aspect-ratio cropping

Sanity's hotspot/crop tool is worth replicating: store the focal point and crop as data independent of pixels, not as a single baked-in crop.

- **Hotspot**: normalized (0–1) x/y coordinates marking the focal point of the image.
- **Crop**: normalized top/bottom/left/right offsets from the original image bounds.
- Both live on the media asset itself, independent of any specific rendering size — so the same stored data drives a hero-banner crop, a square thumbnail, and a portrait card, each computed on demand rather than pre-generated and stored per shape.
- **Editor UI**: show the source image with several aspect-ratio preview frames around the same hotspot, updating live as the editor drags the focal point — the point is seeing all the shapes this image will actually be used in at once, not just one crop.
- **Delivery**: `TaprootImage` resolves the stored hotspot and crop into a rectangle and renders a real `<img>` scaled and offset inside an aspect-ratio box — no derivative files, no transform service, and it works identically under `npm run dev`. Cloudflare's Image Resizing supports gravity/focal-point cropping as a request-time transform, so the same rectangle can be handed to a CDN later; that is a change of `src` rather than of shape, and it belongs with the image-transform endpoint in Phase 3.75 because it cannot be exercised on Node.
- Scope as a fast-follow within Phase 1's media library (basic upload/library first, hotspot editor as the next increment) rather than its own phase — the data model addition is small even though the UI deserves real attention.

## Phased build plan

**Phase 0 — Foundation**
Data adapter (Kysely + SQLite for dev), Astro integration skeleton, OAuth login, hardcoded/simple content-type CRUD (even raw JSON schema temporarily) just to prove the model end to end.

**Phase 1 — Core content editing**
Visual content-type builder (v1 field set above, including relation), content item CRUD, media library, taxonomies, menus, revisions, SEO sidebar, hierarchical paths + redirect-on-move, path resolution + Astro catch-all route, singletons.

**Phase 2 — Blocks & page composition**
Block field type, page composition, Reusable Block promotion + usage tracking, a starter set of common block presets, `BlockRenderer` for Astro.

**No regions.** This phase originally said "region-based page composition", copying WollyCMS. It was built without regions and should stay that way: a `block` field is already an ordered list with its own `allowedBlocks` and `maxBlocks`, and a content type may declare as many as it likes — so a site wanting a header slot and a sidebar slot declares two block fields and names them. A separate region entity would duplicate both constraints and add a second place for a block's position to live. The bet is that a rich enough data model lets a site simulate whatever region structure it wants. "Region" survives in the admin's own copy as a description of one block field, not as an entity.

The presets are the *demo site's*, not Taproot's: `apps/web` seeds hero, call to action, prose, quote, and gallery block types and supplies an Astro component for each. Taproot ships no block templates, because a CMS that shipped a hero component would be shipping a design.

**Phase 3 — Workflow** *(complete)*
The draft/review/schedule/publish workflow with role gates, a scheduler that actually flips a scheduled item live, and an audit log. The workflow is a transition graph in core rather than a status column, so an illegal move is refused for everyone including admins; scheduling is visible-on-read plus a sweep, so it works with no cron wired up; the audit log is append-only and records consequential actions rather than every save. The sweep runs as a Cloudflare cron trigger on the same Worker that serves the site — `@astrojs/cloudflare` only supplies `main` when the wrangler config does not, so naming `src/worker.ts` and re-exporting the adapter's `handle` alongside a `scheduled` export gets both handlers out of one deployment. An earlier note claimed the adapter made that impossible and that a second Worker plus a shared secret were required; the HTTP endpoint and `TAPROOT_CRON_SECRET` survive for platforms without their own cron, and nothing on Cloudflare needs either.

**User management already shipped**, ahead of this phase and out of order: making email/password the primary sign-in method meant a deployment had no way to add a second person, which is not a state to leave a CMS in. Creating users, assigning roles, deactivating, and set-password links are all built. Materially smaller than this phase used to be: it was scoped around departments as an ownership entity and a role model narrowed to them, and both were dropped once departments turned out to be classification — which Phase 1's taxonomies already deliver. The flat role model is already built and enforced; what is missing is the screen to administer it. Read the constraints at the end of the Roles & permissions section before starting; they are what keep Phase 3.75 from turning into a rewrite of this one.

**Phase 3.5 — Content Releases** *(complete)*
Batched staging and coordinated publish, manual or scheduled, across multiple content items. Two tables — `releases` and `release_items` — plus a screen each, a sweep, and the role split below.

The open questions this section listed are now answered, and each answer was smaller than the question:

- **Versions-per-release**, as predicted. `release_items` carries its own `title`, `slug`, `data`, and `seo` rather than pointing at a revision. A revision records what the live item *has been*; staging by reference would mean every edit to a not-yet-live version wrote a line into the history of a page that never showed it. It also makes the staged copy editable, which is the feature.
- **Partial-failure handling is pre-flight, not atomicity.** "What happens if item 4 of 12 fails validation at publish time" cannot be answered with a transaction: D1 has none spanning N item updates, and each item's publish is already its own batch of path rewrites, redirects, and a revision. So the check moved earlier — every staged version is validated before anything is written, which turns the common failure into "nothing happened, here is what to fix". `release_items.published_at` makes the residue of a genuinely unexpected failure resumable rather than a puzzle. A release publishes through `updateItem`, never around it, so a staged slug change cascades and writes its redirects exactly as a rename does.
- **The permissions question — can a Contributor add to a Release someone else created — is yes.** Staging is not publishing: a staged version reaches nobody until an editor publishes the release, which is the same shape as submitting for review. Gating it at editor would mean the people who write the content could not assemble the launch it is for. Publishing stays at editor, and that is not a new rule so much as the existing one arriving by another route — every transition into `published` already needs it, and a release must not be a way to make a change `canChangeStatus` would refuse one item at a time.
- **Singletons stage like anything else**, as this doc asked. Nothing special-cases them.

Two things worth carrying forward. An item may sit in several unpublished releases at once — the doc asked for it and it is a real hazard, since whichever publishes last wins, so both screens name the conflict rather than the schema forbidding it. And **a scheduled release genuinely needs the sweep**, unlike a scheduled item: an item's visibility is computed on read, while a release's content has to be *applied*, which no page view can do. That asymmetry is on the system screen, in the handbook, and in `publishDueReleases`' own comment, because it is the one place "scheduling works with no cron wired up" stops being true.

`blocked` is the one status that needs justifying: a scheduled release whose pre-flight fails at 3am has nobody to tell, and leaving it `scheduled` would sweep the same broken content every minute forever. A release refused while somebody is *looking* at the screen just shows them the reasons and stays put.

**Phase 3.75 — Standalone server & delivery API** *(complete)*
Split the one package into a deployable CMS and a thin Astro client, correcting the Phase 0 misreading recorded under Core architecture decisions.

Sequenced in two halves so there is a working site and a green suite at every commit. **3.75a is done**: API keys, principals, the delivery API, ETags, and type generation — with `apps/web` deliberately untouched and still reading the database directly. That is what makes `delivery.test.ts` able to assert the two paths agree, using the embedded route's own methods (`getItemByPath`, `getChildren`, `ancestorPaths`, `resolveSeo`, `resolveMenu`) as the expectation. **3.75b** is the rename, the consumer package, the `apps/web` rewrite, cross-origin preview, and deleting the embedded path — at which point that comparison stops being possible, so it is written now.

Three things 3.75a settled that this section had left open:

- **The `termHref` question below is answered: unresolved targets.** `deliverMenu` returns `{ type: 'term', taxonomyApiId, slug, name }` and the consumer applies `applyTermHrefs` with exactly the resolver it would have passed to `resolveMenu`. Moving the decision server-side was the alternative and would have been wrong — which taxonomies deserve public pages depends on the routes a site actually serves, so the CMS cannot know it. "Taproot has no opinion about term URLs" survives the split intact.
- **The Phase 3 constraint about guards taking a principal had not been done**, and cost more to add later exactly as predicted. What landed is narrower than the wording implied and better for it: the *auth layer* takes a principal, and the role guards still take `User | undefined`. Making every guard take a principal means each grows a branch that only ever says "not this kind of thing", and forty admin call sites carry a wrapper they never inspect; converting at the boundary gets the same guarantee from the type system, since `principalUser` returns `undefined` for a key and no key can produce a `User`. The two constraints that *were* honoured — one visibility function, publish-at where a scheduler can find it — are why the rest was tractable.
- **`handle()` stays session-only and `handleScoped()` is the opt-in.** A route that says nothing about keys does not accept one, which is what keeps a `content:read` key out of the admin REST API.

The shape is settled:

- **API-only.** The HTTP delivery API is the contract for reading content. `Astro.locals.taproot` and direct database access stop being a public affordance — the server keeps them for its own admin screens, where there is no second implementation to drift from.
- **`npm create taproot` scaffolds the server**, an Astro app the user owns and deploys to Workers + D1, which keeps the v1 hosting decision intact. A Docker image is a later convenience rather than part of this phase; zero native dependencies means it will be a genuinely small one when it comes — Wolly needs a specific Node version to compile `better-sqlite3`, and `node:sqlite` needs nothing. **Built, though after Phase 4 rather than within 3.75** — the phase was declared complete without it, which meant that for two phases there was no way for anyone to start a Taproot project at all: this monorepo was the only deployment that could exist. It scaffolds the server and only the server, prompting for a blank database or a minimal starter, and its `--local` mode depends on a checkout through `file:` specifiers so the generator is verifiable before anything is published. Six of its template files are byte-identical to `apps/studio` and a test asserts it, because the scaffolded copies are the ones nobody here runs.
- **One monorepo.** `apps/studio` is the server; `apps/web` is rewritten from embedded demo into the reference consumer, so that a drift between the two halves of the contract fails `npm test` here rather than surfacing in someone else's project.
- **API keys move here from Phase 5**, because a second project cannot read content without them. They are also the first non-human principal in the role model, which is why Phase 3's guards need to take one.

Genuinely new work, as opposed to work that merely moves: a delivery API returning blocks already resolved, reusable-block dereferencing included, so that a page is not N round trips; cross-origin preview, since `?preview=1` currently works only because the session cookie is same-origin; absolute media URLs and an image-transform endpoint, since the site no longer serves `/uploads` itself; ETags and cache headers; and type generation from the live content model — the current client is typed over table rows, and a consumer wants types for their own content types. That last one is the point of the split rather than a nicety.

One thing to decide here rather than discover: `resolveMenu` takes a `termHref` **callback**, and a function cannot cross an HTTP boundary. Either the endpoint returns unresolved targets and the client builds hrefs site-side, or "Taproot has no opinion about term URLs" needs revisiting.

This lands after Content Releases rather than immediately after Phase 3 because Releases changes what "published" means — versions staged per release, not simply current-vs-draft — and a delivery API built before it would have its visibility rules plumbed twice.

**Phase 4 — Accessibility checker v1** *(complete)*
Alt-text presence, heading order, and link-text quality, surfaced inline in the editor — plus a
site-wide report, which this section did not ask for and which the feature is close to useless
without: a campus site arrives with content already written, and "every page has a panel now" is not
a plan for fixing any of it.

Four decisions worth keeping:

- **Advisory, never blocking.** Nothing the checker finds refuses a save or a publish. The
  alternative — a gate on the transition into `published`, the shape `releasePreflight` already
  has — was rejected because an author who cannot publish on a checker's say-so routes around the
  CMS, and every false positive becomes an outage. `validateItemData` is where a rule that *must*
  hold goes; this is where a rule that should usually hold goes, and the two are deliberately not
  the same code path.
- **The rules are a pure function and the resolution is a separate file.** `checkItemAccessibility`
  takes fields, data, and a lookup context — no database handle — which is what lets the editor's
  React island run it on every keystroke and what makes each rule testable on its own.
  `accessibilityReport.ts` is the half that finds the content and resolves what the rules need. Same
  argument as `resolveSeo`: one implementation, so the panel and the report cannot disagree.
- **`alt_text` is three states, not two.** `null` is "nobody has said"; `''` is "somebody decided
  this needs no description". Without that distinction the rule is unusable — every divider, icon,
  and background flourish is a permanent complaint, and a panel that is always red is one nobody
  reads. Four screens asked the question as `!altText`, which is also true of `''`, so the answer is
  one exported `needsAltText` rather than four places to remember.
- **Heading order is checked within one rich text value, not across the page.** Taproot ships no
  templates and does not know what order a site renders a content type's fields in, or whether it
  renders all of them, so the outline a visitor actually receives is not knowable here. Within one
  value it is knowable exactly. This is a real limit rather than a shortcut, and it is stated in the
  handbook because "why didn't it catch the h2 after my block's h3" is the first question anyone
  asks.

The report is a **scan, not an indexed query**, and says so on screen: it works through 50 items at
a time and reports how far it got rather than a site-wide issue total, because a true total means
reading every row and a quietly capped one is worse than none. Undescribed *images* are the
exception and are asked separately, as a real query — that one also catches an image uploaded and
not yet placed, which no item scan can see.

**Phase 4.5 — Live split-view preview** *(complete)*
The site rendered beside the editor, following what is being typed. Not in the original plan at all — this document had "preview" only in the narrow senses of an SEO card, a field-builder preview, and the cross-origin token 3.75b delivered.

The reason it fits rather than contradicting "Taproot ships no templates": **the CMS still renders nothing.** The rendering stays on the consumer, which resolves the page server-side as it always did; what crosses the gap is the editor's unsaved form state, parked on the existing preview token and merged over the live row exactly as a release's staged version already was. A renderer inside the CMS would have been the second read path this document rules out under "one contract, one set of docs, nothing to drift."

Four decisions worth keeping:

- **The snapshot is a rendering input, not a version.** It carries no status, path, or parent; it is never listed, diffed, restored, or published, and it dies with its token in thirty minutes. That is what keeps "a release is the only place a content item can have a version that is not live" true rather than merely narrowly worded. The moment anything reads it back into the editor as recovered work, this becomes a draft store and Content Releases is the feature it duplicates badly.
- **Sanitising is not relaxed; completeness is.** The snapshot goes through `validateItemData` like every other write, with one option that turns off exactly three rules — `required`, text `minLength`, repeater `minItems`. A minimum is a statement about completeness and a maximum is a bound on what the system will carry, and only the first kind is a question a half-typed form may fail. The richtext transform runs before any of it.
- **A token stays a capability over one item.** The delivery route now applies the override only when the requested path is the token's own. It ignored `path` entirely before, which was invisible while the only caller was a redirect straight to `item.path` — and would have made every page render as the item being edited the moment a frame could follow a link.
- **Zero consumer integration, with an optional upgrade.** A site that already forwards the token gets a working pane. Two lines (`<TaprootPreviewBridge />`) upgrade the refresh from a frame remount to a reload from inside, which is what keeps the scroll position. Requiring it would have made the first-run story a setup error.

**Phase 4.6 — Admin UI pass** *(complete)*
Seven things noticed from using the admin, split so each can be redirected between.

**A — chrome** *(complete)*. One sticky action bar per screen (`PageHeader.astro`, except the item editor where the island owns it because Save is React state). Status transitions became a promoted named action plus a "More" disclosure — `primaryTransition` in core decides which is promoted, and `published` deliberately promotes nothing. Add-to-release moved from a banner into Publishing and now stays on the item instead of navigating away. The sidebar's user block became a menu with an avatar. Plus a repair: two files had been shipping cp1252 mojibake since `ff9af26`, and `sourceEncoding.test.ts` now guards it.

**B — linking** *(complete)*. Link to content by title with autocomplete, stored as `taproot:item:{id}` and resolved to the current path at delivery, so a rename keeps the link working — the same "reference the target, never store a URL" rule menus already follow. Links to media files (`taproot:media:{id}`) work the same way, so a link to a prospectus survives the file being replaced.

**Images in rich text were considered and refused**, which is why `img` is still absent from the allowlist. A reference-only `<img data-taproot-media>` resolved at delivery would have kept alt text in the library — but not the hotspot, because `set:html` cannot produce a `TaprootImage`, so an image in prose would be the only one on the site ignoring its focal point. An image in a paragraph is a block's job.

**C — branding** *(complete)*. A configurable accent, CMS title and logo, in a one-row `settings` table. Status colours stay fixed, as planned: `--color-status-published` is byte-identical to `--color-accent` today by coincidence, and a free accent hue would put Published on top of Review.

Contrast is derived where it can be and reported where it cannot, and that split is the decision worth keeping. The hover shade, the label on a solid button, and the subtle tint all follow from the chosen colour, because each is a question with a right answer — offering the button label as a choice is offering a way to make Save unreadable. Whether the colour is dark enough to be *link text* is a property of the colour itself, so it is measured live and said plainly, with nothing blocked: an institution whose brand colour fails is better served by being told exactly what will be hard to read than by being refused.

Two things fell out of building it that were not visible from the plan. Sweeping the hue circle rather than checking the default green found that moving the hover shade *away from the surface* — the obvious rule — walks a pale accent's dark label below 4.5:1 on hover while it passes at rest; hover moves away from the **label** instead. And the accent is link text inside the rich-text editor, a pair `a11y-contrast.mjs` had never checked in the four phases that token has existed.

**B needed a second pass**, which was not planned and should have been. Linking worked, and its controls were a row of fields wrapped into the editor's toolbar strip: unusable at the ~400px the editor column becomes with the preview pane open, and unable to answer "where does this link currently point?", because a reference is correct and unreadable. One dialog now covers a page, a file, and a web address, opens on the kind already there, and names it. Two defects only a real browser could show — a modal takes focus and the selection goes with it, and React propagates events through a portal's React tree into the item editor's form, so Apply saved the page instead of linking. Every test passed, because they all rendered the editor on its own.

**Phase 5 — Editing, querying, and assistance**
Seven things noticed from using the admin, sub-lettered so each can be redirected between. **Integrations moved to Phase 6 and the form builder to Phase 10** — the old Phase 5 was one sentence and had never been started, so moving it costs nothing, and numbering this band 4.7/4.8 would both misdescribe it as polish on top of Phase 4 and produce a `4.10` that sorts before `4.7`.

Four of the seven are editor-experience defects in screens that already exist and change nothing about the delivery contract. Two of them — the query field and consumer search — need the same missing capability: **a way to ask a question about content that is not "give me this path."** That shared need sets the boundaries, and is why they are sequenced adjacently rather than in the order they were asked for.

`5A → 5B → 5C` is a *file-conflict* ordering rather than a logical one: all three rewrite the field-render bodies in `ItemEditor`, `BlockListEditor` and `RepeaterField`, and the latter two also share `validation/fields.ts`, `FieldControl`, `FieldConfigForm`, `typegen.ts` and `content/accessibility.ts`. Adjacent, never concurrent, smallest diff first. `5C → 5D` is the one hard dependency. 5E and 5F are independent of everything.

**5A — expand/collapse-all** *(complete)*. Blocks had per-row collapse from the start and repeater rows had none, so a staff list of thirty rows buried every field below it and the two composition editors behaved differently for no reason anyone could state. `useCollapsible` is now shared by both, with an "Expand all" / "Collapse all" pair from two rows up — **two buttons rather than one toggle**, because `aria-expanded` describes the state of what a control owns and this one owns many panels in freely mixed states.

Two things fell out of building it that were not visible from the plan. The default has to stay **expanded**, and not for ergonomics: the audit runs `runScripts: 'outside-only'`, so what axe sees is the island's server-rendered markup, and a collapsed panel is `hidden` and therefore skipped entirely. And the audit was **already** missing both editors — it picks the item editor by field count, which is a fact about the content type, while composition is a fact about the item, and the field-count winner on the seeded database had zero blocks placed and zero repeater entries. That is the third instance of the same route-selection trap; the two envelopes are now counted separately, because they sit on different items and one combined score leaves repeaters unaudited.

**5B — conditional field visibility** *(complete)*. Show the banner's message only when the banner is switched on — which the seeded weather-banner singleton now demonstrates, since it already had exactly that shape and showed both fields regardless. A single condition — `{sibling field} {is checked | equals | is not | is set | is empty} {value}` — evaluated by **one pure function in core** that both `validateItemData` and the editor island call, for the same reason `resolveSeo` lives there.

It goes on a nullable `visible_when` column on `fields`, not in `fields.config`: a condition is a property of *a field*, not of a field type, and config would mean adding a key to all twelve type schemas. Repeater sub-fields need the same key because `repeaterRowFields` synthesises its rows from config rather than the table; block types get it free, a block type being a content type. Three rules, each of which had a plausible wrong answer: the condition is evaluated against the **raw input**, not the accumulating `parsed`, or a controller positioned after its dependent is not yet there and the rule silently depends on field order; a hidden field reuses `requireComplete: false`'s existing three-rule relaxation rather than inventing a fourth path, so richtext sanitising still runs; and a **hidden field's value is kept**, because dropping it makes validation a destructive transform driven by a rule an admin can edit later — a content-type edit becoming a silent content wipe on every item's next save. A dangling condition fails **open**, which is why the evaluator takes the sibling names from the schema rather than inferring them from the data.

Two things fell out of building it. The a11y checker's two walks had to **diverge**: the rules walk skips hidden fields, because nagging about content the editor has switched off makes the panel permanently red, while `collectMediaIds` does not, because a hidden field's value is still stored and an image referenced only from one would otherwise be reported as undescribed. And `typegen` has to emit a conditional field **optional whatever `required` says** — "required" there means "required when shown", so a non-optional emit is the CMS promising something it does not enforce, and the consumer dereferences `undefined` on a build that type-checks clean.

**5C — the `query` field.** *(complete)* A saved query embedded in a block: upcoming events in the Arts category, faculty filtered by the department taxonomy. The config bounds what is queryable and the stored value holds the editor's chosen filters, which is what lets one "faculty" block be reused per department page.

Built in two halves so there was a working midpoint. **5C-i** is the field itself — filtering by content type and by taxonomy term with branch expansion, five named sorts, and a live preview in the editor showing the count and the first few titles. **5C-ii** is `content_item_values`, the derived index that makes "events whose *own* start date is upcoming, soonest first" expressible at all: `data` is TEXT holding JSON, and every other read into it in this codebase is a `LIKE` prefilter verified afterwards in JS.

Four decisions worth keeping:

- **A derived index rather than `json_extract`.** Reading the JSON in place needs different syntax per dialect — the first dialect-branched query building in the repo — and is an unindexed scan unless an expression index exists per content type per field. Plain columns sort and range-filter identically on all three backends. The precedent is `taxonomy_assignments`, deliberately: same status (not the source of truth), same rebuild point (the item's write batch), so a restored revision restores it.
- **Three value columns, not one.** `'10' < '9'` is true as text, so a numeric ordering stored as text is wrong in a way that looks plausible on screen. Dates are normalised through `Date` before storing for the same reason — an all-day `2030-05-01` sorts *before* `2030-05-01T09:00:00Z` as raw text and would drop out of a window it belongs in.
- **"Upcoming" is stored as an intent, never as a timestamp.** A stored bound is frozen at whatever moment somebody last pressed save, so the page quietly stops listing anything the day after it was edited — the same trap a stale `publish_at` is. The preview endpoint resolves it the same way, and does its own lookup of the nominated date field rather than trusting the parameter, so the editor's count and the published page cannot diverge precisely when the configuration is wrong.
- **A reindex command is part of the phase.** The migration creates the table empty and cannot fill it — that needs each content type's field definitions and a walk over stored JSON — so until `npm run db:reindex` has run, every query field filtering or ordering by a value answers as though nothing matched.

Two things fell out of building it that were not visible from the plan. `ITEM_SORTS` needed its own importless module, because `items.ts` and `validation/fields.ts` already point at each other and the query field's value schema has to validate a sort. And the seeded event dates had all quietly slipped into the past — which cost more than it looks, because the scheduled item had already published and no longer demonstrated the status it exists to demonstrate, and an "upcoming" listing had almost nothing left to list. Fixed dates are still right for idempotency; they just need to be far enough out to stay fixed.

A result carries the item's **whole `data` minus `block` and `query` fields**, with its references resolved into the existing lookup maps. No per-field configuration: if the editor chose which fields came back, a template would silently render nothing the day somebody unticked "location". A query result is the item's fields, not its page composition — and excluding those two types is also what stops a query inside a queried item fanning out recursively.

Results **cannot land in `data[apiId]`**, which holds the saved query and has to stay usable for a write, so `DeliveryResult` gains a fourth top-level map beside `media`/`references`/`terms`, keyed `${containerId}:${fieldApiId}` — a query field can sit inside a block inside a repeater row, and both envelopes already carry an `id` the consumer can derive the key from.

Filtering and sorting on a value inside `data` goes through a **derived value index** rebuilt in the item's write batch, exactly as `taxonomy_assignments` already is — not `json_extract`, which would be the first dialect-branched query building in the repo and an unindexed scan besides. Split the phase: type, taxonomy, parent and status filters with column sorts need no index at all and ship first; only "upcoming events sorted by their own date" needs it. **A reindex command is part of the phase, not a nicety** — existing content is invisible to every query until it is indexed, and a migration cannot do it.

**5D — full-text search** *(complete)*, offered to consumer sites. A derived text index, flattened with the existing `htmlToText` — whose docstring has always named search indexing. Originally queried with the repo's lowercased `LIKE` idiom and ranked with `CASE`, on the reasoning that "all three dialects share one migration set with no branching, and buying real ranking means two index implementations that must agree plus promoting Postgres from 'wired but not the tested target' into a second real code path". **Both halves of that have since been revisited and it is now FTS5** (`0025_item_text_fts`): D1 does document FTS5, including `fts5vocab` — the belief that it did not was true of an earlier D1 and was never rechecked — and Postgres was removed rather than promoted, so there is no second dialect for a second implementation to disagree with. `content_item_text` survives as the durable, exportable half that the index is built from; `bm25` replaced the body-ranking `CASE` bands, while the *title* bands were kept, because the index is built over prose and holds no title. The trade was explicit: this is what committing to Cloudflare bought. `planDerivedIndexes` was extended rather than joined by a second planner, or the two indexes are rebuilt at different write points and one goes silently stale. The admin's own cross-type search reads the same function, or the CMS ships a worse search than the sites it serves.

Built as one predicate and one order. The matching lives in `ItemFilters.search` — the clause the content list and its **status facets** already shared — so the admin, the delivery listing's `q`, and `GET /delivery/search` narrow identically; the ranking is five `CASE` bands applied when a search has no explicitly named order. `relevance` is deliberately **not** in `ITEM_SORTS`: that set is the query field's sort menu, validated into saved queries and emitted into the generated types, and "most relevant" offered to a listing with no search term is a choice that answers an editor by ignoring them.

Four things fell out of building it that were not visible from the plan.

- **The block walk had to run on saves that carry no content.** `updateItem` rebuilds the indexes from stored `data` on *every* save, but the block registry was loaded only on the branch that validates new content — so a publish, a rename or a status change walked the blocks with no schemas to walk them by and wrote an index with every block's prose missing. Nothing errors and the page still renders; the content simply stops being findable, on the action most likely to be the last one anybody takes. `search.test.ts` pins it and the mutation was run: dropping that branch fails exactly one test.
- **The registry is loaded once and gated on placed blocks**, the same data-driven gate `resolveDelivery` applies on the read path — validation and the text walk both need it, so fetching it twice was two queries for one map, and a content type that merely *offers* a block field has nothing to index.
- **A reusable block contributes nothing, and that is a stated limit.** Reaching the library entry needs a read inside a planner that is synchronous by design, and — the real objection — every referencing page's index would have to be rebuilt whenever the entry changed, which nothing on that write path can trigger. Same shape as a referencing page's revision recording *that* it referenced the entry rather than what it said.
- **"Nobody reindexed" and "nothing matched" are the same empty page**, and the second index made that worse: a missing value row makes a listing answer nothing, where a missing text row makes search answer *less* — no error, no empty result, just pages absent from the middle of a list nobody can check. Settings → System reports the unindexed count for that reason, and the row is written even when an item holds no prose so the two states stay distinguishable.

**5E — media multi-upload and bulk alt text.** One POST carrying several files, with an explicit cap on count and bytes, which is what keeps the plain server-rendered form working where N client-side POSTs would fork the no-JS path. The bulk describe screen has to honour all three alt states — blank is `null`, the Decorative checkbox is `''` — because a grid where blank means "skip" either marks images decorative by omission or wipes existing descriptions. It is reachable from the accessibility report, which today links undescribed images out one at a time; that is the higher-value half and was not in the original ask.

**5F — menus: link chooser, new tab, nofollow.** `open_in_new_tab` already exists end to end and is simply not exposed in the admin; `no_follow` is genuinely new. `ALLOWED_REL` gets exported so menus and rich text share one vocabulary rather than holding two opinions about `rel`. The three target `<form>`s are replaced by `LinkDialog` with a fourth `term` panel, which also fixes a real defect: the item `<select>` is capped at 200, so a site with 300 pages has ~100 that cannot be put in a menu at all. **This is the one place the band overrides a documented decision** — menus work with JavaScript off today and will not afterwards — and it is recorded rather than slid through.

**5G — AI assist.** Provider keys come from the **environment**, with Settings reporting set/not-set and never the value, exactly as the system screen already does for the cron secret; the settings row holds provider, model and feature toggles. That keeps the repo's "no encryption at rest anywhere" true rather than introducing AES and a new required secret. Every affordance is gated on an `available` flag, the way the mailer's `delivers` gates the forgot-password link — a Generate button that 500s because nobody set a key is the same failure as a form whose success message is a lie.

Thin `fetch`-based adapters, no SDKs. That sits in tension with the mailer's "no vendor SDK or per-provider adapter" rule and resolves the other way for a stated reason: mail had a generic shape available and AI does not, and a webhook indirection here would be strictly worse than pasting a key. Alt text needs the image **bytes**, read through the storage adapter — not a URL, which may be unreachable from the Worker. Nothing generated is ever written straight to the row: it fills the input for a human to accept, because a machine writing `''` would silently mark an image decorative, which is the one thing the three-state rule exists to prevent.

**Phase 5.5 — Performance and caching** *(complete)*
The deferred caching work from the URL-structure section above, now that Phase 3.75 has given it a boundary to invalidate against. Edge caching turned on for both deployments, `Cache-Tag` emitted by the delivery API and carried in the payload so a consumer can tag its own HTML, writes declaring what they invalidated, the ETag answered before the page is resolved rather than after, and the read path's remaining N+1s removed.

Two costs found by measuring rather than reading: the five-minute housekeeping sweep was running **two full table scans** on unindexed columns forever, and `blockTypeRegistry` scanned `content_types` on **every page view** including pages with no blocks. Migration `0020_perf_indexes` and a gate fix those; `npm run query-count` and `queryPlans.test.ts` are what stop them coming back. Note the trap the plan walked into and had to be corrected on: indexing both sides of `purgeStaleResetTokens`' `or` changed the query plan by *nothing at all* — SQLite's OR-to-union optimisation does not fire there — so the delete had to be split into two statements to spend the indexes. Measured with `explain query plan` at 0 and 20,000 rows.

**Phase 5.7 — Purge repair** *(complete)*
The site-side purge loop, plus the repairs that had to come first. Raising the TTL from 60s to a day
exposed that purging was substantially broken and had always been: `SITE_TAG` was emitted on **no
response at all**, so publishing a release and running the scheduler purged nothing; reusable
blocks, menus, content types, fields, taxonomies and terms had no `invalidate` call; the three
listing endpoints emitted no `Cache-Tag`, making them purgeable by nothing; and the cron sweep had
no execution context to purge from. Each was invisible at 60s and a day-long bug at 86400.

Sharpest of them: **an ETag that cannot change turns bounded staleness into unbounded staleness.**
A shared cache revalidates rather than refetching when a TTL lapses, the CMS answered 304 because a
library edit touches no referencing row, and RFC 9111 §4.3.4 says a 304 *refreshes* the stored
copy's freshness — so it renewed itself forever. `deliveryCache` now folds
`reusableBlockLibraryVersion` into the validator. Verified against a live deployment, which answered
304 to a tag whose page had changed.

The purge callback itself is a row plus an HTTP POST: Cloudflare scopes purging to the Worker that
owns the cache, so the CMS cannot reach a consumer's HTML directly. A failed purge is queued in
`pending_purges` and retried by the five-minute sweep with backoff, then reported on Settings →
System — because "never throws" also means "never tells anybody", which is affordable at 60s and not
at a day. The consumer flushes wholesale rather than by tag, since `/delivery/items` and
`/delivery/menu` expose no `cacheTags` and a listing page therefore cannot derive its own
dependencies.

**Phase 6 — Integrations**
Webhooks, tracking script manager, MCP server, and workflow notifications. Grouped because they share the outbound-HTTP layer and the API-key scope layer. (The cache-purge callback into a consumer site was grouped here for the same reason and shipped early in Phase 5.7 — raising the TTL made it a prerequisite rather than an integration.) (Redirects moved to Phase 1 — see URL structure section above. API keys moved to Phase 3.75, which cannot ship without them.)

**MCP server exposure** belongs here rather than on the radar: let AI agents query/create/update content through an MCP server rather than raw REST. The visual content-type builder already gives every content type an introspectable typed schema, and API keys already provide an auth/scoping mechanism that doubles as agent-access control. Note that `API_KEY_SCOPES` is a **one-element array** today, consumed with a cast that assumes a non-empty tuple — MCP and webhooks both need a second scope, and that expansion is a small but non-zero piece of this phase.

**Phase 7 — SEO component in `@taprootcms/astro`**
All the SEO markup is hand-written in the reference consumer's layout today. Known gaps: `ogImageSource` is dropped at delivery, so a component cannot distinguish an inherited image from an own one; `resolveSeo` and `canonicalUrl` are main-barrel-only and unreachable from `pure.ts`; there is no site name, no site-level SEO settings on any delivery endpoint, no JSON-LD, and no sitemap surface.

**Phase 8 — Per-content-type permission matrix**
The extension named under Roles & permissions as the answer when flat site-wide roles stop being enough. A genuine retrofit but a small one — no ownership, no membership, no rules about who may reassign what.

**Phase 9 — i18n**
Worth knowing before it is designed: `fields.localized` already exists in the schema and is written by the field builder, and nothing reads it. There is a stub here already, which is either a head start or a trap depending on whether the eventual design wants per-field localisation at all.

**Phase 10 — Form builder & handling (far future, not near-term scope)**
Just capturing it so it's not forgotten: a form builder (fields, validation, conditional logic) plus submission handling/storage and notification routing. Nowhere near the start — revisit once Phases 0–6 are stable. Note that 5B's conditional visibility is the same shape as this phase's "conditional logic" and should be reused rather than rebuilt.

## Decisions already made (no longer open)

- One site per deployment — no multi-site/multi-tenancy.
- Departments are **classification**, and the `department` taxonomy shipped in Phase 1 is the whole of them. There is no departments entity, no per-item ownership, and no role scoped to a department. Reversed from an earlier draft of this doc, which had it the other way round; see Roles & permissions.
- Roles are flat and site-wide: Admin, Editor, Contributor, Viewer. A per-content-type permission matrix is the extension to reach for if that stops being enough.
- Hosting target for v1 is Cloudflare Workers + D1.
- Admin UI library is shadcn/ui, with the accessibility caveats noted above.
- Taproot is a standalone CMS server plus a separate thin Astro client talking to it over HTTP — **not** one package that injects an admin panel into the host site. Phases 0–2 shipped the latter because this doc originally misdescribed Wolly's architecture; Phase 3.75 corrects it, and the original wording is preserved under Core architecture decisions so the mistake isn't made twice.
- The delivery API is the only supported way a site reads content. No dual embedded/HTTP mode — one contract, one set of docs, nothing to drift.
- The server is scaffolded with `npm create taproot` and lives in this monorepo as `apps/studio`; `apps/web` becomes the reference consumer rather than staying an embedded demo.
- The split happens after Phases 3 and 3.5, not before. Roles, workflow, and Content Releases land first.

## Using this with a coding agent

Feed Phase 0 + Phase 1 as the first brief, not the whole doc at once. Let the agent finish and stabilize a phase before handing it the next one — the visual content-type builder (Phase 1) and the roles model (Phase 3) are the two places worth the most human review before moving on, since they're the parts genuinely different from Wolly.
