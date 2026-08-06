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

:::tip
This page introduces preview one piece at a time. If you would rather see the finished route with all
of them already in place, [the whole frontmatter, in one
piece](/build/rendering-a-page/#the-whole-frontmatter-in-one-piece) is the assembled version.
:::

### Never cache or index a preview

```astro
---
if (previewToken) {
  Astro.response.headers.set('cache-control', 'no-store');
  Astro.response.headers.set('x-robots-tag', 'noindex, nofollow');
} else {
  Astro.response.headers.set('cache-control', 'public, max-age=0, s-maxage=86400');
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
---
import { CMS_URL } from '../taproot.ts';

if (CMS_URL) {
  Astro.response.headers.set(
    'content-security-policy',
    `frame-ancestors 'self' ${new URL(CMS_URL).origin}`,
  );
}
---
```

If your site already sends a CSP, **add the directive to it** rather than replacing the header.

`CMS_URL` is imported rather than read from the environment again here, because how the environment
is read depends on where the site is deployed and one file should own that — see
[the connection module](/build/getting-started/#one-module-for-the-connection). The guard matters for
the same reason: `new URL(undefined)` throws, so a missing variable would take the whole page down
rather than sending a weaker header.

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
- **A singleton gets a pane only once you say where it renders.** Its own path is the synthetic
  `/__singleton/{api_id}`, an addressing convenience rather than a route, so Taproot cannot work out
  the address on its own — set **Preview path** on the content type (Settings → Content types) to the
  URL your site serves it at, such as `/`. Left empty there is no pane, which is deliberate: a
  settings singleton has no page, and framing the front page for it would show something that
  content is not.
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
  schedule?: {                                             // a repeater
    id: string;
    data: { time: string; what: string; room?: string };
  }[];
  host_page?: ContentItemId;
}
```

Required fields are non-optional, because validation on write is a promise the CMS actually keeps.
Select options become a union, so a typo is a compile error. `MediaId`, `ContentItemId`, and
`TermId` are ids you look up in the response's maps — the types name them so it is obvious which map.

**A repeater row is an envelope.** Each row is `{ id, data }` with the sub-field values under `data`,
so it is `row.data.time`, never `row.time`. The `id` is the row's stable identity. Getting this wrong
is silent — every row is still an object, so nothing throws and the right *number* of empty things
renders.

**A link is a union discriminated by `kind`**, and only one of the three is a URL:

```ts
type Cta =
  | { kind: 'item'; id: ContentItemId; label?: string; newTab: boolean; noFollow: boolean }
  | { kind: 'media'; id: MediaId; label?: string; newTab: boolean; noFollow: boolean }
  | { kind: 'url'; href: string; label?: string; newTab: boolean; noFollow: boolean };
```

The first two are references, resolved through the same `references` and `media` maps as relation
and media fields — which is what lets a page move without breaking the links aimed at it:

```ts
const href =
  link.kind === 'item' ? references[link.id]?.path
  : link.kind === 'media' ? media[link.id]?.url
  : link.href;
```

A field restricted to fewer kinds generates only those members, so a `switch` over it stays
exhaustive.

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
