import { sql, type Kysely } from 'kysely';

/**
 * Menus, and the items in them.
 *
 * The point of the design is that a menu item **references** its target rather than storing a URL.
 * A page moved from /admissions to /admission-office keeps its menu entry pointing at the right
 * place, because the path is resolved from `content_items.path` at render time. Storing the URL
 * would mean every move silently broke the navigation — which is the same failure the redirects
 * table exists to prevent, and it would be strange to solve it in one place and not the other.
 *
 * Three target kinds, discriminated by `target_type` with one nullable column each:
 *
 * - `item` — a content item. Follows moves, and drops out of the public menu when unpublished.
 * - `term` — a taxonomy term, for a term archive page.
 * - `url`  — anything external, or a path this CMS does not own.
 *
 * A CHECK constraint would be the tidier way to enforce "exactly the matching column is set", but
 * D1 and SQLite disagree with Postgres about enough constraint syntax that it is validated in the
 * service instead, where the error message can say something useful.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('menus')
    .addColumn('id', 'text', (col) => col.primaryKey())
    /** Stable machine name — how a template asks for this menu. Immutable after creation. */
    .addColumn('api_id', 'text', (col) => col.notNull().unique())
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('description', 'text')
    .addColumn('created_at', 'text', (col) => col.notNull())
    .addColumn('updated_at', 'text', (col) => col.notNull())
    .execute();

  await db.schema
    .createTable('menu_items')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('menu_id', 'text', (col) =>
      col.notNull().references('menus.id').onDelete('cascade'),
    )
    /** Self-referential parent, for dropdowns. */
    .addColumn('parent_id', 'text', (col) => col.references('menu_items.id').onDelete('cascade'))
    .addColumn('position', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('depth', 'integer', (col) => col.notNull().defaultTo(0))
    /**
     * Optional override. Null means "use the target's own title", which is what keeps a renamed
     * page's menu entry current. Set it when the nav needs to be terser than the page title —
     * "Apply" in the menu for a page called "Apply for Undergraduate Admission".
     */
    .addColumn('label', 'text')
    .addColumn('target_type', 'text', (col) => col.notNull())
    /**
     * `set null`, not `cascade`.
     *
     * Cascading would make a menu entry disappear the moment someone deleted the page behind it,
     * which is a silent edit to the site's navigation. Nulling the reference leaves the entry in
     * place, still carrying its label, and the admin flags it as broken so a human decides whether
     * to re-point it or remove it. Public rendering skips it either way, so a visitor never sees a
     * dead link.
     */
    .addColumn('content_item_id', 'text', (col) =>
      col.references('content_items.id').onDelete('set null'),
    )
    .addColumn('term_id', 'text', (col) => col.references('terms.id').onDelete('set null'))
    .addColumn('url', 'text')
    .addColumn('open_in_new_tab', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('created_at', 'text', (col) => col.notNull())
    .addColumn('updated_at', 'text', (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex('menu_items_menu_idx')
    .on('menu_items')
    .columns(['menu_id', 'parent_id', 'position'])
    .execute();

  // "Which menus point at this item" — asked before deleting a page, so the warning can be
  // specific about what would break.
  await sql`
    CREATE INDEX menu_items_content_item_idx
    ON menu_items (content_item_id)
    WHERE content_item_id IS NOT NULL
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('menu_items').ifExists().execute();
  await db.schema.dropTable('menus').ifExists().execute();
}
