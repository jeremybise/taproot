# Deploying Taproot

Target: **Cloudflare Workers + D1 + R2**.

Written alongside the code rather than reconstructed afterwards, so it should be accurate as of
Phase 0. If a step here is wrong, that is a bug — fix the doc in the same change as the code.

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

Uploaded media needs a public URL. Either attach a custom domain to the bucket in the Cloudflare
dashboard (R2 → your bucket → Settings → Public access), or serve it through a Worker route. Then
set `TAPROOT_MEDIA_URL` (step 4) to that origin. Without it, media rows exist but their URLs will
not resolve.

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

At least one OAuth provider is required. **The app refuses to boot in production with no sign-in
method configured** — that is deliberate, so a deployment cannot silently end up unreachable.

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

**Never set `TAPROOT_DEV_AUTH` in production.** It enables password sign-in, and the app will
refuse to start rather than run with it enabled outside development. That failure is the intended
behaviour, not something to work around.

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

## 6. First sign-in

The **first person to sign in via OAuth on an empty database becomes an admin.** After that,
everyone starts as a `viewer` and is promoted by an existing admin.

So: deploy, then sign in immediately. If someone else signs in first, they get the admin account.
On a public domain, deploy and claim the first account before announcing the URL.

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

The local D1 database is separate from the dev SQLite file and starts empty. Seed it with:

```bash
cd apps/web && npx wrangler d1 execute taproot --local --command "SELECT 1"
```

…to create it, then apply migrations through the preview server. Local D1 state lives in
`apps/web/.wrangler/state/` and can be deleted to start over.

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

**"No authentication method is configured"** — production with no OAuth secrets set. See step 4.

**"TAPROOT_DEV_AUTH=1 is set but NODE_ENV is not development"** — working as intended. Unset it.

**Media uploads succeed but images 404** — the R2 bucket has no public URL, or `TAPROOT_MEDIA_URL`
does not point at it. See step 2.

**Everything 500s right after deploy** — usually a missing `DB` binding. Run
`npx wrangler deploy --dry-run` and confirm `env.DB` is listed.

**Sign-in redirects to the provider and comes back with an error** — the registered redirect URI
does not match `TAPROOT_ORIGIN`. They must agree exactly, including scheme and any trailing path.
