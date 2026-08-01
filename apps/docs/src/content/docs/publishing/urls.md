---
title: URLs and redirects
description: How a page's address is built, what happens when it moves, and writing redirects by hand.
---

## Where an address comes from

For a **page-like** type, the chain of slugs from the top: a page slugged `apply` under a page
slugged `admissions` lives at `/admissions/apply`.

For a **collection-like** type, the type's prefix and the slug: `/events/spring-open-house`.

**Singletons** have no address. Their content appears wherever the design puts it.

Slugs only have to be unique among siblings, which is what lets `/admissions/apply` and
`/financial-aid/apply` both exist.

## Moving a page

Change its slug, its parent, or both. Everything beneath it moves with it.

**Taproot writes a redirect for every address that changed, automatically.** Move a section with
forty pages under it and you get forty redirects. This is not optional and there is no setting for
it — links people have already shared, bookmarked, and printed keep working.

Redirects are also kept tidy. Move `/a` to `/b` and later `/b` to `/c`, and Taproot repoints the
first redirect so `/a` goes straight to `/c` rather than making browsers walk a chain.

## Writing one by hand

**Settings → Redirects**, administrators only. For addresses that were never Taproot pages — a URL
from an old system, something printed on a poster.

Hand-written redirects are never cleaned up automatically. Automatic ones are tidied when a live
page moves into the address they point away from; yours are left alone, because you had a reason.

A hand-written redirect leaving an address a live page now occupies simply does nothing — Taproot
finds the page first. It starts working again if that page ever moves away, which is usually exactly
what you meant.

## What visitors see

A moved page's old address returns a permanent redirect, which is what tells search engines to
transfer the page's standing to the new address.

An address that matches nothing and has no redirect returns a normal 404.
