# Deploying Taproot

Target for the CMS: **Cloudflare Workers + D1 + R2**.

Written alongside the code rather than reconstructed afterwards. If a step here is wrong, that is a
bug — fix the doc in the same change as the code.

## Two deployments

Taproot is a CMS server and a site that reads from it over HTTP. They deploy separately and the
order matters, because the site needs a key the CMS issues.

| | Directory | Holds | Needs |
|---|---|---|---|
| **CMS** | `apps/studio` | The database, uploads, the admin, the scheduler | D1, R2, a cron trigger |
| **Site** | `apps/web` | Nothing | `TAPROOT_API_URL` and `TAPROOT_API_KEY` |

**Steps 1–5 below are the CMS.** The site is step 6 and is three lines of configuration, because it
has no database and no secrets beyond one scoped read key. Everything that can leak or expire lives
on the CMS side, which is much of the point of the split.

Several sites can read one CMS — each just needs its own key.

---

## Before you start

You need:

- Node 22.12 or newer (`node --version`)
- A Cloudflare account
- `wrangler` — already a dev dependency, so `npx wrangler` works without a global install

Sign in once:

```bash
npx wrangler login
```

---

## 1. Create the D1 database

```bash
npx wrangler d1 create taproot
```

It prints something like:

```
[[d1_databases]]
binding = "DB"
database_name = "taproot"
database_id = "a1b2c3d4-...."
```

Copy the `database_id` into `apps/studio/wrangler.jsonc`, replacing
`REPLACE_WITH_YOUR_D1_DATABASE_ID`.

**Do not rename the binding.** `DB` is what `dbConfigFromEnv()` in `@taprootcms/core` looks for; a
different name silently falls back to local SQLite, which in a Worker means no database at all.

---

## 2. Create the R2 bucket

```bash
npx wrangler r2 bucket create taproot-media
```

The bucket name is already in `wrangler.jsonc` as `taproot-media`. As with D1, the **binding** name
`MEDIA` is what `storageFromEnv()` looks for — change the bucket name freely, but leave the binding.

**Do not give the bucket a public URL unless you have read step 2c.** Media works without one: image
URLs default to `/api/taproot/media/file/…`, a route that reads the object out of R2 and serves it.
That used to default to `/media`, which nothing served — so skipping this step produced uploads that
succeeded, rows that listed, and every `<img>` pointing at a 404, a configuration gap presenting as a
broken picture.

A custom domain on the bucket serves from Cloudflare's edge with no Worker invocation even on a cold
cache, which is faster — but it **turns image resizing off**, because the resizing lives in the route
it bypasses. Step 2c is the trade-off in full.

---

## 2c. Add the Images binding

```jsonc
// apps/studio/wrangler.jsonc
"images": {
  "binding": "IMAGES"
}
```

That is the whole setup. **Nothing to create, and no domain of your own** — it works on a
`workers.dev` subdomain. Cloudflare's free allowance is 5,000 unique transformations a month, counted
per image per size, and a cached one is not re-billed.

With it, the media route resizes on the way out, so a visitor on a phone is not sent the 2000-pixel
photograph an editor uploaded. Without it nothing breaks — the stored original is served, so pages
are heavier and never wrong. That is also why local development on Node needs nothing here.

**This and `TAPROOT_MEDIA_URL` are mutually exclusive, and nothing warns you.** Pointing that at an
R2 custom domain makes media bypass the Worker route — the whole point of it — and the resizing lives
*in* that route, so setting it silently returns to serving full-size originals. Pick one:

| | Images binding | R2 custom domain |
|---|---|---|
| Needs a zone on your account | No | Yes |
| Resizing | Yes | Only via `/cdn-cgi/image/`, which needs the zone too |
| Worker invocation per image | Cold cache only | Never |

The binding is the right default and what `create-taproot` writes. Revisit it when you have a real
domain and enough traffic for cold-cache invocations to matter.

---

## 2b. Create the KV namespace

```bash
npx wrangler kv namespace create taproot-session
```

