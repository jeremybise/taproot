---
title: Preview and types
description: Letting editors preview drafts on your site, and generating types for your content model.
---

## Preview

Editors need to see unpublished content on the real site, with the real design. Because the CMS and
your site are different origins, the CMS mints a short-lived **token** and sends the editor to your
site carrying it.

Your job is one line: forward it.

```astro
---
import { PREVIEW_PARAM } from '@taproot/astro';
import { taproot } from '../taproot.ts';

const previewToken = Astro.url.searchParams.get(PREVIEW_PARAM);

const result = await taproot.resolve(path, { previewToken });
---
```

That is the whole integration. Your site cannot judge the token — it has no session and no database
— so it hands it back and the CMS decides. The capability lives in the token, which is why this is
not a `?preview=1` flag anybody could add to a URL.

`PREVIEW_PARAM` is `taproot_preview`. Use the constant so a rename cannot desynchronise the two ends.

### Never cache or index a preview

```astro
---
if (previewToken) {
  Astro.response.headers.set('cache-control', 'no-store');
  Astro.response.headers.set('x-robots-tag', 'noindex, nofollow');
} else {
  Astro.response.headers.set('cache-control', 'public, max-age=0, s-maxage=60');
}
---
```

The CMS already says `no-store` on its own response, but that is a *different origin serving a
different document*. A shared cache in front of your site would otherwise hold a draft and serve it
to somebody with no token at all.

Skip the canonical tag too — a preview emitting a canonical pointing at the live URL tells a crawler
that a draft is the authoritative version of the page.

### Say that it is a preview

```astro
{previewToken && item.status !== 'published' && (
  <p role="status"><strong>Preview.</strong> This {item.status.replace('_', ' ')} content is not
  visible to visitors.</p>
)}
```

Worth the four lines. Without it, an editor looking at a draft on the real design has nothing
telling them the public cannot see this — and that is exactly how somebody concludes a page is live
when it is not.

### Releases preview through the same token

A [release](/publishing/releases/) holds a staged version of a page, and previewing one uses the
identical mechanism — the CMS resolves the token to the staged content instead of the live row. Your
site needs no extra handling: the response is the same shape, showing what the page will look like
after the release publishes.

### Configuring it

The CMS needs `TAPROOT_SITE_URL` set to your site's origin, or the preview button tells editors it
does not know where to send them. See [Settings and environment](/operate/configuration/).

Tokens last about thirty minutes and can be reopened within that — a link that died on first read
would break reload and the back button.

---

## Generated types

`item.data` is `Record<string, unknown>`, which is a true description of every Taproot site and a
useful description of none. Generate types for **your** content model instead:

```bash
TAPROOT_API_URL=https://cms.example.edu TAPROOT_API_KEY=tpr_… npm run taproot:types
```

That reads the **live** schema over the delivery API — not out of a database — so the types describe
what your site actually receives, and writes `src/content.d.ts`.

### What you get

```ts
export interface PageData {
  summary?: string;
  body?: string;
  departments?: TermId[];
  sections?: TaprootBlock[];
}

export interface EventData {
  starts_at: string;                                       // required in the CMS
  audience?: 'prospective' | 'current' | 'staff' | 'alumni';   // select options as a union
  capacity?: number;
  schedule?: { time: string; what: string; room?: string }[];  // a repeater
  host_page?: ContentItemId;
}
```

Required fields are non-optional, because validation on write is a promise the CMS actually keeps.
Select options become a union, so a typo is a compile error. `MediaId`, `ContentItemId`, and
`TermId` are ids you look up in the response's maps — the types name them so it is obvious which map.

Block types come back as a union discriminated by `type`:

```ts
function render(block: TaprootBlock) {
  switch (block.type) {
    case 'hero':  return block.data.heading;
    case 'quote': return block.data.quote;
  }
}
```

### Check the file in

That is the point. A schema change then shows up as a **reviewable diff**, and the moment somebody
renames a field the templates that used it stop compiling — which is a build failure rather than a
blank space on a page nobody noticed.

Rerun the generator after changing the content model. It is a `.d.ts` and carries no runtime code,
so importing from it costs nothing.
