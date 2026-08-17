---
title: The fields you will meet
description: Every field type Taproot offers, what it looks like, and how to fill it in.
---

The fields on a content item are chosen by whoever set up its content type. There are twelve kinds.
You will probably only meet five or six.

## Text

A single line. Used for names, headings, short labels.

If it has a minimum or maximum length, you are told when you break it, on save.

## Rich text

A proper editor with bold, italic, links, lists, and headings. It has enough rules of its own to
deserve its own page — see [Rich text](/content/rich-text/).

## Number

Digits only. May have a minimum and a maximum, and may or may not accept decimals.

## Yes / no

A checkbox. Off unless someone turns it on.

## Date

A date picker. Some are date-only, some include a time.

## Choice

A dropdown, or a set of checkboxes when several answers are allowed. The options come from the
content type — if the one you want is missing, an administrator adds it, not you.

## Image or file

Opens the media library. See [Images and files](/content/media/).

Some accept one file, some several. When several are allowed, the order you put them in is the
order they appear on the site — drag or use the move buttons to change it.

## Tags

Terms from one of the site's vocabularies. Some let you pick one, some several; some offer a flat
list, some a tree. See [Tags and categories](/content/taxonomies/).

## Link to other content

Points at another content item — "related programmes", "presented by". Search by title; the list
narrows as you type.

If the target page also displays its incoming links, your page appears there automatically once you
save. You do not have to make the link twice.

## Link

One destination, for a button or a "find out more". Choose **Choose a link** and the same dialog
you already use for links in rich text opens: a page on this site, a file from the media library, or
a web address. You can give it its own label, and say whether it opens in a new tab.

This is the field to reach for when the destination is *sometimes* internal and sometimes not — a
"Register" button that points at a page this term and an external booking system the next. "Link to
other content" cannot express an outside address at all.

Some link fields are restricted to one or two of the three kinds; you will only see the choices the
field allows.

Links to a page or a file follow their target. Rename or move the page and the link still works,
with nobody editing the content that points at it.

For a row of buttons, a site admin puts a link field inside a repeater — each row is then one
button, free to carry its own heading or style alongside it.

## Embed

A video, a map, or a form that lives on another site. You paste its address and describe what it is;
Taproot builds the frame around it.

Two things about this field surprise people, and both are deliberate.

**You can only use sites an administrator has approved.** The box under the address lists them. If
what you want is not there, ask — it is one setting, and the reason for the list is that a frame
hands part of your page to somebody else's website.

**Paste the address of the thing being embedded, not the page you were reading.** For a video that
usually means the "embed" address from the provider's own Share menu, not the address in your
browser bar. If you paste the wrong one, most providers show a refusal inside the frame rather than
the video.

The **Title** is not optional and is not shown to sighted visitors. Someone using a screen reader
gets a list of the frames on a page, and the title is the only thing in it — so "Campus tour video"
is useful and "Video" is not. The accessibility panel says so if you write the vague one.

There is no preview inside the field. Use the preview pane to see it in place on the real page, at
the real width.

## Snippet

A dropdown of the site's [text snippets](/content/snippets/) — a shared value like this year's
tuition, kept in one place.

Use this where the value *is* the field: a figure in a statistics panel, a data point on a chart. To
put a shared value in the middle of a sentence instead, you do not need a field at all — type its
`{{ token }}` into any text or rich text box.

The dropdown shows each snippet's name and what it currently reads as, so you can tell `$4,500` from
`$4,900` without opening anything. A field may be narrowed to one kind, in which case only text, or
only number, or only date snippets appear.

## Blocks

A list you build a page out of, choosing from the block types your site offers. See
[Blocks](/content/blocks/).

## Repeater

A small table you add rows to — office hours, staff contacts, a list of dates and descriptions.
Each row has the same set of sub-fields.

Add a row with **Add row**, reorder with the move buttons, remove with the row's own remove button.
Sub-fields can be any of the simpler kinds above, but not blocks and not another repeater; a table
of tables is a data model rather than a field.

### Rows that sort themselves

Where the order is always the same — a glossary by term, courses by code — a repeater can maintain
it for you. Whoever set the field up chooses **Keep entries in order of** and picks one of its
sub-fields; from then on every save puts the rows in that order, so a new entry typed at the bottom
lands where it belongs and nobody tidies up afterwards.

Numbers inside text sort as numbers, so `RAD 20`, `RAD 196` and `RAD 1096` come out in that order
rather than alphabetically. Rows where the field is still blank stay at the end, so a half-finished
entry does not jump to the top.

This is off unless somebody turns it on, because plenty of repeaters carry their meaning *in* the
order they were typed — an event's schedule, the steps of a process, a program's plan where a blank
term means "same as the row above". If your rows are one of those, leave it alone.

---

## Required fields

Marked as required, and refused on save if empty, with the message next to the field rather than in
a summary at the top.

A required rich text field needs actual words. An empty editor technically contains an empty
paragraph, and that does not count.

## Help text

If a field has a note under its label, an administrator wrote it for this site. It is more specific
than anything this handbook can tell you.