Paste the id it prints into `wrangler.jsonc` under `kv_namespaces`, replacing
`REPLACE_WITH_YOUR_KV_NAMESPACE_ID`.

**Taproot does not use this**, which is worth saying plainly: sign-in sessions are rows in the
database, not Astro sessions. `@astrojs/cloudflare` injects a `SESSION` KV binding regardless, and
injects it with **no id** — so if you skip this step `wrangler deploy` quietly creates a namespace
for you. That is not a disaster, but it is a resource you did not choose, and it makes a failed
deploy unretryable: the first run provisions the namespace, and if anything later in the same run
fails, the second run asks for a title that now exists and Cloudflare refuses it with `a namespace
with this account ID and title already exists` (error 10014) — which reads like a Taproot bug rather
than a half-finished first attempt. Declaring the id up front avoids the whole sequence.

---

## 3. Run migrations against D1

Migrations are Kysely migrations in `packages/core/src/db/migrations/`, registered in the static
map in `migrations/index.ts`. The same migrations run locally and remotely — there is no parallel
set of `.sql` files to drift out of sync.

Remote migration runs **on your machine**, not in the Worker: `npm run db:migrate:remote` is a Node
script that talks to Cloudflare's D1 REST API directly. Its three values therefore go in a local
`.env` file — `apps/studio/.env` in this repository, or the **project root** in a project scaffolded
by `npm create taproot`, since that is where `scripts/_env.ts` reads from.

> **These are not `wrangler secret put` values**, and mistaking them for such is the easiest thing
> on this page to get wrong — step 4 below does use that command, immediately after this step does
> not. `wrangler secret put` sets runtime secrets for the deployed Worker, and nothing in the Worker
> ever reads `TAPROOT_CF_*`; the migration has finished before the Worker exists. As secrets the two
> ids are simply inert, and the token is worth actively keeping out — it can rewrite the database and
> has no reason to be in the runtime.

| Variable | Where to find it |
|---|---|
| `TAPROOT_CF_ACCOUNT_ID` | Workers & Pages → Account details, or the hex string in your dashboard URL |
| `TAPROOT_CF_D1_ID` | The `database_id` from step 1 — the same value you pasted into `wrangler.jsonc` |
| `TAPROOT_CF_API_TOKEN` | Created by hand; see below |

**Creating the API token.** The ready-made templates do not dependably carry D1, so make a custom
one:

1. **dash.cloudflare.com/profile/api-tokens** → **Create Token**
2. Scroll past the templates to **Create Custom Token** → *Get started*
3. Permissions: **Account** · **D1** · **Edit**
4. Account Resources: **Include** → the account holding your D1 database
5. **Create Token**, then copy it — Cloudflare shows it once

**Edit, not Read.** The endpoint Taproot calls is a query endpoint that writes, so a Read token
authenticates successfully and then fails on the first migration.

Then:

```bash
npm run db:migrate:remote
```

It prints each migration as it applies, and is safe to re-run — already-applied migrations are
skipped.

### After `0019_item_values` and `0021_item_text`, reindex once

`0019` adds `content_item_values`, the derived index that lets a listing filter and order by a value
inside an item's own field data — an event's start date rather than its publish date. `0021` adds
`content_item_text`, the flattened copy of each item's prose that search reads. Each migration
creates its table **empty**, and cannot fill it: doing so needs every content type's field
definitions and a walk over each item's stored JSON, which is application knowledge rather than
schema knowledge.

```bash
npm run db:reindex
```

One command rebuilds both. Until it has run, any `query` field that filters or orders by a field
value answers as though nothing matched, and search finds an item by its title and by nothing else —
the content is intact and simply not indexed yet. It is safe to re-run at any time, since it rebuilds
from `content_items.data`, which remains the source of truth. New and edited items index themselves
as part of the same write, so this is a one-off for content that already existed.

**Settings → System says whether it is needed.** Under *Search index* it reports how many content
items have never been indexed; anything above zero on a database with content in it means this has
not been run. That number does not fall on its own — nothing sweeps it — and the symptom without it
is a search returning less than it should, with no error anywhere.

