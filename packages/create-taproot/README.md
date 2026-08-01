# create-taproot

Scaffold a [Taproot](https://github.com/jeremybise/taproot) CMS server.

```bash
npm create taproot my-cms
```

Taproot is a DB-backed, Astro-native CMS built for a site with many non-technical contributors — a
visual content-type builder, hierarchical URLs that actually nest, blocks, revisions, a review
workflow, batched releases, and an accessibility checker that reads your content.

## What this creates

**The CMS server**: the deployment that owns the database, the admin panel, and the API. It runs on
Cloudflare Workers + D1 + R2, and on Node and SQLite in development.

**Not the website.** Taproot is two deployments, and that is the design rather than an
inconvenience — the site that visitors read is a separate Astro project that installs
[`@taprootcms/astro`](https://www.npmjs.com/package/@taprootcms/astro), holds an API key, and reads
over HTTP. That is why editing a page cannot take the site down, and why the site can be redesigned
without touching what has been written. Scaffolding that half here would mean generating somebody's
front end, and Taproot ships no templates for the same reason it ships no block components.

## Getting started

```bash
npm create taproot my-cms
cd my-cms
npm install
npm run db:migrate
npm run dev
```

Open <http://localhost:4321>. There are no accounts yet, so it takes you to a one-time setup screen
that creates the first administrator.

> Complete that screen before putting the server anywhere public. Until an account exists, whoever
> reaches the URL first becomes the administrator.

## Options

```
npm create taproot [directory] [options]

  --starter <blank|minimal>  What the CMS starts with. Default: blank
  --local <path>             Depend on a local Taproot checkout via file:
  -y, --yes                  Take defaults, ask nothing
```

**`blank`** gives you the database and nothing else. Right if you already know your content model.

**`minimal`** adds a Page type with a few fields, a home page, and a menu — so the admin has
something in it and the delivery API returns something, rather than being an empty shell you have to
populate before anything is visible.

Neither creates a user account. The first administrator comes from the setup screen, which closes
behind itself the moment an account exists; a seeded account with a known password would end up in
every scaffolded project, and the ones nobody changed would be the ones that mattered.

## Requirements

Node 22.12 or newer, and nothing else. Taproot has **zero native dependencies** — no image library
to compile, no password-hashing binary, no database server — so `npm install` never needs a C++
toolchain.

## Documentation

The handbook covers writing content, administering a site, running the server, and building the
website that reads from it. See the [repository](https://github.com/jeremybise/taproot).

## License

MIT
