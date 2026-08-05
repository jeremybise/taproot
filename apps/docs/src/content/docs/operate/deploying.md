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
- The **Images binding** for resizing, which needs nothing created and no domain; see below
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

:::note[A CMS with nothing configured has no secrets, and that is correct.]
`npx wrangler secret list` returning `[]` is not a symptom on its own — it means nothing has ever
been set with `wrangler secret put`, which is the normal state until you wire up email. The CMS
holds no API key: it *issues* keys and stores only their SHA-256, so `TAPROOT_API_KEY` belongs to
the **site**, a different deployment. `TAPROOT_CRON_SECRET` is not needed on Cloudflare either,
because the sweep is a cron trigger on the Worker itself.

Secrets and `vars` are also separate lists. `wrangler secret list` never shows a `vars` entry and
never will, so an empty result says nothing about whether `TAPROOT_SITE_URL` is set.
:::

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

**On Cloudflare it goes in `vars` in the CMS's `wrangler.jsonc`, not `wrangler secret put`:**

```jsonc
"vars": {
  "NODE_ENV": "production",
  "TAPROOT_SITE_URL": "https://www.example.edu"
}
```

It is an origin, not a credential — there is nothing in it worth encrypting, and it is the address
your visitors already type. Putting it in the committed file is also what makes it survive: `wrangler
deploy` replaces the Worker's `vars` with exactly what that file holds, so a value typed into the
Cloudflare dashboard is deleted by the next deploy, and the deploy that deletes it is usually about
something else entirely. A secret would survive, but reaching for one here is solving the wrong
problem — the file is the right home.

Two symptoms of it being unset, both of which read as something else: the item editor shows an item's
path as plain text instead of a link to the live site, and a singleton with a preview path still
offers no pane.

### Deploy it

`npm run build --workspace=@taprootcms/web` produces an ordinary Astro server build. Node, Workers,
a container — wherever you already deploy Astro. The reference site ships with `@astrojs/node`
because something had to be in the file; swapping in `@astrojs/cloudflare`, `@astrojs/vercel`, or
any other adapter is a one-line change and Taproot has no stake in which.

The one part that is not a one-line change is **how the two variables above reach the client**,
because `import.meta.env` is a build-time substitution and a Cloudflare secret does not exist at
build time. See [Getting started](/build/getting-started/#one-module-for-the-connection) — this
misconfiguration presents as a 401 from the delivery API with the key visibly set, which is a bad
half hour if you have not seen it before.

## Caching

Both deployments ship with caching enabled, and it is worth knowing why the config line exists rather
than only that it does:

```jsonc
// wrangler.jsonc, in both apps
{
  "cache": { "enabled": true }
}
```

**Cloudflare caches neither HTML nor JSON by default** — its default cache is keyed on file
extension — and a Worker's own response is never cached unless the Worker opts in. Without that
block, the `cache-control: public, max-age=0, s-maxage=60` on every delivery response and every
rendered page is correct HTTP that nothing acts on. With it, Cloudflare checks the cache *before*
invoking the Worker: a hit costs no CPU, makes no request to the CMS, touches no database, and
collapses concurrent requests for the same URL into one.

Admin screens bypass it automatically (they set `Set-Cookie`), and so does every preview and draft
(`no-store`). Delivery responses also carry a `Cache-Tag`, and the CMS purges the tags a write
touched — so a published page reaches visitors without waiting out the TTL. See
[The client](/build/the-client/#cache-tags) for what a consumer does with the same tags.

The CMS also runs with `"placement": { "mode": "smart" }`, which puts the Worker near D1 rather than
near the visitor. That is right for the CMS, where resolving a page is a chain of dependent database
queries, and deliberately *not* set on the site, which makes one round of parallel requests and then
renders.

:::caution
A **cron trigger** does not pass through the request path, so an item published by the scheduler is
bounded by the TTL rather than purged. Same asymmetry Settings → System already documents about
scheduling: it fails stale for a minute, never wrong forever.
:::

## Image resizing

Add the Images binding and the CMS resizes media on the way out, so a visitor on a phone is not sent
the 2000-pixel photograph an editor uploaded:

```jsonc
// wrangler.jsonc
"images": {
  "binding": "IMAGES"
}
```

That is the entire setup. **There is nothing to create and no domain of your own is required** — it
works on a `workers.dev` subdomain. Cloudflare's free allowance is 5,000 unique transformations a
month, counted per image per size, and a cached one is not re-billed.

`create-taproot` writes this binding for you. On an older project, add it and redeploy.

Without it nothing breaks — the media route serves the stored original, so pages are heavier and
never wrong. That is also why local development on Node needs nothing here.

:::tip
Sites get the benefit by passing `sizes` to `TaprootImage`, and more of it with `crop="server"`.
See [images and media](/build/images/).
:::

## Media URLs

Out of the box, uploads are served by the CMS Worker itself. On a cache miss that costs a Worker
invocation, an R2 read **and a database row read per image**; on a hit it costs none of them, because
the response is `immutable` and Cloudflare answers it from the edge — provided you have
[enabled caching](#caching).

You can instead put a **custom domain on the R2 bucket** and set `TAPROOT_MEDIA_URL` to it, and
images come from the edge with no Worker involved even on a cold cache.

:::caution
**A custom domain and the Images binding are mutually exclusive.** `TAPROOT_MEDIA_URL` makes media
bypass the Worker route entirely — that is the whole point of it — and the resizing lives *in* that
route. Setting it silently goes back to serving full-size originals, with no error anywhere.

Pick one:

- **The binding** (no domain, resizing works, a Worker invocation only on a cold cache). Right for
  almost everyone, and the default a scaffolded project starts with.
- **A custom domain plus Cloudflare's URL-based transformations**, which need a zone on your account
  and a dashboard toggle under Images → Transformations.
:::

The delivery API returns **absolute** image URLs either way, so the site never needs to know where
media lives.

:::note
`TAPROOT_MEDIA_URL` used to default to `/media`, which nothing served — so an R2 deployment without
a custom domain produced successful uploads and images that 404'd. It now defaults to a route that
actually serves the files, so the broken-picture state is gone.
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
