---
title: The Taproot handbook
description: What Taproot is, who each part of this handbook is for, and where to start.
---

Taproot is a content management system. It holds the pages of your website in a database, gives
you a place to write and edit them, and publishes them when you say so.

This handbook covers three jobs, and you probably only need one of them.

## If you write content

Start with [Signing in](/start/signing-in/), then [Content items](/content/items/) — that page
covers the thing you will spend nearly all your time on. After that, dip into whichever field types
your site actually uses.

The pages worth reading even if you think you know them:

- **[The publishing workflow](/publishing/workflow/)** — what Draft, In review, and Published mean
  here, and why some buttons are missing for you.
- **[Releases](/publishing/releases/)** — how to change a dozen live pages at once without any of
  them changing early.
- **[Revision history](/content/revisions/)** — every save is kept. You can always go back.

## If you administer the site

You decide what kinds of content exist and who may touch them.
[Content types](/admin/content-types/) is where the site's shape is defined, and
[People and access](/admin/users/) is where you add colleagues and choose what each can do.

## If you run the server

[Installing it](/operate/install/) through [Backups and recovery](/operate/backups/) is your half.
The short version: Taproot needs a database and nothing else. It sends no email unless you configure
somewhere to send it, needs no image service, and runs the same on a laptop as on Cloudflare
Workers.

---

## A few things that will save you confusion

**Nothing you do is instant unless it says so.** Saving a draft changes nothing a visitor can see.
Publishing does. The interface tries to be clear about which one a button does.

**A page's address comes from its slug and its parent.** Move a page and its address changes — and
Taproot writes a redirect from the old address automatically, so links people have already shared
keep working. You never have to remember to do that. See [URLs and redirects](/publishing/urls/).

**Your site's content types are your own.** Taproot ships with none. "Page", "Event", and whatever
else you see in the sidebar were defined by whoever set up your site, and the fields on them are
theirs too. If this handbook mentions a field you do not have, that is why.

**Deleting is refused more often than you might expect.** Taproot blocks a delete when it would
leave something broken — a page with children beneath it, a content type still in use — and tells
you what to clear first. That is deliberate. It never quietly breaks something to let a delete
through.
