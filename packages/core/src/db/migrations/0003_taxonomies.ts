import { sql, type Kysely } from 'kysely';

/**
 * Taxonomies: content-type-agnostic term trees, attachable to any content type.
 *
 * Attachment needs no table of its own. A content type gets a taxonomy by having a `taxonomy`
 * field whose config names the taxonomy, which means the existing field system already carries
 * per-type configuration (required, single vs multiple) without a parallel mechanism for it.
 *
 * `taxonomy_assignments` is a **derived index**, not the source of truth. The authored value lives
 * in `content_items.data` under the field's `api_id`, like every other field, so that revisions
 * snapshot tags, validation treats them uniformly, and the API contract has one shape. The
 * assignments table is rebuilt from that value inside the same atomic batch as the item write.
 *
 * The duplication buys the one thing JSON cannot give: an indexed answer to "which items are in
 * this branch of the tree", which is exactly the query Phase 3's taxonomy-scoped permissions are
 * built on. Storing tags *only* in the join table was the alternative, and it would have made a
 * restored revision quietly lose its tags.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('taxonomies')
    .addColumn('id', 'text', (col) => col.primaryKey())
    /** Stable machine name, used in field config and API routes. Immutable after creation. */
    .addColumn('api_id', 'text', (col) => col.notNull().unique())
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('name_plural', 'text', (col) => col.notNull())
    .addColumn('description', 'text')
    /**
     * Whether terms may nest. A flat taxonomy (Tags) and a tree (Departments) differ only in
     * whether the term editor offers a parent, so this is a flag rather than two entities.
     */
    .addColumn('hierarchical', 'integer', (col) => col.notNull().defaultTo(1))
    .addColumn('created_at', 'text', (col) => col.notNull())
    .addColumn('updated_at', 'text', (col) => col.notNull())
    .execute();

  await db.schema
    .createTable('terms')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('taxonomy_id', 'text', (col) =>
      col.notNull().references('taxonomies.id').onDelete('cascade'),
    )
    /**
     * Self-referential parent. `set null` rather than `cascade`, matching content items: orphaning
     * a branch is recoverable by hand, silently deleting a department's whole subtree is not.
     */
    .addColumn('parent_id', 'text', (col) => col.references('terms.id').onDelete('set null'))
    .addColumn('slug', 'text', (col) => col.notNull())
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('description', 'text')
    /**
     * Depth and position are stored; a materialised path deliberately is not.
     *
     * Content items need one because a request URL has to resolve in a single indexed lookup on
     * the hot path. Terms have no public URL in Phase 1, and their only tree query — "this term
     * and its descendants" — is a recursive CTE that runs off `parent_id` alone. Adding a path
     * would mean a second cascading-rewrite implementation to keep correct for no read it serves.
     */
    .addColumn('depth', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('position', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('created_at', 'text', (col) => col.notNull())
    .addColumn('updated_at', 'text', (col) => col.notNull())
    .execute();

  /**
   * Term slugs are unique among siblings within one taxonomy, not globally — so a "Graduate" term
   * can exist under both Admissions and Programs.
   *
   * Two partial indexes for the same reason content items need them: SQLite has no
   * NULLS NOT DISTINCT, so under a plain unique index every root term (parent_id IS NULL) would
   * compare unequal to every other and collide with nothing.
   */
  await sql`
    CREATE UNIQUE INDEX terms_parent_slug_unique
    ON terms (taxonomy_id, parent_id, slug)
    WHERE parent_id IS NOT NULL
  `.execute(db);

  await sql`
    CREATE UNIQUE INDEX terms_root_slug_unique
    ON terms (taxonomy_id, slug)
    WHERE parent_id IS NULL
  `.execute(db);

  await db.schema
    .createIndex('terms_taxonomy_idx')
    .on('terms')
    .columns(['taxonomy_id', 'parent_id', 'position'])
    .execute();

  await db.schema
    .createTable('taxonomy_assignments')
    .addColumn('content_item_id', 'text', (col) =>
      col.notNull().references('content_items.id').onDelete('cascade'),
    )
    .addColumn('term_id', 'text', (col) => col.notNull().references('terms.id').onDelete('cascade'))
    /**
     * Which field produced this row. An item can carry two taxonomy fields pointing at the same
     * taxonomy — "Primary department" and "Also relevant to" — and without this they would be
     * indistinguishable once flattened, so rebuilding one field's rows would clobber the other's.
     */
    .addColumn('field_api_id', 'text', (col) => col.notNull())
    .addPrimaryKeyConstraint('taxonomy_assignments_pk', [
      'content_item_id',
      'field_api_id',
      'term_id',
    ])
    .execute();

  // The Phase 3 query: every item tagged with any term in a branch.
  await db.schema
    .createIndex('taxonomy_assignments_term_idx')
    .on('taxonomy_assignments')
    .column('term_id')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('taxonomy_assignments').ifExists().execute();
  await db.schema.dropTable('terms').ifExists().execute();
  await db.schema.dropTable('taxonomies').ifExists().execute();
}
