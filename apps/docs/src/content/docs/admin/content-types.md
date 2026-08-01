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
- **Singleton** — exactly one item, ever. No create, no delete, just edit. For a site-wide
  announcement banner or footer details.

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
