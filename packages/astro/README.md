# @taprootcms/astro

The [Taproot](https://github.com/jeremybise/taproot) client for Astro. A site installs this and
reads content from a Taproot CMS server over HTTP.

```bash
npm install @taprootcms/astro
```

**This is the half a website installs.** The CMS server is a separate deployment — scaffold one with
`npm create taproot` — and a site never installs it. What you get here is a typed client, a
`BlockRenderer`, a `TaprootImage` that honours the focal point an editor set, and a `TaprootEmbed`
that frames third-party video, maps and forms.

## Setup

Two environment variables: where the CMS is, and a read key you issue from **Settings → API keys**.

```bash
TAPROOT_API_URL=https://cms.example.edu
TAPROOT_API_KEY=tpr_...
```

```ts
import { createTaprootClient } from '@taprootcms/astro';

export const taproot = createTaprootClient({
  url: import.meta.env.TAPROOT_API_URL,
  key: import.meta.env.TAPROOT_API_KEY,
});
```

## Rendering a page

One catch-all route resolves any path in a single round trip — the item, its type and fields,
breadcrumbs, visible children, blocks already dereferenced, resolved SEO, and lookup maps for media,
relations, and terms:

```astro
---
const result = await taproot.resolve(Astro.url.pathname);

// A redirect arrives as a 200 carrying `{ kind: 'redirect' }`, never a 30x — the server must not
// redirect your fetch, it must tell you to redirect your visitor.
if (result.kind === 'redirect') return Astro.redirect(result.to, result.status);
if (result.kind === 'notFound') return new Response('Not found', { status: 404 });

const { item, media } = result;
---
<h1>{item.title}</h1>
```

## Images

`TaprootImage` resolves the hotspot and crop an editor set, and emits a responsive `srcset` the CMS
resizes to match.

```astro
<TaprootImage
  asset={media[item.data.hero]}
  ratio={16 / 9}
  sizes="(min-width: 1024px) 50vw, 100vw"
  crop="server"
/>
```

`sizes` describes the **container**, not the `<img>` — the component knows the crop factor and
rewrites your lengths itself. `crop="server"` asks the CMS for the cropped rectangle so no hidden
pixels are downloaded; it degrades to a hotspot-framed original wherever the CMS cannot transform.

## Embeds

An `embed` field stores `{ url, title }` and never markup — Taproot has no raw HTML field, so the
frame's `sandbox`, `title` and `referrerpolicy` are guarantees rather than things an author
remembered.

```astro
<TaprootEmbed embed={item.data.video} sizing={{ mode: 'ratio', ratio: 16 / 9 }} />
```

Three sizing modes, because a ratio describes only one of the three things people embed: `ratio` for
video, `fixed` for a known height, and `auto` for forms that grow as they are filled in. Under
`auto` the frame reports its height by `postMessage` — Taproot checks that the message came from
*that* frame and clamps the number, and your site supplies the parse for any vendor the built-in
one cannot read:

```js
document.addEventListener('taproot:embed:message', (event) => {
  const { data, origin, setHeight } = event.detail;
  if (origin === 'https://forms.example.edu') setHeight(data.px);
});
```

An embed that needs a script on *your* page is a block component instead, not this field. See the
handbook for that and for the two limits worth knowing up front.

## Listings and facets

`taproot.items` lists visible content — summaries by default, or field values and their lookup maps
with `data: true`, which is what a card grid needs:

```ts
const { items, media, terms } = await taproot.items({
  type: 'person',
  taxonomy: 'department',
  term: selectedSlugs,   // several mean any of them
  sort: 'title',
  data: true,
});

const { terms: departments } = await taproot.terms('department', {
  counts: true,
  type: 'person',        // so the counts describe the rows the grid shows
});
```

`data: true` returns the same shape a `query` field's results arrive in, so one card component
renders either. An unrecognised `sort` is refused rather than ignored.

## Search

`taproot.search` covers titles, paths, and the words inside each item — including the ones in blocks
and repeater rows — with a plain-text excerpt around the match.

```astro
---
const q = Astro.url.searchParams.get('q') ?? '';
const { results, total } = await taproot.search(q, { limit: 10 });
---
{results.map((result) => (
  <article>
    <a href={result.path}>{result.title}</a>
    <p>{result.excerpt}</p>
  </article>
))}
```

Ranked title-first by default; pass `sort` for a named order instead. A blank query returns no
results rather than everything, so an empty search box needs no guard. The excerpt is plain text and
is meant to be rendered as text.

## What it deliberately does not do

**It never touches a database.** This package imports `@taprootcms/core/pure` at runtime — crop
arithmetic and nothing else — and everything else as `import type`, erased at build. Importing the
data layer would drag Kysely and its dialect loaders into a site that cannot use them. The built
consumer is roughly 460 KB and contains no `kysely`.

**It has no opinion about term URLs.** Whether a taxonomy's terms get public pages depends on the
routes your site serves, which the CMS cannot know — so menus arrive with unresolved term targets
and you apply your own resolver.

## Requirements

Astro 7, Node 22.12 or newer.

## Documentation

See the [repository](https://github.com/jeremybise/taproot) — the handbook's "Building a site"
section covers rendering, blocks, images, menus, preview, and generated types.

## License

MIT
