---
title: Blocks
description: BlockRenderer, the component map, and why Taproot ships no block designs.
---

A block field is an ordered list an editor builds a page out of — a hero, some prose, a gallery, a
call to action. Taproot stores what each block **is**: its type and its validated field values.

**It ships no templates.** A CMS that shipped a hero component would be shipping a design, and the
point of user-defined block types is that a site invents the pieces it needs. What crosses the wire
is content; what it looks like is yours.

## The component map

That contract is one object: block `api_id` → your Astro component.

```ts
// src/blocks/index.ts
import CallToAction from './CallToAction.astro';
import Gallery from './Gallery.astro';
import Hero from './Hero.astro';
import Prose from './Prose.astro';

export const BLOCK_COMPONENTS = {
  hero: Hero,
  call_to_action: CallToAction,
  prose: Prose,
  gallery: Gallery,
};
```

The keys are the block types' `api_id` values, exactly as they appear in the admin under
**Settings → Block types**.

## Rendering them

```astro
---
import { BlockRenderer } from '@taproot/astro/components';
import { BLOCK_COMPONENTS } from '../blocks/index.ts';

const blockFields = item.fields.filter((field) => field.type === 'block');
---

{blockFields.map((field) => (
  <BlockRenderer
    blocks={item.data[field.apiId]}
    components={BLOCK_COMPONENTS}
    media={media}
  />
))}
```

| Prop | |
|---|---|
| `blocks` | The field's value from `item.data` |
| `components` | Your map. Anything unlisted renders nothing |
| `media` | The response's media map, forwarded to every block |
| `as` | Optional wrapper element per block. `null` renders bare |

**Pass `media`.** A block holding an image stores an id, and the asset is already in the response —
forwarding the map is what keeps a block template from needing a request of its own. See
[Images and media](/build/images/).

## Writing a block component

Each component receives the block's own fields as props, by `api_id`:

```astro
---
// src/blocks/Quote.astro
interface Props {
  quote: string;
  attribution?: string | null;
}

const { quote, attribution } = Astro.props;
---

<blockquote>
  <p>{quote}</p>
  {attribution && <cite>{attribution}</cite>}
</blockquote>
```

Two extra props come along for anything that needs them:

- `block` — the whole instance, `{ id, type, data, ref? }`
- `media` — the response's media map

## A missing component is not an error

A block type with no entry in your map renders **nothing in production** and a visible note in
development.

That asymmetry is deliberate. Adding a block type in the admin and forgetting the component is the
expected mistake, so it is loud while you build and silent in front of visitors — one unmapped block
must not take down the page around it.

## Reusable blocks need nothing from you

An editor can promote a block to a shared library, and a page then stores a reference rather than a
copy. **The CMS dereferences it before sending**, so `block.data` holds the content either way and
your component cannot tell the difference.

`block.ref` is set when the library owns the content. You will rarely read it — it is there for a
template that wants to mark shared content in an editor-facing view.

:::note
Every block instance has `data`, whether it is inline or a reference. If you have seen an older
description claiming inline blocks carry their fields at the top level, that was wrong — and it was
wrong in a way that compiles and reads `undefined` from every field.
:::

## Nested blocks

A block type can itself have a block field. Render it with another `BlockRenderer`, forwarding the
same map:

```astro
---
import { BlockRenderer } from '@taproot/astro/components';

interface Props {
  heading: string;
  cards?: unknown;
  media?: Record<string, any>;
}

const { heading, cards, media = {} } = Astro.props;
---

<section>
  <h2>{heading}</h2>
  <BlockRenderer blocks={cards} components={BLOCK_COMPONENTS} media={media} />
</section>
```

The CMS prevents a block containing itself and caps nesting a few levels deep, so this cannot
recurse forever.
