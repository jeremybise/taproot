---
title: Installing it
description: Getting Taproot running locally from a fresh clone.
---

Taproot needs Node 22.12 or newer and nothing else. There is no image library to compile, no
password-hashing binary, and no database server — a fresh clone installs without a C++ toolchain on
any platform.

## From a clone

```bash
npm install
cp .env.example apps/web/.env
npm run db:seed
npm run dev
```

The admin is at `http://localhost:4321/admin`. Sign in with **admin@example.com** / **taproot**.

Every value in `.env.example` has a working default. Nothing needs editing to get a dev server up.

## What the seed gives you

A demo campus site: content types with real fields, nested pages, an events collection, a singleton
banner, a taxonomy with a term tree, a menu, media with focal points set, reusable blocks, and an
open release with content staged in it.

It is **idempotent** — run it again and it fills in what is missing without duplicating what is
there. `npm run db:reset` deletes the local database and starts over.

## The commands

| | |
|---|---|
| `npm run dev` | Dev server on :4321 |
| `npm run docs` | This handbook, on :4322 |
| `npm run db:seed` | Migrate and seed. Safe to repeat |
| `npm run db:reset` | Delete the local database and reseed |
| `npm run db:migrate` | Migrate without seeding |
| `npm test` | The test suite |
| `npm run typecheck` | Types, per workspace |
| `npm run a11y` | Accessibility audit — needs `npm run dev` running |
| `npm run build` | Production build |
| `npm run preview` | Build and serve through the real Workers runtime |

:::note
Astro 7 runs the dev server as a daemon. `astro dev stop`, `astro dev status`, and `astro dev logs`
control it. If a database command fails saying the file is in use, stop the dev server first — it
holds the SQLite file open.
:::

## The layout

```
packages/core     data layer, auth, content services, storage. No framework
packages/astro    the Astro integration: admin panel, REST API, typed client
apps/web          the demo campus site
apps/docs         this handbook
```

## Where the data goes

Locally, a SQLite file at `apps/web/data/taproot.sqlite`, through Node's built-in SQLite. No server
to install, nothing to configure.

In production, Cloudflare D1. Postgres is wired but is not the tested target.

## Development runs on Node, production on Workers

Deliberately. The Workers runtime has no built-in SQLite, so running the dev server in it would make
`npm run db:seed` impossible without a dev server already running — a circle nobody wants on their
first day.

`npm run preview` builds and serves through the real Workers runtime when you need to check
something that only differs there.
