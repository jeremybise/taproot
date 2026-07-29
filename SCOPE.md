# Taproot — Scoping Doc v0.1

**Project name: Taproot.** No known collision with any existing CMS or web-dev tool. Heads up for context: there's an unrelated, older Bitcoin protocol upgrade also called Taproot (crowds npm/GitHub search results with cryptocurrency libraries, but no product competition), and a real 501(c)(3) nonprofit called the Taproot Foundation (skills-based volunteering, unrelated field). Neither is a legal blocker. npm packages should be published under an `@taproot` org scope (a free namespace, not a company) — see below.

## What this is

A DB-backed, Astro-native CMS. WollyCMS's block/region page-building and content-modeling breadth, EmDash's portable-database philosophy, Directus's visual schema authoring, plus real role-scoped permissions and a built-in accessibility checker — aimed at a real-world use case (a campus website with many non-technical departmental contributors), not just a personal blog.

Git-based storage (Markdoc/MDX-in-repo) is explicitly ruled out for this use case: campus staff won't use GitHub, and per-department permissions need an app-level data layer, not repo ACLs.

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
- **Block** — the general composition primitive placed into a page's regions (hero, CTA, gallery, rich text, etc.)
- **Reusable Block** — a Block instance promoted to a shared library, referenced by ID from multiple content items, usage-tracked so it warns/blocks on deletion while still referenced
- **Content Type** — user-defined schema (fields, not raw JSON) that content items conform to

## Core architecture decisions

- **Data layer**: portable SQL adapter (Kysely-style) so the same codebase runs on SQLite (dev), Postgres, or Cloudflare D1 — matches your comfort with either Node or Cloudflare, don't lock to one.
- **Media storage**: S3-compatible interface (local disk/S3 in Node, R2 on Cloudflare).
- **Framework integration**: Astro integration package exposing admin panel, REST API, typed client, and a `BlockRenderer` component — same shape as Wolly's `@wollycms/astro`.
- **Auth**: OAuth (Google/GitHub/Microsoft) + TOTP, same as Wolly — no reason to change this part.
- **Hosting target for v1**: Cloudflare Workers + D1, decided. Keep the data adapter portable regardless, but build and test against this first.
- **Single site, no multi-tenancy**: departments are a permission scope within one site, not separate site instances. Simplifies the roles model and removes a whole class of routing/deployment complexity.
- **Permissions are their own model, not a taxonomy**: an earlier draft of this doc scoped role assignments to taxonomy branches. That conflated two different questions — _what is this content about_ (classification, editable by contributors) and _who is responsible for it_ (authority, not theirs to change). Tying them means adding a tag for discoverability silently grants another department edit rights, and any contributor who can edit an item can change who else can. The department/permission model gets its own entities in Phase 3; taxonomies stay purely about classification. See the Roles & permissions section.

## Data model sketch

**Field types (v1 set):**
text, richtext, number, boolean, date, select, media, taxonomy reference, **relation** (single or multi-reference to other content items, with reverse lookup), block, repeater/array.

The relation field is a named gap in Wolly — make it a first-class field type from day one, not an afterthought.

**Other entities**, matching what you said you want to keep:

- Taxonomies — content-type-agnostic trees, attachable to any content type. Classification only: they describe what content is about and never determine who may edit it (see Roles & permissions)
- Menus — items point to content items, taxonomy terms, or external URLs
- Media library — assets with alt text, focal point, variants (alt text feeds the accessibility checker)
- Webhooks, API keys, tracking script manager, audit log — standard admin-config entities, low complexity, defer to later phase
- Accessibility checker — starts with alt-text presence, heading-order validation in richtext/blocks, and link-text quality; contrast checking against your defined theme tokens is a good v2 add
- **Revisions** — every save on a content item creates an append-only revision (author, timestamp, diff-able snapshot), with restore-to-previous. Cheap to build in from the start, painful to retrofit onto existing content later, so it belongs in Phase 1 rather than deferred.
- **SEO sidebar** — per-content-item panel: meta title/description, OG image (falls back to a default per content type if unset), and live search-result / social-card previews. This is really just a structured field group plus a preview renderer, so it can ride along with Phase 1's content editing work rather than needing its own phase.