> Only needed on a database that already had content when the migration was applied. A fresh
> deployment has nothing to backfill, and `npm run db:seed` indexes what it creates.

**A 400 reading "not authorized" is usually about the account, not the token.** Cloudflare answers
that way when the token is valid but has no D1 access *for that account id* — either
`TAPROOT_CF_ACCOUNT_ID` is wrong, or the token's Account Resources point at a different account. If
both ids are right, the permission is Read rather than Edit. Listing the databases the token can
actually see (`GET /accounts/{id}/d1/database`) settles which it is in one request.

> Keep `TAPROOT_CF_API_TOKEN` out of version control. `.env` is gitignored; in CI, set it as a
> secret.

---

## 4. Configure secrets and variables

### Secrets (never in `wrangler.jsonc`)

Nothing here is required: email and password sign-in works with no secrets at all. Configure a
provider only if you want OAuth *as well*.

**The app refuses to boot with no sign-in method configured at all** — which now means only the
deliberate combination of `TAPROOT_PASSWORD_AUTH=0` and no provider. That is a locked building, and
it is cheaper to say so at startup than at a login page with no buttons on it.

```bash
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
```

Google and Microsoft use `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` and
`MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` (plus optionally `MICROSOFT_TENANT`, which
defaults to `common`).

The OAuth redirect URI to register with each provider is:

```
https://your-domain/api/taproot/auth/callback/<provider>
```

…where `<provider>` is `github`, `google`, or `microsoft`.

### Plain variables

Add to the `vars` block in `apps/studio/wrangler.jsonc`:

```jsonc
"vars": {
  "NODE_ENV": "production",
  "TAPROOT_ORIGIN": "https://your-domain"
}
```

`TAPROOT_MEDIA_URL` is deliberately absent. Set it only if you chose an R2 custom domain over the
Images binding in step 2c — it turns resizing off, silently.

`TAPROOT_ORIGIN` must match the domain the site is actually served from — it is what OAuth redirect
URIs are built from, so a mismatch breaks sign-in.

`TAPROOT_PASSWORD_AUTH=0` turns email and password sign-in off, for a deployment that wants OAuth
exclusively. Leave it unset otherwise.

**`TAPROOT_DEV_AUTH` is retired and Taproot refuses to start while it is set.** It used to enable
password sign-in in development only. Ignoring it silently would leave anyone still setting it
believing they had scoped something they had not — and for `TAPROOT_DEV_AUTH=0`, believing they had
turned off something that is now on by default. Remove it.

---

## 4b. Scheduled publishing

Scheduling a **page** works with no configuration: it goes live for visitors at its scheduled moment
whether or not anything is running, because visibility is computed when the page is requested.

What a scheduler adds is the *record* catching up — the status turning from Scheduled to Published,
and `published_at` being stamped. Without one, the admin keeps saying "scheduled" about a page the
public can already see, and offers a button to reconcile it by hand.

> **A scheduled Content Release is the exception, and it is not a cosmetic one.** A release's
> content lives in `release_items` and has to be *applied* when its moment arrives — paths
> recalculated, redirects written, revisions appended — which no page request can do. With nothing
> running the sweep, a scheduled release simply does not publish.
>
> If anyone on the site intends to schedule a release, confirm the sweep is running before they rely
> on it. **Settings → System** reports releases waiting, releases past their time, and releases the
> sweep reached and refused.

**On Cloudflare this is already wired and needs no configuration.** `wrangler.jsonc` carries a cron
trigger, and `apps/studio/src/worker.ts` is the Worker entry that handles it:

```jsonc
"main": "./src/worker.ts",
"triggers": { "crons": ["*/5 * * * *"] }
```

```ts
import { handle } from '@astrojs/cloudflare/handler';
import { scheduled } from '@taprootcms/studio/runtime/worker';

export default { fetch: handle, scheduled };
```

