---
title: Menus and term URLs
description: Rendering navigation, and deciding which taxonomy terms get pages on your site.
---

```astro
---
import { applyTermHrefs } from '@taprootcms/astro';
import { taproot, termHref } from '../taproot.ts';

const nav = applyTermHrefs(await taproot.menu('main'), termHref);
---

<nav aria-label="Main">
  <ul>
    {nav.map((entry) => (
      <li>
        <a href={entry.href}>{entry.label}</a>
        {entry.children.length > 0 && (
          <ul>{entry.children.map((child) => (
            <li><a href={child.href}>{child.label}</a></li>
          ))}</ul>
        )}
      </li>
    ))}
  </ul>
</nav>
```

Two steps, and the second one is the interesting one.

## Fetch it in the page, not in the layout

The natural place for that snippet is your site layout, where the nav is rendered — and it is the
wrong place. **Astro runs a page's frontmatter to completion before a layout's**, so a
`await taproot.menu()` in the layout cannot start until the `await taproot.resolve()` in the page has
finished. That is two round trips to the CMS one after the other, on every page view, for two
requests that have nothing to say to each other.

Fetch both in the page and pass the nav down:

```astro
---
const [result, nav] = await Promise.all([
  taproot.resolve(path),
  taproot.menu('main').then((entries) => applyTermHrefs(entries, termHref)),
]);
---

<SiteLayout nav={nav}>…</SiteLayout>
```

Make the layout's `nav` prop **required**. An optional one with a fetch as its fallback leaves the
serial path in place for whoever has not read this page, which is precisely who will hit it.

If two components end up asking for the same menu in one render, that costs one request, not two —
the client deduplicates requests that are in flight together.

## Menus reference their targets

A menu entry points at a **page**, a **term**, or an external **URL** — it never stores a path. That
is the whole point: a moved page keeps its place in the navigation, and an unpublished one drops out
of it, with nobody editing the menu.

`menu()` returns only entries a visitor may follow. A broken one — its target deleted — is absent,
because a consumer can do nothing with it but render a dead link. The admin is where a broken menu
row is meant to be visible and fixed.

## Term targets arrive unresolved

An entry's `target` is one of:

```ts
{ type: 'item', path: '/admissions' }
{ type: 'url',  url: 'https://example.org' }
{ type: 'term', id, name, slug, taxonomyApiId }
```

The first two are already links. The third is not — and deliberately.

**Taproot has no opinion about whether a taxonomy's terms have public pages.** Most taxonomies on a
real site classify content without deserving a page each: a review status, an internal owner, an
audience segment. Publishing archives for those would leak editorial structure into your URL space.
Others genuinely want one.

Which is which depends on the routes *your site actually serves*, so the CMS cannot know it. It
hands you the term and you decide.

## Deciding, in one place

```ts
// src/taproot.ts
export const PUBLIC_TERM_TAXONOMIES = new Set(['department']);

export function termHref(term: { taxonomyApiId: string; slug: string }): string | null {
  return PUBLIC_TERM_TAXONOMIES.has(term.taxonomyApiId)
    ? `/${term.taxonomyApiId}/${term.slug}`
    : null;
}
```

`applyTermHrefs` walks the tree and drops any entry your resolver returns `null` for — nothing is
wrong, there is simply nowhere to link to.

Keep it a shared constant, because **two things must agree**: this resolver, and the route that
serves those pages. A term that gets an href but no route is a link to a 404.

## Serving a term archive

Add it to the catch-all, *after* the item lookup so a real page always wins:

```astro
---
const result = await taproot.resolve(path);

let archive = null;

if (result.kind === 'not_found') {
  const segments = path.split('/').filter(Boolean);

  if (segments.length === 2 && PUBLIC_TERM_TAXONOMIES.has(segments[0]!)) {
    const found = await taproot
      .items({ taxonomy: segments[0]!, term: segments[1]!, limit: 200 })
      .catch(() => null);

    if (found?.term) {
      archive = { title: found.term.name, items: found.items };
    }
  }

  if (!archive) return new Response('Not found', { status: 404 });
}
---
```

Three things worth knowing:

**`term` takes a slug when you name the `taxonomy`.** A URL carries a slug and the database keys on
an id; translating it yourself would be a second round trip on the endpoint that exists to avoid
them.

**The response carries the term back**, so the heading is the editor's "Student Services" rather than
an un-slugified "student services" — a rule that also gets "PhD" wrong in a way nothing can recover.

**A term filter always means the whole branch.** Filing something under "Biology" finds it when a
visitor browses "Sciences". The expansion happens server-side, so you never need the term tree.

## Trying it after the item lookup

An archive is attempted only when no content item claims the path. That keeps `/department/…` from
being a reserved prefix nobody may use — if an editor creates a real page there, it wins.

Use `found.term` rather than `found.items.length` to decide whether the archive exists. A term with
nothing filed under it is still a page, and saying "nothing here yet" is more useful than a 404
suggesting the URL is wrong.
