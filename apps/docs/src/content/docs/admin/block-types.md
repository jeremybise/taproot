---
title: Block types
description: Defining the pieces editors build pages out of.
---

A **block type** is the schema for a block: a hero banner has an image, a heading, and a link; a
quote has a quotation and an attribution.

**Settings → Block types**. Administrators only.

## The same thing as a content type, addressed differently

A block type is a content type whose items have no address. It uses the same field builder, the same
field types, and the same validation, because it is the same thing — the only difference is that its
content lives inside another item rather than at a URL of its own.

They are listed separately so that "New content item" and the sidebar never offer something that
cannot be a page.

## Creating one

Name, plural name, API ID, then fields — exactly as for a content type. The API ID is how the site's
code finds the component that renders this block, so agree it with whoever builds the templates.

## Taproot ships no block designs

Taproot stores what a block *contains*. How it *looks* comes from a component in your site's own
code, matched to the block type's API ID.

That is a deliberate line: a CMS that shipped a hero component would be shipping a design. If a
block type exists here with no matching component, editors can fill it in and nothing renders.

## Making a block type available

A block type appears in an editor's **Add block** list when a content type has a **block field**
that accepts it. The field's settings decide which types it offers and how many blocks it takes.

So creating a block type is two steps: define it here, then add or configure a block field on the
content types that should be able to place it.

## Nesting

A block type may itself have a block field — a Section holding Cards. Taproot stops a block
containing itself, directly or indirectly, and caps nesting a few levels deep regardless of what the
editor offers.

## Deleting

Refused while any content item places a block of this type, and refused while any reusable block in
the library is one. Both are checked, because a library entry no page has used yet is invisible to
the first check.
