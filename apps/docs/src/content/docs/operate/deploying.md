---
title: Deploying
description: Two deployments, what each needs, and the order to bring them up.
---

**Taproot is two deployments**, and knowing that up front saves a lot of confusion:

| | What it is | What it needs |
|---|---|---|
| **The CMS** (`apps/studio`) | Admin panel, REST API, delivery API, scheduler | A database, object storage, a cron trigger |
| **The site** (`apps/web`) | What visitors see | A URL for the CMS and an API key |

They are separate on purpose. The CMS is upgraded, backed up, and secured like a piece of
infrastructure; the site is a front end that can be rebuilt, redesigned, or replaced without any of
that moving. Only one of them holds your content.

You can also run **several sites against one CMS** — a main site and a microsite, say — since a site
is only a consumer with a key.

The tested target for the CMS is Cloudflare Workers with D1 and R2. The site has no such
requirement: it is an ordinary Astro app and deploys anywhere Astro does.

`DEPLOYMENT.md` in the repository is the step-by-step version with exact commands; this page is the
shape of it and the parts people trip on.

## Deploy the CMS first

The site is useless without it, and you will need a key from it.

### What you need

- A Cloudflare account
- A **D1 database** for content
- An **R2 bucket** for uploads
- A **KV namespace** — which Taproot itself never reads; see below
- `wrangler` — already a dev dependency

### The order

1. **Create the D1 database** and put its binding in `apps/studio/wrangler.jsonc`.
2. **Create the R2 bucket** and bind it likewise.
2b. **Create the KV namespace** and paste its id in. Taproot stores sign-in sessions in the
   database, not in KV, but `@astrojs/cloudflare` requires a `SESSION` binding and will create the
   namespace silently if you leave the id out — which makes a failed deploy impossible to retry.
3. **Run migrations against D1** — `npm run db:migrate:remote`, which needs
   `TAPROOT_CF_ACCOUNT_ID`, `TAPROOT_CF_D1_ID`, and `TAPROOT_CF_API_TOKEN` in a local `.env` file.
4. **Set secrets** with `wrangler secret put`. Never in `wrangler.jsonc`, which is committed.
5. **Deploy** — `npm run deploy`.

:::caution[Step 3 is a local `.env`. Step 4 is `wrangler secret put`. They are not the same thing.]
The two steps sit next to each other and use different mechanisms, which is the most common way to
get stuck here.

Migrations run **on your machine** and talk to Cloudflare's REST API, so `TAPROOT_CF_ACCOUNT_ID`,
`TAPROOT_CF_D1_ID`, and `TAPROOT_CF_API_TOKEN` go in `.env` — the project root, in a project made by
`npm create taproot`. Nothing in the deployed Worker ever reads them, so setting them with
`wrangler secret put` does nothing for the migration; the token especially is worth keeping out of
the runtime, since it can rewrite the database and the Worker never needs it.

The token has to be a **custom** token carrying `Account` · `D1` · `Edit`. Read is not enough — the
endpoint that applies migrations is a query endpoint that writes. `DEPLOYMENT.md` has the click
path, and what a 400 "not authorized" actually means when you hit it.
:::

### First sign-in

A fresh deployment has no users. Visiting `/admin` offers a **setup screen** that creates the first
administrator.

This is the only unauthenticated write anywhere in the admin, and it stops being available the
instant a user exists. Do it immediately after deploying — before you tell anyone the address.

Then add colleagues from **Settings → People**.

:::caution
The setup screen refuses once any user exists. It is not a recovery path — if you lose every
administrator, promoting somebody means going to the database directly. That is why Taproot refuses
to demote the last one.
:::

### Scheduled publishing

Nothing to configure. The cron trigger is already in `apps/studio/wrangler.jsonc` and reaches the
`scheduled` export in `apps/studio/src/worker.ts`.

Confirm it after deploying — **Settings → System** shows the counts. It matters most if anyone
intends to use scheduled [releases](/publishing/releases/), which do not publish without it.

## Then deploy the site

### Give it a key

In the CMS: **Settings → API keys → Create key**, with the `content:read` scope. Copy it — that is
the only time it is shown. See [API keys](/admin/api-keys/).

### Configure it

Two variables, and that is the whole of it:

```
TAPROOT_API_URL=https://cms.example.edu
TAPROOT_API_KEY=tpr_…
```

The site holds no database credentials, because it has no database.

### Tell the CMS where the site is

Back in the CMS, set `TAPROOT_SITE_URL` to the site's origin. That is what preview links are built
from — without it, an editor pressing the preview button gets told the CMS does not know where to send
them, which is a clearer failure than a redirect to a 404 on the wrong origin.

### Deploy it

`npm run build --workspace=@taprootcms/web` produces an ordinary Astro server build. Node, Workers,
a container — wherever you already deploy Astro.

## Media URLs

Out of the box, uploads are served by the CMS Worker itself. That works and costs a Worker request
per image.

Put a **custom domain on the R2 bucket** and set `TAPROOT_MEDIA_URL` to it, and images come from the
edge instead. Recommended, not required.

The delivery API returns **absolute** image URLs either way, so the site never needs to know where
media lives.

:::note
`TAPROOT_MEDIA_URL` used to default to `/media`, which nothing served — so an R2 deployment without
a custom domain produced successful uploads and images that 404'd. It now defaults to a route that
actually serves the files, so the broken-picture state is gone; the custom domain is purely a speed
choice.
:::

## Generating types for the site

Once the CMS is up:

```bash
TAPROOT_API_URL=https://cms.example.edu TAPROOT_API_KEY=tpr_… npm run taproot:types
```

That writes a `content.d.ts` describing your content types, which the site checks in. Rerun it after
changing the content model — the diff shows what changed, and anything that stopped existing stops
compiling.

## Checking against the real runtime

`npm run preview` builds the CMS and serves it through `wrangler dev` — the actual Workers runtime
rather than Node.

Worth doing before a first deploy. Development runs on Node deliberately (Workers has no built-in
SQLite, which would make seeding impossible), so this is where a Workers-only difference shows up.

## Upgrading later

Run `npm run db:migrate:remote` before deploying a CMS version that adds a migration. Migrations are
additive and are never renumbered or edited after shipping.

The site can be deployed independently and usually needs no coordination: the delivery API is the
contract between them, and it is versioned by being additive rather than by a version number.

## Other platforms

The CMS needs a JavaScript runtime and a database. Nothing is Cloudflare-specific except the D1 and
R2 bindings, and both have adapters.

The one thing to arrange elsewhere is the scheduler, which has no cron of its own outside Cloudflare
— see [The scheduler](/operate/scheduler/).
