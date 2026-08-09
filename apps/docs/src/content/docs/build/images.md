---
title: Images and media
description: The media map, TaprootImage, and honouring the focal point an editor set.
---

Media fields store **ids**. The assets themselves arrive in the response's `media` map, keyed by
that id.

```ts
item.data.hero_image          // '019fbd07-cf56-…'
media[item.data.hero_image]   // the asset
```

Everything the page references is in the map — including images inside blocks, and the SEO social
card — so rendering a gallery costs one lookup per image and no requests.

## What an asset looks like

```ts
{
  id, url, alt, title, mimeType,
  width, height,
  hotspot: { x, y } | null,                        // normalised 0–1
  crop: { top, right, bottom, left } | null,       // normalised offsets
}
```

`url` is **absolute**. Your site does not know where the CMS keeps its files — R2 with a custom
domain, or served by the CMS Worker — and it does not need to.

## Use `TaprootImage`, not `object-fit: cover`

```astro
---
import { TaprootImage } from '@taprootcms/astro/components';

const asset = media[item.data.hero_image];
---

{asset && <TaprootImage asset={asset} ratio={16 / 5} alt="" />}
```

| Prop | |
|---|---|
| `asset` | An entry from the media map |
| `ratio` | Width ÷ height — `16 / 9`, `1`, `1200 / 630`. **Omit it** when the box has no fixed shape — see [when there is no ratio](#when-there-is-no-ratio) |
| `alt` | Overrides the asset's own alt text. `""` marks it decorative |
| `sizes` | How wide the **container** is at each breakpoint. Default `'100vw'` |
| `crop` | `'css'` (default) or `'server'` — see [where the crop happens](#where-the-crop-happens) |
| `format` | `'auto'` (default — AVIF with a WebP fallback), or one of `'webp'`, `'avif'`, `'jpeg'`, `'png'`, `'original'` |
| `widths` | Override the offered widths. `[]` emits no `srcset` |
| `loading` | `'lazy'` (default) or `'eager'` |
| `fetchpriority` | `'high'` for the one image worth raising — usually the hero |
| `class` | Applied to the wrapper — or to the `<img>` itself when you omit `ratio` |

### Why this matters

Editors set a **focal point** on each image — the part that must stay in frame. `object-fit: cover`
centre-crops, so it throws that away: an editor places a face carefully and the site cuts it out at
exactly the shape they set it for.

`TaprootImage` resolves the stored hotspot and crop into a rectangle for the ratio you ask for, and
positions a real `<img>` inside an aspect-ratio box. One asset drives a 16:9 hero, a square
thumbnail, and a portrait card, each correct, with no derivative files and nothing to regenerate
when a template changes shape.

It stays a real `<img>` — so alt text, lazy loading, and crawler visibility all survive, which a CSS
background image loses.

:::caution
**Do not set `aspect-ratio` on it yourself.** The component owns its wrapper because the maths only
avoids distorting the image if the box carries the same ratio the rectangle was resolved for. A
caller imposing its own shape gets the image letterboxed inside a frame it was not cropped for.

Set `width`, `border-radius`, and margins freely — just not the ratio.

If your container genuinely has no fixed shape, **omit `ratio`** rather than inventing one — see
[when there is no ratio](#when-there-is-no-ratio).
:::

## When there is no ratio

Some containers are as tall as whatever is laid over them. A page-title band is a minimum height
plus however tall the heading and breadcrumbs turn out to be; a call-to-action is padding plus its
copy. Both change shape with the viewport *and* with the content, so there is no ratio to resolve a
crop rectangle against — and forcing one would either letterbox the photograph or push the text out
of its own section.

**Omit `ratio`.** You get a bare `<img>` you place yourself, still with the full `srcset`, the format
handling, and the editor's focal point applied as `object-position`.

```astro
<div class="relative min-h-64">
  <TaprootImage
    asset={asset}
    alt=""
    class="absolute inset-0 h-full w-full object-cover"
    sizes="100vw"
  />
  <h1 class="relative">Admissions</h1>
</div>
```

Three differences from the framed mode:

- **`class` lands on the `<img>`**, because there is no wrapper — that is the element you are placing.
- **You choose the `object-fit`.** `cover` for a band, `contain` for a logo. The component will not
  choose for you, because both are right for different callers.
- **The crop is approximated, not resolved.** `object-position` can slide the whole image within its
  container, so it expresses the focal point but not a sub-rectangle — the cropped-away edges are
  still on screen. It is much closer to what the editor asked for than the browser's default centre.

:::caution
Reaching for a plain `<img>` to escape the ratio costs you the resize as well. That is worth stating
plainly because it was measured on a real site: a page-title band shipped a 170 KB original as its
largest-contentful element where the WebP candidate was 76 KB. Skipping the crop is a good reason to
skip the crop — it was never a reason to skip everything else.
:::

## Sizing images for the visitor

`TaprootImage` emits a `srcset`, and the media route resizes to match. A phone is not sent the
2000-pixel photograph an editor dragged in.

**The one thing worth passing is `sizes`.** It describes how wide the *container* is, and the
default of `100vw` is right for a full-bleed hero and far too generous for anything else — a
half-width card left at the default fetches a hero-sized file at every breakpoint.

```astro
<TaprootImage
  asset={asset}
  ratio={4 / 3}
  sizes="(min-width: 1024px) 50vw, 100vw"
/>
```

Describe the box you placed, not the `<img>` inside it. Under the default `crop="css"` the element
is deliberately wider than its container — it is scaled up so the crop rectangle fills the frame —
and the component rewrites your lengths by that factor itself. Getting it the other way round is
how responsive images end up one breakpoint too soft on exactly the layouts that needed them.

Widths come from a fixed ladder (320 to 1920), filtered so nothing above the source is ever offered,
plus the source's own width when the ladder stops short of it. The ladder is closed on purpose: a
URL accepting any width is a URL where one crawler mints unbounded transformations against your
monthly allowance.

**Format defaults to `'auto'`, which offers AVIF with a WebP fallback.** The component emits a
`<picture>` whose sources each name one format, so the browser takes AVIF where it can decode it —
typically another 20–25% off an already-WebP-sized file — and WebP everywhere else. Nothing is
negotiated from a request header, so every URL stays its own cache entry.

Name a single format (`format="webp"`) to emit one plain `<img>` instead, or `format="original"` to
keep whatever was uploaded — that still resizes. SVG and GIF are never re-encoded: rasterising an SVG
throws away the thing it is good at, and resizing a GIF flattens the animation to its first frame.

## Where the crop happens

| | `crop="css"` (default) | `crop="server"` |
|---|---|---|
| Who crops | The browser, via CSS | The media route |
| Bytes delivered | The whole frame; part is hidden | Only the visible rectangle |
| `sizes` | Rescaled by the crop factor | Emitted exactly as written |
| Needs a transform-capable CMS | No | For the exact crop |

The default is correct everywhere, including a deployment that cannot transform images at all, which
is why it is the default.

`crop="server"` matters most where the crop is most aggressive. A 3.5:1 photograph in a 4:3 well
resolves to a rectangle covering 37.8% of the source width — so under CSS cropping the browser
fetches a full-width file and paints about a third of it, and is *also* soft for it, because the
ladder tops out at the source's width however little survives the crop. Measured on one real page,
switching four images to `crop="server"` took them from 2,182 KB to 195 KB, and sharper.

```astro
<TaprootImage asset={asset} ratio={4 / 3} sizes="50vw" crop="server" />
```

:::note
It degrades rather than breaks. If the transform cannot happen — no Images binding, a monthly
allowance reached, a format the resizer refuses — the original arrives and the image is framed on
its stored hotspot with `object-fit: cover`. The worst case is an approximate crop, never the wrong
picture.

Setting it up is one binding and no domain; see [deploying](/operate/deploying/).
:::

## Alt text

Comes from the media library, where an editor writes it once for the asset. `TaprootImage` reads it
unless you override.

```astro
<TaprootImage asset={asset} ratio={16 / 5} alt="" />
```

An explicit `""` marks the image decorative, which is correct when an adjacent heading already
carries the meaning — repeating it would make a screen reader announce the same words twice. That is
why the prop is not defaulted with `??`: an empty string is a decision, not an absence.

`null` alt text is an asset nobody has described yet. The component renders `""` rather than a
filename, because a filename read aloud is worse than silence.

## Images in blocks

Forward the map through `BlockRenderer` and look up the same way:

```astro
---
// src/blocks/Hero.astro
import { TaprootImage } from '@taprootcms/astro/components';
import type { DeliveryMedia } from '@taprootcms/astro';

interface Props {
  heading: string;
  image?: string | null;
  media?: Record<string, DeliveryMedia>;
}

const { heading, image, media = {} } = Astro.props;
const asset = image ? media[image] : undefined;
---

{asset && <TaprootImage asset={asset} ratio={16 / 5} alt="" />}
<h2>{heading}</h2>
```

## Galleries keep their order

A multi-file field stores an ordered array, and that order is the one an editor arranged with the
move buttons. Map over the ids, not over the map:

```astro
---
const assets = (item.data.images as string[] ?? [])
  .map((id) => media[id])
  .filter(Boolean);
---
```

## Resolving a crop yourself

If you need the rectangle without the component — for an image CDN, or a canvas — the same functions
are exported:

```ts
import { resolveCrop, cropFrame } from '@taprootcms/astro';
```

These are the functions the admin's hotspot editor previews with, shared rather than reimplemented,
so what an editor sees while dragging is what your site renders.
