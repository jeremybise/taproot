---
title: Releases
description: Changing many live pages at once, all going out together, without any of them changing early.
---

A **release** is a named batch of content that goes live together.

It exists for the case nothing else in Taproot handles: **changing pages that are already live,
without the changes appearing until you are ready.** Saving a published page publishes it
immediately — so "new tuition figures across a dozen pages, all at 9am on Monday" had no home before
releases.

## How it works

A release holds a **copy** of each item's content. You edit that copy. The live page carries on
showing what it always showed. When the release publishes, every copy is applied to its page at
once.

## Creating one

**Content → Releases → Create release**. Needs the Editor role.

Name it after the launch rather than the date — "Tuition update 2027", not "September 1". Dates
change; what the release is for does not.

## Adding content

Open any content item. Above the editor, **Add this item to a release** offers every open release.

That takes a copy of the item's content as it is right now. Contributors can do this — staging is not
publishing, and nothing you put in a release reaches anybody until an Editor publishes it.

## Editing the staged copy

Once an item is in a release, the editor shows a banner. **Edit its staged version** switches the
editor to the copy inside the release.

In that mode:

- The panel on the right says so, and the save button reads **Save to release**.
- **The live page does not change**, however many times you save.
- Status, scheduling, and the parent page are missing — those belong to the live item, and a release
  publishes everything in it, so the status question is the release's rather than each item's.

**Edit the live page instead** takes you back to editing what visitors see now.

## Publishing

From the release's own screen. Two ways:

**Publish now** applies every staged version immediately.

**Or go live at** schedules it. Needs the scheduler to be running — see the warning below.

Both need the Editor role, because publishing a release publishes every item in it, and that is a
publishing decision however many items there are.

## The check before anything is written

Taproot validates **every** staged item before writing a single one. If any would fail, nothing
happens at all and you get a list of what to fix.

This is what stops "item 4 of 12 failed" leaving half a launch live. The reasons are worked out
fresh each time you look, so fixing a problem clears it from the list.

Common reasons a release is not ready:

- **Nothing in it.**
- **An item is Archived.** There is no route from Archived to Published for anyone. Return it to
  Draft first, then re-stage it.
- **An item's content no longer validates.** Usually a required field added to the content type
  after the item was staged. Open the staged version and fill it in.
- **An item was deleted.** Remove it from the release.

## If the same item is in two releases

Allowed, and both release screens say so. Taproot does not stop you, because staging a page in
"Spring launch" and "Tuition update" is a reasonable thing to do.

Be aware of what it means: each release holds its own copy, so **whichever publishes last is what
visitors end up with**. The earlier release's changes are overwritten.

## Keeping a staged copy current

If the live page changed after you staged it, your staged copy still holds the older content — and
publishing would quietly revert the newer changes, because a staged version is a whole snapshot
rather than a list of differences.

**Refresh from live page** on the release screen pulls the current content in again. It discards
edits you made inside the release, so use it when the live page has moved on and your staged edits
have not started.

## Removing an item

**Remove from release** on the release screen. The live page is untouched.

You cannot remove an item that has already been published as part of this release — that would erase
the record while leaving the change live.

## Scheduled releases need the scheduler

:::caution
A scheduled **page** goes live at its moment whether or not anything is running on the server. A
scheduled **release** does not.

The difference is that a page's content is already in place and only has to be revealed, while a
release's content has to be *applied* — addresses recalculated, redirects written, revisions
recorded. No page view can do that.

If nothing is running the sweep on your installation, a scheduled release simply does not go live.
Ask whoever runs your server, or see [The scheduler](/operate/scheduler/).
:::

## If a scheduled release is refused

Taproot marks it **Blocked** and stops. It does not retry.

That is on purpose. There was nobody watching at 3am, and retrying broken content every minute until
somebody noticed would fill the audit log and change nothing. Blocked means a person is needed.

Open it, fix what is listed, then publish it or schedule it again. The audit log records when it was
refused and why.

## After it publishes

The release becomes a record of what went live together, and cannot be edited or deleted. Create a
new one for further changes.

Each item also gets its own revision, so the change shows up in that page's history like any other
save.
