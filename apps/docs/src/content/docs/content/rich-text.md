---
title: Rich text
description: The editor's formatting, its keyboard shortcuts, and the two things it deliberately will not do.
---

Rich text fields have a toolbar and understand the usual keyboard shortcuts.

## What you can use

- **Bold** and *italic*
- Headings, starting at level 2
- Bulleted and numbered lists
- Links
- Block quotes
- Code, inline and as a block

## Keyboard

| | |
|---|---|
| Bold | `Ctrl/Cmd + B` |
| Italic | `Ctrl/Cmd + I` |
| Link | `Ctrl/Cmd + K` |
| Undo | `Ctrl/Cmd + Z` |
| Redo | `Ctrl/Cmd + Shift + Z` |

Everything on the toolbar is reachable by keyboard. Tab into it and use the arrow keys.

## Pasting

Paste from Word, Google Docs, or a web page and Taproot keeps the structure it recognises —
headings, lists, bold, links — and drops the rest. Fonts, colours, and sizes from the source do not
come through.

That is deliberate. Pasted formatting is how a site ends up with one paragraph in Calibri 11 and the
next in Arial 13. Your site's design decides how text looks.

## Two things it will not do

**No top-level headings.** Body headings start at Heading 2. The page's own title is its Heading 1,
and a second one breaks the document outline that screen readers and search engines both use to
understand the page.

**No images.** Images belong in the media library, where they carry alt text and a focal point that
travels with them. Sites that put images inline in body text end up with pictures nobody can
describe. Use an image field, or an image block if your site has one.

## Why your markup may come back changed

Taproot rewrites rich text when it saves, keeping only what it understands. Something it cannot
parse becomes nothing rather than staying as-is.

This is a security measure, not tidiness: rich text is stored as HTML and rendered onto your public
site, so anything it kept without understanding could run in a visitor's browser. If you paste
something exotic and it disappears on save, that is this.
