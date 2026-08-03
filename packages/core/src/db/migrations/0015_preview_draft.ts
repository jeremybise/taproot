import type { Kysely } from 'kysely';

/**
 * An unsaved editor snapshot, attached to a preview token.
 *
 * The split-view preview pane needs the *form's* current state to reach the consumer, and the
 * consumer resolves a page server-side — so that state has to live somewhere the delivery API can
 * read. These columns are that somewhere.
 *
 * **They are a rendering input, not a version.** `resolvePreviewToken` is the only reader,
 * `writePreviewDraft` the only writer, and nothing may ever restore from them. They carry no status,
 * no parent, and no path; they cannot be published, listed, diffed, or recovered; they die with the
 * token, in thirty minutes. That is what keeps "a release is the only place a content item can have
 * a version that is not live" true — a release stages content that will *become* live, and this is
 * a picture of a form somebody is still typing into. The moment something reads these back into the
 * editor as recovered work, this is a draft store and Content Releases is the feature it duplicates.
 *
 * Shaped like `release_items`' four content columns on purpose: `resolvePreviewToken` already merges
 * a staged version over the live row, and this merges over *that* with the identical code.
 * `parent_id` and `status` are absent for exactly the reasons they are absent from `release_items` —
 * re-parenting is a change to the tree, and what status a page ends up in is not a question a
 * preview gets to answer.
 *
 * `draft_updated_at` is the flag for "a snapshot exists" rather than deriving it from four nullable
 * columns, which would be four chances to disagree — a snapshot whose `data` happened to be cleared
 * would read as no snapshot at all. Deliberately not named `updated_at`: `updated_at` is what a
 * version has.
 *
 * No index. The only query these ride along with is the primary-key lookup that was already there.
 */
export async function up(db: Kysely<any>): Promise<void> {
  // One `ALTER TABLE` per statement: SQLite and D1 both accept exactly one `ADD COLUMN` per
  // statement, so the batched form silently is not available here.
  await db.schema.alterTable('preview_tokens').addColumn('title', 'text').execute();
  await db.schema.alterTable('preview_tokens').addColumn('slug', 'text').execute();
  await db.schema.alterTable('preview_tokens').addColumn('data', 'text').execute();
  await db.schema.alterTable('preview_tokens').addColumn('seo', 'text').execute();
  await db.schema.alterTable('preview_tokens').addColumn('draft_updated_at', 'text').execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  for (const column of ['draft_updated_at', 'seo', 'data', 'slug', 'title']) {
    await db.schema.alterTable('preview_tokens').dropColumn(column).execute();
  }
}
