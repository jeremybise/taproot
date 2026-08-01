---
title: Reusable blocks
description: Content written once and shown on many pages, edited in one place.
---

A **reusable block** is a piece of content that lives in a library rather than on a page. Put it on
five pages and all five show the same thing. Edit it once and all five change.

Use it for anything that is genuinely the same in several places: an admissions office's contact
details, a standing safety notice, a shared call to action.

## Creating one

**Library → Reusable blocks → New**. Pick a block type, give it a name that describes what it is for
— you will be picking it from a list later — and fill in its content.

There is no empty-shell step. You write the content as part of creating the entry, because a library
entry is only ever stored once it is valid, and that is what lets pages using it skip re-checking it.

## Promoting a block you already wrote

In a block field, a block you have filled in offers **Promote to library**. The page then references
the library entry instead of holding its own copy.

Promoting needs the Editor role, because it shares content across pages rather than changing one.

## Placing one on a page

In any block field, **Add block** lists the library alongside the block types. Pick an entry and the
page stores a *reference*, not a copy.

You cannot edit its content from the page. That is the whole point — one authoritative copy. The
editor links through to the library entry.

## What this means for history

A page's revision history records **that** it referenced an entry, not what the entry said at the
time. Restore an old revision of the page and you get the reference back, resolving to the library's
content *today*.

That is right for shared content: restoring last spring's version of a page should not resurrect
last spring's opening hours. But it is a real difference from an ordinary block, whose content is
part of the page and comes back exactly as it was.

## Deleting

Refused while any page still references it. Taproot tells you how many and which.

This is stricter than most deletes in Taproot, and on purpose: a reference with no target renders as
a gap on precisely the pages nobody is watching — which is why the content was shared in the first
place.
