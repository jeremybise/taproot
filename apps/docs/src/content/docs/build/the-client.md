---
title: The client
description: createTaprootClient, the four methods it gives you, and the shape of what comes back.
---

```ts
import { createTaprootClient } from '@taprootcms/astro';

const taproot = createTaprootClient({
  url: 'https://cms.example.edu',
  apiKey: import.meta.env.TAPROOT_API_KEY,
  fetch: globalThis.fetch,   // optional — swap in your own caching or retries
});
```

`import.meta.env` is the Node spelling. How the key reaches this call depends on where the site is
deployed — on Cloudflare it is `env` from `cloudflare:workers` — and
[Getting started](/build/getting-started/#one-module-for-the-connection) has both, plus why the
wrong one fails as a 401 rather than as a missing variable.

Four methods.

## `resolve(path, options?)`

Everything needed to render a path, in one round trip.

```ts
const result = await taproot.resolve('/admissions/apply');
```

It returns a **discriminated union**, not a page or a throw:

```ts
{ kind: 'item', item, breadcrumbs, children, media, references, terms }
{ kind: 'redirect', to: '/new-path', status: 301 }
{ kind: 'not_found' }
```

Handle all three. `not_found` and an unreachable CMS are different situations — one is your 404
page, the other is an outage — which is why a miss is data and only a failure throws.

**By path, and there is no by-slug form.** A slug is unique among siblings rather than site-wide, so
`/admissions/apply` and `/financial-aid/apply` share the slug `apply` and "the item with slug `apply`"
is not a question with one answer. To pin a fixed route — a front page, an "about" page with its own
template — to one item, pass its path:
[One specific item at a fixed route](/build/rendering-a-page/#one-specific-item-at-a-fixed-route).

:::caution
**A redirect is data, not a 30x.** You have to issue the redirect to *your* visitor, on your origin.

If the CMS answered with a real 30x, your server-side `fetch` would follow it and hand you the wrong
page's content under the requested URL — silently, and only for moved pages.
:::

### What is in an item

```ts
result.item = {
  id, title, slug, path,
  status,                  // 'published', or 'scheduled' with its moment passed
  publishedAt, updatedAt,
  contentType: { apiId, name, namePlural, kind },
  fields: [ { apiId, label, type, required, helpText, position, config } ],
  data: { /* field values, keyed by api_id */ },
  seo: { title, description, ogImageId, noIndex },
}
```

`fields` is the content type's schema **in the order an editor sees it**, which is what lets a
template render a page by walking the schema rather than hardcoding field names — see
[Rendering a page](/build/rendering-a-page/).

`seo` is already resolved: `title` falls back to the item's title, and `ogImageId` to the content
type's default social image. The admin's preview calls the same function, so what you render and
what an editor previews cannot disagree.

### The reference maps

Alongside the item:

| | |
|---|---|
| `breadcrumbs` | Ancestors, outermost first. Excludes the item itself |
| `children` | Visible children, for "in this section" navigation |
| `media` | Every image and file the content references, keyed by id |
| `references` | Every content item a relation field points at, keyed by id |
| `terms` | Every taxonomy term the content carries, keyed by id |

**`data` keeps ids; the maps resolve them.**

```ts
item.data.hero_image           // '019fbd07-cf56-…'
result.media[item.data.hero_image]   // { url, alt, width, height, hotspot, … }
```

Inlining the objects into `data` would read more nicely and be wrong three ways: `data` would stop
matching the field types the CMS validates against — and therefore the types it generates for you —
an image used twice would be serialised twice, and the payload could no longer be handed back to a
write.

The maps also **respect visibility**. A relation pointing at a draft leaves the id in `data` and
omits it from `references`, so you cannot accidentally render the title of something unpublished.

## `items(options?)`

A filtered list of visible items, for index pages, archives and card grids.

```ts
const { items, total } = await taproot.items({
  type: 'event',       // a content type's api_id
  search: 'open day',
  sort: 'newest',
  limit: 20,
  offset: 0,
});
```

Returns **summaries** by default, not whole items: `id`, `title`, `slug`, `path`, `status`,
`publishedAt`, `updatedAt`. A listing renders a title and a link; sending every field of fifty items
so a template can use two of them would make the endpoint that exists to avoid round trips expensive
in another way.

### Options

| Option | Meaning |
| --- | --- |
| `type` | A content type's `api_id`. Omit for every addressable type |
| `term` | A term id, or a slug when `taxonomy` is given. **Several mean any of them** |
| `taxonomy` | The taxonomy `term` belongs to, which is what lets `term` be a slug from a URL |
| `search` | Title, path and body text — the same search `search()` runs |
| `sort` | `path` (default), `title`, `newest`, `oldest`, `recently_updated` |
| `data` | Send each item's field values and the maps they resolve through |
| `limit` | Defaults to 50, capped at 200 |
| `offset` | For paging |

An unrecognised `sort` is **refused with a 400** rather than ignored. A silently defaulted sort is a
directory that comes back in the wrong order with nothing to explain it.

Singletons are omitted. Their `path` is a synthetic internal one that nothing serves, so listing
them would hand you links that 404. Fetch a singleton with `resolve` if you need it.

This is also not the way to find one known item. Filtering the results by slug still leaves you
making the `resolve` call you could have made first — see
[One specific item at a fixed route](/build/rendering-a-page/#one-specific-item-at-a-fixed-route).

### Rendering cards: `data: true`

A card grid needs more than a title — a photo, a role, a date. `data: true` sends each item's own
field values, plus the lookup maps their ids resolve through:

```astro
---
const { items, media, terms } = await taproot.items({
  type: 'person',
  data: true,
  sort: 'title',
  limit: 24,
});
---
{items.map((person) => {
  const photo = media[person.data.photo];
  return (
    <article>
      {photo && <TaprootImage asset={photo} ratio={1} sizes="(min-width: 60rem) 20vw, 45vw" />}
      <h2><a href={person.path}>{person.title}</a></h2>
      <p>{person.data.role}</p>
      <p>{person.data.departments.map((id) => terms[id].name).join(', ')}</p>
    </article>
  );
})}
```

:::note[Not every collection has item pages]
A content type can be configured so its items have **no pages of their own** — the usual case for a
staff directory. `resolve` answers `not_found` at those items' paths, so do not link a card's title
to `item.path` for such a type: your own site would 404. `schema()` reports `hasItemPages` per type
if you want a template that decides from the CMS rather than from what its author remembers, and
`apps/web/src/pages/directory.astro` is the worked example.

A listing that names the type still returns them, which is exactly how that page is built. Site
search does not, because a search result is a link.
:::

**This is the same shape a `query` field's results arrive in**, so a card component written for one
renders the other unchanged. What that means in practice:

- `data` holds the item's own fields with `block` and `query` **stripped** — a card renders a
  thumbnail and a name, not another page's page-builder blocks. If the value you want lives inside a
  block, `resolve` that item.
- Media, relation and term values are **ids**, resolved through `media`, `references` and `terms`
  beside the items. Ids rather than inlined objects, for the reason
  [the reference maps](#the-reference-maps) exist: an image used by ten people is serialised once.
- A multi-value field carries **all** of its values. Somebody in two departments has both, and both
  are in `terms`.
- Internal links inside rich text are already resolved to real paths.

The three maps are present only when you ask for `data` — a summary carries no ids to look up.

### Facets: filtering by several terms

`term` accepts a list, and they mean **any of them**: ticking two departments widens the list rather
than narrowing it to people in both. Each is expanded to its whole branch server-side, so filing
somebody under "Biology" finds them when a visitor filters by "Sciences".

```ts
const selected = Astro.url.searchParams.getAll('department'); // ['sciences', 'admissions']

const { items, total } = await taproot.items({
  type: 'person',
  taxonomy: 'department',
  term: selected,
  data: true,
});
```

Use [`terms()`](#termstaxonomyapiid-options) to build the checkboxes themselves — hard-coding them
means the filter goes stale, silently, the first time an editor adds a department.

## `terms(taxonomyApiId, options?)`

A taxonomy's terms, for building a facet.

```ts
const { terms } = await taproot.terms('department', { counts: true, type: 'person' });
```

Each term is `{ id, name, slug, taxonomyApiId, parentId }`, flat and depth-first — parents before
their children — so rendering the list in order without reading `parentId` still puts a child under
its parent. Nest them yourself for a tree; a `<select>` can use them as they come.

`counts: true` adds `itemCount`, which is the number of items **a visitor can see** under that term
*and everything beneath it*, counting an item filed under both a parent and its child once. It costs
a second query server-side, so it is opt-in.

**Pass `type` whenever the listing beside the facet is narrowed to one.** Without it, "Biology (12)"
counts every kind of content tagged Biology, while clicking it returns only people — a facet
disagreeing with its own filter. With it, the two describe the same set.

The first argument takes the taxonomy's `api_id` **or its id**, which is what a `taxonomy` field
carries in `config.taxonomyId` — so you can go straight from a field in the schema to its terms
without looking the name up. A slug and a uuid cannot be mistaken for each other. `schema()` also
lists every taxonomy with both, if you would rather map one to the other yourself.

`apps/web/src/pages/directory.astro` in the Taproot repository is a working page built on these two
methods: a card grid with photos, a department facet with counts, checkbox state in the URL, and no
JavaScript.

A taxonomy that does not exist is a **404**, not an empty list: a taxonomy with no terms yet is an
ordinary state, so answering one for a misspelled `api_id` would hide the typo indefinitely.

## `search(query, options?)`

Search the site's content — titles, paths, and the words inside each item.

```ts
const q = Astro.url.searchParams.get('q') ?? '';
const { results, total } = await taproot.search(q, { limit: 10 });
```

Each result is an `items` summary plus an **`excerpt`**: a window of the item's own text around the
match, as plain text.

```ts
results[0];
// { id, title, slug, path, status, publishedAt, updatedAt,
//   excerpt: '…confirmed by the accreditation review of 2019, which…' }
```

Render the excerpt **as text**, never with `set:html`. It carries no markup — deliberately, so that
nothing here is a string your templates have to trust — and highlighting the term is something you
can do yourself, since you know what was searched for.

### What it searches

Every text and rich-text value an item holds, including the ones inside blocks and repeater rows,
flattened to plain words when the item is saved. Markup is not part of it: searching for `strong`
does not find every page with bold text on it.

Two things it does not see. Content that lives **only in a reusable block** is not found through the
pages that show it — the page stores a reference rather than a copy — though the pages' own text
still is. And anything past roughly 3,000 words in a single item is not indexed, which is longer than
the pages a site like this holds.

### Ranking, and asking for a different order

Results come back most-relevant first: an exact title match, then a title starting with the term,
then a title containing it, then the path, then the body. Pass `sort` to override that with a named
order — `path`, `title`, `newest`, `oldest` or `recently_updated`. Sorting a news archive's results
by date is the usual reason:

```ts
await taproot.search(q, { sort: 'newest' });
```

The ranking is intentionally coarse. It says where the term was found and nothing more, because that
is what the underlying match knows — there is no term-frequency score behind it, and inventing one
would be a number that looks meaningful and is not.

### Options

| Option | Meaning |
| --- | --- |
| `type` | A content type's `api_id`, to search one type |
| `sort` | A named order. Omit for relevance |
| `limit` | Defaults to 20, capped at 100 |
| `offset` | For paging |

A blank or whitespace-only query returns **no results** rather than everything, so your search form
needs no guard of its own. Only content a visitor can already see is searched — the same visibility
rule `items` applies, so a page whose scheduled moment has passed is included whether or not anything
has swept it. Singletons are omitted for the reason `items` omits them.

`apps/web/src/pages/search.astro` in the Taproot repository is a working page: a plain `GET` form, no
JavaScript, the query in the URL so a result page can be linked and reloaded.

:::caution[Upgrading an existing site]
Search reads an index built when each item is saved, and the migration that adds it creates it empty.
An operator has to run `npm run db:reindex` once against the CMS — until then, search finds items by
title and by nothing else. Settings → System reports how many items are waiting.
:::

## `menu(apiId)`

```ts
const entries = await taproot.menu('main');
```

Returns entries with their targets **described rather than turned into URLs**, because deciding
whether a taxonomy's terms have public pages is your call and not the CMS's. See
[Menus and term URLs](/build/menus/).

## `schema()`

The whole content model. Read by the type generator; rarely useful at request time. See
[Preview and types](/build/preview-and-types/).

```ts
{ contentTypes: [ { id, apiId, name, namePlural, kind, urlPrefix, fields } ],
  blockTypes:   [ … ],
  taxonomies:   [ { id, apiId, name, namePlural, hierarchical } ] }
```

`taxonomies` is what makes the uuids inside a field's `config` resolvable — a `taxonomy` field names
its vocabulary by `taxonomyId`, and a `relation` or `query` field names its target type by
`targetContentTypeId`, which is why `contentTypes` carries `id` as well as `apiId`. The taxonomies'
*terms* are not here: a vocabulary can hold hundreds and the schema is read to learn the model —
[`terms()`](#termstaxonomyapiid-options) answers that, with counts.

## Errors

A failed request throws `TaprootDeliveryError`, which carries `.status`.

```ts
import { TaprootDeliveryError } from '@taprootcms/astro';

try {
  const result = await taproot.resolve(path);
} catch (error) {
  if (error instanceof TaprootDeliveryError && error.status === 401) {
    // The key is missing, wrong, or revoked.
  }
  throw error;
}
```

A 404 does **not** throw — it comes back as `{ kind: 'not_found' }`, because a page not existing is
an ordinary outcome and an exception is not how you want to express it on every request.

The 401 message names the likely cause rather than repeating the status, because the fix is on your
side: a missing or revoked `TAPROOT_API_KEY`. Bare "401" sends people to the CMS to look for a fault
that is not there.

## Caching

Delivery responses carry an `ETag`, `s-maxage=86400`, and a `Cache-Tag` header. A conditional request
costs a 304 with no body — and, on the CMS side, no page resolution at all: the validator is answered
from a single indexed lookup rather than by building the payload and discarding it.

**A shared cache in front of your site is what makes any of this matter, and on Cloudflare you have
to ask for one.** Cloudflare does not cache HTML or JSON by default — its default cache is keyed on
file extension — and a Worker's own response is never cached unless the Worker opts in. So
`s-maxage` is correct HTTP that nothing acts on until you enable it:

```jsonc
// wrangler.jsonc
{
  "cache": { "enabled": true }
}
```

With that, Cloudflare checks the cache *before* invoking your Worker. A hit costs no CPU, makes no
request to the CMS, and touches no database anywhere in the system; concurrent requests for the same
URL collapse into one render. `apps/web/wrangler.jsonc` in the Taproot repository is a worked
example.

### Cache tags

Every `resolve` response tells you what the page depends on, in the payload as well as in the header:

```json
{
  "kind": "item",
  "cacheTags": ["item:019f…", "type:page", "item:019f…", "block:019f…"]
}
```

They are in the payload because *you* need them: your site renders HTML from this response and has to
tag that document, and it cannot work out the dependencies itself. A page depends on more than its
own row — a renamed ancestor changes its breadcrumbs, a published child changes its "in this section"
list, a reusable block edited in the library changes its content without touching the page at all,
and a listing depends on the *type* rather than on the items it happened to match. The CMS knows all
four; your site does not.

Re-emit them on your own response and you can purge by tag later:

```astro
---
const result = await taproot.resolve(path);
if (result.kind === 'item') {
  Astro.response.headers.set('cache-tag', result.cacheTags.join(','));
}
---
```

Ignoring `cacheTags` entirely is fine and is what every site did before they existed — you fall back
to `s-maxage` expiring, which is the backstop either way.

### A day is a long time, so read the next two sections

`s-maxage=86400` is only safe because purging is what keeps content fresh; the TTL is the backstop
for a purge that never arrived. If you cache this site's own HTML for a day as well — which you
should — mount the purge endpoint below, or an edit will take a day to appear.

### What the ETag covers

The validator is built from the item's `updated_at` **and a stamp for the reusable-block library**,
so it notices an edit, a publish, a status change, a move, a release applying a staged version, and
an entry edited in the library.

That last one used to be a documented gap here, and the gap was worse than this page once claimed.
It said a library edit left a client "stale until `s-maxage` lapses". There was no such bound: when
a cached copy expires a shared cache *revalidates* rather than refetching, the CMS answered 304
because the page's own row had not changed, and [RFC 9111
§4.3.4](https://www.rfc-editor.org/rfc/rfc9111#section-4.3.4) says a 304 refreshes the stored
response's freshness — so the stale copy renewed itself indefinitely. Folding the library's stamp
into the validator is what fixes it.

Even so, **do not build a response cache keyed on the ETag in your own client**. The reasoning has
changed but the advice has not: you would be reimplementing a shared cache badly, without the purge
callback that makes the long TTL safe. `@taprootcms/astro` deduplicates *concurrent* requests for
one resource within a render and deliberately stops there.

### Clearing your own cache

Cloudflare scopes cache purging to the Worker that owns the cache, so the CMS clearing its cached
JSON cannot touch the HTML you rendered from it. Mount an endpoint and it can:

```ts
// src/pages/_taproot/purge.ts
import { createTaprootPurgeHandler } from '@taprootcms/astro';

export const prerender = false;
export const POST = createTaprootPurgeHandler({ secret: process.env.TAPROOT_PURGE_SECRET });
```

Then set `TAPROOT_SITE_PURGE_URL` and `TAPROOT_SITE_PURGE_SECRET` on the **studio**, with the secret
matching. Both or neither — the CMS treats a URL without a secret as no configuration at all, so a
half-finished setup behaves like an absent one rather than a broken one.

It flushes your whole cache rather than purging the tags it was sent, deliberately. Only `resolve`
exposes `cacheTags`; `/delivery/items` and `/delivery/menu` do not, so a listing page cannot derive
what it depended on — and tag-precise purging would silently never invalidate exactly the pages most
likely to be stale, like an index that should be showing a newly published item. At a few edits a
day the re-warm costs nothing and cannot be wrong.

Leaving it unmounted is supported: the endpoint answers 404 when no secret is set, the CMS records
the failed purge and retries it, and Settings → System reports it. What you give up is prompt
invalidation — your pages then change only when your own TTL lapses.

Previews are always `no-store`. Do not cache a response you fetched with a preview token — see
[Preview and types](/build/preview-and-types/).
