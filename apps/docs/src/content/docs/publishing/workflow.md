---
title: The publishing workflow
description: The five statuses, the moves between them, and why the editor shows buttons instead of a dropdown.
---

Every content item has a status. Moving between them is what publishing is.

| Status | What it means |
|---|---|
| **Draft** | Being written. Not on the site. |
| **In review** | Handed to an editor to look at. Still not on the site. |
| **Scheduled** | Will appear at a set moment. See [Scheduling a page](/publishing/scheduling/). |
| **Published** | Live. Visitors see it. |
| **Archived** | Taken off the site and kept. |

## Buttons, not a dropdown

The Publishing panel offers **named actions** — "Submit for review", "Approve and publish", "Cancel
schedule" — rather than a list of statuses.

That is because "submit for review" is an act with a name, and "set the status to In review" is how
that act used to be spelled. Nobody could find it.

Pressing one stages the change. **Nothing moves until you save**, and the button says so.

## Which moves exist

Not every status can reach every other. The moves are:

- **Draft** → In review, Published, Scheduled, Archived
- **In review** → back to Draft, or on to Published, Scheduled, Archived
- **Scheduled** → Draft, In review, Published, Archived
- **Published** → Draft, In review, Scheduled, Archived
- **Archived** → **Draft only**

**There is no Archived → Published, for anyone, including administrators.** A page was archived for
a reason, and whatever made it wrong then is usually still wrong. Bringing it back through Draft is
what puts a human in front of the content before the public is. Restore it as a draft, read it,
publish it.

## Who may make which move

Contributors can move things into Draft and In review. Everything else — Published, Scheduled,
Archived, **and anything leaving Published** — needs an Editor.

That last one catches people out. Taking a live page to Draft removes it from the site, so it is a
publishing decision even though Draft sounds harmless. A Contributor can still edit a live page's
content; they just cannot take it down.

## Withdrawing your own submission

A Contributor who spots a mistake in something they submitted can move it back to Draft themselves.
They should not have to ask somebody to hand it back.

## Editing something already live

Saving a published item publishes those edits **immediately**. There is no draft copy of a live
page.

When you need to prepare a change without it going out — new figures across several pages, a launch
on a date — use a [release](/publishing/releases/). That is the only way to have a pending version
of a live page.
