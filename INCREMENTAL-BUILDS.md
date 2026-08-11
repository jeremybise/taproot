# Astro incremental builds

**This is an exploration, not a decision.** [SCOPE.md](SCOPE.md) is where settled decisions live and
this is not one yet. It exists so the question can be answered from evidence rather than from
instinct, and so that whoever answers it inherits the traps rather than finding them.

Astro 7.2 shipped `experimental.incrementalBuild`. It is the first time a build-time posture has
been cheap enough to be worth costing out for a Taproot consumer, and the question it raises is not
"should Taproot become a static site generator" — it should not — but "should a site that wants to
prerender some of its content pages be able to, without giving up correctness".

The answer this document argues for: **yes, for a collection at a time, and the version has to be
computed by the CMS rather than by the site.** Two independent properties of Astro's build make a
consumer-side dependency manifest impossible on the target platform, and both are verified below.

Claims about Astro are cited against `withastro/astro` `packages/astro/src` at `main`
(7.2.x); claims about this repository are cited as `path:line`.

---

## 1. What the feature actually is

Every trade-off below follows from this contract, so it is worth stating tightly.

- `experimental: { incrementalBuild: true }` in the Astro config.
- **Only pages returned from `getStaticPaths()` that carry a `cacheKey` can be skipped.** Everything
  else — including static pages that do not use `getStaticPaths` — renders on every build. A path
  whose `cacheKey` is `undefined` is always rendered and never cached
  (`astro: core/build/generate.ts:621`), which makes omission the correct fail-open and means you
  never have to invent a sentinel.
- A page is reused only when **both** its `cacheKey` and its route's module-graph hash match the
  previous build. Astro owns the code side; the `cacheKey` is the data side and is entirely the
  caller's problem.
- The cache lives in `cacheDir` (`node_modules/.astro/` by default). `outDir` is emptied at the
  start of every build and skipped pages are restored from `cacheDir`, so **CI must persist that one
  directory or every build is cold** — with no error, only a slow build.
- Changing the Astro config *or* the project's dependencies invalidates the entire cache. Paths
  dropped from `getStaticPaths()` have their cache copies pruned. `astro build --force` bypasses.
- Stated limitations: the cache is **disabled when `build.concurrency > 1`** (a warning, not an
  error — `astro: core/build/generate.ts:115-118`; the default is already 1); server islands
  re-render unless `ASTRO_KEY` is stable; changes to middleware do not invalidate cached pages.

Sources: the [experimental flag reference][astro-docs] and the [7.2 release notes][astro-720].

This repository pins `astro ^7.1.4` in all three apps and peers `^7.0.0` in `packages/astro` and
`packages/studio`, so any of this needs a minor bump first.

[astro-docs]: https://docs.astro.build/en/reference/experimental-flags/incremental-build/
[astro-720]: https://astro.build/blog/astro-720/

### Three behaviours worth knowing before reading further

**It works in `output: 'server'`.** `generatePages` is called from both the `static` and the
`server` branch of the build (`astro: core/build/static-build.ts:211` and `:217`), and the
incremental cache is constructed with no output-mode condition. Prerendering one route inside an
otherwise on-demand site gets the same treatment as a fully static build.

**A prerendered dynamic route has an SSR fallback, and this is the most useful fact here.** The
assumption that unmatched paths simply 404 is wrong (`astro: core/app/base.ts:313-325`):

```ts
// Prerendered routes are served as static files by the hosting layer.
// When the first match is a prerendered *dynamic* route, try to find
// a non-prerendered route that can serve this path. Dynamic prerendered
// routes only cover their specific static paths, so an SSR route with
// the same pattern should handle all other URLs.
if (routeData.prerender) {
  if (routeData.params.length > 0) {
    const allMatches = this.pipeline.matchAllRoutes(this.safeDecodeURI(pathname));
    return allMatches.find((r) => !r.prerender);
  }
  return undefined;
}
```

So a path that was not built falls through to a non-prerendered route matching the same pathname.
Almost everything in §6 that looks like it breaks does not, provided the SSR catch-all is left in
place — which is why the shape recommended here is **a prerendered route added beside
`[...path].astro`, not `prerender` flipped on it**.

