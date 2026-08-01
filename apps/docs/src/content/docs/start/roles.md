---
title: What your role can do
description: The four roles, what each one may do, and why a button might be missing.
---

Taproot has four roles. They are site-wide: your role is the same on every page, every content type,
and every section. There is no "editor of the Biology pages" — if you can edit one page, you can edit
them all.

| | Viewer | Contributor | Editor | Admin |
|---|---|---|---|---|
| See the admin | ✓ | ✓ | ✓ | ✓ |
| Create and edit content | | ✓ | ✓ | ✓ |
| Upload images and files | | ✓ | ✓ | ✓ |
| Submit for review | | ✓ | ✓ | ✓ |
| Put content in a release | | ✓ | ✓ | ✓ |
| Publish, schedule, archive | | | ✓ | ✓ |
| Take a live page down | | | ✓ | ✓ |
| Create and publish releases | | | ✓ | ✓ |
| Delete content | | | ✓ | ✓ |
| Share a block to the library | | | ✓ | ✓ |
| Content types and fields | | | | ✓ |
| Menus, people, redirects, audit log | | | | ✓ |

## Why some buttons are missing

The admin only offers what your role can actually do. If you are a Contributor, the item editor
shows **Save draft** and **Submit for review** and nothing that would put a page in front of
visitors. That is not a screen failing to load — it is the screen being honest.

The same rule applies underneath: the interface and the server agree about what you may do, so you
will not find a button that then refuses you.

## The two that surprise people

**Taking a page down needs the Editor role, not just publishing it.** Moving a live page back to
Draft removes it from the site, which is a publishing decision even though the status it lands in
sounds harmless. A Contributor can still edit a live page's content — they just cannot make it stop
being live.

**Putting content in a release only needs Contributor.** Staging content reaches nobody: it waits
inside the release until an Editor publishes it, which is the same shape as submitting something for
review. So the people who write the content can assemble the launch it is for, and an Editor still
decides when it goes out.

## Tags do not grant permission

Tagging a page with a department classifies it. It does not decide who may edit it. This is worth
stating because it is a reasonable thing to assume and it is not true here: any contributor can
change any tag, so if tags granted access, changing a tag would change who could edit — including
who could change the tag.

## The last administrator

Taproot refuses to demote or deactivate the last active administrator. A site with no administrator
cannot be administered back into having one, because every screen that could fix it sits behind the
role that just disappeared.
