---
title: Embeds
description: TaprootEmbed, the three sizing modes, and the seam for forms that report their own height.
---

An `embed` field stores two strings and no markup:

```ts
item.data.video   // { url: 'https://…', title: 'Campus tour video' }
```

That is the whole design. Taproot deliberately has **no raw HTML field** — a stored value rendered
with `set:html` is stored XSS against every visitor and every editor, and roles here are flat, so
the lowest role there is would get script execution on your site. Storing a URL instead means the
frame's `sandbox`, `title`, `referrerpolicy` and host are guarantees rather than things whoever
pasted the snippet remembered.

Render it with `<TaprootEmbed>`:

```astro
---
import { TaprootEmbed } from '@taprootcms/astro/components';
---
<TaprootEmbed embed={item.data.video} sizing={{ mode: 'ratio', ratio: 16 / 9 }} />
```

Building the `<iframe>` yourself gets you the storage safety and none of the rendering safety, which
is half the point of the field.

## Sizing

A ratio is right for exactly one of the three things people embed. A video is 16:9 forever; a form
is 400px until somebody trips validation and then it is 900px.

| Mode | Config | For |
| --- | --- | --- |
| `ratio` | `{ mode: 'ratio', ratio: 16 / 9 }` | Video, most maps. Needs no JavaScript. |
| `fixed` | `{ mode: 'fixed', height: 600 }` | Anything with a height you know. |
| `auto` | `{ mode: 'auto', minHeight: 400 }` | Forms that grow as they are filled in. |

The mode is set on the **field**, by whoever configured the content type — so an editor pasting a
link never has to reason about aspect ratios. Read it from the schema, or state it in the template
when the template is what decides (a "Video" block is 16:9 because that is what it is for).

## Forms that report their own height

Under `auto`, the frame starts at `minHeight` and grows when the embedded page posts its height.
There is **no standard** for that message: iframe-resizer posts a colon-delimited string, other
vendors post `{ height }`, and whoever built a given form posted whatever they liked.

So the split is the same one `termHref` makes for menus: **Taproot owns the security, your site owns
the parse.** The built-in parser handles the common shapes, so most forms need nothing at all:

- a bare number, or a numeric string
- `{ height: 640 }`, including `{ type: 'resize', height: 640 }`
- a JSON string of either
- iframe-resizer's `[iFrameSizer]…:640:0:init`

When a provider does something of its own, listen for `taproot:embed:message`:

```astro
<script>
  document.addEventListener('taproot:embed:message', (event) => {
    const { data, origin, setHeight } = event.detail;
    if (origin !== 'https://forms.example.edu') return;
    if (data?.kind === 'vendor:height') setHeight(data.px);
  });
</script>
```

`setHeight` applies the clamp, so overriding the parse cannot accidentally opt out of the bound. By
the time your handler runs, Taproot has already checked that the message came from *this* frame
(`event.source`, not just the origin — two embeds from one provider on a page share an origin) and
will refuse anything that is not a positive number under 5000.

If nothing calls `setHeight`, the built-in parser runs. If that cannot read the message either, the
frame is left exactly where it is — never collapsed. Pages receive messages meant for somebody else
constantly.

### Three limits worth knowing before you hit them

**A vendor that posts to `window.top` breaks in the preview pane only.** The pane frames your site,
so your page is not the top window there — the height message lands in the CMS instead. The embed
sits at `minHeight` in preview and works perfectly once published, which is a miserable thing to
debug if you do not know it can happen. `window.parent` is unaffected.

**Auto sizing cannot work for a same-origin embed.** Framing your own domain makes
`allow-scripts allow-same-origin` equivalent to no sandbox at all, so `TaprootEmbed` drops
`allow-same-origin` — which gives the frame an opaque origin, and the origin check can then never
match. If you are embedding your own page, you almost certainly want a component rather than a
frame.

**Some providers need a script on the host page.** That is a protocol rather than a URL, and it is
not this field. Write a block component instead: `BLOCK_COMPONENTS` maps a block type to any Astro
component you like, so the handshake lives in your repository where a developer can read it, while
the block's other fields — heading, intro copy, which campaign — stay editable in the CMS. That is
the right answer whenever the embed has moving parts, and it is strictly safer than a raw HTML field
would have been.

## The frame Taproot builds

```html
<iframe
  src="…" title="…" loading="lazy"
  sandbox="allow-scripts allow-same-origin allow-forms allow-popups
           allow-popups-to-escape-sandbox allow-presentation"
  referrerpolicy="strict-origin-when-cross-origin"
  allowfullscreen></iframe>
```

`allow-top-navigation` is **absent**: a framed page may not navigate the page it sits in. So is
`allow-downloads`, which is the most likely reason to override — pass your own `sandbox` (it
replaces the default wholesale, so you can see everything you are granting).

`allow` is empty by default. Every entry hands a capability to another origin, so `autoplay` or
`clipboard-write` is a decision for your template:

```astro
<TaprootEmbed embed={item.data.video} allow="encrypted-media; picture-in-picture" />
```

## Approved hosts

The field refuses any address that is not on its allowlist, and an **empty allowlist admits
nothing** — unlike a media field's `accept`, where empty means anything. An unconfigured embed field
embeds nothing at all, on purpose.

An entry covers everything under it, so `youtube.com` admits `www.youtube.com` but not
`evil-youtube.com` and not `youtube.com.evil.example`.

Enforcement is server-side, in `validateItemData` — the editor's warning is a courtesy, because the
REST API accepts this value from any client holding a session.

One thing the allowlist does not do: your site's own `Content-Security-Policy`. If you send one,
`frame-src` has to name the same hosts. The allowlist is what makes that list knowable.
