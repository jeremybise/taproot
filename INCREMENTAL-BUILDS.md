# Astro incremental builds

**This is an exploration, not a decision.** [SCOPE.md](SCOPE.md) is where settled decisions live and
this is not one yet. It exists so the question can be answered from evidence rather than from
instinct, and so that whoever answers it inherits the traps rather than finding them.

Astro 7.2 shipped `experimental.incrementalBuild`. It is the first time a build-time posture has
been cheap enough to be worth costing out for a Taproot consumer, and the question it raises is not
"should Taproot become a static site generator" — it should not — but "should a site that wants to
prerender its content pages be able to, without giving up correctness".

The short answer this document argues for: **yes, and it is about four small pieces, one of which is
a trap that will silently ship broken if it is not understood first.** The parts Taproot would have
to build are small because the hard parts — enumerating routable paths, and knowing what a page
depends on — already exist for other reasons.

---

## 1. What the feature actually is

Every trade-off below follows from this contract, so it is worth stating tightly.

- `experimental: { incrementalBuild: true }` in the Astro config.
- **Only pages returned from `getStaticPaths()` that carry a `cacheKey` can be skipped.** Everything
  else — including static pages that do not use `getStaticPaths` — renders on every build.
- A page is reused only when **both** its `cacheKey` and its route's module-graph hash match the
  previous build. Astro owns the code side: it hashes the template, layouts, components, imported
  assets and package code. The `cacheKey` is the data side and is entirely the caller's problem.
- The cache lives in `cacheDir` (`node_modules/.astro/` by default). `outDir` is emptied at the
  start of every build and skipped pages are restored from `cacheDir`, so **CI must persist that one
  directory or every build is cold** — with no error, only a slow build.
- Changing the Astro config *or* the project's dependencies invalidates the entire cache. Paths
  dropped from `getStaticPaths()` have their old output cleaned up. `astro build --force` bypasses.
- Stated limitations: the cache is **disabled when `build.concurrency > 1`** (a warning, not an
  error); server islands re-render every build unless `ASTRO_KEY` is stable; and **changes to
  middleware do not invalidate cached pages**.

Sources: the [experimental flag reference][astro-docs] and the [7.2 release notes][astro-720].

This repository pins `astro ^7.1.4` in all three apps and peers `^7.0.0` in `packages/astro` and
`packages/studio`, so any of this needs a minor bump first.

[astro-docs]: https://docs.astro.build/en/reference/experimental-flags/incremental-build/
[astro-720]: https://astro.build/blog/astro-720/

---

## 2. Why Taproot is unusually well placed

Two of the three things an incremental build needs are already built, and neither was built for
this.

**Enumerating what to build is one paged sweep.** `/delivery/items` with no `type` parameter applies
`contentTypeHasItemPages` implicitly ([items.ts:177](packages/studio/src/api/delivery/items.ts)),
because an index of everything is a list of links and a collection with item pages turned off has no
URL to link to. That is exactly the routable path set, and every entry carries `updatedAt`. At 200
rows per request ([items.ts:156](packages/studio/src/api/delivery/items.ts)) a 3,000-page site
enumerates in fifteen requests.

**Knowing what a page depends on is already on the wire.** `resolve`'s payload carries `cacheTags`
([delivery.ts:487-520](packages/core/src/content/delivery.ts)) — `SITE_TAG`, the item's own `item:`
and `type:`, a `type:` per listing the page performs, an `item:` per breadcrumb ancestor, per child,
per relation target and per query match, a `block:` per reusable block and a `snippet:` per snippet.
That is a per-page dependency graph, computed at render time, already serialised. It exists because
a consumer tagging its own HTML *cannot derive the dependencies itself*, which is the same reason a
build cannot.

**Triggering a rebuild needs nothing at all.** Webhooks carry `item.published` and `item.updated`
with a subject naming `path`, `contentType` and `status`, where `path` is null for a type with no
item pages ([subjects.ts:33](packages/core/src/webhooks/subjects.ts)) so a rebuild never fetches an
address the site answers 404 at. `createTaprootWebhookHandler`'s own worked example
([webhook.ts:17](packages/astro/src/webhook.ts)) is `if (event.event === 'item.published') await
rebuild(event.subject);`. This is the one piece of the story that is finished.

---

## 3. The trap: the delivery ETag is not a cacheKey

