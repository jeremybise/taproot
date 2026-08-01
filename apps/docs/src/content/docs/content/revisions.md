---
title: Revision history
description: Every save is kept. How to see what changed and how to go back.
---

Taproot snapshots a content item every time you save it. The history is at the bottom of the item
editor, newest first.

Each entry shows who saved it, when, and which fields changed by name — "Title, Body, Social image"
rather than a wall of markup.

## What is not recorded

**A save that changed nothing.** Open an item, think better of it, save anyway — no entry. A history
full of identical entries is worse than no history, because it buries the saves that meant
something.

**The scheduled publish time.** A scheduled moment is an intention about the future, not content, so
it is not part of a snapshot. See the warning under *Restoring* below.

## Comparing

Select any revision to see what it changed against the one before it.

## Restoring

**Restore** on any revision brings its content back.

Restoring is an ordinary save, which matters more than it sounds:

- **It appends a new revision** rather than rewinding the log. Restoring the wrong one is itself
  undoable, and the history stays a complete record.
- **It restores the slug too**, so a restore can move the page — and that cascades to everything
  beneath it and writes redirects, exactly as renaming would.
- **It restores the status**, and the same permission rules apply. A Contributor cannot restore a
  revision that was published, because that would be publishing.

:::caution
Restoring a revision that was **Scheduled** lands the item in Scheduled with **no date**. The
scheduled moment was never snapshotted, so there is nothing to bring back.

The item is then invisible to visitors and will never publish itself. The editor shows the date
field as empty and required. Pick a new moment, or move it to another status.

This fails safely and says so, rather than inheriting a date from months ago and going live the
instant you save.
:::

## Reusable blocks are different

If the page places a reusable block, its history records **that** the block was referenced, not what
the block said at the time. A restore brings back the reference, resolving to the library's content
today. See [Reusable blocks](/content/reusable-blocks/).

## History and deletion

Deleting an item deletes its history. There is no way back after that — which is part of why Taproot
refuses deletes that would break something rather than asking twice.
