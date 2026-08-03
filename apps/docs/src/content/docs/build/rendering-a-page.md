---
title: Rendering a page
description: The catch-all route, redirects, breadcrumbs, and rendering fields from the schema.
---

One route serves every page, because a Taproot path is resolved at request time rather than matched
against files on disk.

## The catch-all

```astro
---
// src/pages/[...path].astro
import Layout from '../layouts/Layout.astro';
import { taproot } from '../taproot.ts';

export const prerender = false;

const path = `/${Astro.params.path ?? ''}`.replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1');

const result = await taproot.resolve(path);

if (result.kind === 'redirect') {
  return Astro.redirect(result.to, result.status === 302 ? 302 : 301);
}
if (result.kind === 'not_found') {
  return new Response('Not found', { status: 404 });
}

const { item, breadcrumbs, children, media } = result;

Astro.response.headers.set('cache-control', 'public, max-age=0, s-maxage=60');
---

<Layout title={item.seo.title} description={item.seo.description}>
  <h1>{item.title}</h1>
</Layout>
```

**Handle the redirect first.** Every path change in Taproot writes one automatically — rename a
page, move a section, and forty descendants get redirects — so this branch is what keeps every link
anyone ever shared working. Skipping it turns a rename into forty 404s.

## Rendering fields from the schema

`item.fields` is the content type's fields in the order an editor sees them, so a template can
render any content type without knowing its field names:

```astro
---
const renderable = item.fields.filter((field) =>
  ['text', 'richtext', 'number', 'date', 'select', 'boolean'].includes(field.type),
);
---

{renderable.map((field) => {
  const value = item.data[field.apiId];
  if (value === undefined || value === null || value === '') return null;

  if (field.type === 'richtext') return <div set:html={String(value)} />;
  if (field.type === 'boolean') return <p><strong>{field.label}:</strong> {value ? 'Yes' : 'No'}</p>;
  return <p><strong>{field.label}:</strong> {String(value)}</p>;
})}
```

That is the generic approach, and it is what the reference site does. A real site usually wants named
fields for its important types — `item.data.summary`, `item.data.starts_at` — with generated types
making a typo a build error. See [Preview and types](/build/preview-and-types/).

### Rich text is HTML, and already sanitised

`set:html` is correct here, and safe: richtext is sanitised **on write** in the CMS, through an
allowlist that re-emits only what it understands. Sanitising again at render would be
belt-and-braces against a boundary that is already the right one.

### Internal links resolve before you see them — you do nothing

An editor can link to another page by picking it rather than typing its address, and Taproot stores
that as a reference. **By the time the HTML reaches you, it is an ordinary `href`** pointing at
wherever that page currently lives. Renaming a page therefore updates every link to it across the
site, with nobody editing any content and nothing for this app to do.

Two consequences worth knowing rather than discovering:

- A link whose target is unpublished or deleted arrives as **plain text with the link removed**, so
  you never render an anchor to a page that would 404. Under a preview token the link is kept, so an
  editor can check a section of drafts that link to each other.
- The target's id is still in `references`, and a linked file's in `media`, if you want to do
  something else with them.

## Breadcrumbs and children

Both arrive resolved:

```astro
<nav aria-label="Breadcrumb">
  <ol>
    <li><a href="/">Home</a></li>
    {breadcrumbs.map((crumb) => (
      <li><a href={crumb.path}>{crumb.title}</a></li>
    ))}
  </ol>
</nav>

{children.length > 0 && (
  <nav aria-labelledby="subpages">
    <h2 id="subpages">In this section</h2>
    <ul>
      {children.map((child) => <li><a href={child.path}>{child.title}</a></li>)}
    </ul>
  </nav>
)}
```

`children` contains only what a visitor may see, so an unpublished child does not leak its title
through a navigation list.

## SEO and the social image

`item.seo` is resolved, including fallbacks — but the social image is an **id**, looked up in the
media map like everything else:

```astro
---
const ogAsset = item.seo.ogImageId ? media[item.seo.ogImageId] : undefined;
---

<title>{item.seo.title}</title>
{item.seo.description && <meta name="description" content={item.seo.description} />}
{ogAsset && <meta property="og:image" content={ogAsset.url} />}
{ogAsset?.alt && <meta property="og:image:alt" content={ogAsset.alt} />}
{item.seo.noIndex && <meta name="robots" content="noindex, nofollow" />}
```

`ogAsset.url` is **absolute**, because a relative social image is ignored by every crawler and your
site does not know where the CMS keeps its files.

`item.seo.description` can legitimately be empty — Taproot deliberately has no excerpt fallback,
because a truncated first sentence reads like a machine wrote it and search engines pick a better
snippet themselves. Render the tag only when there is one.

## Index pages

```astro
---
const { items } = await taproot.items({ type: 'event', limit: 20 });
---

<ul>
  {items.map((event) => <li><a href={event.path}>{event.title}</a></li>)}
</ul>
```

## Related content

A relation field stores ids; `references` resolves them, and omits anything a visitor may not see:

```astro
---
const related = (item.data.related_pages as string[] ?? [])
  .map((id) => result.references[id])
  .filter(Boolean);
---
```

Filter for `Boolean` rather than assuming a hit — an id whose target is a draft is deliberately
absent from the map, and that is the map doing its job.

## The whole frontmatter, in one piece

