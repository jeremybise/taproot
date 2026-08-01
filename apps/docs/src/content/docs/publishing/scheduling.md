---
title: Scheduling a page
description: Setting a page to go live at a moment, and what happens if the server is not watching.
---

Scheduling makes one page appear at a moment you choose. To coordinate several pages, use a
[release](/publishing/releases/) instead.

## Scheduling

In the item editor's Publishing panel, choose **Schedule**, pick a date and time, and save. Needs
the Editor role.

The time is **your local time**, taken from your computer.

If you pick a moment that has already passed, the editor says so — the page goes live as soon as you
save.

## What happens at that moment

The page becomes visible to visitors. That is true **whether or not anything is running on the
server**, because Taproot works out visibility as the page is requested rather than relying on a
background job.

This matters more than it sounds. It means scheduling works on a fresh installation where nobody has
set up a scheduled task — which is every installation on its first day, and many small ones forever.

A background sweep then catches the stored status up, so the admin stops saying "Scheduled" about a
page the public can already read. If nobody has set that up, the page is still live and correct; the
admin is just a little behind. See [The scheduler](/operate/scheduler/).

:::note
[Releases](/publishing/releases/) are different, and this is the one place the distinction bites: a
scheduled *release* genuinely needs the sweep to be running, because its content has to be applied
rather than merely revealed. A page view cannot do that.
:::

## Cancelling

**Cancel schedule** in the Publishing panel returns it to Draft, or move it to any other status.

The scheduled time is **cleared** whenever a page stops being Scheduled. That is deliberate: a
leftover time is a trap, because scheduling the page again months later without picking a new moment
would inherit one in the past — which means immediately.

So rescheduling always means picking a new time. That is the safe behaviour, not an inconvenience.

## Checking on it

**Settings → System** shows how many pages are waiting, and how many are past their time with the
status not yet caught up.

That second number is the one to watch. A few, briefly, is normal. A number that does not fall
within a few minutes means nothing is running the sweep — the pages are still live, but the record
is drifting.
