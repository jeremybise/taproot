---
title: The scheduler
description: What the periodic sweep does, why scheduled pages work without it, and why releases do not.
---

The **CMS** has one periodic job — the site has none, and nothing about scheduling depends on the
site being up. It:

- Publishes **scheduled content items** whose time has come.
- Publishes **scheduled releases** whose time has come.
- Clears expired sessions, spent password-reset tokens, aged-out sign-in attempts, and expired
  preview links.

## What needs it and what does not

**A scheduled page does not need it.** Visibility is worked out as a page is requested, so a page
goes live at its moment whether or not anything has swept. The sweep then catches the *stored* status
up so the admin stops disagreeing with the site.

That is what makes scheduling work on a deployment where nobody wired up a cron — which is every
deployment on its first day, and plenty of small ones forever.

**A scheduled release does need it.** A release's content lives separately and has to be *applied* —
addresses recalculated, redirects written, revisions appended. No page view can do that.

:::caution
If nothing runs the sweep on your installation, scheduled releases simply do not publish. This is
the one scheduling feature that genuinely depends on it, and it is worth confirming before anyone
relies on a timed launch.
:::

## On Cloudflare

Nothing to set up. The sweep is a cron trigger on the same Worker that serves the CMS — the
`triggers.crons` entry in `apps/studio/wrangler.jsonc`, reaching the `scheduled` export in
`apps/studio/src/worker.ts`.

No second Worker, no shared secret, nothing crossing the network.

This works because `@astrojs/cloudflare` only supplies a Worker entry when the wrangler config names
none, and the entry it would supply is nothing but a fetch handler. Naming our own costs the adapter
nothing and buys a `scheduled` export.

## Anywhere else

`POST /api/taproot/scheduler/run`, with `TAPROOT_CRON_SECRET` set and sent as
`authorization: Bearer <secret>`.

```
*/5 * * * *  curl -fsS -X POST https://example.edu/api/taproot/scheduler/run \
               -H "authorization: Bearer $TAPROOT_CRON_SECRET"
```

Every five minutes is plenty. The job is idempotent — running it twice publishes nothing the second
time, because each item and each release is claimed conditionally — so a scheduler that retries on
timeout cannot double-publish.

An administrator session can also call it, which is what the "Run now" button in the admin uses.

## Checking on it

**Settings → System**:

- **Waiting to publish** — scheduled items, whether or not their moment has arrived.
- **Past their time, status not caught up** — the number to watch. A few, briefly, is normal. A
  number that does not fall means nothing is sweeping.
- **Releases waiting / past their time / refused.**

**"Sweep last published something" is not a health check.** A sweep that finds nothing writes
nothing, so on a site that schedules rarely it can be months old with a perfectly healthy cron.

## Blocked releases

If a scheduled release fails its pre-flight check, Taproot marks it **Blocked** and stops. It does
not retry.

Retrying broken content every five minutes with nobody watching would fill the audit log and fix
nothing. Blocked means a person is needed — the count appears on Settings → System, and the audit
log records why.