Everything above is shown a piece at a time, which is useful for explaining and unhelpful when what
you want is a route that works. Here it is assembled, **including preview** — the parts
[Preview and types](/build/preview-and-types/) introduces one at a time.

Nothing here is optional-but-recommended except where a comment says so. This is the shape to start
from and delete out of.

```astro
---
// src/pages/[...path].astro
import Layout from '../layouts/Layout.astro';
import { BlockRenderer, TaprootPreviewBridge } from '@taprootcms/astro/components';
import { PREVIEW_PARAM } from '@taprootcms/astro';
import { taproot, CMS_URL } from '../taproot.ts';
import { BLOCK_COMPONENTS } from '../blocks/index.ts';

export const prerender = false;

// Collapse doubled slashes and drop a trailing one, so `/about/` and `/about` are one page rather
// than a hit and a 404.
const path = `/${Astro.params.path ?? ''}`.replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1');

// Forwarded untouched: this site has no session and no database, so it cannot judge a token. The
// CMS decides. That is why preview is a token and not a `?preview=1` anybody could type.
const previewToken = Astro.url.searchParams.get(PREVIEW_PARAM);

const result = await taproot.resolve(path, { previewToken });

// Redirects first. Every path change in Taproot writes one, so this branch is what keeps shared
// links working after a rename.
if (result.kind === 'redirect') {
  return Astro.redirect(result.to, result.status === 302 ? 302 : 301);
}
if (result.kind === 'not_found') {
  return new Response('Not found', { status: 404 });
}

const { item, breadcrumbs, children, media } = result;

const ogAsset = item.seo.ogImageId ? media[item.seo.ogImageId] : undefined;

// A preview is never canonical: pointing a canonical at the live URL tells a crawler that a draft
// is the authoritative version of the page.
const canonical = previewToken ? null : new URL(item.path, Astro.url.origin).toString();

const blockFields = item.fields.filter((field) => field.type === 'block');

if (previewToken) {
  // A different origin serving a different document — the CMS's own `no-store` does not cover this
  // response, and a shared cache in front of your site would serve a draft to somebody with no
  // token at all.
  Astro.response.headers.set('cache-control', 'no-store');
  Astro.response.headers.set('x-robots-tag', 'noindex, nofollow');

  // Framable by the CMS and nothing else. Not required — Astro sends no framing headers, so the
  // pane already works — but "no header" and "only the CMS" are different promises, and the second
  // is the one worth making about a document showing unpublished content.
  if (CMS_URL) {
    Astro.response.headers.set(
      'content-security-policy',
      `frame-ancestors 'self' ${new URL(CMS_URL).origin}`,
    );
  }
} else {
  Astro.response.headers.set('cache-control', 'public, max-age=0, s-maxage=60');
}
---

<Layout
  title={item.seo.title}
  description={item.seo.description}
  canonical={canonical}
  ogImage={ogAsset?.url ?? null}
  ogImageAlt={ogAsset?.alt ?? null}
  noIndex={Boolean(previewToken) || item.seo.noIndex === true}
>
  {/* Optional. Upgrades a whole-frame remount to a reload from inside, which keeps scroll position.
      Behind the token check, so a visitor never ships a listener for a handshake that cannot happen. */}
  {previewToken && <TaprootPreviewBridge />}

  {previewToken && item.status !== 'published' && (
    <p role="status">
      <strong>Preview.</strong> This {item.status.replace('_', ' ')} content is not visible to visitors.
    </p>
  )}

  <nav aria-label="Breadcrumb">
    <ol>
      <li><a href="/">Home</a></li>
      {breadcrumbs.map((crumb) => <li><a href={crumb.path}>{crumb.title}</a></li>)}
    </ol>
  </nav>

  <article>
    <h1>{item.title}</h1>

    {blockFields.map((field) => (
      <BlockRenderer blocks={item.data[field.apiId]} components={BLOCK_COMPONENTS} media={media} />
    ))}
  </article>

  {children.length > 0 && (
    <nav aria-labelledby="subpages">
      <h2 id="subpages">In this section</h2>
      <ul>
        {children.map((child) => <li><a href={child.path}>{child.title}</a></li>)}
      </ul>
    </nav>
  )}
</Layout>
```

### What the order buys you

Four things have to happen before anything renders, and each one is a bug if it moves:

- **The token is read before `resolve`**, because it is an argument to it. A route that reads it
  afterwards has already fetched published content and has nothing to do with it.
- **The redirect branch precedes the 404 branch**, or a moved page 404s at its old address.
- **The headers are set in the frontmatter**, not in the layout. Once the response body starts, a
  header set is a header ignored — and the one you lose is `no-store` on a draft.
- **`CMS_URL` comes from `src/taproot.ts`**, not from a second environment read here. See
  [Getting started](/build/getting-started/#one-module-for-the-connection): on Workers the two
  spellings are not interchangeable, and one file reading the environment is one file to change.

### What is deliberately not in here

- **Term archive pages.** Whether a taxonomy's terms get URLs is your decision, not Taproot's — see
  [Menus and term URLs](/build/menus/).
- **Rendering plain fields generically.** The block renderer covers a site built from blocks; the
  schema-driven loop earlier on this page covers one that is not.
- **`TaprootImage`.** Blocks that hold images use it internally — see
  [Images and media](/build/images/).

The reference site (`apps/web/src/pages/[...path].astro`) is this route plus term archives and the
generic field loop, if you want the version with everything switched on.