This is the paragraph the rest of the document exists to earn.

The delivery API already computes a per-page validator that looks exactly like what `cacheKey` asks
for — a short string that changes when the page's data changes:

```
W/"{itemId}-{updatedAtMs}-{libraryVersion}"
```
— [cache.ts:137](packages/studio/src/api/delivery/cache.ts)

Reusing it is the obvious implementation and it is wrong, for a reason that is invisible from the
code: **the ETag is only sound because tag purges evict behind it.** It does not move when a menu is
edited, when a media asset's alt text or hotspot changes, or when a seventh event publishes into a
page listing "the six soonest". In the running system every one of those writes purges a tag, the
stored response is evicted, and the validator is never consulted against a payload it would get
wrong.

**A build has no purge.** Nothing evicts a `cacheKey`. Under `incrementalBuild` those same three
edits produce pages that are not stale for a TTL — they are stale *permanently*, and every
subsequent build re-confirms the staleness. The build succeeds, the page renders, the bytes are
wrong, and nothing throws or logs. It is the same shape as the `OUTPUT_QUALITY` bug and the
format-less `output()` bug: correct picture, wrong bytes, only measurement finds it.

The related lesson, already recorded once in this repository, is worth re-reading before touching
any of this: [libraryVersion.ts](packages/core/src/content/libraryVersion.ts) exists because a
validator that cannot move is not bounded by the TTL but *unbounded*, since RFC 9111 §4.3.4 makes a
304 refresh the stored copy. A `cacheKey` that cannot move is that bug with the TTL removed.

---

## 4. The cacheKey design

```
cacheKey = hash( itemId, itemUpdatedAt, stamp(site), ...stamp(t) for t in previousBuildTags(path) )
```

Three inputs, each doing a job the others cannot.

### The per-item stamp

`id` plus `updatedAt`, straight off the `/delivery/items` sweep that `getStaticPaths` is already
making. Free.

### The `site` stamp

One number folding everything `SITE_TAG` covers: menus, media, taxonomies and terms, content types
and fields, settings, snippets and reusable blocks.

Coarse on purpose, and the precedent is exact — this is the blast radius
`createTaprootPurgeHandler` already has, which flushes everything rather than purging the tags it
was sent ([purge.ts:108](packages/astro/src/purge.ts)), for the reason stated there: a listing page
has no way to know what it depended on, so tag-precise purging would silently never invalidate the
index most likely to be stale. Media is the same argument one level down: a media id lives inside
`content_items.data`, so there is no reverse index from an asset to the items placing it.

The query shape already exists. `contentLibraryVersion`
([libraryVersion.ts:29-42](packages/core/src/content/libraryVersion.ts)) is a single `union all` of
two `max(updated_at)` aggregates; this is the same statement with more branches.

**But say plainly what changes about it.** That function's own comment calls its over-breadth cheap
because "it costs a revalidation rather than a re-render". In a build it costs **a re-render of
every page on the site**. Identical coarseness, an order of magnitude more expensive, and the
comment should not be read across without noticing that.

### The per-tag stamps

The only part that buys precision, and the reason the whole scheme is worth building rather than
falling back to a full rebuild per publish.

A page that recorded `type:event` last build re-renders when an event publishes; the other 3,000
pages skip. This needs one stamp per content type — a single `max(updated_at) group by
content_type_id`.

### The one endpoint this needs

**`GET /api/taproot/delivery/versions`** → `{ site, types: { [apiId]: stamp } }`. Two aggregates,
`handleScoped` with `content:read` like every other delivery route, registered in the route table in
[packages/studio/src/index.ts](packages/studio/src/index.ts) since routes here are injected rather
than files-on-disk. That is the entire CMS-side surface.

### `getStaticPaths` must not fetch the content

Worth its own paragraph because getting it wrong throws away most of the win. `getStaticPaths`
returns `props: { path }` and nothing more; `resolve()` stays in the page frontmatter, which Astro
**does not run for a skipped page**. So a skipped page costs zero delivery requests and zero
`resolveDelivery` query fan-out at the CMS.

Putting the resolved payload into `props` — the natural thing to do, since the data is right there —
would make every build fetch all N pages whether or not it rendered them. The build would get
faster; the CMS would not.

### Soundness holes, worked through

