import type { Kysely } from 'kysely';

/**
 * Cross-origin preview.
 *
 * `?preview=1` worked only because the site and the CMS shared an origin, so the admin's session
 * cookie came along — the check was on the session, never on the parameter. Once the site is a
 * separate deployment that cookie is not sent, and there is nothing to check.
 *
 * A row rather than a signed token, following `login_challenges` for the same reasons: it has to be
 * revocable and short-lived, and a self-contained signed value stays valid however the account
 * changes underneath it. It also avoids inventing a signing secret, which would need a default to
 * keep `npm run dev` working and a default signing secret is not a secret.
 *
 * `id` is the SHA-256 of the token, as everywhere else, so the raw value exists only in the link.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('preview_tokens')
    .addColumn('id', 'text', (col) => col.primaryKey())
    /** The item being previewed. Cascades: a preview of a deleted page has nothing to show. */
    .addColumn('content_item_id', 'text', (col) =>
      col.notNull().references('content_items.id').onDelete('cascade'),
    )
    /**
     * The release whose staged version to show, or null for the item's own current content.
     *
     * One token mechanism covering both, deliberately. Phase 3.5 added a second thing worth
     * previewing — the version waiting inside a release — and building a separate token for it is
     * how the two drift until one of them stops checking something.
     */
    .addColumn('release_id', 'text', (col) => col.references('releases.id').onDelete('cascade'))
    /** Who asked. A preview shows unpublished content, so the log should say whose link it was. */
    .addColumn('created_by', 'text', (col) => col.references('users.id').onDelete('set null'))
    .addColumn('expires_at', 'text', (col) => col.notNull())
    .addColumn('created_at', 'text', (col) => col.notNull())
    .execute();

  // The only query besides the primary-key lookup is the expiry sweep.
  await db.schema
    .createIndex('preview_tokens_expires_idx')
    .on('preview_tokens')
    .column('expires_at')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('preview_tokens').execute();
}
