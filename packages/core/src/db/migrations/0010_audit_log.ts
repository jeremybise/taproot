import type { Kysely } from 'kysely';

/**
 * The audit log.
 *
 * Append-only, and nothing in the codebase updates or deletes a row — the value of a log is
 * exactly that it cannot be tidied by whoever it embarrasses. That is enforced by convention and
 * review rather than by a database grant, because the CMS holds one connection with full rights;
 * saying so here is what makes a future `updateTable('audit_log')` obviously wrong.
 *
 * Denormalised on purpose. `actor_email` and `subject_label` are copied in at write time rather
 * than joined at read time, because the point of a log is what was true *then*: an entry reading
 * "deleted Admissions" stays meaningful after the page and the person are both gone, and a join
 * would render it as two nulls. `actor_id` keeps the link for as long as the row survives.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('audit_log')
    .addColumn('id', 'text', (col) => col.primaryKey())
    /** Who. Null for something the system did on its own, like the scheduler publishing. */
    .addColumn('actor_id', 'text', (col) => col.references('users.id').onDelete('set null'))
    .addColumn('actor_email', 'text')
    /** What: a dotted verb like `item.published` or `user.two_factor_cleared`. */
    .addColumn('action', 'text', (col) => col.notNull())
    /** What it was done to: `item`, `user`, `content_type`, … */
    .addColumn('subject_type', 'text', (col) => col.notNull())
    /**
     * No foreign key, deliberately. A log entry about a deleted item has to survive the item —
     * `on delete set null` would erase the only record of which one it was, and a cascade would
     * delete the evidence along with the thing.
     */
    .addColumn('subject_id', 'text')
    /** What it was called at the time. */
    .addColumn('subject_label', 'text')
    /** Free-form detail, e.g. the status a transition moved between. JSON text. */
    .addColumn('detail', 'text')
    .addColumn('created_at', 'text', (col) => col.notNull())
    .execute();

  // Newest-first is the only read, and filtering by actor or subject narrows it.
  await db.schema
    .createIndex('audit_log_created_idx')
    .on('audit_log')
    .column('created_at')
    .execute();

  await db.schema
    .createIndex('audit_log_subject_idx')
    .on('audit_log')
    .columns(['subject_type', 'subject_id'])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('audit_log').execute();
}
