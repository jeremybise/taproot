---
title: When something is wrong
description: The things that go wrong most often, and what each one actually means.
---

## "I published it and the site still shows the old version"

Your site caches pages briefly at the edge. Wait a minute and reload.

If it persists, check the item really is Published rather than Scheduled with a moment still ahead of
it.

## "My page vanished from the site"

Check its status. Something moved it off Published — the [audit log](/admin/audit-log/) records who
and when.

If it is still Published, check whether it moved: a slug or parent change relocates it, and the old
address now redirects. That is working correctly, not a fault.

## "A scheduled page did not go live"

A scheduled *page* goes live at its moment regardless of the scheduler, so this is almost always one
of:

- The time was in a different timezone than you meant. The editor uses your computer's local time.
- The status is not actually Scheduled.
- There is no date at all — see the next entry.

## "It says Scheduled but the date field is empty"

You restored a revision that was Scheduled. The scheduled moment is not part of a snapshot, so there
was nothing to bring back.

The page is invisible and will never publish itself. Pick a new moment or move it to another status.
It fails this way on purpose — the alternative is inheriting a date from months ago and going live
instantly.

## "A scheduled release did not publish"

Unlike a page, a release genuinely needs the scheduler running. Check **Settings → System**.

If the release says **Blocked**, the sweep reached it and refused it. Open it — the reasons are
listed, and the audit log has the moment it happened.

## "I cannot delete this"

Taproot refuses deletes that would break something, and lists what to clear. The usual ones:

- **A page has children.** Move or delete them first.
- **A page is staged in an unpublished release.** Remove it from the release.
- **A content type still has items**, or another type's relation field targets it.
- **A reusable block is still placed on a page.**
- **A release has already published.** It is the record of what went live; make a new one.

## "My formatting disappeared when I saved"

Rich text keeps only what it understands and drops the rest. Pasted fonts, colours, and sizes are
removed by design — see [Rich text](/content/rich-text/).

Top-level headings and inline images are also deliberately not allowed.

## "The image is cropped wrong"

Set its focal point. **Library → Media**, open the image, drag the focal point until every preview
frame looks right. See [Images and files](/content/media/).

## "I edited a page in a release and the live page did not change"

Working as intended. That is what a release is: the staged copy waits until the release publishes.

If you meant to change the live page, use **Edit the live page instead** from the banner.

## "Someone else's changes overwrote mine"

Check whether the page is in a release. A release publishes a whole snapshot, so it replaces whatever
the live page said — including edits made after it was staged.

**Refresh from live page** on the release screen pulls current content into the staged copy. See
[Releases](/publishing/releases/).

## "I am locked out"

Repeated failed sign-ins temporarily block further attempts, by email and by location. It clears on
its own; waiting is the fix.

If it is a forgotten password or a lost two-factor device, see
[People and access](/admin/users/).

## "Buttons I expect are not there"

Your role. See [What your role can do](/start/roles/). The admin only shows what you can actually
do, so a missing button is a permission, not a broken screen.

## A database command says the file is in use

Stop the CMS dev server first — `astro dev stop --root apps/studio`. It holds the SQLite file open.
The site's server does not touch the database and can stay up.

## "The site shows an error but the admin works"

The site could not reach the CMS, or its key was refused. Check that the CMS is running, that
`TAPROOT_API_URL` points at it, and that `TAPROOT_API_KEY` names a key that has not been revoked —
**Settings → API keys** lists them and shows when each was last used.

The two are separate deployments, so one being healthy says nothing about the other.

## "Preview says Taproot does not know where to send me"

`TAPROOT_SITE_URL` is not set on the CMS. Preview links are built from it — see
[Settings and environment](/operate/configuration/).
