import { sql, type Kysely } from 'kysely';

/**
 * Deployment-wide settings: one row, named columns.
 *
 * Phase 4.6c needs somewhere to keep what the CMS calls itself and what colour it is. A key/value
 * table is the reflex, and it is the wrong shape here — every read comes back as text needing a
 * parse, nothing can say which keys exist, and a foreign key on the logo is impossible. Named
 * columns get all three from the schema, and adding a setting later is an `ADD COLUMN` rather than
 * an untyped string appearing in a blob.
 *
 * One row is not a limitation being worked around: SCOPE settled "one site per deployment", so a
 * second row would describe a site that cannot exist. The check constraint says so in the schema
 * rather than in a comment, and the writer upserts on the primary key.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('settings')
    // Always 'site'. The constraint is what makes the upsert in `updateBranding` total: there is
    // exactly one row it can ever conflict with.
    .addColumn('id', 'text', (col) => col.primaryKey().check(sql`id = 'site'`))
    /** What the admin calls itself. Null is "Taproot", which is not the same as an empty string. */
    .addColumn('title', 'text')
    /**
     * `on delete set null`, not cascade.
     *
     * Deleting the image used as the logo must put the ◆ mark back, not delete the settings row
     * along with the title and both accent colours.
     */
    .addColumn('logo_media_id', 'text', (col) => col.references('media.id').onDelete('set null'))
    /**
     * Hex, one per palette, because a hue that reads well on white rarely reads well on the dark
     * surface — the built-in accent is two different greens for exactly that reason. Null means the
     * stylesheet's own value, so an unthemed admin emits no override at all.
     */
    .addColumn('accent_light', 'text')
    .addColumn('accent_dark', 'text')
    .addColumn('updated_at', 'text', (col) => col.notNull())
    .addColumn('updated_by', 'text', (col) => col.references('users.id').onDelete('set null'))
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('settings').execute();
}