**The dependency hash is per route, over the transitive module graph's transformed code**
(`astro: core/build/plugins/plugin-incremental.ts:27-48, 87-97`). Two consequences, one of which is
a real cost and one of which kills an obvious design:

- `[...path].astro` imports `BLOCK_COMPONENTS` from `apps/web/src/blocks/index.ts`, which imports
  every block component. **Editing any one of them re-renders every page on the route.** The lockfile
  hash likewise walks up to the first directory holding one (`astro: core/build/lockfile/finder.ts:38-57`),
  which in this monorepo is the root `package-lock.json` — so a dependency change anywhere in the
  workspace, including `apps/studio`, invalidates `apps/web`'s cache.
- Anything reachable from the page whose *contents* vary between builds invalidates the route. See
  §4.

---

## 2. Why Taproot is unusually well placed

Two of the three things an incremental build needs are already built, and neither was built for
this.

**Enumerating what to build is one paged sweep.** `/delivery/items` with no `type` parameter applies
`contentTypeHasItemPages` implicitly ([items.ts:177](packages/studio/src/api/delivery/items.ts)),
because an index of everything is a list of links and a collection with item pages turned off has no
URL to link to. That is exactly the routable path set, and drafts are excluded for free. At 200 rows
per request ([items.ts:156](packages/studio/src/api/delivery/items.ts)) a 3,000-page site enumerates
in fifteen.

**Knowing what a page depends on is already computed.** `resolve`'s payload carries `cacheTags`
([delivery.ts:487-520](packages/core/src/content/delivery.ts)) — `SITE_TAG`, the item's own `item:`
and `type:`, a `type:` per listing it performs, an `item:` per breadcrumb ancestor, per child, per
relation target and per query match, a `block:` per reusable block and a `snippet:` per snippet.

**Triggering a rebuild needs nothing at all.** Webhooks carry `item.published` and `item.updated`
with a subject naming `path`, `contentType` and `status`, where `path` is null for a type with no
item pages ([subjects.ts:33](packages/core/src/webhooks/subjects.ts)) so a rebuild never fetches an
address the site answers 404 at. `createTaprootWebhookHandler`'s own worked example
([webhook.ts:17](packages/astro/src/webhook.ts)) is `if (event.event === 'item.published') await
rebuild(event.subject);`. This is the one piece of the story that is finished.

---

## 3. The trap: the delivery ETag is not a cacheKey

The delivery API already computes a per-page validator that looks exactly like what `cacheKey` asks
for — a short string that changes when the page's data changes:

```
W/"{itemId}-{updatedAtMs}-{libraryVersion}"
```
— [cache.ts:137](packages/studio/src/api/delivery/cache.ts)

Reusing it is the obvious implementation and it is wrong, for a reason invisible from the code:
**the ETag is sound only because tag purges evict behind it.** It does not move when a menu is
edited, when a media asset's alt text or hotspot changes, or when a seventh event publishes into a
page listing "the six soonest". In the running system each of those writes purges a tag, the stored
response is evicted, and the validator is never consulted against a payload it would get wrong.

**A build has no purge, and no TTL.** Nothing evicts a `cacheKey` and nothing expires it. Under
`incrementalBuild` those same edits produce pages that are stale *permanently*, and every subsequent
build re-confirms the staleness. The build succeeds, the page renders, the bytes are wrong, and
nothing throws or logs. Same shape as the `OUTPUT_QUALITY` bug and the format-less `output()` bug:
correct picture, wrong bytes, only measurement finds it.

The related lesson is already recorded once here.
[libraryVersion.ts](packages/core/src/content/libraryVersion.ts) exists because a validator that
cannot move is not bounded by the TTL but *unbounded*, since RFC 9111 §4.3.4 makes a 304 refresh the
stored copy. **A `cacheKey` that cannot move is that bug with the TTL removed** — and every
tolerance elsewhere in this repository phrased as "costs a stale reference for the shared TTL" stops
applying the moment there is no TTL. That sentence appears verbatim in
[cacheTags.ts:22-28](packages/core/src/content/cacheTags.ts) and in
[libraryVersion.ts:19-20](packages/core/src/content/libraryVersion.ts), and both need re-reading
against a build cache rather than read across.

---

## 4. The version has to be computed by the CMS

The natural design is for the site to record each page's `cacheTags` during a build, persist them
in `cacheDir`, and resolve them against a stamp endpoint on the next build's `getStaticPaths`. It
does not work, for two independent reasons, either of which is sufficient.

