---
title: Your CMS project
description: The folder npm create taproot made is your deployment. What to commit, what never to, and how to upgrade.
---

`npm create taproot my-cms` makes a folder that looks like scaffolding output. It isn't. **It is your
deployment, and it belongs in version control** — the rest of this page is what follows from that.

The CMS itself is not in the folder. It arrives as `@taprootcms/studio` and `@taprootcms/core` in
`node_modules`, which is why the project stays small and why upgrading is a dependency change rather
than a merge. What the folder holds is the part that is *yours*: which Cloudflare resources this
deployment uses, how it is built, and which version of Taproot is running.

## Commit it

Almost nothing in the project can be reconstructed if you lose it:

| | Why it matters |
|---|---|
| `wrangler.jsonc` | Your D1 database id, KV namespace id, R2 bucket name, and cron schedule. Derivable from nothing |
| `astro.config.mjs` | The adapter setup and the build configuration |
| `src/worker.ts` | The Worker entry, including the `scheduled` export the cron trigger reaches |
| `scripts/` | Your migrate and seed commands |
| `package-lock.json` | Exactly which version of Taproot is deployed — and therefore what to roll back to |

The deploy instructions already assume this. "Set secrets with `wrangler secret put`, never in
`wrangler.jsonc`" is advice that only means something if `wrangler.jsonc` is committed and the
secrets are not.

`git init`, commit, push. Any host will do; nothing here is GitHub-specific.

## Never commit

The generated `.gitignore` already covers both, but they are worth knowing by name because the cost
of getting them wrong is not symmetrical with everything else:

- **`.env`** — your Cloudflare API token, and any OAuth client secrets. The token can rewrite your
  database.
- **`data/*.sqlite`** — your local development database.

Check the ignore is doing its job before your first push:

```bash
git status --ignored --short | grep -E "\.env|\.sqlite"
```

They should appear as ignored. If `.env` shows up as a file to be committed instead, stop and fix
that first.

:::danger
If `.env` has already been committed at any point, removing it in a later commit **does not help** —
it is still in the history, and history is what a clone copies. Rotate the credential instead:
delete the Cloudflare API token, issue a new one, and change any OAuth secrets. Treat anything that
was ever in a pushed commit as public.
:::

## Public or private?

**Either works.** Nothing in the committed files is a credential, so a public repository is not a
leak — which is the answer to the question most people actually mean.

The resource ids in `wrangler.jsonc` are identifiers, not secrets. A D1 database id is useless
without account credentials, which is exactly why the secrets go somewhere else.

**Private is still the better default**, for a reason that has nothing to do with what is in there
today: it costs nothing, and it bounds the damage of a future mistake. The realistic risk to a CMS
deployment is not the ids — it is somebody pasting a token into `wrangler.jsonc` in a hurry two
years from now. Private turns that into an incident you can fix quietly rather than a credential you
must assume is gone.

## Upgrading Taproot

```bash
npm install @taprootcms/core@latest @taprootcms/studio@latest
npm run db:migrate:remote
npm run deploy
git commit -am "Taproot <version>"
```

The two packages **move together**. They share a version and the server imports the data layer's
internals, so a mismatched pair is a broken install rather than a supported combination.

**Migrate before deploying, not after.** For the moment between the two your old deployed code is
running against the new schema, and that is safe because migrations are additive and are never
renumbered or edited after shipping — old code simply ignores columns it does not know about. The
other order is the one that breaks: new code expecting a column that is not there yet.

Not every release adds a migration. Running `db:migrate:remote` when there is nothing to apply
prints that it is already up to date, so it costs a few seconds and removes the need to check.

Your **site** deploys independently and usually needs no coordination at all. The delivery API is
the contract between the two halves, and it is versioned by being additive rather than by a number.

## Two projects, two repositories

The CMS and the website are separate deployments, so they are separate projects — see
[Deploying](/operate/deploying/). Nothing stops you keeping both in one repository, but nothing
expects it either, and the useful property is that they can be rebuilt, redeployed, and rolled back
without reference to each other. Only one of them holds your content.
