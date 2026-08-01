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