**It invalidates itself.** `getStaticPaths` runs inside the page module, so anything it imports is
in that route's transitive graph, and the hash is over each module's *transformed code*
(`astro: core/build/plugins/plugin-incremental.ts:87-97`). A virtual module holding last build's
manifest has contents that change whenever any page's dependency set changes — which changes the
route's dependency hash, which fails the skip check for **every path on the route**. A Vite `define`
has the same shape. The manifest defeats itself by existing.

**And it cannot be read from disk on the target platform.** The escape — `node:fs` inside
`getStaticPaths` — works under `@astrojs/node` and not under `@astrojs/cloudflare`, which supplies
an out-of-process prerenderer so non-Node runtimes can render (`astro:
types/public/integrations.ts:280-300`, which names workerd; `@astrojs/cloudflare`'s own
`prerenderer.ts`). A `globalThis` side channel fails for the same reason: the page and the
integration are not in one process.

There is a third problem that would remain even if those two were solved. **The recorded tag set is
not a sound dependency set for a build**, in three specific ways:

- **Truncation drops exactly the tags nothing else covers.** `normalizeCacheTags` caps at 200 by
  breaking in emission order ([cacheTags.ts:113-126](packages/core/src/content/cacheTags.ts)), and
  the emission order puts `blockTag` and `snippetTag` **last**
  ([delivery.ts:487-520](packages/core/src/content/delivery.ts)). Those two exist precisely because
  a reusable block or a snippet edited in the library changes what a page renders *without touching
  its row* — so the first tags discarded are the only ones covering the case no row-derived
  validator can see. Tolerable behind a TTL, unbounded without one.
- **`item:` dominates and carries no type.** Breadcrumbs, children, relation targets and query
  matches all arrive as `item:{uuid}`. A `{ site, types }` endpoint cannot stamp them, and a
  reference to an item with `item_pages` off is not in the enumeration sweep either.
- **A dependency set can change with no recorded tag moving.** Publish a child of a *different*
  content type: `createItem` writes only the child's row, so the parent's `updated_at` does not
  move, the parent's tags name neither the new child nor `type:event`, and the parent is skipped
  with its "in this section" list permanently short. This is already a hole in the edge-cache purge
  scheme — bounded by `s-maxage` — and cross-type hierarchies are explicitly supported here
  ([CLAUDE.md](CLAUDE.md), "A `page`'s parent need not share its content type").

### `GET /api/taproot/delivery/build-index`

The CMS can see the whole graph cheaply and already owns the read contract, so put the version
there and leave the site with nothing to get wrong.

```
GET /api/taproot/delivery/build-index?limit=500&offset=0
→ { total: 1743, paths: [ { path: "/admissions/apply", version: "a3f…" }, … ] }
```

`getStaticPaths()` becomes: page through it, return `{ params, cacheKey: version }`. No manifest, no
carry-forward, no module-graph contamination, identical under Node and workerd, and the entire
soundness argument in one server-side function with a test suite beside `delivery.test.ts`.

What `version` folds in, and what each term is there to catch:

| Term | Catches |
|---|---|
| `id`, `updated_at` | edit, publish, unpublish, status change, cascading move, release apply — everything the existing ETag covers, and the cascade does stamp descendants |
| `publish_at` bucketed against now | a scheduled item crossing its moment, which writes no row at all |
| `max(updated_at)` over path ancestors | breadcrumb titles and ancestor renames |
| `max(updated_at)` **and `count(*)`** grouped by `parent_id` | a new, deleted or unpublished child — including the cross-type case today's tags miss |
| `max(updated_at)`, `count(*)` per type, for `dependencyTypes(itemType)` | listings, `query` fields, relation cards |
| `contentLibraryVersion` | reusable blocks and snippets, reused verbatim from [libraryVersion.ts:29-42](packages/core/src/content/libraryVersion.ts) |
| a site stamp over menus, media, taxonomies, terms, content types, fields, settings | everything `SITE_TAG` covers |

Two things about that table are load-bearing.

**`count(*)` beside every `max(updated_at)`.** A `max` does not move when a row is deleted — or
moves *backwards* if the deleted row was the max. Deletion is invisible to a high-water mark, and
enumeration only covers it for items that had a path of their own.

