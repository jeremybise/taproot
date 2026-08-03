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

## Remote migration fails with 400 "not authorized"

Almost always the **account**, not the token. Cloudflare answers that way when the token is valid
but has no D1 access for the account id you gave it — so check `TAPROOT_CF_ACCOUNT_ID` first, then
that the token's **Account Resources** include that same account. If both are right, the permission
is `D1 · Read` where it needs `D1 · Edit`: migrations write, so Read authenticates and then fails.

Listing what the token can actually see settles it in one request —
`GET /accounts/{account_id}/d1/database` returns every D1 database it can reach, with the uuid that
belongs in `TAPROOT_CF_D1_ID`.

Also check *where* you put the three values: they go in a local `.env`, not `wrangler secret put`.
Migrations run on your machine, and the deployed Worker never reads `TAPROOT_CF_*`. See
[Settings and environment](/operate/configuration/).

## "The site shows an error but the admin works"

The site could not reach the CMS, or its key was refused. Check that the CMS is running, that
`TAPROOT_API_URL` points at it, and that `TAPROOT_API_KEY` names a key that has not been revoked —
**Settings → API keys** lists them and shows when each was last used.

The two are separate deployments, so one being healthy says nothing about the other.

## "Preview says Taproot does not know where to send me"

`TAPROOT_SITE_URL` is not set on the CMS. Preview links are built from it — see
[Settings and environment](/operate/configuration/).

## "The live preview pane is blank"

Almost always something in front of your site adding an `X-Frame-Options` header — a WAF, a CDN
rule, or a security-headers middleware. It refuses to let the CMS frame the page, and the browser
reports it only to its own console, which nobody has open.

It has to be removed **where it is added**. A `Content-Security-Policy` from your site cannot loosen
an `X-Frame-Options` set upstream of it; the two are not negotiated, the stricter wins.

Check by opening the preview link in a normal tab — the button in the editor header does exactly
that. If the page loads there but not in the pane, framing is what is being blocked.

## "The preview shows my page, but the menu is missing it"

Working as intended, and only for unpublished pages. Menus and listings come from delivery endpoints
that take no preview token, so they show published content whatever the pane is showing. A draft
page previews correctly and does not appear in its own navigation until it is published.

## "My unsaved changes are not showing on that page"

The pane's address box will show you any page on your site, but unsaved changes only appear on the
item's **own** page. A preview token is a capability over one content item — deliberately, so that
holding one is not a key to every unpublished page on the site.
