---
title: Text snippets
description: A value written once and used in sentences across the site, changed in one place.
---

A **text snippet** is a single value — this year's tuition, an application deadline, the main
switchboard number — that appears in prose on many pages. Write it once, use it anywhere, change it
in one place.

Where a [reusable block](/content/reusable-blocks/) shares a whole *region* of a page, a snippet
shares a *value inside a sentence*.

## Creating one

**Library → Text snippets → New snippet.**

| Field | What it is for |
| --- | --- |
| **Name** | How you find it in the list. Safe to rename — nothing refers to it. |
| **Token id** | What you type in content, as `{{ tuition }}`. **Fixed after creation.** |
| **Kind** | Text, Number or Date. |
| **Value** | The value itself: `4500`, or `2026-08-15`, or a phrase. |
| **How it reads** | Optional. What appears in a sentence — `$4,500` rather than `4500`. |
| **Note** | Optional, for whoever changes it next: where the figure comes from, when it is reviewed. |

### The token id cannot be changed later

Every page using a snippet refers to it by that id, so renaming it would break those pages with
nothing on screen saying so. Pick a name you can live with — `tuition`, `application_deadline`,
`main_phone`.

The **Name** is free to change at any time. Only the id is fixed.

### Why "Value" and "How it reads" are separate

The value is the fact; how it reads is the presentation. Splitting them lets one snippet serve two
jobs: a sentence gets `$4,500`, and a chart on the site gets `4500` to plot without having to pick a
number back out of a sentence.

If you leave **How it reads** empty, Taproot formats the value sensibly — `4500` becomes `4,500`, and
`2026-08-15` becomes `August 15, 2026`. Fill it in when you want something else.

## Using one

Type the token into **any text or rich text field**:

> Tuition for the 2026–27 year is `{{ tuition }}` for in-state students.

That is all. There is no button to press and nothing to insert — it is ordinary typing, and it works
the same in a plain text box as in the rich text editor, including inside blocks and repeating rows.

When the page is delivered to your website, the token is replaced. A visitor sees the value; they
never see the braces.

## Changing a value

Edit the snippet and save. Every page using it changes at once — you do not republish those pages,
and you do not need to know which they are.

The snippet's own page tells you how many items use it, which is the number worth glancing at before
you change something.

## If you mistype a token

A token naming a snippet that does not exist is **left exactly as you typed it**, braces and all. It
will look wrong on the page, which is deliberate — the alternative is rendering nothing, which
quietly turns "Tuition is $4,500 per year" into "Tuition is  per year" and looks fine until somebody
reads it closely.

So if you see `{{ tution }}` on a page, that is a typo in the token, not a broken snippet.

## Deleting

A snippet that is still used **cannot be deleted**. The delete button is replaced by a note saying
how many items use it.

Remove every `{{ token }}` from your content first, then delete. This is the same rule reusable
blocks follow, and for the same reason: a reference with nothing behind it breaks the pages nobody
happens to be looking at.

## Pointing a field at a snippet

Some fields are set up as a **Snippet** field — a dropdown of your snippets rather than a place to
type. Your site's developer uses these where the value *is* the field rather than part of a
sentence: a figure in a statistics panel, a data point on a chart.

Pick from the list. The dropdown shows each snippet's name and what it currently reads as, so you can
tell `$4,500` from `$4,900` without opening anything.

## Two things worth knowing

**Search does not look inside a snippet.** Searching the site for `4,500` will not find a page whose
tuition comes from a snippet, because what the page stores is the token. Searching for the words
around it works normally.

**A field's length limit counts the token, not the value.** If a field allows 40 characters,
`{{ tuition }}` uses 15 of them — not the 6 that `$4,500` would. This only matters on fields with a
tight limit, and it errs in the direction of letting you type less rather than more.
