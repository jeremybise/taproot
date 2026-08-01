---
title: Blocks
description: Building a page out of sections, and reordering them.
---

A **block field** lets you build a page out of pieces — a hero banner, then some prose, then a
gallery, then a call to action — instead of filling in one fixed form.

Each piece is a **block**. Its type decides what fields it has, and the types available come from
your site.

## Adding one

**Add block** lists what this field accepts. Pick a type and it appears at the bottom, expanded, for
you to fill in.

A field may cap how many blocks it takes. At the cap, **Add block** stops offering more.

## Reordering

Every block has **Move up** and **Move down** buttons. If your site's build also supports dragging,
the buttons still work — they are the primary way, not a fallback, because dragging is unusable with
a keyboard or a screen reader.

## Removing

Each block has its own remove button. It takes that block's content with it and there is no undo
short of leaving without saving — or restoring an earlier revision after you have saved.

## Collapsing

Blocks collapse to their heading so a long page stays manageable. Collapsing changes nothing about
the content.

## Blocks inside blocks

A block type can itself have a block field — a "Section" holding "Cards", say. Taproot allows this
and stops two things:

- **A block cannot contain itself**, directly or through another block. Otherwise the page would
  nest forever.
- **Nesting is capped** a few levels deep, whatever the editor offers.

If a type you expected is not in the **Add block** list inside a nested block, one of those is why.

## Sharing a block across pages

If the same content needs to appear on several pages — an office's contact details, a standing
notice — promote it to the library instead of copying it. See
[Reusable blocks](/content/reusable-blocks/).