**`MAX_CACHE_TAGS = 200` truncation is a hole here and is not one for a purge.**
[cacheTags.ts:21-29](packages/core/src/content/cacheTags.ts) justifies truncate-not-fail on the
grounds that "a page that keeps a stale reference for the shared TTL is a much smaller problem than
a response rejected for an oversized header". That reasoning is correct and it does not survive the
move: with no TTL and no purge, "for the shared TTL" becomes "forever", and a truncated tag list is
an *incomplete dependency set* silently treated as complete.

The mitigation needs no CMS change. `MAX_CACHE_TAGS` is re-exported through
[pure.ts:49](packages/core/src/pure.ts), so the helper can treat a tag list of exactly that length
as "dependencies unknown" and force a render. It fails safe, and the false positive — a page with
exactly 200 real tags — costs one render.

**The menu is fetched in the page frontmatter and carries no tags.** `deliverMenu` returns them and
the route destructures them off, using them only for the response header
([menu/[apiId].ts:31-37](packages/studio/src/api/delivery/menu/%5BapiId%5D.ts)). So a menu edit
appears in no page's recorded dependency set. Folding menus into the `site` stamp is what closes it,
and is why `site` cannot be dropped from the key even for a page whose dependencies are fully known.

**Renamed subtrees are fine, and the reason is worth checking rather than assuming.**
[cacheTags.ts:96-99](packages/core/src/content/cacheTags.ts) deliberately does not enumerate
descendants of a rename, because their content did not change — only their addresses did. Under
prerendering a descendant's `path` changes, so `getStaticPaths` emits a path the manifest has never
seen (rendered, because unknown) and drops the old one (cleaned up by Astro). What makes it correct
rather than lucky is that the page's breadcrumb trail did change, and the recorded ancestor `item:`
tag is what covers that.

**Deletions and unpublishes are covered by enumeration, not by tags.** Each build re-lists what
exists, so a vanished item is a vanished path and Astro cleans up its output.

That is also the argument against the cheaper-looking enumeration. Polling
`/delivery/items?sort=recently_updated` against a watermark reads O(changed) rows instead of O(all),
which on a large site is most of the requests — and it **has no tombstones**. A deleted or
unpublished item simply stops appearing in the listing, and nothing enumerates the fact that it
used to be there. The page would stay built, stay deployed, and stay reachable, with no record
anywhere of why. Listing everything each build is the more expensive answer and the only correct
one; fifteen requests for three thousand pages is not a cost worth optimising into that.

**Every unknown case must render.** First build, unfamiliar path, missing manifest, unparseable
manifest, truncated tag list. The default in every branch is render, and a manifest that fails to
load is a slow build rather than a wrong one.

---

## 5. Dependency persistence: the integration

Precision requires the previous build's `cacheTags` to survive into the next build's
`getStaticPaths`. That is `taprootIncremental()`, exported from `@taprootcms/astro` and added by the
site to its own `integrations: []`.

**Why this does not contradict the plain-library rule.**
[purge.ts:9-11](packages/astro/src/purge.ts) says `@taprootcms/astro` "is a plain library — it has
no Astro integration and calls no `injectRoute` — so the site owns the file and therefore owns the
path, the runtime, and the secret's provenance". That rule is about **route injection and secret
provenance**. An integration the site adds itself, which injects no route, mounts no handler and
holds no secret, does not take any of those three things away from the site. It is worth stating
here rather than leaving the apparent contradiction for a reader to trip over.

**How the tags reach the integration is the part that will silently do nothing.** The page has
`result.cacheTags` in its frontmatter; the integration runs in the Astro process while the page is
executed through Vite's SSR module runner. A module-level `Map` in `@taprootcms/astro` is
**not reliably the same instance** across those two module graphs. It would work in dev, record
nothing in a real build, and produce a manifest that is permanently empty — which fails safe (every
page renders) and therefore looks like the feature simply not helping. A
`globalThis[Symbol.for(…)]` channel is the fix, and the reason for it belongs in a comment.

**Carrying skipped pages forward is sound, and the argument is what makes the scheme terminate.**
A skipped page never runs its frontmatter, so it never re-records its dependencies. Its previous
entry must be carried forward — and that is safe because if the module hash and the `cacheKey` both
matched, the output is byte-identical, and a byte-identical page consumed a byte-identical set of
dependencies. Entries for paths no longer enumerated are dropped.

**It lives in `cacheDir`**, flushed in `astro:build:done`. That is deliberate: it rides the exact CI
persistence requirement Astro already imposes and adds no second one for an operator to miss.

