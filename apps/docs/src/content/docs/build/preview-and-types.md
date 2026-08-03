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
import { PREVIEW_PARAM } from '@taprootcms/astro';
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

## Split-view live preview

The same token also drives the **live preview pane** in the item editor: your site rendered beside
the fields, updating as the editor types. Unsaved changes reach it because the CMS parks the form's
current state on the token, and your SSR route picks it up on its next fetch — so what you see is
your own templates rendering content that has not been saved yet.

**If you have done the one line above, this already works.** There is nothing else to configure.

### Two lines that make it better

Without them the pane refreshes by reloading the whole frame from the outside, which starts the page
back at the top. On a long page that gets tiring fast. Add this to your layout:

```astro
---
import { TaprootPreviewBridge } from '@taprootcms/astro/components';
---
{previewToken && <TaprootPreviewBridge />}
```

It lets the CMS ask the page to reload *itself*, which keeps the scroll position. Keep it behind the
token check — otherwise every visitor ships a message listener for a handshake that can never happen.

The component learns the CMS's origin from the message it receives, so there is nothing to configure
and it never broadcasts to an arbitrary framer. It uses an inline `<script>`, so a site with a strict
script CSP needs a hash or a nonce for it.

### Let the CMS frame you

Nothing is required here either — Astro sends no framing headers and neither does Cloudflare, so the
pane frames your site as-is. Setting it explicitly is still worth it, because "no header" and "only
the CMS may frame this" are different promises:

```astro
Astro.response.headers.set(
  'content-security-policy',
  `frame-ancestors 'self' ${new URL(import.meta.env.TAPROOT_API_URL).origin}`,
);
```

If your site already sends a CSP, **add the directive to it** rather than replacing the header. Read
the CMS's origin however your host supplies it — the same choice as
[the connection module](/build/getting-started/#one-module-for-the-connection), and on Cloudflare an
undefined value here throws inside `new URL` rather than quietly sending a weaker header.

`frame-ancestors` rather than `X-Frame-Options`, which has no origin-list form at all — `ALLOW-FROM`
was never implemented in Chrome and is gone from the rest.

### What the pane cannot show you

Worth knowing before you conclude something is broken:

- **Navigation and listings are published-only.** A draft page previews correctly but does not appear
  in the previewed menu, because menus and item listings come from delivery endpoints that take no
  preview token.
- **Unsaved changes apply on the item's own address.** The pane has an address box — useful for
  seeing a change in context, or for previewing a reusable block on a page that places it — but
  pointing it elsewhere shows the live published site. That is deliberate: a preview token is a
  capability over one item, not a key to every unpublished page.
- **Singletons have no page of their own**, so they get no pane. Their path is the synthetic
  `/__singleton/{api_id}`, which is an addressing convenience rather than a route.
- **A new item cannot be previewed until it is saved once**, because the token has to name a row.
- **Cookies behave differently inside the frame.** A `SameSite=Lax` cookie your site sets is not
  sent in a cross-site framed context, so a consent banner or an A/B cookie may act differently in
  the pane than in a tab.

### If the pane is blank

Almost always a WAF, CDN rule, or security-headers middleware in front of your site adding
`X-Frame-Options: SAMEORIGIN`. A CSP from your app cannot loosen that — it has to be removed where it
is added. See [Troubleshooting](/troubleshooting/).

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