## Visual content-type builder

Directus-style: add a field, pick its type from a list, configure options (label, required, relation target, etc.) in a form with a live preview — not hand-written JSON. This is a genuine differentiator over Wolly and worth prioritizing early, since it's also the thing that makes the rest of the admin usable for non-technical campus staff.

## Roles & permissions model

This is the reason the git-based approach didn't work, so it's worth designing deliberately rather than bolting on later.

- **Base roles**: Admin, Editor, Contributor, Viewer.
- **Scoping**: a role assignment can be scoped to a content type, a **department**, or specific content items — this is what lets each department manage only its own content.
- **Departments are their own entity**, not taxonomy terms. They are an organisational fact about who is responsible for content, and they need properties a taxonomy has no business carrying: membership, and rules about who may reassign ownership. A department tree and a Department _taxonomy_ may well both exist — one for authority, one for "this page is about Admissions" — and they should not be the same rows. An earlier draft of this doc made them the same thing; see the note under Core architecture decisions for why that was wrong.
- **Ownership is assigned, not tagged**: changing which department owns a content item must require a higher role than editing that item, or a contributor can hand their own work to someone else — or take someone else's.
- **Unowned content fails closed**: an item with no department is editable by admins only, and the admin surfaces the list so it does not accumulate invisibly.
- **Workflow states** per content item: Draft → In Review → Scheduled → Published → Archived, with role gates on transitions (Contributor can create/edit Draft and submit to Review; Editor approves and publishes; Admin bypasses).
- **Field-level permissions**: explicitly a stretch goal, not MVP. Wolly doesn't do this either, and it's a meaningfully bigger lift (per-field write checks at the API layer) — don't let it block v1.

## Content Releases (batched, coordinated publishing)

The Sanity-style feature: stage changes across many content items into a named batch (a "Release"), then publish the whole batch at once — manually or on a schedule. This is the right feature for "tuition changes across a dozen pages" or "a big event that touches the homepage, an events page, and three department pages, all going live at 9am on the same day."

It's more complex than a single item's scheduled publish, worth naming clearly:

- A content item can simultaneously have a **live published version** and a **pending version staged in one or more open Releases**. That means the data model needs to track versions-per-release, not just current-vs-draft.
- Publishing a Release means atomically (or as close to atomically as the platform allows) publishing every item's staged version in that batch — partial-failure handling matters here (what happens if item 4 of 12 fails validation at publish time?).
- Depends on Revisions and the Draft/Review/Scheduled workflow already being solid — build this _after_ Phase 3, not alongside it, since it's a coordination layer on top of both.
- Permissions question worth deciding when you get here: can a Contributor add their department's item to a Release someone else created, or only an Editor/Admin?

Given the dependency on revisions + workflow + scheduling all being stable first, and that it's a genuinely large feature, it gets its own phase below rather than being folded into Phase 3.

## URL structure & path resolution

Explicitly solving what Wolly (and most flat-page CMSes) don't: content should be able to nest under URLs like `/admissions/how-to-apply`, not land as siblings of everything else.