---

## 6. What the hybrid posture costs

The posture under consideration is `output: 'server'` with `prerender = true` on
`src/pages/[...path].astro` only — search, the API proxies, `/directory`, `/index` and
`/taproot/purge` stay on demand. Everything below is a cost of prerendering that one route.

### Redirects

`result.kind === 'redirect'` ([\[...path\].astro:66-68](apps/web/src/pages/%5B...path%5D.astro))
becomes unreachable for prerendered paths: a prerendered dynamic route generates only its
`getStaticPaths` paths.

*Rejected:* Astro's config `redirects`, because changing the config invalidates the **entire**
incremental cache — every path change would force a full rebuild, the feature defeating itself.
*Also rejected:* a `_redirects` file written into `outDir` at `astro:build:done`, which works on
Cloudflare and Netlify but is host-specific and needs a `/delivery/redirects` endpoint that does not
exist.

**Recommended: move the `redirect` and `not_found` branches into an on-demand `src/pages/404.astro`
with `prerender = false`.** It relocates code that already exists, needs no new delivery endpoint,
and keeps redirect logic out of the config hash. The mechanism it rests on is documented for
Cloudflare — *"Routing for static assets is based on the file structure in the build directory… If
no match is found, this will fall back to the Worker for on-demand rendering"* — so an unmatched
path does reach the Worker. What remains unverified is narrower; see §9.

### Term archives

Currently served from the catch-all's `not_found` branch
([\[...path\].astro:80-109](apps/web/src/pages/%5B...path%5D.astro)). They move with it to the 404
route and stay on demand, unchanged. That they need no rework is the strongest argument for that
route over any other option.

### Preview, which is the sharpest cost and fails silently

The CMS pane frames `${TAPROOT_SITE_URL}${item.path}?taproot_preview=…`. If that path is
prerendered, **the query string is ignored, the static file is served, and the pane shows the
published version while claiming to show a draft.** `Astro.url.searchParams` and
`Astro.response.headers` ([\[...path\].astro:163-192](apps/web/src/pages/%5B...path%5D.astro), which
sets `no-store`, `x-robots-tag` and the `frame-ancestors` CSP) do nothing at build time.

This is worse than a broken preview, because a broken preview is visible. Three options:

1. A dedicated on-demand preview route plus a CMS-side preview URL template. Correct, and it means
   `previewPathFor` stops describing the address the pane opens, which is a real change to a
   contract several screens read.
2. Cloudflare `run_worker_first`. Host-specific, and it gives back the Worker wake that prerendering
   was buying.
3. **Make `prerender` an env-driven flag**, so a preview or staging deployment builds the same
   catch-all on demand while production prerenders it. Simplest, changes no contract, and it keeps
   `apps/web` demonstrating both postures from one source. Recommended, subject to §9.

### Scheduled publishing loses the property that makes it work on day one

`visibleToPublic` is computed on read ([items.ts](packages/core/src/content/items.ts)), which is
what makes scheduling work on a deployment where nobody wired up a cron — that is every deployment
on its first day. A prerendered page cannot go live at 9am without something rebuilding at 9am.

This is the same asymmetry [CLAUDE.md](CLAUDE.md) already records for scheduled *releases*
("a scheduled release needs the sweep; a scheduled item does not"), made worse: under prerendering,
both need it. It deserves the same prominence — Settings → System and the handbook both say where
"scheduling works with no cron" stops being true, and this would extend that sentence.

### The purge endpoint and `PAGE_CACHE_CONTROL` go vestigial for content pages

A prerendered page is a static asset; `Astro.response.headers` never runs for it, so
`PAGE_CACHE_CONTROL` ([cache.ts:21](apps/web/src/cache.ts)) does not apply and there is no rendered
HTML for `/taproot/purge` to flush. Both stay meaningful for the routes still on demand. Nothing
should be deleted — but a deployment that prerenders and still has `TAPROOT_SITE_PURGE_URL`
configured is paying for a purge that clears less than it used to, and should know it.

---

## 7. Is it worth it

**The case for.** The site survives the CMS being down, and the CMS can scale to zero — which is a
genuinely different reliability posture, not a faster version of the current one. Deploy targets
stop requiring a Workers-shaped runtime for content pages. There is no per-request delivery latency
and no shared-cache correctness to reason about on the prerendered half. Warm rebuilds cut *CMS*
query load in proportion to what changed, since `resolveDelivery` is several D1 queries per page and
skipping 3,000 pages skips all of them. And it makes the webhook feature load-bearing rather than
notional.