**`dependencyTypes(T)` is derived from the schema, not from what a page matched.** For content type
`T`: `{T}`, plus the target of every `relation` and `query` field, recursing into the block types
`T` can place (bounded by `MAX_BLOCK_DEPTH`, as the search walk already is), and every type if any
query is untyped. That is single digits, so `MAX_CACHE_TAGS` never enters the picture, and it
over-approximates in the safe direction: a `page` placing no listing still carries `type:event`,
costing an unnecessary render and never a stale one. The rule `resultFields` already states applies
— the failure to fear is the silent one.

**Two operational rules that are not optional.**

`getStaticPaths` must **fail the build on a partial fetch**, never return a short list. A truncated
enumeration reads to Astro as "these paths were removed", and their cache copies are pruned — so one
transient CMS hiccup silently discards cache. Assert `paths.length === total`.

**Version the hash input.** When a term is added to the table above, every key must move once. That
is one full rebuild, and it has to be automatic rather than remembered.

### `getStaticPaths` must not fetch the content

`getStaticPaths` returns `props: { path }` and nothing more; `resolve()` stays in the page
frontmatter, which Astro does not run for a skipped page. So a skipped page costs zero delivery
requests and zero `resolveDelivery` query fan-out at the CMS. Putting the resolved payload into
`props` — the natural thing, since the data is right there — makes every build fetch all N pages
whether or not it renders them. The build gets faster; the CMS does not.

---

## 5. What is left for an integration

With the version server-side, `taprootIncremental()` stops being the mechanism and becomes three
things an integration is genuinely the right shape for:

- **Write `_redirects` in `astro:build:generated`**, whose `dir` is the client output
  (`astro: types/public/integrations.ts:436-440`). This hook runs before the Cloudflare adapter's
  own `astro:build:done`, which reads an existing `_redirects` and appends to it, so ordering is
  right for free.
- **Refuse to boot on a misconfiguration** in `astro:config:setup`: `build.concurrency > 1`, which
  Astro only warns about; a missing `ASTRO_KEY` where server islands are in use.
- **Assert the cache is behaving** in `astro:build:done`. A cache that silently skips everything
  looks exactly like a cache working perfectly, so log rendered-versus-skipped and fail a build that
  skips 100% after a known publish. This is the repo's "assert the tag is on the wire" discipline
  applied one layer up.

It must not `injectRoute`. [purge.ts:9-11](packages/astro/src/purge.ts) records that
`@taprootcms/astro` is a plain library and the site owns its own paths; an integration that only
reads config, writes into `dir` and validates takes none of that away. Its docblock should say so,
because the next person will read `purge.ts` and conclude the rule was abandoned.

**One separate gotcha:** integrations and the adapter are dropped from the config hash, which only
includes serialisable values (`astro: core/build/config-hash/input.ts:12`).
[apps/web/astro.config.mjs:30](apps/web/astro.config.mjs) picks its adapter from `TAPROOT_TARGET`,
so a Node build and a Cloudflare build sharing one `cacheDir` will restore each other's pages. The
cache directory has to be keyed by target.

---

## 6. What prerendering costs, given the SSR fallback

The shape assumed here is **a prerendered route added beside the SSR catch-all**, with the page body
extracted into a shared `PageView.astro` so there is one implementation and two entry files.
Flipping `prerender` on `[...path].astro` gives up the fallback and most of what follows.

**Redirects keep working, unchanged.** A redirect source names no item, so it is in no
`getStaticPaths`, so it misses the static layer and reaches the SSR catch-all where
`result.kind === 'redirect'` ([\[...path\].astro:66-68](apps/web/src/pages/%5B...path%5D.astro))
already handles it. This is the strongest single argument for the twin-route shape.

*Rejected, and worth recording:* Astro's config `redirects`. `config.redirects` is in the config
hash (`astro: core/build/config-hash/input.ts:44`), and Taproot writes a redirect automatically on
every rename and every descendant of a moved subtree. An editor renaming one page would invalidate
the entire cache. A `_redirects` file written by the integration has no such problem and is an
optimisation over the fallback rather than a replacement — Cloudflare Pages caps static rules, and
`@astrojs/node` has no equivalent at all.

**Term archives keep working**, for the same reason and with the same code
([\[...path\].astro:80-109](apps/web/src/pages/%5B...path%5D.astro)).

