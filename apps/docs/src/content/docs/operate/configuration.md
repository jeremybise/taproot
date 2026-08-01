---
title: Settings and environment
description: Every environment variable Taproot reads, and what happens when each is unset.
---

Configuration is environment variables. In development they come from `apps/web/.env`; in production
from your platform's secrets. Real environment variables always win over the file.

**Settings → System** in the admin shows what the running deployment actually resolved, which is
usually faster than reading a config file over somebody's shoulder.

## Sign-in

| | |
|---|---|
| `TAPROOT_PASSWORD_AUTH` | `0` turns email-and-password sign-in off. On by default |
| `TAPROOT_ORIGIN` | The origin the site is served from. Used to build OAuth redirect URIs |
| `GOOGLE_CLIENT_ID` / `_SECRET` | Optional Google sign-in |
| `GITHUB_CLIENT_ID` / `_SECRET` | Optional GitHub sign-in |
| `MICROSOFT_CLIENT_ID` / `_SECRET` / `MICROSOFT_TENANT` | Optional Microsoft sign-in |

Email and password is the primary way in. OAuth is an addition, not a replacement.

:::caution
**Taproot refuses to start if there is no way in at all** — `TAPROOT_PASSWORD_AUTH=0` with no OAuth
provider configured. That is a deployment nobody can administer, and failing at boot is better than
discovering it at the sign-in screen.

`TAPROOT_DEV_AUTH` no longer exists and **throws on sight** if present. It is not ignored, because
silently dropping it would leave you believing you had scoped something.
:::

## Database

| | |
|---|---|
| `TAPROOT_SQLITE_PATH` | Local SQLite file, relative to `apps/web`. Created automatically |
| `DATABASE_URL` | Switches to Postgres. Requires `npm install pg` |

On Cloudflare, the D1 binding takes over and neither is read.

## Media

| | |
|---|---|
| `TAPROOT_UPLOAD_DIR` | Where local uploads are written |
| `TAPROOT_MEDIA_URL` | Public base URL for media |

In production the R2 binding takes over from the upload directory.

`TAPROOT_MEDIA_URL` is worth understanding. Unset, media is served by Taproot itself, from
`/api/taproot/media/file/…`. That always works, and costs a request to your Worker per image.

Set it to a custom domain on your R2 bucket and images come straight from the edge instead. That is
faster and is the recommended production setup — but it is an optimisation, not a requirement.

## Email

| | |
|---|---|
| `TAPROOT_MAIL_WEBHOOK_URL` | Where to POST outgoing mail |
| `TAPROOT_MAIL_WEBHOOK_TOKEN` | Sent as a bearer token, if your endpoint wants one |
| `TAPROOT_MAIL_FROM` | The From address |

See [Email](/operate/email/). With none set, Taproot writes messages to the log and hides the
features that would promise delivery.

## Scheduler

| | |
|---|---|
| `TAPROOT_CRON_SECRET` | Authenticates an external scheduler calling `POST /api/taproot/scheduler/run` |

**Not needed on Cloudflare** — the sweep is a cron trigger on the Worker itself, so nothing crosses
the network and there is nothing to authenticate. See [The scheduler](/operate/scheduler/).

## Remote D1 migrations

Only for `npm run db:migrate:remote`:

`TAPROOT_CF_ACCOUNT_ID`, `TAPROOT_CF_D1_ID`, `TAPROOT_CF_API_TOKEN`.

Keep the API token out of version control.
