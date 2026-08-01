---
title: People and access
description: Adding colleagues, choosing their role, and helping someone who is locked out.
---

**Settings → People**. Administrators only.

## Adding someone

Give a name, an email address, and a [role](/start/roles/).

You are **not** asked to set their password, and there is no field for it. Instead Taproot gives you
a **set-password link** to send them.

## Why you never set somebody's password

If you type a password and send it to a colleague, you know their password. So does anyone who reads
the message, now or later. And people reuse passwords, so it is rarely only about your site.

The link Taproot generates instead:

- **Works once**, and expires after 48 hours.
- **Is stored hashed**, so even the database does not hold the usable value.
- **Is shown to you through a one-time reveal rather than sitting in the address bar** — a URL ends
  up in browser history, in the `Referer` header, and in server logs.

Copy it and send it however you normally reach that person. If it expires, generate another; there
is no penalty.

## When somebody forgets their password

If your site has email set up, they use **Forgot your password?** on the sign-in screen and need
nothing from you.

If it does not, that link is not shown, and generating a set-password link from this screen is the
route. Both use the same mechanism.

## Changing a role

Takes effect on their next request. No need for them to sign out.

## Deactivating

Deactivating stops somebody signing in and keeps everything they wrote, along with their name on it.
Use this when somebody leaves.

Deleting a person is not the way to remove access — deactivating is.

## The last administrator

Taproot refuses to demote or deactivate the last active administrator. Every screen that could
restore the role sits behind it, and the first-run setup screen refuses to help because users
already exist.

Promote somebody else first.

## Helping someone locked out of two-factor

If a colleague has lost both their phone and their recovery codes, this screen has **Clear
two-factor** for their account. They can then sign in with their password alone and set it up again.

**You cannot do this to your own account.** Your own two-factor is managed from your Account screen,
which asks for your password. Offering it here would route around that check and turn an unattended
admin session into a way of stripping protection off the very account it belongs to.

## Ending someone's sessions

**Sign out everywhere** ends every session for that account. Use it when a laptop is lost.

Doing it to *yourself* keeps your current browser signed in. Being logged out for taking a
precaution teaches people not to take precautions.

## Sign-in throttling

Repeated failures temporarily block further attempts, counted both per email address and per
location. It clears on its own.

If a colleague says they are locked out and are sure of their password, this is usually it. Waiting
is the fix.