That works because `@astrojs/cloudflare` only fills in `main` when the wrangler config does not, and
the entry it would have supplied is exactly `{ fetch: handle }`. Naming your own costs nothing and
adds the `scheduled` export a cron trigger needs. This used to say the adapter made that impossible;
it does not.

The sweep also clears expired sessions, spent reset links, and aged-out sign-in attempts, so those
tables stop growing on their own.

### Anywhere else

Without Cloudflare's cron there is no in-process timer, so point an external scheduler at the
endpoint and give it a secret — the endpoint is public, and publishing content is not something a
public URL should do unauthenticated:

```bash
npx wrangler secret put TAPROOT_CRON_SECRET   # or set it however your host takes secrets
```

```
POST https://your-domain/api/taproot/scheduler/run
Authorization: Bearer <TAPROOT_CRON_SECRET>
```

It is idempotent — running it twice publishes nothing the second time, because each item and each
release is claimed conditionally — so a scheduler that retries on timeout cannot double-publish.
Every fifteen minutes is plenty for items; if you schedule releases, match the interval to how
precise "goes live at 9am" needs to be, since a release publishes only when the sweep reaches it.

An admin can also run it by hand from the content list, and **Settings → System** reports how many
items are waiting, how many are overdue, how many releases are waiting, overdue, or blocked, and
when the sweep last published anything.

A release that fails its pre-flight check during an unattended sweep is marked **Blocked** and is
not retried — retrying broken content every few minutes with nobody watching would fill the audit
log and fix nothing. The blocked count on Settings → System is the signal that somebody is needed.

---

## 5. Deploy

```bash
npm run deploy
```

That runs `astro build` (Cloudflare adapter) then `wrangler deploy`.

To check the bundle without deploying:

```bash
cd apps/studio && npx astro build && npx wrangler deploy --dry-run
```

The dry run lists every binding it resolved. If `DB` or `MEDIA` is missing there, the Worker will
fail at runtime, not at deploy — check the dry-run output before shipping.

---

## 6. First sign-in, and adding people

**Email and password is the primary way in.** OAuth is optional — configure a provider in step 4
and its buttons appear alongside the form; configure none and it is password-only.

The CMS deployment serves the admin and the API and nothing else, so **its root redirects to
`/admin`** — the hostname on its own is a working address, and you do not have to hand anyone a
path. It is a 302 rather than a 301 on purpose: `adminPath` is configurable, and a permanent
redirect would stay cached in browsers after an operator moved the admin.

A fresh deployment has no accounts, so **`/admin` sends you to a one-time setup screen** that
creates the first administrator and signs you in. It disables itself the moment any account exists,
and the check is inside the same SQL statement that does the insert, so two people hitting it
together cannot both become admin.

That does mean the window between deploying and completing setup is a window in which whoever
reaches the URL first becomes the administrator. **Deploy and complete setup before announcing the
URL**, exactly as with the OAuth land-grab it replaces.

After that, add people from **Settings → Users & access**. You never choose anyone's password: you
create the account and get a one-time link to send them, and they set their own. The link works
once, expires after 48 hours, and is shown only on the page that generated it — mint a new one if
it goes astray.

If you have configured outgoing email (below), people can also request their own link from the
**Forgot your password?** link on the sign-in form, and no administrator is involved. Without a
mailer that link is not shown at all, and the admin-generated one is the only route.

Passwords must be at least 12 characters. There is no composition rule, on purpose: length is what
costs an attacker something, and demanding a digit and a symbol reliably produces `Password1!`.

Sign-in is throttled — 10 failures in 15 minutes, counted per email address *and* per client IP,
so neither grinding one account nor spraying one password across many is unlimited. The lock lifts
on its own as the failures age out; there is nothing for an administrator to clear.

Anyone can turn on **two-factor authentication** from *Your account*. Sign-in then asks for a code
after the password, and ten single-use recovery codes are shown once at enrolment — the server keeps
only their hashes, so that screen is the only chance to save them.

