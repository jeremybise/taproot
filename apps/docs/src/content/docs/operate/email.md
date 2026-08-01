---
title: Email
description: Taproot sends one message and works with none. Wiring up delivery when you want it.
---

Taproot sends **exactly one** kind of message: the self-service password reset link.

It runs perfectly well sending none. `npm run dev` needs no mail service, and neither does a small
production deployment where an administrator hands out set-password links directly.

## With nothing configured

Messages are written to the server log, and the features that would promise delivery are **hidden**:

- No "Forgot your password?" link on the sign-in screen.
- The forgot-password screen and its API route both refuse.

That is deliberate. A form whose success message is a lie — "check your email", when the message
went into a log nobody reads — is worse than no form.

Password resets still work; an administrator generates a set-password link and hands it over. See
[People and access](/admin/users/).

## Turning delivery on

Set `TAPROOT_MAIL_WEBHOOK_URL` and `TAPROOT_MAIL_FROM`. Optionally `TAPROOT_MAIL_WEBHOOK_TOKEN`,
which is sent as `authorization: Bearer <token>`.

Taproot POSTs flat JSON:

```json
{
  "from": "cms@example.edu",
  "to": "someone@example.edu",
  "subject": "Set your Taproot password",
  "text": "…",
  "html": "…"
}
```

Point it at your own endpoint and forward from there to whatever you already use — a serverless
function, an existing internal mail service, a workflow tool.

## Why there is no Resend or SES integration

Four providers means four payload shapes, four error semantics, four sets of credentials, and four
things to keep working as their APIs change. A CMS that deliberately ships no block templates should
not be maintaining four mail adapters.

A webhook is the seam where your organisation's existing mail arrangements already live.

## Throttling

Reset requests are throttled in their own counter, separate from sign-in attempts.

That separation matters: if they shared a counter, repeatedly asking to reset somebody's password
would be a way to lock them out of signing in.

## Checking it works

**Settings → System** shows whether a mailer is configured and whether it can deliver. Trigger a
reset for a test account and watch your endpoint.
