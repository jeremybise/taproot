import type { Kysely } from 'kysely';

/**
 * `rel="nofollow"` on a menu entry.
 *
 * The other half of the `rel` work: `open_in_new_tab` has existed since `0004_menus` and simply had
 * no control in the admin, while this had nothing at all. Both are now editable, and both compose
 * through `menuRel` so a menu link and a rich-text link opening in a new tab carry the same
 * protection.
 *
 * **Not a free-text `rel` column**, which is the shape somebody reaches for once a second token is
 * wanted. `rel` is security-relevant, the useful editorial tokens are few, and a text column admits
 * whatever a future form posts — the same argument that makes `ALLOWED_REL` an allowlist rather
 * than a validation. A third token, if one is ever genuinely wanted, is a third column and a third
 * checkbox, which is more honest about the size of the vocabulary than a text input pretending to
 * an openness it does not have.
 *
 * `noopener noreferrer` gets no column deliberately. It is not a decision an editor makes — it is
 * added whenever the entry opens in a new tab — and a column for it is a column somebody can untick.
 *
 * Defaults to 0, so every existing entry keeps behaving exactly as it did. Nothing to backfill.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('menu_items')
    .addColumn('no_follow', 'integer', (col) => col.notNull().defaultTo(0))
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('menu_items').dropColumn('no_follow').execute();
}
