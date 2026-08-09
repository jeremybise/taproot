---
title: Menus
description: Building navigation that survives pages being moved and renamed.
---

**Library → Menus**. Administrators only.

A menu is a named, ordered tree of entries. Your site's templates ask for one by its API ID —
`main`, `footer` — so creating a menu is only half the job; the other half is a template that renders
it.

## Entries reference their target

A menu entry points at a **content item**, a **term**, or an **external URL**. For the first two it
stores a reference, never an address.

That is the entire point:

- **Move a page and its menu entry follows.** No menu editing, no broken link.
- **Unpublish a page and it drops out of the public menu** on its own, and comes back when it is
  published again.

## Adding an entry that points at a page

The **Page** box is a search: type part of a title and it narrows. The title is what you read, with
the path underneath it in smaller type — two pages can legitimately share a title, and the path is
what tells `/admissions/apply` from `/financial-aid/apply`.

It reaches every page on the site, however deep. Earlier versions offered a fixed list that stopped
at the first two hundred pages, which on a large site meant newer pages could not be linked at all.

## Labels

Leave an entry's label blank and it uses its target's own title, so renaming the page renames the
menu entry.

Set one when the navigation wants something shorter than the page title — "Apply" for "How to Apply
to Riverbend College".

## Ordering and nesting

Move buttons reorder. Give an entry a parent to nest it as a dropdown; how many levels actually
render is up to your site's design.

## Term entries

Only useful if your site gives that taxonomy's terms their own pages. If it does not, the entry has
nowhere to point and is skipped when the menu renders. See [Tags and categories](/content/taxonomies/).

## When a target is deleted

The entry stays, with its reference emptied, and shows in the admin as obviously broken. It is
skipped on the public site.

It is deliberately not removed for you: silently editing the site's navigation because something
else was deleted is worse than a visible broken row that somebody fixes.