**Preview breaks for one case, and it is the important one.** The pane frames
`{siteUrl}{item.path}?taproot_preview={token}`, and static asset serving keys on pathname, not query
string. Previewing a *draft or unpublished* item works — its path is in no `getStaticPaths`, so the
request reaches SSR and the existing branch runs. Previewing an **edit to an already-published
page** — the draft snapshot and the release-staged version, which is Phase 4.5's split view — serves
the prerendered file and shows the editor the live page while claiming to show their edit. It cannot
be fixed on the consumer side: middleware does not run for static assets, and neither `_routes.json`
nor `run_worker_first` discriminates on a query string. Options: prerender only collections whose
items are rarely previewed; or add an optional preview path prefix to the CMS so the pane opens at
an on-demand route importing the same `PageView.astro`. Do not accept it silently — an editor
pressing Preview and being shown the live page is the "never leave a deployment in a state its own
UI cannot reach" rule with the word *reach* doing different work.

**Scheduled publishing degrades rather than breaking, and the residue is listings.**
`visibleToPublic` computed on read ([items.ts](packages/core/src/content/items.ts)) is what makes
scheduling work with no cron wired up. An item scheduled for 09:00 is not in the 08:00 build, so at
09:00 its path misses the static layer, reaches the SSR catch-all, and renders live and correct. The
prerendered `/events` index built at 08:00 is what stays wrong. So the honest statement is that
**prerendering makes a rebuild trigger mandatory** — and the trigger exists, signed and retried,
with `publishDueItems` firing `item.published` from the five-minute sweep. The cost is up to five
minutes plus a build, against zero today.

**A release publish is a rebuild storm unless debounced.** `INLINE_DISPATCH_LIMIT` means a fifty-item
release dispatches what it can and leaves the rest to the sweep, so a rebuild triggered per
`item.published` fires many times for one release. Prefer `release.published`.

**Every response header set in a prerendered page's frontmatter is discarded**, unless the adapter
declares `staticHeaders`. That is `PAGE_CACHE_CONTROL` ([cache.ts:21](apps/web/src/cache.ts)), the
`frame-ancestors` CSP and `x-robots-tag` on previews
([\[...path\].astro:163-192](apps/web/src/pages/%5B...path%5D.astro)) — all four silently gone. This
is the same class as the two cache bugs already recorded here: a header nobody has observed working.
If a policy is wanted on prerendered HTML it belongs in `_headers` or the static server, and it has
to be verified on the wire.

Downstream of that, **`/taproot/purge` goes inert for prerendered paths.** It calls
`purgeEverything` on the Worker's own cache ([purge.ts:108](packages/astro/src/purge.ts)), and a
prerendered page is not in it. The endpoint stays — it still covers the SSR half — but its docblock's
claim about what it flushes, and `apps/web/src/cache.ts`'s claim that the purge is what makes a long
TTL safe, both stop being true for the prerendered half. Those are prose changes, not just code.

---

## 7. Is it worth it

**For.** The site survives the CMS being down, and the CMS can scale to zero — an availability
posture, not a faster version of the current one. No per-request delivery latency; the comment at
[\[...path\].astro:36-53](apps/web/src/pages/%5B...path%5D.astro) about shaving one serial round
trip is evidence of what that costs today. Warm rebuilds cut CMS query load in proportion to what
changed, which is the specific thing *incremental* buys — without it, prerendering just moves the
load from per-request to per-build. And every cache bug recorded in [CLAUDE.md](CLAUDE.md) is a bug
in keeping a cache correct *over time*; a build either rendered from current data or it did not.

**Against.** [SCOPE.md:109](SCOPE.md) is not a throwaway — the whole URL-structure section is built
on request-time resolution, and §6 shows prerendering re-introduces the rebuild-per-publish it ruled
out. Incremental makes that rebuild cheaper, not unnecessary. Preview breaks for the split-view case.
A publish stops being visible in seconds. The warm-rebuild win is narrower than it sounds, because
the dependency hash is per route: editing one block component re-renders everything on it, and so
does any dependency change anywhere in the monorepo. And the whole of §3 and §4 exists because a
build cache has no TTL — this adds a soundness surface on the side where staleness is unbounded.

