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

A filtered list of visible items, for index pages and archives.

```ts
const { items, total } = await taproot.items({
  type: 'event',       // a content type's api_id
  search: 'open day',
  limit: 20,
  offset: 0,
});
```

Returns **summaries**, not whole items: `id`, `title`, `slug`, `path`, `status`, `publishedAt`,
`updatedAt`. A listing renders a title and a link; sending every field of fifty items so a template
can use two of them would make the endpoint that exists to avoid round trips expensive in another
way. Call `resolve` when you need content.

Filtering by a term takes a slug when you name the taxonomy — see
[Menus and term URLs](/build/menus/).

Singletons are omitted. Their `path` is a synthetic internal one that nothing serves, so listing
them would hand you links that 404. Fetch a singleton with `resolve` if you need it.

This is also not the way to find one known item. Filtering the results by slug still leaves you
making the `resolve` call you could have made first — see
[One specific item at a fixed route](/build/rendering-a-page/#one-specific-item-at-a-fixed-route).

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

Delivery responses carry an `ETag`, `s-maxage=60`, and a `Cache-Tag` header. A conditional request
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

### What the ETag does not cover

The validator is built from the item's `updated_at`, so it notices an edit, a publish, a status
change, a move, and a release applying a staged version. It cannot notice a **reusable block edited
in the library**, because that changes what the page renders without touching the page's row. That is
exactly what the `block:` tag is for, and `s-maxage=60` is the bound if you are not purging.

For the same reason, do not build a response cache keyed on the ETag in your own client. It would
work right up until somebody edits a shared block, at which point the tag keeps matching and your
copy goes stale with no expiry at all. `@taprootcms/astro` deduplicates *concurrent* requests for one
resource within a render and deliberately stops there.

Previews are always `no-store`. Do not cache a response you fetched with a preview token — see
[Preview and types](/build/preview-and-types/).
