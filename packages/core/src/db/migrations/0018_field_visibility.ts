import type { Kysely } from 'kysely';

/**
 * When a field is shown, as a condition on one of its siblings.
 *
 * "Show the banner text only when the banner is switched on" is the case, and without it every
 * conditional field on a content type is a permanently visible input with a help text asking the
 * editor to ignore it under some circumstance.
 *
 * **A column rather than a key in `config`.** A condition is a property of *a field*, not of a field
 * type: `visible_when` means the same thing on a text field and on a repeater, so putting it in
 * `config` would mean adding an identical key to all twelve per-type schemas in `fieldConfigSchemas`
 * and keeping twelve copies in step. Repeater sub-fields are the exception that proves it — they
 * have no row of their own, so `repeaterSubField` carries the same key and `repeaterRowFields`
 * copies it onto the row it synthesises. Block types need nothing extra, a block type being a
 * content type whose fields are rows in this table.
 *
 * Null means unconditional, which is what every existing field becomes — the safe answer is the one
 * you get by not thinking about it, as with `preview_path` and `url_prefix`.
 *
 * The stored shape is one condition, not a rule set: `{ field, operator, value? }`. AND/OR was
 * considered and left out, because it turns the field builder into a query builder for a case
 * nobody has yet — and a second condition can be added later without moving the first, where
 * unpicking an expression tree could not be.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('fields').addColumn('visible_when', 'text').execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('fields').dropColumn('visible_when').execute();
}
