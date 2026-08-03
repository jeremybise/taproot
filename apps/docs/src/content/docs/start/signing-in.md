---
title: Signing in
description: Getting into the admin, resetting a forgotten password, and what to do when a code is asked for.
---

The admin lives on your **CMS**, which is a different address from the website itself.

Taproot is two deployments: the CMS, where content is written, and the site visitors read. If your
site is `example.edu`, the CMS is usually something like `cms.example.edu` — ask whoever set it up,
or look for the address in a bookmark you were sent.

Opening that address on its own is enough; it takes you to the admin. The admin's own URL is
`/admin` on the CMS, so `cms.example.edu/admin` works too and is what your bookmark will say.

That separation is why editing a page never takes the site down, and why the site can be redesigned
without touching anything you have written.

## Signing in

Enter your email address and your password. If your site has a Google, GitHub, or Microsoft button
and your account is linked to one, you can use that instead.

If you were sent somewhere and asked to sign in first, Taproot takes you on to where you were
headed rather than dumping you on the dashboard.

## If you are asked for a six-digit code

Your account has two-factor authentication turned on. Open your authenticator app, read the current
code for Taproot, and enter it.

Each code works **once**. If you mistype and retype the same code, it will be refused even though it
is still on screen — wait for the next one.

If you have lost your phone, use one of the recovery codes you saved when you set two-factor up.
Each of those works once too. If you have lost both, an administrator can clear two-factor from your
account; see [Two-factor authentication](/admin/two-factor/).

## If you have forgotten your password

Use **Forgot your password?** on the sign-in screen. Taproot emails you a link that lets you set a
new one. The link works once and expires.

:::note
The link only appears if your site has email set up. If it is not there, nobody can send you one —
ask an administrator, who can generate a set-password link and hand it to you directly. That is not
a worse path, just a different one; see [People and access](/admin/users/).
:::

## If sign-in stops accepting you

After several failed attempts Taproot temporarily refuses further ones, both for your email address
and from your location. This is deliberate — it is what stops somebody guessing passwords — and it
clears on its own after a short wait. Waiting is faster than anything else you could do.

## Changing your own password

Click your name at the bottom of the sidebar, then **Account settings**.

You will be asked for your **current** password as well as the new one. That is what stops somebody
who finds your laptop unlocked from locking you out of your own account.

Changing your password signs you out **everywhere else** and keeps you signed in here. If somebody
else had got into your account, that ends their session.
