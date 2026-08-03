---
title: Two-factor authentication
description: Turning it on for your own account, recovery codes, and what to do when a phone is lost.
---

Two-factor authentication asks for a six-digit code from your phone as well as your password. It is
per-account and you turn it on for yourself.

**Your name at the bottom of the sidebar → Account settings.**

## Turning it on

1. Choose to set up two-factor. Taproot shows a QR code.
2. Scan it with an authenticator app — Google Authenticator, 1Password, Authy, whichever.
3. Enter the code the app shows, to prove it worked.
4. **Save the recovery codes.** They are shown once.

Step 3 is what completes it. Until you enter a correct code, nothing is turned on — that way a
mis-scanned QR code cannot lock you out of your own account.

## Recovery codes

Ten single-use codes, each of which works in place of your phone exactly once.

Put them where you keep other important things and not only on the phone with the authenticator on
it — the case they exist for is losing that phone.

You can generate a fresh set from the Account screen. Doing so invalidates the old ones and requires
your password.

## Signing in with it on

Password first, then the code. Your password alone never signs you in — Taproot holds a short-lived,
single-use, cancellable challenge between the two steps rather than signing you in and asking
afterwards.

**Each code works once.** Mistype it and retyping the same digits will be refused even though the app
still shows them. Wait for the next code. This is on purpose: a code read over your shoulder would
otherwise work again for a minute and a half.

The code step is throttled like the password step. Six digits is a million possibilities, which is
few enough to guess if nothing is counting.

## Turning it off

From the Account screen, with your password.

Cancelling a setup you never confirmed does **not** need your password — an unconfirmed secret is
protecting nothing yet.

## If you lose your phone

Use a recovery code, sign in, and set two-factor up again with the new device.

If you have lost the recovery codes too, an administrator can clear two-factor from your account —
see [People and access](/admin/users/). This used to mean a database console while the sign-in screen
said "ask an administrator", which was not a workable answer.

## For administrators

You can clear two-factor for anybody else. You cannot clear your own from that screen; use your
Account screen, which asks for your password.
