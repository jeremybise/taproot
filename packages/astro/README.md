# @taprootcms/astro

The [Taproot](https://github.com/jeremybise/taproot) client for Astro. A site installs this and
reads content from a Taproot CMS server over HTTP.

```bash
npm install @taprootcms/astro
```

**This is the half a website installs.** The CMS server is a separate deployment — scaffold one with
`npm create taproot` — and a site never installs it. What you get here is a typed client, a
`BlockRenderer`, and a `TaprootImage` that honours the focal point an editor set.

## Setup

Two environment variables: where the CMS is, and a read key you issue from **Settings → API keys**.

```bash
TAPROOT_API_URL=https://cms.example.edu
TAPROOT_API_KEY=tpr_...
```

```ts
import { createTaprootClient } from '@taprootcms/astro';

export const taproot = createTaprootClient({
  url: import.meta.env.TAPROOT_API_URL,
  key: import.meta.env.TAPROOT_API_KEY,
});
```

## Rendering a page

One catch-all route resolves any path in a single round trip — the item, its type and fields,
breadcrumbs, visible children, blocks already dereferenced, resolved SEO, and lookup maps for media,
relations, and terms:

```astro
---
const result = await taproot.resolve(Astro.url.pathname);

// A redirect arrives as a 200 carrying `{ kind: 'redirect' }`, never a 30x — the server must not
// redirect your fetch, it must tell you to redirect your visitor.
if (result.kind === 'redirect') return Astro.redirect(result.to, result.status);
if (result.kind === 'notFound') return new Response('Not found', { status: 404 });

const { item, media } = result;
---
<h1>{item.title}</h1>
```

## What it deliberately does not do

**It never touches a database.** This package imports `@taprootcms/core/pure` at runtime — crop
arithmetic and nothing else — and everything else as `import type`, erased at build. Importing the
data layer would drag Kysely and its dialect loaders into a site that cannot use them. The built
consumer is roughly 460 KB and contains no `kysely`.

**It has no opinion about term URLs.** Whether a taxonomy's terms get public pages depends on the
routes your site serves, which the CMS cannot know — so menus arrive with unresolved term targets
and you apply your own resolver.

## Requirements

Astro 7, Node 22.12 or newer.

## Documentation

See the [repository](https://github.com/jeremybise/taproot) — the handbook's "Building a site"
section covers rendering, blocks, images, menus, preview, and generated types.

## License

MIT
