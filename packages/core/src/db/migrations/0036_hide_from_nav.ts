import { sql, type Kysely } from 'kysely';

/**
 * Whether this content type gets its own entry in the admin sidebar.
 *
 * The sidebar is built from the content types that exist, one entry each, which is right up to about
 * a dozen and wrong past it. A staff directory's `person`, or a `policy` reached only through the page
 * that lists it, are real content types — versioned, classified, indexed — that nobody ever reaches
 * from the sidebar. Entries nobody clicks push the ones people use every day below the fold.
 *
 * **The sidebar only, and that is the whole rule.** A hidden type keeps its list screen, its create
 * screen, its items, and its place in "All content" and in search — this is a navigation preference,
 * not a second kind of visibility. The distinction matters because the tempting version is the
 * dangerous one: a flag that also filtered listings would be a delete that does not delete, and
 * "never leave a deployment in a state its own UI cannot reach" is the rule that forbids it. Every
 * hidden type is still one click away at **Content → All content**, and its own list is still at a
 * stable URL.
 *
 * Default 0, so no existing deployment's sidebar changes under it. Meaningful for every kind
 * — unlike `url_prefix` or `preview_path`, a singleton is exactly as clutterable as a collection — so
 * neither write path forces it by kind.
 *
 * Nothing is derived from it, so there is no `npm run db:reindex` step.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    alter table content_types add column hide_from_nav integer not null default 0
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('content_types').dropColumn('hide_from_nav').execute();
}