> **Recovering a locked-out administrator.** If the only admin loses their password, they can use
> **Forgot your password?** where email is configured, or another admin can generate a link. If
> there is no other admin *and* no mailer, the fallback is a direct database write — delete the row
> from `users` for a fresh start, or insert a `password_reset_tokens` row by hand. Taproot refuses
> to demote or deactivate the last active administrator precisely so that this stays rare.
>
> A lost authenticator is easier: any admin can **Clear two-factor** for someone else from
> Settings → Users & access, which is logged. Recovery codes remain the first answer, which is why
> they are worth saving.

---

## 6b. Outgoing email

Taproot sends exactly one message — the self-service password reset link — and **needs no mail
service to run**. With nothing configured it writes that message to the server log, which is what
keeps `npm run dev` working from a fresh clone, and the *Forgot your password?* link is hidden so
nobody is promised a message that will not arrive.

**No provider is built in**, deliberately: Resend, Postmark, SES and SendGrid each have their own
payload shape and error semantics, and a CMS that ships no block templates should not be
maintaining four mail adapters. Instead, point Taproot at an endpoint of yours:

```bash
npx wrangler secret put TAPROOT_MAIL_WEBHOOK_URL
npx wrangler secret put TAPROOT_MAIL_WEBHOOK_TOKEN   # optional
npx wrangler secret put TAPROOT_MAIL_FROM            # optional, passed through
```

It POSTs flat JSON and expects any 2xx:

```json
{ "from": "cms@example.edu", "to": "someone@example.edu",
  "subject": "Reset your password on cms.example.edu",
  "text": "…", "html": "…" }
```

Forwarding that to your sender is a few lines in a Worker, a Lambda, or an automation tool. A
non-2xx is treated as a failure and logged; the person at the form is still told to check their
inbox, because saying otherwise would reveal that their address has an account here.

**Settings → System** reports which mailer is live and whether it delivers.

Requests are rate-limited to 5 per address and per IP per 15 minutes, counted separately from
sign-in attempts — otherwise anyone could lock a colleague out of signing in by repeatedly asking
to reset their password.

## 6c. Deploy the site

The site is an ordinary Astro app. It needs two variables and nothing else:

```
TAPROOT_API_URL=https://your-cms-domain
TAPROOT_API_KEY=tpr_...
```

Create the key in the admin under **Settings → API keys**, with the `content:read` scope. It is
shown exactly once — `id` is its hash, so there is nothing to read it back from.

Then, on the **CMS**, set `TAPROOT_SITE_URL` to the site's origin. That is what preview links are
built from, and what the item editor's live preview pane frames; without it an editor opening a
preview is told the CMS does not know where to send them.

On Cloudflare it belongs in `vars` in the CMS's `wrangler.jsonc`, **not** `wrangler secret put`:

```jsonc
"vars": {
  "NODE_ENV": "production",
  "TAPROOT_SITE_URL": "https://www.example.edu"
}
```

An origin is not a credential, so there is nothing to encrypt — and committing it is what makes it
survive, since `wrangler deploy` replaces the Worker's `vars` with exactly what that file holds and
deletes anything added in the dashboard.

Note that `npx wrangler secret list` returning `[]` on the CMS is normal and says nothing about this:
secrets and `vars` are separate lists, and a CMS with no email webhook configured has no secrets at
all. The CMS never holds `TAPROOT_API_KEY` — it issues keys and stores only their hash, so that one
belongs to the site.

One thing to check on the **site** if the preview pane comes up blank: nothing in Taproot or in
Astro sends a framing header, but a WAF, CDN rule, or security-headers middleware in front of the
site may add `X-Frame-Options: SAMEORIGIN`, which stops the CMS framing it. That has to be removed
where it is added — a `Content-Security-Policy` from the app cannot loosen it. `apps/web` sets
`frame-ancestors` explicitly under preview as the worked example.

```bash
npm run build --workspace=@taprootcms/web
```

Deploy the result wherever you already deploy Astro — Node, Workers, a container. It holds no
database credentials, so a compromised site cannot edit content.

