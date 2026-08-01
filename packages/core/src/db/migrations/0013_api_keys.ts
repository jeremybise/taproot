import type { Kysely } from 'kysely';

/**
 * API keys: the first non-human principal in the role model.
 *
 * They arrive with the delivery API because a second deployment cannot read content without one.
 * SCOPE had them in Phase 5; they moved here for that reason, and because a key is the thing that
 * forces "who is asking" to stop meaning "which user row".
 *
 * The token is hashed at rest with the same helper sessions and password-reset links use, and `id`
 * **is** that hash — so verification is one indexed lookup rather than a scan, and a database dump
 * is not a set of live credentials. The raw value exists once, in the response that created it.
 *
 * Deliberately not modelled as a user with a role. A key is not a person: it cannot own content,
 * cannot appear as a revision's author, and must never satisfy a check written as "an editor did
 * this". Giving it a `users` row would make every one of those true by accident.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('api_keys')
    .addColumn('id', 'text', (col) => col.primaryKey())
    /** What it is for, in a human's words: "campus website", "staging". */
    .addColumn('label', 'text', (col) => col.notNull())
    /**
     * The first characters of the raw token, stored in the clear.
     *
     * Without it the list is labels alone, and matching a row against the value in some
     * deployment's environment means guessing. Eight hex characters is 32 bits of a 256-bit token —
     * enough to recognise one, nowhere near enough to use it.
     */
    .addColumn('token_prefix', 'text', (col) => col.notNull())
    /** JSON array of scope strings. See `API_KEY_SCOPES`. */
    .addColumn('scopes', 'text', (col) => col.notNull())
    /**
     * Null means it never expires.
     *
     * Offered rather than required: a key that expires silently takes a website down at a moment
     * nobody chose, so the safe default is the one an operator opts out of rather than into.
     */
    .addColumn('expires_at', 'text')
    /**
     * Revoked rather than deleted.
     *
     * The audit log records that a key existed and was used; deleting the row would leave those
     * entries naming an id nothing can resolve. Same reasoning as deactivating a user instead of
     * removing them.
     */
    .addColumn('revoked_at', 'text')
    /**
     * When it was last accepted, to the minute.
     *
     * The one question an operator actually asks of this screen is "is anything still using this?",
     * which a creation date cannot answer. Written coarsely on purpose — see `touchApiKey`.
     */
    .addColumn('last_used_at', 'text')
    .addColumn('created_by', 'text', (col) => col.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'text', (col) => col.notNull())
    .addColumn('updated_at', 'text', (col) => col.notNull())
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('api_keys').execute();
}
