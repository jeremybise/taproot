import type { Kysely } from 'kysely';

/**
 * Content Releases: a named batch of staged content that goes live together.
 *
 * The feature this table exists for is "tuition changes across a dozen live pages, all at 9am on
 * the same day". Until now Taproot had nowhere to put that: `content_items` holds exactly one row
 * per item, so editing a published page changed what the public saw at the moment of the save.
 * There was no pending version, and therefore nothing to coordinate.
 *
 * `release_items` is that pending version. It carries its own `title`, `slug`, `data`, and `seo`
 * rather than pointing at a revision, and the distinction is load-bearing: revisions are an
 * append-only record of what the *live* item has been, so staging by reference would mean every
 * edit to a not-yet-live version wrote a line into the history of a page that never showed it.
 * A staged version is editable and belongs to the release; a revision is frozen and belongs to the
 * item.
 *
 * `parent_id` is deliberately not staged, matching what revisions capture. Re-parenting is a
 * structural change to the tree rather than a change to a page's content, and staging it would mean
 * a release could rearrange the site's hierarchy as a side effect of a copy change. A staged `slug`
 * *is* captured, because it is authored alongside the title — publishing one cascades paths and
 * writes redirects through the ordinary update path, exactly as renaming would.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('releases')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('description', 'text')
    /**
     * `open` → being assembled. `scheduled` → waiting for `publish_at`. `published` → every staged
     * version landed. `blocked` → a scheduled publish reached its moment and pre-flight refused it.
     *
     * `blocked` exists for the unattended case only. A release that fails pre-flight while somebody
     * is looking at the screen just shows them the reasons and stays as it was; one that fails at
     * 3am has nobody to tell, and leaving it `scheduled` would retry it against the same broken
     * content every sweep, forever, writing an audit entry each time.
     */
    .addColumn('status', 'text', (col) => col.notNull().defaultTo('open'))
    /** When a `scheduled` release should go live. Same split as `content_items.publish_at`. */
    .addColumn('publish_at', 'text')
    .addColumn('published_at', 'text')
    .addColumn('created_by', 'text', (col) => col.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'text', (col) => col.notNull())
    .addColumn('updated_at', 'text', (col) => col.notNull())
    .execute();

  /**
   * The sweep's only query is "scheduled releases whose time has come", and it runs on a timer
   * against every row. Indexed together for the same reason `content_items.publish_at` is.
   */
  await db.schema
    .createIndex('releases_publish_at_idx')
    .on('releases')
    .columns(['status', 'publish_at'])
    .execute();

  await db.schema
    .createTable('release_items')
    .addColumn('id', 'text', (col) => col.primaryKey())
    /** A staged version has no meaning without its release, so it goes when the release goes. */
    .addColumn('release_id', 'text', (col) =>
      col.notNull().references('releases.id').onDelete('cascade'),
    )
    /**
     * Cascaded rather than nulled, unlike a menu entry pointing at a deleted page.
     *
     * A menu entry survives its target so the broken row stays visible in the admin; a staged
     * version has nothing to apply itself to and could never publish. The visibility that a
     * cascade would cost is bought back in `itemDeleteImpact`, which *blocks* deleting an item that
     * is staged in an open release — so the row is never silently dropped out from under a launch.
     */
    .addColumn('content_item_id', 'text', (col) =>
      col.notNull().references('content_items.id').onDelete('cascade'),
    )
    .addColumn('title', 'text', (col) => col.notNull())
    .addColumn('slug', 'text', (col) => col.notNull())
    .addColumn('data', 'text', (col) => col.notNull())
    .addColumn('seo', 'text', (col) => col.notNull())
    /** Who put it in the release. Distinct from whoever later publishes the release. */
    .addColumn('staged_by', 'text', (col) => col.references('users.id').onDelete('set null'))
    /**
     * When this staged version was applied to its item, or null if it has not been.
     *
     * Per-item rather than per-release because a release publish is N writes and cannot be one
     * atomic statement — D1 has no interactive transactions, and each item's update is already its
     * own batch of path rewrites, redirects, and a revision. Pre-flight validation is what keeps
     * "item 4 of 12 fails" from happening at all; this column is what makes the residue of a
     * genuine mid-flight failure resumable rather than a puzzle.
     */
    .addColumn('published_at', 'text')
    .addColumn('created_at', 'text', (col) => col.notNull())
    .addColumn('updated_at', 'text', (col) => col.notNull())
    .execute();

  /**
   * One staged version per item per release — but an item may be staged in several open releases at
   * once, which is what the scope doc means by "a pending version staged in one or more Releases".
   * That is a real hazard rather than an oversight: publishing one release makes the other's staged
   * copy stale, so `releaseConflicts` surfaces it on both screens rather than the schema forbidding
   * a thing editors legitimately want to do.
   */
  await db.schema
    .createIndex('release_items_unique_idx')
    .on('release_items')
    .columns(['release_id', 'content_item_id'])
    .unique()
    .execute();

  /** Answers "which releases hold this item" — the conflict check, the delete guard, and the
   *  banner on the item editor all read it. */
  await db.schema
    .createIndex('release_items_item_idx')
    .on('release_items')
    .column('content_item_id')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('release_items').execute();
  await db.schema.dropTable('releases').execute();
}