Optionally generate types for it:

```bash
TAPROOT_API_URL=https://your-cms-domain TAPROOT_API_KEY=tpr_... npm run taproot:types
```

That reads the live content model over the delivery API and writes `apps/web/src/content.d.ts`,
which is checked in — so a schema change shows as a reviewable diff and anything renamed stops
compiling.

---

## Verifying against real Workers locally

`npm run dev` uses Node and a local SQLite file — fast, zero-setup, and what you want most of the
time (see "Why dev is Node" in the README).

To exercise the actual Workers runtime with real local D1 and R2 emulation:

```bash
npm run preview
```

That builds with the Cloudflare adapter and serves it through `wrangler dev`. Worth doing before a
release, and whenever you touch anything that behaves differently on workerd — crypto, streams,
or anything reaching for a Node built-in.

**The local D1 database is separate from the dev SQLite file, starts empty, and there is no
supported way to migrate or seed it.** `npm run db:migrate` targets the local SQLite file, and
`db:migrate:remote` goes over the D1 REST API to a deployed database; neither can reach Miniflare's
emulated D1, whose file lives at an internal path the scripts cannot reliably write to. That is the
same constraint recorded in `apps/studio/astro.config.mjs` — it is why dev runs on Node in the first
place.

So `npm run preview` is for exercising the **runtime** — crypto, streams, anything reaching for a
Node built-in — not for clicking around a populated admin. Point it at a real remote D1 for that,
or apply migrations by hand with `wrangler d1 execute --local --file`. Local D1 state lives in
`apps/studio/.wrangler/state/` and can be deleted to start over.

There is likewise **no production seeding path**: `npm run db:seed` writes to the local SQLite file
and the local upload directory. A fresh deployment therefore has no content types at all, and the
first admin builds them through the admin UI.

---

## Upgrading the schema later

1. Add `packages/core/src/db/migrations/000N_description.ts` exporting `up` and `down`.
2. Register it in the map in `migrations/index.ts` — discovery is a static map because a Worker
   bundle has no filesystem to scan.
3. `npm run db:migrate` locally, then `npm run db:migrate:remote`.
4. Deploy.

Never edit a migration that has already been applied anywhere. Add a new one.

---

## Troubleshooting

**"No authentication method is configured"** — `TAPROOT_PASSWORD_AUTH=0` with no OAuth provider
set. See step 4.

**"TAPROOT_DEV_AUTH is no longer used"** — remove that variable. See step 4.

**`/admin` keeps redirecting to `/admin/setup`** — the `users` table is empty. Either complete
setup, or check you are pointing at the database you think you are.

**"Too many sign-in attempts"** — the throttle. It clears itself within 15 minutes; there is no
administrative unlock, by design.

**Media uploads succeed but images 404** — the R2 bucket has no public URL, or `TAPROOT_MEDIA_URL`
does not point at it. See step 2.

**Images render but are never resized** — either the `IMAGES` binding is missing (step 2c; check
`npx wrangler deploy --dry-run` lists `env.IMAGES`), or `TAPROOT_MEDIA_URL` is set and media is
bypassing the route that does the resizing. Confirm by requesting a variant directly:
`curl -sI '<image url>?w=320&f=webp'` should answer `content-type: image/webp` and a much smaller
`content-length`. Note it can legitimately answer the original for a minute after a deploy while the
new version rolls out — and because the response is `immutable`, a request made *during* a rollout
can cache the old answer under the new URL. Wait for the rollout before testing a variant URL.

**A resized image is bigger than the original** — you are on `@taprootcms/core` older than 0.1.20,
which never set an encoding quality and let the binding encode near-lossless. Upgrade.

**Everything 500s right after deploy** — usually a missing `DB` binding. Run
`npx wrangler deploy --dry-run` and confirm `env.DB` is listed.

**Sign-in redirects to the provider and comes back with an error** — the registered redirect URI
does not match `TAPROOT_ORIGIN`. They must agree exactly, including scheme and any trailing path.
