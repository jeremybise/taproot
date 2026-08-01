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
cp .env.example apps/studio/.env
cp apps/web/.env.example apps/web/.env
npm run db:seed
npm run dev
```

That starts **two** servers, which is Taproot's shape rather than an inconvenience:

- **The CMS** at `http://localhost:4321` — the admin is at `/admin`. Sign in with
  **admin@example.com** / **taproot**.
- **The site** at `http://localhost:4323` — a demo campus website that reads content from the CMS
  over HTTP. It has no database and no admin panel.

Every value in both `.env.example` files has a working default. Nothing needs editing.

## What the seed gives you

A demo campus site: content types with real fields, nested pages, an events collection, a singleton
banner, a taxonomy with a term tree, a menu, media with focal points set, reusable blocks, and an
open release with content staged in it.

It is **idempotent** — run it again and it fills in what is missing without duplicating what is
there. `npm run db:reset` deletes the local database and starts over.

## The commands

| | |
|---|---|
| `npm run dev` | Both servers — CMS on :4321, site on :4323 |
| `npm run dev:studio` / `dev:web` | One at a time |
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
packages/studio   the CMS server: admin panel, REST API, delivery API
packages/astro    the client a site installs. No database
apps/studio       the CMS deployment
apps/web          the reference consumer — a site reading over HTTP
apps/docs         this handbook
```

The package a *site* installs is `@taprootcms/astro`. `@taprootcms/studio` is the server, and a site
never installs it.

## Where the data goes

Locally, a SQLite file at `apps/studio/data/taproot.sqlite`, through Node's built-in SQLite. No server
to install, nothing to configure.

In production, Cloudflare D1. Postgres is wired but is not the tested target.

## Development runs on Node, production on Workers

Deliberately. The Workers runtime has no built-in SQLite, so running the dev server in it would make
`npm run db:seed` impossible without a dev server already running — a circle nobody wants on their
first day.

`npm run preview` builds and serves through the real Workers runtime when you need to check
something that only differs there.
