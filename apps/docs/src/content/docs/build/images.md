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
import { TaprootImage } from '@taproot/astro/components';

const asset = media[item.data.hero_image];
---

{asset && <TaprootImage asset={asset} ratio={16 / 5} alt="" />}
```

| Prop | |
|---|---|
| `asset` | An entry from the media map |
| `ratio` | Width ÷ height — `16 / 9`, `1`, `1200 / 630` |
| `alt` | Overrides the asset's own alt text. `""` marks it decorative |
| `loading` | `'lazy'` (default) or `'eager'` |
| `class` | Applied to the wrapper |

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
import { TaprootImage } from '@taproot/astro/components';
import type { DeliveryMedia } from '@taproot/astro';

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
import { resolveCrop, cropFrame } from '@taproot/astro';
```

These are the functions the admin's hotspot editor previews with, shared rather than reimplemented,
so what an editor sees while dragging is what your site renders.
