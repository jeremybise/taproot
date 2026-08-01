# @taprootcms/studio

The [Taproot](https://github.com/jeremybise/taproot) CMS server as an Astro integration: the admin
panel, the REST API, and the delivery API.

**Most people should not install this directly.** Run `npm create taproot`, which scaffolds a server
project with this already wired up.

```bash
npm create taproot my-cms
```

**A website does not install this.** A site installs
[`@taprootcms/astro`](https://www.npmjs.com/package/@taprootcms/astro) and reads content over HTTP.
This is the server, and it owns the database.

## What it adds

```js
import taproot from '@taprootcms/studio';

export default defineConfig({
  output: 'server',
  integrations: [taproot()],
});
```

That injects 80-odd routes: the admin at `/admin` (with `/` redirecting to it), the REST API and the
delivery API under `/api/taproot`, and a middleware that resolves the session or the API key.

| Option | |
|---|---|
| `adminPath` | Where the admin mounts. Default `/admin`. Cannot be `/` |
| `addReactRenderer` | Leave on unless the host app already adds `@astrojs/react` |

## How it is built

**The admin is server-rendered Astro, not a SPA.** Every screen is a page whose permission check
runs before any HTML is sent, and React appears only where interaction demands it. That is primarily
an accessibility decision: client-side routing needs hand-built focus management and route
announcements to meet WCAG AA, and real navigation gets both for free. The admin is WCAG 2.1 AA,
checked per release by an axe run over every route plus a numeric contrast check of every token
pair.

**It ships source, not a build.** Astro's `injectRoute` compiles `.astro` entrypoints out of
`node_modules` through the host's Vite pipeline, the same way Starlight does.

**Zero native dependencies.** Passwords are PBKDF2-SHA256 through `crypto.subtle`, both SQL drivers
are written in-tree, and image dimensions are read from header bytes rather than decoded — so the
same code runs on Node and on Workers, and `npm install` never needs a C++ toolchain.

## Requirements

Astro 7, Node 22.12 or newer, and `@taprootcms/core`.

## Documentation

See the [repository](https://github.com/jeremybise/taproot). The handbook covers using the CMS,
administering a site, and running the server.

## License

MIT
