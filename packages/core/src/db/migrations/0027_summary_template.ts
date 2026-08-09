import { sql, type Kysely } from 'kysely';

/**
 * Turn `content_types.title_field` into `content_types.summary_template`.
 *
 * `title_field` named a single field's `api_id` and was offered by the content-type settings screen
 * under the label *"Which field labels an item in admin lists"*. **No admin list ever read it.** It
 * was stored, validated, round-tripped through the API, and enforced by nothing — the same shape as
 * `reverseLabel`, which the field builder collected for two phases before anything rendered it.
 *
 * ## Renamed rather than joined by a second column
 *
 * A template is a superset: `title_field: 'headline'` is exactly `summary_template: '{{ headline }}'`,
 * and the conversion below is one statement. Adding `summary_template` *beside* `title_field` would
 * leave two settings answering "what does this thing say it is", with no rule for which wins — the
 * "two spellings of one fact" this codebase keeps avoiding. Nothing read the old column, so nothing
 * breaks; the values are carried across so a deployment that had configured it keeps its choice.
 *
 * ## Why the column is wider than its old name suggests
 *
 * The reason a single field was not enough is blocks. A block instance has no title, so a collapsed
 * row could only ever say its *type* — three "Card"s in a row, telling an editor nothing about which
 * card is which. A template can read `{{ headline }} · {{ link }}`, which is the difference between
 * a list of blocks and a list of the page's actual content.
 *
 * ## Two statements, not `ALTER TABLE … RENAME COLUMN`
 *
 * D1 does support the rename, and it would be shorter. It is avoided because the conversion has to
 * happen anyway — a bare rename would leave `headline` sitting in a column now read as a template,
 * where it renders as the literal text "headline" on every row. Adding, filling and dropping makes
 * the transformation the visible part of the migration rather than a follow-up somebody has to
 * remember.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('content_types').addColumn('summary_template', 'text').execute();

  // `{{ api_id }}` for every type that had chosen a field, null for everything else. Written with
  // the spaces the settings screen produces, so a stored template and a freshly typed one match.
  await sql`
    update content_types
       set summary_template = '{{ ' || title_field || ' }}'
     where title_field is not null and title_field <> ''
  `.execute(db);

  await db.schema.alterTable('content_types').dropColumn('title_field').execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('content_types').addColumn('title_field', 'text').execute();

  /*
   * Only a template naming exactly one field and nothing else can go back, which is the honest
   * inverse: `{{ headline }} · {{ link }}` has no single-field spelling, and guessing the first
   * token would silently drop the rest. Anything else reverts to null — the state every deployment
   * was in before this, since nothing read the column.
   */
  await sql`
    update content_types
       set title_field = trim(replace(replace(summary_template, '{{', ''), '}}', ''))
     where summary_template like '{{%}}'
       and summary_template not like '%}}%{{%'
       and trim(replace(replace(summary_template, '{{', ''), '}}', '')) not like '% %'
  `.execute(db);

  await db.schema.alterTable('content_types').dropColumn('summary_template').execute();
}
