# Deploying Taproot

Target: **Cloudflare Workers + D1 + R2**.

Written alongside the code rather than reconstructed afterwards. If a step here is wrong, that is a
bug — fix the doc in the same change as the code.

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

Copy the `database_id` into `apps/web/wrangler.jsonc`, replacing
`REPLACE_WITH_YOUR_D1_DATABASE_ID`.

**Do not rename the binding.** `DB` is what `dbConfigFromEnv()` in `@taproot/core` looks for; a
different name silently falls back to local SQLite, which in a Worker means no database at all.

---

## 2. Create the R2 bucket

```bash
npx wrangler r2 bucket create taproot-media
```

The bucket name is already in `wrangler.jsonc` as `taproot-media`. As with D1, the **binding** name
`MEDIA` is what `storageFromEnv()` looks for — change the bucket name freely, but leave the binding.

**Uploaded media needs a public URL, and this is required rather than recommended.** Nothing in
Taproot serves bytes back out of R2 — there is no `/media/*` route — so an R2 deployment resolves
image URLs only through a bucket you have exposed yourself. Attach a custom domain to the bucket in
the Cloudflare dashboard (R2 → your bucket → Settings → Public access), then set
`TAPROOT_MEDIA_URL` (step 4) to that origin.

Skip this and uploads still succeed: rows are written, the admin lists them, and every `<img>`
points at a path nothing answers. The failure is silent and looks like a broken image rather than a
missing setting.

---

## 3. Run migrations against D1

Migrations are Kysely migrations in `packages/core/src/db/migrations/`, registered in the static
map in `migrations/index.ts`. The same migrations run locally and remotely — there is no parallel
set of `.sql` files to drift out of sync.

Remote migration goes over Cloudflare's D1 REST API, which needs three values in
`apps/web/.env`:

| Variable | Where to find it |
|---|---|
| `TAPROOT_CF_ACCOUNT_ID` | Cloudflare dashboard → Workers & Pages → Account details |
| `TAPROOT_CF_D1_ID` | The `database_id` from step 1 |
| `TAPROOT_CF_API_TOKEN` | My Profile → API Tokens → Create Token, with the **D1 Edit** permission |

Then:

```bash
npm run db:migrate:remote
```

It prints each migration as it applies, and is safe to re-run — already-applied migrations are
skipped.

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

Add to the `vars` block in `apps/web/wrangler.jsonc`:

```jsonc
"vars": {
  "NODE_ENV": "production",
  "TAPROOT_ORIGIN": "https://your-domain",
  "TAPROOT_MEDIA_URL": "https://media.your-domain"
}
```

`TAPROOT_ORIGIN` must match the domain the site is actually served from — it is what OAuth redirect
URIs are built from, so a mismatch breaks sign-in.

`TAPROOT_PASSWORD_AUTH=0` turns email and password sign-in off, for a deployment that wants OAuth
exclusively. Leave it unset otherwise.

**`TAPROOT_DEV_AUTH` is retired and Taproot refuses to start while it is set.** It used to enable
password sign-in in development only. Ignoring it silently would leave anyone still setting it
believing they had scoped something they had not — and for `TAPROOT_DEV_AUTH=0`, believing they had
turned off something that is now on by default. Remove it.

---

## 5. Deploy

```bash
npm run deploy
```

That runs `astro build` (Cloudflare adapter) then `wrangler deploy`.

To check the bundle without deploying:

```bash
cd apps/web && npx astro build && npx wrangler deploy --dry-run
```

The dry run lists every binding it resolved. If `DB` or `MEDIA` is missing there, the Worker will
fail at runtime, not at deploy — check the dry-run output before shipping.

---

## 6. First sign-in, and adding people

**Email and password is the primary way in.** OAuth is optional — configure a provider in step 4
and its buttons appear alongside the form; configure none and it is password-only.

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

Passwords must be at least 12 characters. There is no composition rule, on purpose: length is what
costs an attacker something, and demanding a digit and a symbol reliably produces `Password1!`.

Sign-in is throttled — 10 failures in 15 minutes, counted per email address *and* per client IP,
so neither grinding one account nor spraying one password across many is unlimited. The lock lifts
on its own as the failures age out; there is nothing for an administrator to clear.

Anyone can turn on **two-factor authentication** from *Your account*. Sign-in then asks for a code
after the password, and ten single-use recovery codes are shown once at enrolment — the server keeps
only their hashes, so that screen is the only chance to save them.

> **Recovering a locked-out administrator.** If the only admin loses their password, generate a
> link for them from another admin account. If there is no other admin, the fallback is a direct
> database write — delete the row from `users` for a fresh start, or insert a
> `password_reset_tokens` row by hand. Taproot refuses to demote or deactivate the last active
> administrator precisely so that this stays a rare situation.
>
> The same applies to a lost authenticator: another admin cannot currently clear someone else's
> second factor from the UI, so it is `DELETE FROM totp_secrets WHERE user_id = ...` until that
> screen exists. Recovery codes are the intended answer, which is why they are worth saving.

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
same constraint recorded in `apps/web/astro.config.mjs` — it is why dev runs on Node in the first
place.

So `npm run preview` is for exercising the **runtime** — crypto, streams, anything reaching for a
Node built-in — not for clicking around a populated admin. Point it at a real remote D1 for that,
or apply migrations by hand with `wrangler d1 execute --local --file`. Local D1 state lives in
`apps/web/.wrangler/state/` and can be deleted to start over.

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

**Everything 500s right after deploy** — usually a missing `DB` binding. Run
`npx wrangler deploy --dry-run` and confirm `env.DB` is listed.

**Sign-in redirects to the provider and comes back with an error** — the registered redirect URI
does not match `TAPROOT_ORIGIN`. They must agree exactly, including scheme and any trailing path.
