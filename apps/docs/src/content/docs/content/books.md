---
title: Books
description: Catalogs, handbooks and manuals — documents with a table of contents, a reading order, and yearly editions.
---

A **book** is a document rather than a section of your site: a course catalog, a student handbook, a
policy manual. It has a table of contents, pages read in an order somebody arranged, and usually a
new edition every year.

Everything nested under a book becomes one of its sections, as deep as the document needs. Your site
can then render a contents sidebar and previous/next links from that structure, without anyone
maintaining a list by hand.

## Making a content type into a book

Books are not created from the Books screen. A **content type** is marked as making books, and then
every item of that type is one.

1. Go to **Settings → Content types** and open the type — or create one, with the kind set to
   **Page**.
2. Tick **Items of this type are books**.
3. Save.

A type called *Handbook* now produces books: create "Student Handbook 2026-27", nest chapters under
it, and it appears under **Library → Books**.

Only page types can be books. A collection is a flat list and a singleton is a single record, so
neither has a structure to outline.

## Arranging the outline

Open a book from **Library → Books** to see its outline: every section, indented by depth, in reading
order.

The order is the order the sections sit in under each parent — the same order the content list shows
them in. Rearranging them there rearranges the book.

Draft sections appear in this outline so you can work on them, and are left out of what your site
receives until they are published.

## Editions

An edition is simply another book. `/handbooks/2026-27` and `/handbooks/2027-28` are two books
sitting under the same parent page, and the Books screen groups them under it.

To start next year's:

1. Open the current edition from **Library → Books**.
2. Type the new URL segment — `2027-28`.
3. Press **New edition**.

Everything is copied as **drafts**, so nothing appears on your site until you publish it. Links
*within* the book are repointed at the copies, so next year's chapters link to next year's pages
rather than back into last year's. Links pointing outside the book are left alone.

A large book is copied in batches. If the screen says some items are still to copy, press the button
again to continue where it stopped — nothing is duplicated twice.

:::note
The published edition is never touched. Because the copy is made of genuinely separate pages,
anything you do to next year's catalog cannot change what last year's says — which matters when
students are entitled to the edition in force when they enrolled.
:::

## Retiring an edition

When a new edition goes live, the old one usually stays readable but should stop competing with it in
search results. From the old edition you can apply one change to the whole book at once — either
unpublishing it, or asking search engines not to index it while leaving it readable.

Anything you are not allowed to change is skipped and named, rather than the whole operation failing.

## What a book cannot use

Pages inside a book **cannot use reusable blocks or text snippets**.

This is deliberate, and it is the reason books exist as their own idea. Both of those are shared:
editing one changes every page that uses it. In an ordinary site that is exactly what you want. In a
book it would silently rewrite editions you already published — change the tuition snippet once, and
the 2024-25 handbook starts quoting this year's figure, with nothing in its revision history showing
that it changed.

If several pages of a book need the same wording, put it on the **book's own fields** instead. It is
then part of that edition, gets copied forward with it, and stays correct in every edition after it
moves on.

Images and files work normally inside a book.

## Bits worth knowing

- **Books cannot be nested.** A book inside another book has no clear answer to which outline a
  section belongs to, so it is refused.
- **Turning the setting on can affect existing pages.** If content already nested under items of that
  type uses reusable blocks or snippets, the settings screen lists exactly which pages would stop
  saving, before you commit.
- **The address stays yours.** A book and its sections are ordinary content items with ordinary URLs;
  being a book changes how they are grouped and navigated, not where they live.
