import type { Kysely } from 'kysely';

/**
 * Append-only revision history for content items.
 *
 * A revision is a snapshot of the authored content *after* a save, not a diff against the previous
 * one. Diffs are computed on read, where the two versions being compared are already in hand;
 * storing them instead would make every revision depend on its predecessor surviving, which is
 * exactly the property an append-only log should not have.
 *
 * The snapshot is deliberately the authored content only — title, slug, status, data, seo — and
 * not the derived tree columns (`path`, `depth`, `position`). Those are computed from the slug and
 * the parent at write time, and a restore has to recompute them anyway so descendants and redirects
 * stay consistent. `path` is stored purely so history can show where the item lived at the time.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('revisions')
    .addColumn('id', 'text', (col) => col.primaryKey())
    // Cascade: a revision has no meaning once its item is gone, and unlike a page subtree there is
    // nothing here a human could recover by hand.
    .addColumn('content_item_id', 'text', (col) =>
      col.notNull().references('content_items.id').onDelete('cascade'),
    )
    // 1-based and monotonic per item, so "restore revision 4" is stable and means something to a
    // human. Gaps never appear because revisions are never deleted.
    .addColumn('revision_number', 'integer', (col) => col.notNull())
    .addColumn('title', 'text', (col) => col.notNull())
    .addColumn('slug', 'text', (col) => col.notNull())
    // Where the item lived when this revision was taken. Display only — a restore recomputes the
    // path rather than trusting this, since ancestors may have moved since.
    .addColumn('path', 'text', (col) => col.notNull())
    .addColumn('status', 'text', (col) => col.notNull())
    .addColumn('data', 'text', (col) => col.notNull().defaultTo('{}'))
    .addColumn('seo', 'text', (col) => col.notNull().defaultTo('{}'))
    // What produced this revision: a normal save, the item's creation, or a restore of an earlier
    // revision. A restore is itself a save, so it appends rather than rewinding the log.
    .addColumn('reason', 'text', (col) => col.notNull().defaultTo('save'))
    // Set only when `reason` is 'restore' — which revision was restored, for an audit trail.
    .addColumn('restored_from', 'integer')
    .addColumn('created_by', 'text', (col) => col.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'text', (col) => col.notNull())
    .execute();

  /**
   * The next revision number is read before the batch is built, because a batch cannot read its own
   * writes. Two saves racing on the same item would therefore compute the same number — this index
   * turns that into a failed second write rather than two revisions silently sharing a number and
   * making "restore revision 4" ambiguous forever.
   */
  await db.schema
    .createIndex('revisions_item_number_unique')
    .on('revisions')
    .columns(['content_item_id', 'revision_number'])
    .unique()
    .execute();

  // History is always read newest-first for one item.
  await db.schema
    .createIndex('revisions_item_created_idx')
    .on('revisions')
    .columns(['content_item_id', 'created_at'])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('revisions').ifExists().execute();
}