- **Hierarchical content types** get a self-referential `parent` field. Not every content type needs this — decide per type whether it's Page-like (nests under a parent) or Collection-like (flat, type-prefixed URL, e.g. `/events/spring-open-house`).
- **Materialized path**: store a denormalized `path` column (parent's path + own slug), indexed and unique. Sibling slugs only need to be unique under the same parent, not site-wide — that's what lets `/admissions/apply` and `/financial-aid/apply` coexist.
- **Cascading renames/moves**: renaming or re-parenting a node has to update every descendant's path. A recursive CTE (`WITH RECURSIVE`, works in SQLite/D1 and Postgres) can pull the whole subtree and bulk-update it in one query. This is the part that makes people avoid building this feature — it needs to actually be implemented, not special-cased away.
- **Auto-redirects on path change**: every path change should write a redirect record (old path → new path) automatically, not rely on someone remembering to add one manually. This is where the Redirects feature (liked from Wolly) earns its keep — move it out of the later integrations bucket and build it alongside hierarchy in Phase 1, since it's the same underlying mechanism.

**Delivering this to Astro**: since content is DB-backed and hosted on Workers, there's no need for a full static rebuild per publish (a real advantage over the git-based approach ruled out earlier). One catch-all Astro route (`[...path].astro`) resolves the request path via a single indexed lookup against the `path` column at request time (SSR), then renders through the matched content type's template + `BlockRenderer`. Front it with Cloudflare's Cache API/KV, invalidated on publish, for static-like speed with on-publish freshness.

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
- **Delivery**: Cloudflare's Image Resizing supports gravity/focal-point-based cropping as a request-time transform parameter, so hotspot+crop data can be passed straight through at render time rather than needing to pre-generate every possible crop — fits the Workers+R2 stack already decided on.
- Scope as a fast-follow within Phase 1's media library (basic upload/library first, hotspot editor as the next increment) rather than its own phase — the data model addition is small even though the UI deserves real attention.

## Phased build plan

**Phase 0 — Foundation**
Data adapter (Kysely + SQLite for dev), Astro integration skeleton, OAuth login, hardcoded/simple content-type CRUD (even raw JSON schema temporarily) just to prove the model end to end.

**Phase 1 — Core content editing**
Visual content-type builder (v1 field set above, including relation), content item CRUD, media library, taxonomies, menus, revisions, SEO sidebar, hierarchical paths + redirect-on-move, path resolution + Astro catch-all route, singletons.

**Phase 2 — Blocks & page composition**
Block field type, region-based page composition, Reusable Block promotion + usage tracking, a starter set of common block presets (hero, CTA, gallery, rich text, staff card), `BlockRenderer` for Astro.

**Phase 3 — Roles & workflow**
Departments as a first-class entity (membership, ownership of content items), scoped role model, draft/review/schedule/publish workflow, audit log. Departments are built here rather than in Phase 1 because nothing before this phase consumes them — Phase 1's taxonomies classify content, they do not own it.

**Phase 3.5 — Content Releases**
Batched staging and coordinated publish (manual or scheduled) across multiple content items. Build only once Phase 3's revisions and workflow states are stable — see the Content Releases section above for why.

**Phase 4 — Accessibility checker v1**
Alt-text presence, heading order, link-text quality, surfaced inline in the editor.

**Phase 5 — Integrations**
Webhooks, API keys, tracking script manager. (Redirects moved to Phase 1 — see URL structure section above.)

**Phase 6 — Form builder & handling (far future, not near-term scope)**
Just capturing it so it's not forgotten: a form builder (fields, validation, conditional logic) plus submission handling/storage and notification routing. Nowhere near the start — revisit once Phases 0–5 are stable.

**On the radar, no timeline yet**

- **MCP server exposure** — let AI agents query/create/update content through an MCP server rather than raw REST. Not scoped in detail yet, but worth building Phase 5's API/API-keys layer with this in mind, since the visual content-type builder already gives every content type an introspectable typed schema, and API keys already provide an auth/scoping mechanism that could double as agent-access control. Cheaper to keep this in mind now than to retrofit a second auth model later.

## Decisions already made (no longer open)

- Departments are a permission scope within a single site — no multi-site/multi-tenancy.
- Departments are their own entity, designed in Phase 3. They are **not** taxonomy terms, and taxonomies carry no authority — reversed from an earlier draft of this doc, see Core architecture decisions.
- Hosting target for v1 is Cloudflare Workers + D1.
- Admin UI library is shadcn/ui, with the accessibility caveats noted above.

## Using this with a coding agent

Feed Phase 0 + Phase 1 as the first brief, not the whole doc at once. Let the agent finish and stabilize a phase before handing it the next one — the visual content-type builder (Phase 1) and the roles model (Phase 3) are the two places worth the most human review before moving on, since they're the parts genuinely different from Wolly.
