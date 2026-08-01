---
title: Accessibility
description: What the checker looks for, why each rule matters, and how to fix what it finds.
---

Taproot checks your content for the problems that most often lock people out of a page, and shows
them in two places: a panel beside the editor while you write, and a report covering the whole site.

**Nothing it finds will stop you saving or publishing.** It is a list of things worth fixing, not a
gate. A checker that refuses to let you publish is a checker people learn to work around.

## The panel while you write

Every content item's editor has an **Accessibility** panel in the sidebar, between Publishing and
the SEO fields. It updates as you type — you do not have to save to see whether something you just
wrote is a problem.

When there is nothing to report it says so in one line and takes up no room.

Each finding names the field it came from, and clicking it takes you there.

## The report

**Content → Accessibility** lists every item with something worth fixing.

By default it checks the pages a visitor can actually reach — published, and scheduled pages whose
time has passed. Tick **Include unpublished** to see drafts and archived pages too. You can also
narrow it to one content type or one kind of issue.

It works through your content a page of 50 items at a time, and says how far it has got: "Checked
50 of 312 items". That is deliberate — it reads and inspects every one of those items rather than
looking up an answer, so it tells you what it has actually looked at rather than guessing at a
total.

Everything is worked out fresh each time you open it. There is no "mark as fixed": fix the page and
the finding is gone.

## What it looks for

### Images with no alt text

Every image needs either a description or an explicit note that it needs none.

Alt text is what somebody hears in place of the picture. Write what the image *conveys* in this
context, not what is literally in the frame — "Students crossing the quad between lectures" rather
than "photo".

If an image genuinely carries no information — a divider, a background texture, an icon next to a
label that already says the same thing — open it in **Media** and tick **Decorative**. It then has
no description on purpose, and the report stops asking.

Leaving the box blank is not the same as ticking Decorative. Blank means nobody has got to it yet,
which is exactly what the report is for.

The report lists undescribed images separately from the pages, and that list includes images you
have uploaded but not yet used anywhere. Those are worth doing now — the alternative is describing
them later, on somebody else's deadline.

### Heading order

Headings must not skip a level, and a rich text field starts at level 2.

Level 1 is the page's title, which Taproot renders for you — that is why the toolbar offers no
level 1 and why body headings start at 2.

Skipping matters because a lot of people navigate a page by jumping between headings rather than
reading it top to bottom. Going straight from a level 2 to a level 4 tells them there is a
sub-section they have missed. Use the levels to say what belongs inside what, not to choose a text
size.

Going back *up* more than one level is fine — a level 3 followed by a level 2 is simply the next
section starting.

Each rich text field is checked on its own, because Taproot does not know what order your site
renders its fields in, or whether it renders all of them.

### Links with no text

A link whose text is empty is announced as nothing but "link".

This usually happens by accident — a link applied to a space, or to formatting that was later
deleted. Put the words back, or remove the link.

### Unhelpful link text

"Click here", "read more", and bare web addresses are flagged as warnings.

Screen readers can list every link on a page on its own, out of the sentence around it. In that
list, six links reading "read more" are six links to nowhere in particular, and
`https://example.edu/admissions/apply` is read out character by character.

Link the words that describe where it goes: **How to apply**, not **click here** to apply.

This is a warning rather than an error because it is a judgement call — occasionally the sentence
around a link really does carry it.

## Content from the reusable block library

If a page places a [reusable block](/content/reusable-blocks/), findings in that block's content are
reported against the page — but marked as belonging to the library entry, with a link to it.

That is because the page does not hold that content and you cannot fix it from there. Open the
library entry, fix it once, and every page using it is fixed.

## What this does not check

The checker reads your *content*. It cannot see the templates your site renders it with, so colour
contrast, focus behaviour, and the structure of the page around your content are the site's job
rather than something the CMS can answer for.

It also cannot tell you whether alt text is any *good* — only whether it exists. A description
reading "image" passes the check and helps nobody.