The feature is also early. Astro has already shipped a fix for `incrementalBuild` re-rendering
unchanged routes because a route's dependency hash depended on the order its assets finished
building ([#17616](https://github.com/withastro/astro/pull/17616)) — a cache-correctness bug in the
half Astro owns, found after release.

**The reading this document lands on.** The defensible posture is not "prerender the site". It is
**prerender the collections that are append-mostly and rarely previewed** — news, events, a course
catalogue — where the page count is highest and the risk is lowest, and keep SSR as the fallback for
everything else. That takes the availability and latency win where it is worth most, keeps
redirects, archives, scheduling and draft preview working through code that does not change, and
never puts the whole site behind a build.

**On measuring it.** The seeded demo has nowhere near enough pages to show a win, so any claim about
build times needs a synthetic large seed and an actual measurement. And `npm run query-count` will
not see `/build-index`, because it measures `resolveDelivery` rather than routes — the caveat
`contentLibraryVersion`'s own docblock already records. Measure its aggregates with
`explain query plan` at 0 and 20,000 rows, per `0020_perf_indexes`.

---

## 8. If the answer is yes

**Stage 0 — repairs that stand on their own merit.** Each is correct today, independent of any of
this. `/delivery/menu` computes `cacheTags` and the route drops them
([menu/[apiId].ts:31-37](packages/studio/src/api/delivery/menu/%5BapiId%5D.ts)) — emit them, which
is what [purge.ts:20-27](packages/astro/src/purge.ts) says it is waiting for. Make truncation
**visible** in `normalizeCacheTags`, since a truncated tag list is currently indistinguishable from
a complete one. Consider whether `createItem` should stamp its parent's `updated_at`, which would
close the cross-type-child hole for the existing edge cache too.

**Stage 1 — prove the routing, with no incremental flag at all.** Extract
[\[...path\].astro](apps/web/src/pages/%5B...path%5D.astro)'s body into `PageView.astro`; add one
prerendered route for a single collection with a **static first segment**, so route priority is
unambiguous (see §9); add a non-prerendered `404.astro`, which does not exist today. Then verify by
measurement: an unbuilt path reaches SSR, a redirect still 301s, a preview token on a *built* path
serves the stale file, and `curl -I` shows no `cache-control`.

**Stage 2 — the endpoint.** `buildIndexVersions` in `packages/core/src/content/`, Kysely-bearing and
therefore never in `pure.ts`; the route registered in
[packages/studio/src/index.ts](packages/studio/src/index.ts), since routes here are injected rather
than files-on-disk. Tests beside `delivery.test.ts` asserting the version moves for each write path —
edit, publish, unpublish, delete, cascading move, same-type child, cross-type child, a scheduled item
crossing `publish_at`, snippet, reusable block, menu, media — and does not move for an unrelated
write. Against the methods each write path uses, not against a second implementation.

**Stage 3 — turn it on.** `experimental.incrementalBuild`; `cacheKey` from `/build-index`, omitted
where absent; a `cacheDir` keyed by `TAPROOT_TARGET`; CI persisting it; skip-ratio assertions.

**Stage 4 — `_redirects` and the integration.** A `/delivery/redirects` endpoint
(`listRedirects` already exists; note the table has `created_at` and no `updated_at`, so it cannot
carry a stamp without a migration), and `taprootIncremental()` per §5.

**Stage 5 — widen, only if 1–4 hold**, and decide the preview question first rather than after.

---

## 9. Unverified

Everything in §1's "three behaviours" and §4's two impossibility arguments was read from Astro's
source and is cited. These four were not settled:

1. **Route ordering between a prerendered and an SSR route at the same pattern.** Astro's comparator
   doc comment claims prerendered routes sort first, but no such comparison appears in the function
   body — with equal segment counts it falls through to `localeCompare`. Stage 1 sidesteps this with
   a static first segment rather than relying on it; if you ever need two catch-alls, test it and
   assert it.
2. **Whether `@astrojs/cloudflare` declares `adapterFeatures.staticHeaders`.** This decides whether
   §6's dropped-headers problem is total or partial.
3. **Whether Workers Assets serves a prerendered file for a request carrying a query string.** The
   preview breakage in §6 depends on it, and it is a five-minute `curl`.
4. **The query-plan cost of `/build-index`'s aggregates**, per §7.
