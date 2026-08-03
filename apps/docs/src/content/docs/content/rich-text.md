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

## Links

Select the words you want to link, then press the chain button or `Ctrl/Cmd + K`. With nothing
selected, the link brings its own text — the page title, the filename, or the address.

The dialog offers three kinds of link, and the difference between them matters:

**A page.** Search for it by title and choose it from the list. Taproot stores which page you
picked, not its address — so if that page is later renamed or moved to a different part of the site,
every link to it keeps working and nobody has to go and find them.

**A file.** Choose it from the media library, the same one images come from. Stored the same way: if
somebody uploads a new version of the prospectus over the old one, every link to it follows.

**A web address.** For anything outside this site. Typed addresses are stored exactly as typed, so
this is the one kind that can break — if you are linking to a page on this site, use the first
option instead.

Two options apply whichever kind you choose. **Open in a new tab** does what it says. **Tell search
engines not to follow** is for links you would rather not vouch for.

### Changing a link that is already there

Put the cursor anywhere in the link and press the chain button again. The dialog opens on the kind
of link it is and shows what it currently points at, with a way to go and look at it. Change it,
adjust the options, or use **Remove link** to unlink the words without deleting them.

If it says the page or file no longer exists, the thing it pointed at has been deleted. Visitors do
not see a broken link — the words stay and the link quietly drops away — but nobody is taken
anywhere either, so it is worth pointing somewhere else.

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
