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

Where they go is the host's business — a `.env` file and whatever environment panel your platform
offers, for most of them.

### On Cloudflare

The URL is an ordinary variable and belongs in the committed config; the key is a secret and must
not:

```jsonc
// wrangler.jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "my-site",
  "main": "@astrojs/cloudflare/entrypoints/server",
  "compatibility_date": "2025-05-21",
  "compatibility_flags": ["nodejs_compat"],
  "assets": { "directory": "./dist", "binding": "ASSETS" },
  "vars": { "TAPROOT_API_URL": "https://cms.example.edu" }
}
```

```bash
npx wrangler secret put TAPROOT_API_KEY
```

`main` points at the adapter's entrypoint, which is right for a site. (The CMS names a worker file of
its own instead, but only because it needs a `scheduled` export for the publishing sweep — your site
has no scheduler.)

Then a git-ignored `.dev.vars` for local work, holding both:

```
TAPROOT_API_URL=http://localhost:4321
TAPROOT_API_KEY=tpr_...
```

:::danger[`.dev.vars` is local-only and is never uploaded.]
It is read by `astro dev` and `wrangler dev` and by nothing else. A variable that lives *only* there
is `undefined` in the deployed Worker — the classic "worked perfectly locally, 500s the moment it
ships". It surfaces from inside the client as

```
Error: createTaprootClient was given no `url`. This is usually an environment
variable that is undefined at runtime rather than a missing argument…
```

and it fails at module scope, before a request is ever made, so *every* path 500s rather than one.
Deployed values come from `vars` in `wrangler.jsonc` and from `wrangler secret put`. Keep `.dev.vars`
as well — it is a second copy for local dev, not the source.

On `@taprootcms/astro` **0.1.4 and earlier** the same mistake reads
`TypeError: Cannot read properties of undefined (reading 'replace')` with a stack pointing into a
bundled chunk, which names neither the variable nor the fact that it is configuration. Same cause,
same fix.
:::

## One module for the connection

Put the client in one place rather than constructing it per route:

```ts
// src/taproot.ts — Node, and anything that runs it
import { createTaprootClient } from '@taprootcms/astro';

export const CMS_URL = import.meta.env.TAPROOT_API_URL;

export const taproot = createTaprootClient({
  url: CMS_URL,
  apiKey: import.meta.env.TAPROOT_API_KEY,
});
```

```ts
// src/taproot.ts — Cloudflare Workers
import { env } from 'cloudflare:workers';
import { createTaprootClient } from '@taprootcms/astro';

export const CMS_URL = env.TAPROOT_API_URL;

export const taproot = createTaprootClient({
  url: CMS_URL,
  apiKey: env.TAPROOT_API_KEY,
});
```

Reading a binding is not I/O, so `cloudflare:workers` answers at module scope and the one-module
pattern survives intact. Only the two lines that read the environment differ.

**Export the URL as well as the client.** One route later needs the CMS's origin on its own — to name
it in a `frame-ancestors` directive so the preview pane may frame the page — and having it here means
this file stays the *only* place in the project that reads the environment. A second read somewhere
else is a second thing to remember when the host changes, and it will be the one that gets missed.

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

### Teaching TypeScript about `cloudflare:workers`

The import above will be underlined with **"Cannot find module 'cloudflare:workers'"** until the
Workers types exist. It is a virtual module the runtime supplies, so nothing in `node_modules`
declares it and `npm install` cannot fix it. Generate the types from your own config instead:

```bash
npx wrangler types
```

That writes `worker-configuration.d.ts` — the runtime types *and* an `Env` inferred from your
bindings. Point tsconfig at it:

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "types": ["./worker-configuration.d.ts", "node"]
  }
}
```

Append if you already have a `types` array: setting it replaces the automatic `@types/*` pickup,
which is why `node` is listed alongside — you are on `nodejs_compat`. Astro's own types arrive
through `src/env.d.ts`'s reference directive and are unaffected.

The generated file goes stale whenever `wrangler.jsonc` or `.dev.vars` changes, so wire it into the
scripts rather than remembering:

```json
"dev": "wrangler types && astro dev",
"build": "wrangler types && astro check && astro build"
```

:::note[The second squiggle]
Once the import resolves, `env.TAPROOT_API_KEY` errors with *"Property 'TAPROOT_API_KEY' does not
exist on type 'Env'"*. `wrangler types` infers `Env` from `vars` plus **`.dev.vars`**, and a secret
that exists only in `wrangler secret put` is invisible to it. Adding it to `.dev.vars` and re-running
fixes the type — which is a second reason that file earns its place, alongside making local dev work.
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
