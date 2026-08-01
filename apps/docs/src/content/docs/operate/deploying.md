---
title: Deploying
description: Getting Taproot onto Cloudflare Workers, and what the first sign-in looks like.
---

The tested target is Cloudflare Workers with D1 and R2.

`DEPLOYMENT.md` in the repository is the step-by-step version with the exact commands; this page is
the shape of it and the parts people trip on.

## What you need

- A Cloudflare account
- A **D1 database** for content
- An **R2 bucket** for uploads
- `wrangler` — already a dev dependency

## The order

1. **Create the D1 database** and put its binding in `apps/web/wrangler.jsonc`.
2. **Create the R2 bucket** and bind it likewise.
3. **Run migrations against D1** — `npm run db:migrate:remote`, which needs
   `TAPROOT_CF_ACCOUNT_ID`, `TAPROOT_CF_D1_ID`, and `TAPROOT_CF_API_TOKEN`.
4. **Set secrets** with `wrangler secret put`. Never in `wrangler.jsonc`, which is committed.
5. **Deploy** — `npm run deploy`.

## First sign-in

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

## Scheduled publishing

Nothing to configure. The cron trigger is already in `wrangler.jsonc` and reaches the `scheduled`
export in `apps/web/src/worker.ts`.

Confirm it after deploying — **Settings → System** shows the counts. It matters most if anyone
intends to use scheduled [releases](/publishing/releases/), which do not publish without it.

## Media URLs

Out of the box, uploads are served by the Worker itself. That works and costs a Worker request per
image.

Put a **custom domain on the R2 bucket** and set `TAPROOT_MEDIA_URL` to it, and images come from the
edge instead. Recommended, not required.

:::note
`TAPROOT_MEDIA_URL` used to default to `/media`, which nothing served — so an R2 deployment without
a custom domain produced successful uploads and images that 404'd. It now defaults to a route that
actually serves the files, so the broken-picture state is gone; the custom domain is purely a speed
choice.
:::

## Checking against the real runtime

`npm run preview` builds and serves through `wrangler dev` — the actual Workers runtime rather than
Node.

Worth doing before a first deploy. Development runs on Node deliberately (Workers has no built-in
SQLite, which would make seeding impossible), so this is where a Workers-only difference shows up.

## Upgrading later

Run `npm run db:migrate:remote` before deploying a version that adds a migration. Migrations are
additive and are never renumbered or edited after shipping.

## Other platforms

Taproot needs a JavaScript runtime and a database. Nothing is Cloudflare-specific except the D1 and
R2 bindings, and both have adapters.

The one thing to arrange elsewhere is the scheduler, which has no cron of its own outside Cloudflare
— see [The scheduler](/operate/scheduler/).
