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

## Sidebar order

**Settings → Content types** reorders the sidebar. Put what people touch daily at the top.

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
