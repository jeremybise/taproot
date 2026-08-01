---
title: Getting started
description: Creating an Astro site that reads its content from a Taproot server.
---

A Taproot site is an **ordinary Astro app** that fetches content over HTTP. It holds no database, no
admin panel, and no CMS code beyond one small client package — which means you can redesign it,
rebuild it in a different framework, or throw it away, without any of that touching the content.

This section is for whoever builds that site. If you write content, you want
[Content items](/content/items/) instead.

## What you need

- A running Taproot CMS, and its address
- An **API key** with the `content:read` scope — created in the admin under
  **Settings → API keys**, and shown exactly once. See [API keys](/admin/api-keys/).

## Create the site

```bash
npm create astro@latest my-site
cd my-site
npm install @taproot/astro
```

Astro must render on the server, because content is resolved per request:

```js
// astro.config.mjs
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
});
```

:::note
A site that wants a **static** build can fetch at build time instead — the client is the same, since
the delivery API is plain HTTP. You lose publish-without-rebuild, which is most of the reason
Taproot is database-backed, so server output is the default worth starting from.
:::

## Configure it

```
# .env
TAPROOT_API_URL=https://cms.example.edu
TAPROOT_API_KEY=tpr_...
```

Two variables, and that is genuinely all of it. The site holds no database credentials because it
has no database — which is also why a compromised site cannot edit anything.

## One module for the connection

Put the client in one place rather than constructing it per route:

```ts
// src/taproot.ts
import { createTaprootClient } from '@taproot/astro';

export const taproot = createTaprootClient({
  url: import.meta.env.TAPROOT_API_URL,
  apiKey: import.meta.env.TAPROOT_API_KEY,
});
```

## The smallest thing that works

```astro
---
// src/pages/[...path].astro
import { taproot } from '../taproot.ts';

export const prerender = false;

const result = await taproot.resolve(`/${Astro.params.path ?? ''}`);

if (result.kind === 'redirect') {
  return Astro.redirect(result.to, result.status === 302 ? 302 : 301);
}
if (result.kind === 'not_found') {
  return new Response('Not found', { status: 404 });
}

const { item } = result;
---

<h1>{item.title}</h1>
```

Start the CMS and this site, and every published page resolves. That is the whole integration —
everything else in this section is about rendering it well.

## What you get in one request

`resolve` returns everything the page needs at once: the item, its content type and fields,
breadcrumbs, visible children, blocks with reusable ones already dereferenced, resolved SEO, and
lookup maps for every image, related item, and term the content references.

That is deliberate, and it is the reason the delivery API exists as its own thing. Rendering one
page used to take a dozen queries; as a dozen HTTP round trips it would have been unusable. See
[The client](/build/the-client/) for the full shape.

## The reference site

`apps/web` in the Taproot repository is a working consumer — a small campus site with blocks,
images, menus, term archives, and preview. It lives in the same repository as the CMS on purpose,
so that a change breaking the contract fails Taproot's own tests rather than surfacing in your
project.

When a page here says "the reference site does this", that is what it means.
