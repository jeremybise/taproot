---
title: Content types
description: Defining what kinds of content the site has, and the fields on each.
---

A **content type** defines a kind of content: Page, Event, Staff Profile. It has a name, a way its
items are addressed, and a set of fields.

Taproot ships with none. Everything in your sidebar was defined here. Administrators only.

**Settings → Content types**.

## Creating one

**Name** and **plural name** are what editors see — "Event" and "Events".

**API ID** is the machine name. It appears in addresses and code, and **cannot be changed after
creation**. Pick carefully: `event`, `staff_profile`.

**Kind** decides how items are addressed, and also cannot change afterwards:

- **Page** — nests under a parent. `/admissions/apply`. For anything hierarchical.
- **Collection** — flat, sharing a prefix you set. `/events/spring-open-house`. For lists of like
  things.
- **Singleton** — exactly one item, ever. No create, no delete, just edit. For a homepage assembled
  from blocks, a site-wide announcement banner, or footer details.

**URL prefix** appears for collections and is the segment their items sit under — `events` puts an
item at `/events/spring-open-house`. Leave it blank and it is worked out from the name.

It follows the rules of a web address rather than the rules of an API ID, and the two differ in one
place that catches people out: **a URL prefix separates words with hyphens and will not accept
underscores**, while an API ID is the reverse. A type whose API ID is `alum_profile` gets the prefix
`alum-profile`. That is the ordinary convention for a readable URL, and it is what search engines
expect.

Changing the prefix later does not move items that already exist — their addresses are fixed at the
point they are created, so an existing item keeps the URL people have already linked to, and only
items made afterwards use the new prefix.

**Items have their own pages** appears for collections, and is on unless you turn it off. On, each
item is a page on your site at its own URL — an event at `/events/spring-open-house`. Off, the items
still exist and still have every field they had; they are simply not published as pages.

Turn it off for content that is only ever shown *inside* something else: a staff directory, a set of
testimonials, the course sections listed on a programme page. Four things change the moment you do,
and they are the whole point:

- Nothing is served at the item's address. `/people/marguerite-okafor` answers 404 on your site
  rather than rendering a page nobody designed.
- Site search leaves those items out, because a search result is a link.
- A listing of *everything* leaves them out too — but a listing that asks for this type by name
  still returns them, which is how the page that shows them is built.
- There is no preview, because there is no page to preview. The editor says so under the item's
  title.

Turning it back on restores the pages: the address never went away, it simply had nothing at it.

**Preview path** appears for singletons only, and is optional. A singleton has no URL of its own —
it is edited through one fixed sidebar entry — so Taproot cannot know where your site shows it.
Setting this to the address it renders at, usually `/` for a homepage, turns on the live preview
pane for that singleton.

Leave it empty for a singleton that is *not* a page: site-wide settings, an address, social links.
There is nothing to look at, and a preview aimed anywhere else would show a page that content is not.
That is why the default is off rather than on.

**Default social image** is used by items of this type that set none of their own. It is *inherited*,
not copied — change it later and every item that has not overridden it follows. Copying it onto items
at creation would silently freeze the old one.

## Fields

The field builder is on the content type's own screen.

Each field needs a **label** (what editors see), an **API ID** (the machine name, fixed after
creation), and a **type**. Optionally: help text, whether it is required, and type-specific settings
— minimum and maximum, the options in a choice field, which taxonomy a tags field draws on, which
content type a relation points at.

**Reordering** uses the move buttons, which set the order editors see. Dragging works too where
supported, but the buttons are the primary control, not a fallback — dragging is unusable with a
keyboard.

### Help text earns its place

An editor reading a field for the first time has your help text and nothing else. "Shown on the
listing card, roughly 20 words" is worth more than any amount of general documentation.

### Showing a field only when it matters

Under **Visibility**, a field can name one other field on the same type and only appear when that
field says so — *show the message only when the banner is switched on*. It keeps a form honest:
nobody is asked to fill in a closure message for a banner nobody is showing.

Three things are worth knowing before you use it.

**A hidden field is never required.** If you mark a field required *and* give it a condition, that
means "required when shown". Editors are never blocked by an input they cannot see.

**Hidden fields keep what is already in them.** Switching the condition off does not clear anything
— switch it back on and the text is still there. The same is true when you add a condition to a
field that already has content across hundreds of items: nothing is erased.

**Your site still decides what to render.** Taproot ships no templates, so the condition governs the
*editing form*, not the page. A hidden field's value is still delivered, and the usual template
reads the controlling field itself — the same checkbox your condition names.

The condition can name any field beside it, which means inside a block it names another field in
that block, and inside a repeater it names another field in that row. So one row of opening hours
can hide its closing time while the row above it shows one.

If you delete or rename a field that something else depends on, the dependent field simply becomes
visible again rather than disappearing.

## Sidebar order and icons

**Settings → Content types** reorders the sidebar. Put what people touch daily at the top.

Each type can also be given a **sidebar icon** on its own settings screen. It is decoration — the
name is always beside it, and an icon is never the only thing telling two entries apart — but on a
site with a dozen types it makes the sidebar scannable rather than a list to read.

## What the list shows

**List columns**, on the type's settings screen, chooses which columns the list of these items has —
and the order it is sorted in.

The list shows the columns in the order they appear in the table. Use **Move up** and **Move down**
to arrange them, **Remove** to drop one, and the buttons under **Add a column** to bring in a
built-in (path, status, updated, created) or any of the type's own fields — a photograph, a start
date, a job title: whatever tells one row from the next.

**Title is always shown**, because it carries the link to the editor. You can move it, but not
remove it.

**Default order** sorts the list. Beyond the built-in orders, *Soonest first* and *Latest first* sort
by one of the type's own fields — pick which underneath. An events list ordered by when the events
happen is the case this exists for.

Only fields the CMS indexes can be sorted by: text, number, yes/no, date and choice. A field added
later becomes available with no further step.

Two things are quietly forgiving here, because the columns are chosen on this screen and the fields
are edited on the next one:

- **Delete a field a column shows, and the column disappears** rather than becoming an empty stripe.
- **Delete a field the list is sorted by, and the order falls back** to the site's own order rather
  than the screen breaking.

## The summary line

A content type can say how one of its items reads in one line: **Summary line**, on the type's
settings screen.

Write `{{ field_api_id }}` where a value should go, and plain text between them:

```
{{ position }} — {{ email }}
```

A person in a list then reads "Registrar — m.okafor@example.edu" rather than just their name. The
field ids you can use are listed under the box.

Two rules worth knowing:

- **An empty field takes its separator with it.** `{{ headline }} · {{ link }}` on an item with no
  link reads "Apply now", not "Apply now ·".
- **Leave it empty and items are labelled by their title**, which is right for most types.

It matters most on **block types**, where it becomes the collapsed row's label — the difference
between a page showing "Card 2 of 5" three times and one showing what each card actually says.

## Block types

A block type is a content type whose items are never addressed — they live inside a block field on
another item. They are managed separately at **Settings → Block types** so the two lists stay
readable; see [Block types](/admin/block-types/).

## Deleting

Taproot lists every reason a content type cannot be deleted, and only offers the delete when the
list is empty. Reasons include:

- **Items of this type still exist.** Delete them first.
- **A menu points at one of its items.**
- **A relation field on another type targets it** — even with zero items. Deleting anyway would
  leave a picker offering nothing and stored references pointing at a type that is gone.

A relation field on the type being deleted does not count against itself, so a self-referencing
"related pages" field cannot make its own type permanently undeletable.

Confirm by typing the API ID. It is checked on the server.
