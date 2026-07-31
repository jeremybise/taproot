import type { Kysely } from 'kysely';

/**
 * The two tables email/password sign-in needs once it is the front door rather than a dev
 * convenience: somewhere to count failed attempts, and somewhere to park a single-use token for
 * setting a password.
 *
 * Both are deliberately boring — no state machine, no status column. A row's existence is the
 * fact, and both are safe to purge on a schedule.
 */
export async function up(db: Kysely<any>): Promise<void> {
  /**
   * Failed sign-in attempts, one row each.
   *
   * A row per attempt rather than a counter per identifier, because a counter needs a window start
   * and a reset rule, and read-modify-write on it across two concurrent requests loses attempts —
   * on precisely the workload where concurrency is the attack. Counting rows in a time window is a
   * single indexed query and cannot undercount.
   *
   * `identifier` is scoped by kind (`email:someone@example.edu`, `ip:203.0.113.4`) so both live in
   * one table without an address ever colliding with an address-shaped local part.
   */
  await db.schema
    .createTable('login_attempts')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('identifier', 'text', (col) => col.notNull())
    .addColumn('created_at', 'text', (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex('login_attempts_identifier_idx')
    .on('login_attempts')
    .columns(['identifier', 'created_at'])
    .execute();

  /**
   * Single-use tokens for setting a password.
   *
   * The id **is** the SHA-256 of the token, the same model as `sessions`: the raw value exists only
   * in the link handed to the person, so a database dump cannot be replayed as a set of live
   * password resets.
   *
   * `created_by` is nullable on purpose, and it is the seam that lets email-delivered self-service
   * reset arrive later without reshaping this table: an admin-generated link records who generated
   * it, and a "forgot password" link records nobody. Nothing else about the flow differs — the same
   * token, the same expiry, the same single use — only who asked for it and how it was delivered.
   */
  await db.schema
    .createTable('password_reset_tokens')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('user_id', 'text', (col) =>
      col.notNull().references('users.id').onDelete('cascade'),
    )
    .addColumn('expires_at', 'text', (col) => col.notNull())
    .addColumn('created_by', 'text', (col) => col.references('users.id').onDelete('set null'))
    .addColumn('used_at', 'text')
    .addColumn('created_at', 'text', (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex('password_reset_tokens_user_idx')
    .on('password_reset_tokens')
    .column('user_id')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('password_reset_tokens').execute();
  await db.schema.dropTable('login_attempts').execute();
}
