import type { Kysely } from 'kysely';

/**
 * Reusable blocks: a block instance promoted to a shared library.
 *
 * The case is a piece of content that appears on many pages and must change in one place — an
 * office's contact details, a term's key dates, an emergency notice. Copying a block onto twelve
 * pages means twelve edits and, in practice, three of them missed.
 *
 * A row here owns its `data`; an item that places it stores only a reference. That asymmetry is the
 * whole feature: an ordinary block's content belongs to the page and is versioned with it, while a
 * reusable block's content belongs to the library and changing it changes every page at once.
 *
 * `block_type` is the block type's `api_id` rather than its id, matching how block instances name
 * their type in `content_items.data`. It is a text column and not a foreign key for the same
 * reason: block instances are JSON and cannot have one either, so the block type delete path
 * checks both places rather than relying on the database in one and not the other.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('reusable_blocks')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('description', 'text')
    .addColumn('block_type', 'text', (col) => col.notNull())
    .addColumn('data', 'text', (col) => col.notNull().defaultTo('{}'))
    .addColumn('created_by', 'text', (col) => col.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'text', (col) => col.notNull())
    .addColumn('updated_at', 'text', (col) => col.notNull())
    .execute();

  // The library lists by type ("show me the reusable calls to action"), which is the only query
  // that is not a lookup by id.
  await db.schema
    .createIndex('reusable_blocks_type_idx')
    .on('reusable_blocks')
    .column('block_type')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('reusable_blocks').execute();
}
