---
title: Content items
description: Creating, editing, moving, and deleting the pages and entries that make up your site.
---

A **content item** is one piece of content: a page, an event, a news story. Everything you write in
Taproot is one. It is called an item rather than a page because a page is only one of the kinds your
site might have.

## Creating one

From a content type's list — **Pages**, **Events** — use **New**. Or use **All content → New** and
pick the type first.

You need a title to save. Everything else can wait.

## The editor

**Title** is what the item is called. It appears in lists, in menus that have not been given their
own label, and as the page's heading on the site.

**Slug** is the last part of the web address, filled in from the title as you type. Editing it by
hand stops it following the title — which is what you want on anything already published, since its
address is out in the world.

**Fields** are whatever your site's administrator defined for this content type. See
[The fields you will meet](/content/fields/).

**Publishing** is the sidebar panel on the right. See [The publishing workflow](/publishing/workflow/).

**Search engines** is the panel below it. See [Search engines and social cards](/content/seo/).

## Saving

**Save changes** writes everything at once. Nothing is saved as you type.

Saving an already-published page publishes those changes **immediately** — there is no separate
draft of a live page. If you need to prepare a change without it going out, put the page in a
[release](/publishing/releases/); that is exactly what releases are for.

Every save is recorded. See [Revision history](/content/revisions/).

## Where an item lives

Depends on the kind of content type it is, which is set by an administrator and not something you
change per item:

- **Page-like** types nest. Pick a **Parent page** and the address is built from the chain:
  a page slugged `apply` under `/admissions` lives at `/admissions/apply`.
- **Collection-like** types are flat and share a prefix: `/events/spring-open-house`.
- **Singletons** have no address of their own. Their content appears wherever the site's design
  puts it.

Two pages under different parents may use the same slug — `/admissions/apply` and
`/financial-aid/apply` are both fine. Two under the *same* parent may not; Taproot adds a suffix
rather than refusing.

## Moving a page

Change the **Parent page**, the **Slug**, or both, and save.

Everything beneath it moves too, and every address that changed gets a redirect from its old
location automatically. You do not have to do anything about the old links. See
[URLs and redirects](/publishing/urls/).

## Previewing

The **eye** icon in the editor's action bar opens a live preview beside the editor: your real site, with your
real design, updating as you type — including changes you have not saved yet. It stays put while you
scroll the fields.

On a narrow screen there is not room for both, so the same icon switches between editing and
previewing rather than showing them side by side.

It is a preview of what the page *will* be, not what visitors see now. Only signed-in people with
permission can open it, and the link it uses expires; it is not a way to show a draft to the public.

Two things it deliberately does not do. **Navigation and listings show published content only**, so a
draft page previews correctly without appearing in its own menu. And the address box shows you any
page on the site, but your *unsaved* changes only appear on this item's own page.

Use **Open in a new tab** inside the preview to get a full-width window with the same content.

Singletons have no preview, because they have no address of their own.

## Adding it to a release

Under **Publishing** in the sidebar. Choose an open release and press **Add to release** — it takes a
copy of the content as it is now, and you edit that copy without the live page changing. Editors can
also create a release from the same control.

You stay on the item, so anything you have typed and not saved is still there.

## Deleting

The **bin** icon in the editor's action bar, set apart from the others. You have to type the item's slug to
confirm, and it is checked on the server — you cannot get past it by turning JavaScript off.

Taproot refuses the delete outright when it would break something:

- **Items sit beneath it.** They would be stranded at addresses describing where they used to be.
  Move or delete them first.
- **It is staged in an unpublished release.** Deleting it would remove it from that release with no
  sign it had gone, and the launch would quietly be missing a page. Remove it from the release
  first.

It warns, but lets you continue, when the consequence is visible:

- **A menu points at it.** The entry stays in the admin as an obviously broken row and stops
  appearing on the site.
- **Another item links to it** through a relation field. That field shows the link as missing.

Deleting an item removes its revision history too. There is no undo.
