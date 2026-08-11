---
title: Images and files
description: Uploading, alt text, and the focal point that keeps faces in frame.
---

**Library → Media** holds every image and file uploaded to the site.

## Uploading

From the media library, or from any image field — the picker has an upload tab, so you never have to
leave what you are writing.

The library takes **up to ten files at once**, up to 60 MB in total. If one file is too big the rest
still upload, and the next screen tells you which did not. Asking for more than ten at a time is
refused rather than quietly trimmed, so you never have to work out which ones were dropped.

**You will be asked to describe your images straight after uploading.** That moment is when you know
what the image is for, and an upload path that never asks is how a library fills with images nobody
can describe. From the picker — one image, chosen for one field — the alt text box is right there on
the upload form. From the library, where you may have added ten at once, you land on a screen with a
row per image instead: one description cannot serve ten pictures.

## Describing several images at once

The describe screen gives each image a thumbnail, a description box and a **Decorative** tick. Fill
in what you can and press save.

An asset's own page has the same description controls, above the focal point and crop editor —
describing an image comes before deciding how it is framed.

**A row you leave blank stays an open question.** It is not marked decorative — describing three of
twelve images must not quietly declare the other nine finished. Come back to the rest whenever you
like; the [accessibility report](/content/accessibility/) keeps listing them until they are done, and
its **Describe them together** button opens this same screen for whatever is still outstanding. That
is the way to clear a backlog: in screenfuls, rather than one image at a time.

If you type a description over a Decorative tick that was already there, the description wins.

## Alt text

Describe what the image shows, in a sentence, as if to somebody who cannot see it.

- **Good:** "Students walking across the quad in autumn."
- **Not useful:** "image", "photo", "IMG_4821.jpg".

If an image is purely decorative and the surrounding text already says everything, open it and tick
**Decorative — this image needs no alt text** rather than describing it redundantly.

Ticking that box is not the same as leaving the field blank. Blank means nobody has described it
yet, and the [accessibility report](/content/accessibility/) will say so; Decorative means somebody
decided it needs no description, and the report leaves it alone. The two look identical in an empty
text box, which is why the box exists.

## Choosing an image

Every place you pick an image uses the same picker: image fields, the social card in the SEO panel,
a content type's default social image.

The grid is one stop for your keyboard, not one per image. Tab into it, then:

| | |
|---|---|
| Move between images | Arrow keys |
| Select | `Space` or `Enter` |
| Close | `Escape` |

Search narrows the grid. Anything you have already selected **stays selected** even after a search
hides it — the count at the bottom is the truth, not what is currently on screen.

A field configured for documents shows documents. If you cannot find a PDF in an image field, the
field is not asking for one.

## The focal point

Open any image from the media library and you get a hotspot editor: the image with preview frames
for the shapes your site actually uses — wide banner, square thumbnail, portrait card.

Drag the focal point and watch every frame update at once. Whatever you centre stays centred in
every shape.

This matters because the same image gets cropped differently in different places. Without a focal
point, a wide crop of a portrait photograph cuts off the head. With one, it does not.

**Crop** trims the source — removing a distracting edge — and the focal point then works within
what is left.

Nothing is baked into a file. The original is kept and each shape is worked out when the page
renders, so one asset serves every use and changing the design does not mean re-cropping anything.

## Replacing an image

Upload the new one and repoint the fields that used the old one. Taproot does not swap the file
underneath, because the same asset may be in use somewhere with a crop that suits the old image and
not the new one.

## Deleting

Taproot lists what uses an asset before you delete it. Removing one still in use leaves the pages
referencing something that is gone.
