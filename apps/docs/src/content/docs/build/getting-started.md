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
npm install @taprootcms/astro
```

Astro must render on the server, because content is resolved per request. The **adapter** is the one
line here that depends on where the site will live:

```js
// astro.config.mjs — Node, and anything that runs it
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
});
```

```js
// astro.config.mjs — Cloudflare Workers
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

export default defineConfig({
  output: 'server',
  adapter: cloudflare(),
});
```

Vercel, Netlify, and Deno have adapters too, and Taproot has no preference among any of them: the
site is an ordinary Astro app holding an API key, so it runs wherever Astro runs. Your host's
deployment instructions are Astro's to give, not this handbook's — **except** for one thing
downstream of this choice, which is how the two variables below reach the client.

:::note
A site that wants a **static** build can fetch at build time instead — the client is the same, since
the delivery API is plain HTTP. You lose publish-without-rebuild, which is most of the reason
Taproot is database-backed, so server output is the default worth starting from.
:::

## Configure it

```
TAPROOT_API_URL=https://cms.example.edu
TAPROOT_API_KEY=tpr_...
```

Two variables, and that is genuinely all of it. The site holds no database credentials because it
has no database — which is also why a compromised site cannot edit anything.

Where they go is the host's business: a `.env` file and whatever environment panel your platform
offers, for most of them. On Cloudflare the URL belongs in `vars` in `wrangler.jsonc`, and the key
belongs in `wrangler secret put TAPROOT_API_KEY` — with both in a git-ignored `.dev.vars` for local
work.

## One module for the connection

Put the client in one place rather than constructing it per route:

```ts
// src/taproot.ts — Node, and anything that runs it
import { createTaprootClient } from '@taprootcms/astro';

export const taproot = createTaprootClient({
  url: import.meta.env.TAPROOT_API_URL,
  apiKey: import.meta.env.TAPROOT_API_KEY,
});
```

```ts
// src/taproot.ts — Cloudflare Workers
import { env } from 'cloudflare:workers';
import { createTaprootClient } from '@taprootcms/astro';

export const taproot = createTaprootClient({
  url: env.TAPROOT_API_URL,
  apiKey: env.TAPROOT_API_KEY,
});
```

Reading a binding is not I/O, so `cloudflare:workers` answers at module scope and the one-module
pattern survives intact. Only the two lines that read the environment differ.

:::caution[`import.meta.env` is a build-time read, and on Workers that is not a runtime one.]
Astro replaces `import.meta.env.TAPROOT_API_KEY` with whatever the environment held when the site
was **built**. The Node adapter then fills it from `process.env` at runtime, so the familiar pattern
works there. Cloudflare has no `process.env` to fill it from, and a key set with `wrangler secret
put` never existed at build time — so the client sends no `Authorization` header, the delivery API
answers 401, and the site fails with *"The Taproot server refused the API key."*

That message is true and unhelpful: `wrangler secret list` shows the key sitting right there, so the
one thing you will not think to doubt is the line that reads it. And the other outcome is worse — a
key that *was* in the build environment gets inlined into the deployed bundle, which puts a
credential in a build artefact.
:::

:::note[One spelling for both]
If you would rather not fork this file per host, [`astro:env`](https://docs.astro.build/en/guides/environment-variables/)
is the portable route. Declare the schema once:

```js
// astro.config.mjs
import { defineConfig, envField } from 'astro/config';

export default defineConfig({
  env: {
    schema: {
      TAPROOT_API_URL: envField.string({ context: 'server', access: 'public' }),
      TAPROOT_API_KEY: envField.string({ context: 'server', access: 'secret', optional: true }),
    },
  },
});
```

and read it the same way everywhere:

```ts
import { TAPROOT_API_URL, TAPROOT_API_KEY } from 'astro:env/server';
```

It costs a schema block and buys a missing variable being a named error instead of a 401.
:::

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
