---
title: Branding
description: Give the CMS your own name, logo, and colour — and read the contrast figures before you commit to one.
---

**Settings → Branding**, administrators only.

This is what the CMS calls itself for the people who sign in to it: the name in the sidebar, the
mark beside it, the browser tab, and the sign-in screen. **None of it reaches your website.** Your
site's own design is yours; this is the tool your colleagues log into.

## Name and logo

The **title** replaces "Taproot" wherever it appears in the admin. Leave it blank to put "Taproot"
back — an empty box means the default, not a nameless CMS.

The **logo** is chosen from the media library, the same place images come from, and appears in place
of the ◆ mark. It is scaled to the height of the text beside it, so a wide wordmark works as well as
a square icon. It also becomes the browser tab's icon. Remove it and the ◆ returns.

## Accent colour

One colour for light mode and one for dark. Two, not one, because a hue that reads well on white
rarely reads well on a dark background — Taproot's own green is two different greens for that
reason.

Everything else is worked out from what you choose:

| Derived | Where you see it |
|---|---|
| The hover shade | Buttons under the pointer |
| The label colour | Text on a solid button |
| The tint | Behind the current sidebar item, and the banner after a save |

Those are not offered as choices on purpose. A button label is a question with a right answer, and a
CMS that let you pick it is a CMS that lets you make Save unreadable.

**Status badges keep their own colours.** Draft, In review, Scheduled, Published, and Archived have
to stay told apart from one another, and a free accent would sooner or later put Published on top of
In review.

## The contrast figures

Under each colour is every pair it takes part in, with its ratio and whether that clears the
[WCAG](https://www.w3.org/WAI/WCAG21/quickref/) threshold — 4.5:1 for text, 3:1 for a boundary you
only have to see. They move as you change the colour, so you can find a shade that works before you
save rather than afterwards.

The three derived pairs should always pass. The two that can fail are the ones that depend on the
colour itself:

- **Accent as text** — links inside the rich-text editor are drawn in the accent.
- **Accent as an outline** — the ring around a selected image, and borders drawn in it.

A pale colour will fail both in light mode, and a very dark one will fail both in dark mode. Usually
a darker shade of the same hue for light mode, or a lighter one for dark mode, is all it takes.

**Nothing stops you saving a colour that fails.** Institutions have brand colours and they are not
always contrastable; being told exactly what will be hard to read is more use than being refused.
But a failing pair is a real accessibility problem for the people using the CMS every day, so it is
worth a second look before you decide the brand colour has to win.

## What is not here

Fonts and spacing are not configurable, and there is no custom CSS. The admin has an accessibility
bar to meet — every colour pair is checked, the type scale is what the layout was built around — and
those are the two knobs most likely to quietly break it.
