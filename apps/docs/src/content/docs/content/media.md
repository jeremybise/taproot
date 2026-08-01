---
title: Images and files
description: Uploading, alt text, and the focal point that keeps faces in frame.
---

**Library → Media** holds every image and file uploaded to the site.

## Uploading

From the media library, or from any image field — the picker has an upload tab, so you never have to
leave what you are writing.

**You will be asked for alt text as you upload.** That moment is when you know what the image is
for. An upload path that never asks is how a library fills with images nobody can describe.

## Alt text

Describe what the image shows, in a sentence, as if to somebody who cannot see it.

- **Good:** "Students walking across the quad in autumn."
- **Not useful:** "image", "photo", "IMG_4821.jpg".

If an image is purely decorative and the surrounding text already says everything, leave alt text
empty deliberately rather than describing it redundantly.

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
