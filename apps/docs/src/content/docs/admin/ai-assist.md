---
title: AI assist
description: Suggested alt text and page metadata, and why nothing is ever saved for you.
---

Taproot can propose **alt text** for an image and a **meta title and description** for a page. It is
off until an administrator sets it up, and it never saves anything on your behalf.

## Nothing is written for you

Every suggestion lands in a box. You read it, change it, or clear it, and **Save** is still the only
thing that records anything.

That is not caution for its own sake. Leaving alt text blank and leaving it *marked decorative* are
different things — decorative means "this image carries no information", and a screen reader skips
it. No generator can know that about a picture, so a machine is never allowed to decide it. The same
logic is gentler but real for a meta description: it is a claim about what a page is *for*, and the
person who wrote the page is the one who can judge it.

Treat what you get as a first draft from somebody who has not read your page carefully.

## Turning it on

**Settings → AI assist**, administrator only.

Your provider key goes in the **environment**, not into Taproot — the screen tells you which variable
to set and reports each provider as configured or not. It never shows a key and cannot accept one.
Ask whoever runs your deployment if you are not sure.

Then choose a provider, and switch on the parts you want. There are two switches rather than one on
purpose: describing an image the model can see and summarising a page are different jobs, and wanting
one without the other is reasonable. Both start off.

You can leave **Model** blank to use the provider's default, or set it to pin a particular one.

For Claude, any of these work: `claude-opus-5` (the default), `claude-opus-4-8`, `claude-opus-4-7`,
`claude-opus-4-6`, `claude-sonnet-5`, `claude-sonnet-4-6`, `claude-haiku-4-5`, or `claude-fable-5`.
**`claude-sonnet-5` is a good choice for this job** — describing an image in a sentence is not hard
reasoning, and it costs a fraction of Opus. `claude-haiku-4-5` is cheaper still.

If you set a model name the provider does not recognise, the Generate button reports the error and
names the model, which is usually enough to spot a typo.

Each press of a Generate button spends your provider's API credit.

## Alt text

On the [describe screen](/content/media/#describing-several-images-at-once) each image gets a
**Suggest** button, and there is one at the bottom for every row you have left blank. That one works
through them a few seconds apart and **skips anything you have already written** — it will not
overwrite your words.

Read each sentence before saving. The model can see the picture but not why you chose it, so it
tends to describe what is in the frame rather than what the image is doing on your page. Those are
often different, and the second one is what alt text is for.

## Meta titles and descriptions

In an item's **Search & social** panel, **Generate from page content** fills both boxes from the
page's own text — including text inside blocks, which is what the site search reads too.

It fills both boxes, replacing whatever is there, so you can press it again if the first attempt is
wrong.

An item that has never been indexed has no text to read, and the panel says so rather than inventing
a description of a page it was shown nothing of. Saving the item once fixes it.
