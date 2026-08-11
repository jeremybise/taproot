---
title: Webhooks
description: How another system finds out that content changed, and how to tell whether it heard.
---

A **webhook** is Taproot telling another system that something happened — a page went live, a
release published, an item was deleted. The other system rebuilds a site, updates a search index,
posts to a channel, whatever it is for.

**Settings → Webhooks.** Administrators only, in both directions: an endpoint is where the titles
and paths of unpublished work leave the deployment, and the list is an inventory of what this
deployment talks to.

## A webhook says what changed, never the content

The event carries the item's id, title, path, slug, status and content type — enough to decide
whether to bother — and nothing else. To read the content, the receiver asks the delivery API like
any other reader.

That is deliberate. A payload carrying fields would be a second read contract, with no API key, no
scope check, and no visibility rules, arriving at whatever URL somebody typed into a form. Keeping
it a notification means a receiver gets published content by construction, the payload never has to
track your content model, and an endpoint cannot be used to pull out drafts.

## Setting one up

Give it a **name** describing the system that will receive it, so you know what stops working if you
pause it, and a **URL**.

The URL must be **https**, unless it is `localhost`. Events name unpublished pages by title, so
plain `http` to a public host puts your editorial calendar on the wire in clear — nearly always a
typo rather than a decision.

Then choose the events. There are six:

| Event | When |
| --- | --- |
| `item.created` | A new item exists, whatever its status. |
| `item.updated` | An item was saved. **Every** edit, including drafts. |
| `item.published` | An item became visible to the public. |
| `item.unpublished` | An item stopped being visible — moved to draft, review, or archived. |
| `item.deleted` | An item was removed. Carries what it was, because it is gone. |
| `release.published` | A whole release went live, alongside the per-item events. |

`item.updated` and `item.published` both fire when a save publishes something. They are not two
names for one thing: "the content changed" and "the content became public" are different questions,
and a site rebuild wants the second while a search index wants the first. Subscribe to what you can
act on — a rebuild subscribed to `item.updated` fires on every draft keystroke.

**Publication is about crossing the line, not about the destination.** Moving a live page to
archived sends `item.unpublished`, because from a visitor's point of view that is what happened.

## The signing secret

Every request carries an `x-taproot-signature` header. Your receiver checks it against the endpoint's
secret and rejects anything that does not match — without that check, the URL is an open invitation
to anybody who guesses it.

Taproot shows the secret **once**, when the endpoint is created, and does not show it again. A page
that can reveal a credential is a page an unattended session can reveal it from. If you lose it, use
**Rotate the secret**: the old one stops working immediately, so paste the new one into your receiver
before the next change is saved.

## Receiving them

If your site is built with `@taprootcms/astro`, mount the handler:

```ts
// src/pages/taproot/events.ts
import { createTaprootWebhookHandler } from '@taprootcms/astro';
import { env } from 'cloudflare:workers';

export const prerender = false;

export const POST = createTaprootWebhookHandler({
  secret: env.TAPROOT_WEBHOOK_SECRET,
  async onEvent(event) {
    if (event.event === 'item.published') {
      await rebuild(event.subject.path);
    }
  },
});
```

It verifies the signature, refuses anything stale or forged, and answers on your behalf. Four things
it is doing that are easy to get wrong by hand, and every one of them fails silently:

- It reads the **raw** body and verifies that. `JSON.stringify(await request.json())` is a different
  string from the one that was signed the first time a value round-trips differently.
- It compares digests in constant time, so a wrong signature leaks nothing about the right one.
- It checks the timestamp inside the signature, which is what stops a captured request being replayed
  later.
- It answers **after** your handler finishes. Taproot reads a 2xx as "this landed" and stops retrying,
  so answering early turns a retried delivery into a single attempt.

Not using `@taprootcms/astro`? `verifyWebhookSignature` is exported on its own and does the same
check anywhere `crypto.subtle` exists.

### Deliveries can arrive twice

A request that times out after your receiver has already committed looks exactly like one that never
arrived, so Taproot sends it again. That is what at-least-once means, and no sender can do better
over HTTP.

Every attempt of one delivery carries the same `x-taproot-delivery` id — also in the body as `id` —
so recording the ids you have processed makes handling it twice harmless.

## When something does not arrive

Each endpoint's own page lists every attempt, newest first, with the outcome and the reason.

A failure is retried on a widening schedule by the scheduled sweep — after 5 minutes, then 15, 30,
an hour, and so on — and given up on after eight tries. Settled rows are cleared after 30 days.
Anything that has been given up on is also reported on **Settings → System**, because a delivery that
never lands would otherwise be silent.

The usual causes, and what they look like in the log:

- **401** — the secrets disagree. Nearly always a trailing newline or space from a paste. Rotate and
  paste again.
- **404** — the route is not mounted where the URL says, or the file is named with a leading
  underscore, which Astro excludes from routing.
- **Redirected (301/302)** — Taproot deliberately does not follow redirects, because that would send
  a signed body wherever the redirect points. Put the final address in the URL. An apex domain
  bouncing to `www` is the common one.
- **No answer within 10s** — the receiver accepted the connection and did not reply. Usually work
  being done inline that should be queued.

**Retries need the scheduled sweep.** The first attempt happens immediately, but every retry after
that is the cron. See [The scheduler](/operate/scheduler/) — a deployment with no sweep gets one
attempt per event and no second chance.

## Pausing rather than deleting

**Pause** stops the events and keeps the URL, the secret, and the delivery history. It is what you
want while somebody fixes the receiving end.

**Delete** removes the endpoint and its whole delivery log, including failures nobody has looked at
yet. Confirmed by typing the endpoint's name, checked on the server.

## Two Workers on one Cloudflare account

If your CMS and your site are both Workers on the same account, a request between them is
short-circuited internally rather than going out through the public edge — and the loopback does not
route the way a real request does, so a correctly mounted endpoint can answer **404** to the CMS
while answering correctly to `curl` from your laptop.

Both `wrangler.jsonc` files need `"global_fetch_strictly_public": true` in their compatibility flags.
Taproot's own scaffolder sets it. The general version of this: testing an endpoint from your laptop
is not testing the caller.