**The case against.** It argues against SCOPE.md's central bet, and the bet is good:
[SCOPE.md:109](SCOPE.md) frames DB-backed SSR as "a real advantage over the git-based approach ruled
out earlier — no need for a full static rebuild per publish". Prerendering reintroduces exactly the
publish-to-visible latency Taproot exists partly to remove, and costs the scheduling property
outright.

The `site` stamp means one alt-text edit rebuilds everything, so the win is real only for
deployments whose edits are mostly ordinary content saves — which is most of them, but it should be
checked rather than assumed for any particular site.

`cacheDir` in CI is a footgun with no error path: a pipeline that forgets to persist it is silently
a cold build forever, and the symptom is "this feature did nothing" rather than a failure.

And the feature is early. Astro has already shipped a fix for `incrementalBuild` re-rendering
unchanged routes because a route's dependency hash depended on the order its assets finished
building ([#17616](https://github.com/withastro/astro/pull/17616)) — a cache-correctness bug in the
half Astro owns, found after release.

**On measuring it.** The seeded demo has nowhere near enough pages to show a win, so any claim about
build times needs a synthetic large seed and an actual measurement. Do not let a number into this
document that was reasoned about rather than observed; that is the lesson `npm run query-count`
exists for.

---

## 8. If the answer is yes

Smallest correct thing first, each stage independently shippable.

1. **Bump Astro to `^7.2`** across the three apps and the two peer ranges. Add
   `experimental.incrementalBuild` behind an env flag in
   [apps/web/astro.config.mjs](apps/web/astro.config.mjs). Confirm `build.concurrency` is 1, since
   above that the cache is silently disabled.
2. **`GET /api/taproot/delivery/versions`** in `packages/studio/src/api/delivery/`, registered in
   the route table in [packages/studio/src/index.ts](packages/studio/src/index.ts). Two aggregates,
   modelled on `contentLibraryVersion`.
3. **`taprootStaticPaths()` and `taprootIncremental()`** in `packages/astro/src`, exported from
   [packages/astro/src/index.ts](packages/astro/src/index.ts). This is where the truncation check,
   the render-on-unknown defaults and the `globalThis` channel live.
4. **Move the `redirect` / `not_found` / term-archive branches** out of
   [apps/web/src/pages/\[...path\].astro](apps/web/src/pages/%5B...path%5D.astro) into an on-demand
   `apps/web/src/pages/404.astro`; add `getStaticPaths` and the env-driven `prerender` to the
   catch-all.
5. **[DEPLOYMENT.md](DEPLOYMENT.md)**: the `cacheDir` CI requirement, the rebuild webhook, and the
   scheduling caveat.

---

## 9. Unverified claims

Three things this document assumes and has not tested. The first one, if it goes the wrong way,
ends the hybrid posture and most of this document with it.

1. **That `experimental.incrementalBuild` applies to prerendered routes inside `output: 'server'`
   at all**, rather than only to `output: 'static'`. The docs describe it in terms of "static pages
   generated by `getStaticPaths()`" without naming an output mode, and the original roadmap issue
   says incremental builds would support "static, hybrid and server". *Test:* a two-route project in
   server output, one prerendered route with `cacheKey`, built twice with no changes; check whether
   the second build reports a skip.
2. **That Astro dispatches an unmatched path to a `prerender = false` `404.astro`** rather than
   serving a prerendered `404.html`. The Cloudflare adapter documents that unmatched paths fall
   through to the Worker, but the same page lists "prerendered error page fetching" among its
   companion handlers, which cuts the other way. *Test:* both adapters, request a path not in
   `getStaticPaths`, check whether the on-demand 404 route's code runs. If it does not, the redirect
   story falls back to a generated `_redirects` file and a new delivery endpoint.
3. **That Astro 7 accepts a non-literal `export const prerender`.** Vite inlines
   `import.meta.env.X` before Astro's scanner sees the module, but the scanner may require a
   literal. *Test:* set it from an env var and check the build output for the route's mode. If it
   refuses, the fallback is two route files selected at build time, which is worse and should be
   weighed against options 1 and 2 in §6.
