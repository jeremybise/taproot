---
title: Settings and environment
description: Every environment variable Taproot reads, and what happens when each is unset.
---

Configuration is environment variables. In development they come from a `.env` file; in production
from your platform's secrets. Real environment variables always win over the file.

**There are two deployments and two files**, and almost everything belongs to the first:

| | File | What it configures |
|---|---|---|
| **The CMS** (`apps/studio`) | `apps/studio/.env` | Database, storage, sign-in, mail, the scheduler |
| **The site** (`apps/web`) | `apps/web/.env` | Two variables: where the CMS is, and a key |

If a variable is not in the site's short list at the bottom of this page, it belongs to the CMS.

**Settings → System** in the admin shows what the CMS actually resolved, which is usually faster
than reading a config file over somebody's shoulder.

---

# The CMS

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
| `TAPROOT_SQLITE_PATH` | Local SQLite file, relative to `apps/studio`. Created automatically |

On Cloudflare, the D1 binding takes over and this is not read. A `DATABASE_URL` naming a Postgres
database **throws on startup** rather than being ignored — Taproot has no Postgres driver, and
falling back to a local file would let a deployment look healthy while writing every page somewhere
nobody is backing up.

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

## Where the site is

| | |
|---|---|
| `TAPROOT_SITE_URL` | Origin of the site that reads this content |

Used for preview: the admin's preview button mints a short-lived token and redirects to this
origin carrying it, and the item editor's **live preview pane** frames the same origin.

Unset, an editor pressing that button is told the CMS does not know where to send them, and the pane
says the same rather than framing nothing — which is a clearer failure than a redirect to a 404 on
the CMS's own origin, and the reason it is checked rather than guessed.

## Scheduler

| | |
|---|---|
| `TAPROOT_CRON_SECRET` | Authenticates an external scheduler calling `POST /api/taproot/scheduler/run` |

**Not needed on Cloudflare** — the sweep is a cron trigger on the Worker itself, so nothing crosses
the network and there is nothing to authenticate. See [The scheduler](/operate/scheduler/).

## Remote D1 migrations

| | |
|---|---|
| `TAPROOT_CF_ACCOUNT_ID` | Workers & Pages → Account details, or the hex string in your dashboard URL |
| `TAPROOT_CF_D1_ID` | The `database_id` already in `wrangler.jsonc` |
| `TAPROOT_CF_API_TOKEN` | A **custom** token carrying `Account` · `D1` · `Edit` |

**These three are the exception to the rule at the top of this page.** Everything else here is read
by the running CMS, so in production it comes from your platform's secrets. These are read only by
`npm run db:migrate:remote`, a Node script on your own machine — so they live in a local `.env` in
every environment, including production, and `wrangler secret put` is the wrong home for them. The
deployed Worker never reads `TAPROOT_CF_*` at all.

Keep the API token out of version control, and out of the Worker: it can rewrite the database, and
nothing in the runtime has any use for it.

---

# The site

Two variables, and that is genuinely all of it. The site holds no database credentials, because it
has no database.

| | |
|---|---|
| `TAPROOT_API_URL` | Origin of the CMS: `https://cms.example.edu` |
| `TAPROOT_API_KEY` | An API key with the `content:read` scope |

Create the key in the CMS under **Settings → API keys**; it is shown exactly once. See
[API keys](/admin/api-keys/).

`TAPROOT_API_KEY` is **optional against a local CMS**, where a signed-in session reaches the
delivery endpoints too — which is what makes opening a delivery URL in a browser to see exactly what
the site receives possible while debugging. A deployed site needs a real key.

The same two variables are read by `npm run taproot:types`, which generates TypeScript for your
content model by reading the **live** schema over HTTP rather than out of the database. That is
deliberate: the generator exercises the same contract the site uses, so the types describe what the
site actually receives.

## Why the split is this lopsided

Everything that can leak, expire, or be misconfigured — database credentials, OAuth secrets, a mail
webhook, storage bindings — belongs to the CMS. A site is a front end holding one scoped read
credential, so a compromised site cannot edit content, and redeploying or replacing it touches none
of the configuration above.
