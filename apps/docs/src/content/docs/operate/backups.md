---
title: Backups and recovery
description: What to back up, and how to get back in when something has gone wrong.
---

## Only the CMS holds anything

The site holds no data at all — no database, no uploads, one read-only API key. Losing it entirely
costs you a redeploy. **Everything worth backing up is in the CMS deployment**, which is much of the
point of the two being separate.

Two things there, and they are separate:

- **The database** — all content, revisions, users, releases, menus, taxonomies, the audit log.
  Everything except the files themselves.
- **The object store** — the uploaded files. R2 in production, a directory locally.

A database backup without the files gives you content referencing images that are gone. Back up
both.

## Backing up the database

**D1**: use Cloudflare's export. `wrangler d1 export <name> --remote --output backup.sql` produces
a file you can restore from.

**Local SQLite**: copy the file at `TAPROOT_SQLITE_PATH`, under `apps/studio`. Stop the CMS dev
server first, or you may copy it mid-write.

**Postgres**: `pg_dump`, as usual.

How often depends on how much editing you would accept losing. Revisions mean an editor can undo
their own mistakes without a restore, so backups are really for the whole-database failure — which
argues for less frequent but genuinely offsite copies.

## Backing up files

R2 has its own replication and lifecycle rules. Whether you also copy elsewhere is the usual
question of trusting one provider.

Locally, the upload directory is an ordinary directory.

## Restoring

Restore the database, restore the files, redeploy. Media rows reference storage keys, so files
restored under the same keys reconnect on their own.

If you restore only the database, images uploaded after that backup point at objects that are not
there. The admin will show them as missing rather than hiding it.

## When nobody can sign in

**Somebody forgot a password** → they use "Forgot your password?" if email is set up, or an
administrator generates a set-password link. See [People and access](/admin/users/).

**Somebody lost their two-factor device** → they use a recovery code, or an administrator clears
two-factor from their account.

**Every administrator is locked out** → this is the one with no in-product answer, which is why
Taproot refuses to demote or deactivate the last active administrator. Recovery means going to the
database and setting a user's `role` to `admin` directly. The setup screen will not help; it refuses
once any user exists.

If you administer a Taproot site, having a second administrator account is the cheapest insurance
there is.

## What the audit log gives you

Not a backup, but often the faster answer to "what happened here". It records publishing, deletions,
and access changes with who and when, and survives the deletion of whatever it describes — an entry
about a deleted page still names the page.

Retention is a sweep by age. Decide how long you want to keep entries before you need them.
