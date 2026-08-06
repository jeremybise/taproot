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

D1 refuses to export a database containing a virtual table, and Taproot has one — `content_item_fts`,
the full-text search index. Drop it, export, and recreate it:

```sql
drop table content_item_fts;
```

```bash
wrangler d1 export <name> --remote --output backup.sql
```

```sql
create virtual table content_item_fts using fts5(text);
insert into content_item_fts(rowid, text) select rowid, text from content_item_text;
```

Nothing is lost by leaving it out of the backup, and that is by design rather than luck: the index is
derived, the prose it indexes lives in `content_item_text`, which exports normally, and
`npm run db:reindex` rebuilds it from there on a restored database. What you must not do is restore a
backup and skip the rebuild — search then returns nothing, with no error to say why.

**Local SQLite**: copy the file at `TAPROOT_SQLITE_PATH`, under `apps/studio`. Stop the CMS dev
server first, or you may copy it mid-write.

**Time Travel is the one you will actually use.** D1 keeps a continuous point-in-time record and can
restore to any minute within the last 30 days (7 on the free plan) with no setup and no export step.
An export is for the things Time Travel does not cover: keeping a copy longer than the window, and
taking one off Cloudflare entirely.

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
