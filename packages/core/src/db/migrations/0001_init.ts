import { sql, type Kysely } from 'kysely';

/**
 * Initial schema.
 *
 * Written against the SQLite feature set because that is what both dev (node:sqlite) and
 * production (D1) run. Types are chosen to be portable: TEXT for timestamps and JSON, INTEGER
 * for booleans.
 */
export async function up(db: Kysely<any>): Promise<void> {
  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  await db.schema
    .createTable('users')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('email', 'text', (col) => col.notNull().unique())
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('avatar_url', 'text')
    .addColumn('role', 'text', (col) => col.notNull().defaultTo('viewer'))
    .addColumn('is_active', 'integer', (col) => col.notNull().defaultTo(1))
    .addColumn('created_at', 'text', (col) => col.notNull())
    .addColumn('updated_at', 'text', (col) => col.notNull())
    .execute();

  await db.schema
    .createTable('user_credentials')
    .addColumn('user_id', 'text', (col) =>
      col.primaryKey().references('users.id').onDelete('cascade'),
    )
    .addColumn('password_hash', 'text', (col) => col.notNull())
    .addColumn('created_at', 'text', (col) => col.notNull())
    .addColumn('updated_at', 'text', (col) => col.notNull())
    .execute();

  await db.schema
    .createTable('oauth_accounts')
    .addColumn('provider', 'text', (col) => col.notNull())
    .addColumn('provider_user_id', 'text', (col) => col.notNull())
    .addColumn('user_id', 'text', (col) => col.notNull().references('users.id').onDelete('cascade'))
    .addColumn('created_at', 'text', (col) => col.notNull())
    .addPrimaryKeyConstraint('oauth_accounts_pk', ['provider', 'provider_user_id'])
    .execute();

  await db.schema
    .createIndex('oauth_accounts_user_id_idx')
    .on('oauth_accounts')
    .column('user_id')
    .execute();

  await db.schema
    .createTable('totp_secrets')
    .addColumn('user_id', 'text', (col) =>
      col.primaryKey().references('users.id').onDelete('cascade'),
    )
    .addColumn('secret', 'text', (col) => col.notNull())
    .addColumn('verified_at', 'text')
    .addColumn('created_at', 'text', (col) => col.notNull())
    .execute();

  await db.schema
    .createTable('sessions')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('user_id', 'text', (col) => col.notNull().references('users.id').onDelete('cascade'))
    .addColumn('expires_at', 'text', (col) => col.notNull())
    .addColumn('created_at', 'text', (col) => col.notNull())
    .execute();

  await db.schema.createIndex('sessions_user_id_idx').on('sessions').column('user_id').execute();
  // Expired-session cleanup scans by expiry.
  await db.schema
    .createIndex('sessions_expires_at_idx')
    .on('sessions')
    .column('expires_at')
    .execute();

  // -------------------------------------------------------------------------
  // Content model
  // -------------------------------------------------------------------------

  await db.schema
    .createTable('content_types')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('api_id', 'text', (col) => col.notNull().unique())
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('name_plural', 'text', (col) => col.notNull())
    .addColumn('description', 'text')
    .addColumn('kind', 'text', (col) => col.notNull().defaultTo('collection'))
    .addColumn('icon', 'text')
    .addColumn('url_prefix', 'text')
    .addColumn('title_field', 'text')
    .addColumn('created_at', 'text', (col) => col.notNull())
    .addColumn('updated_at', 'text', (col) => col.notNull())
    .execute();

  await db.schema
    .createTable('fields')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('content_type_id', 'text', (col) =>
      col.notNull().references('content_types.id').onDelete('cascade'),
    )
    .addColumn('api_id', 'text', (col) => col.notNull())
    .addColumn('label', 'text', (col) => col.notNull())
    .addColumn('type', 'text', (col) => col.notNull())
    .addColumn('help_text', 'text')
    .addColumn('position', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('required', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('localized', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('config', 'text', (col) => col.notNull().defaultTo('{}'))
    .addColumn('created_at', 'text', (col) => col.notNull())
    .addColumn('updated_at', 'text', (col) => col.notNull())
    // A field's machine name must be unique within its type — it is the key in `content_items.data`.
    .addUniqueConstraint('fields_type_api_id_unique', ['content_type_id', 'api_id'])
    .execute();

  await db.schema
    .createIndex('fields_content_type_id_idx')
    .on('fields')
    .column('content_type_id')
    .execute();

  await db.schema
    .createTable('content_items')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('content_type_id', 'text', (col) =>
      col.notNull().references('content_types.id').onDelete('cascade'),
    )
    .addColumn('slug', 'text', (col) => col.notNull())
    // Self-referential parent. `set null` rather than `cascade`: orphaning a subtree is recoverable,
    // silently deleting a department's whole page tree is not.
    .addColumn('parent_id', 'text', (col) => col.references('content_items.id').onDelete('set null'))
    .addColumn('path', 'text', (col) => col.notNull())
    .addColumn('depth', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('position', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('status', 'text', (col) => col.notNull().defaultTo('draft'))
    .addColumn('title', 'text', (col) => col.notNull())
    .addColumn('data', 'text', (col) => col.notNull().defaultTo('{}'))
    .addColumn('seo', 'text', (col) => col.notNull().defaultTo('{}'))
    .addColumn('published_at', 'text')
    .addColumn('created_by', 'text', (col) => col.references('users.id').onDelete('set null'))
    .addColumn('updated_by', 'text', (col) => col.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'text', (col) => col.notNull())
    .addColumn('updated_at', 'text', (col) => col.notNull())
    .execute();

  // The public catch-all route resolves a request in exactly one indexed lookup against this.
  await db.schema
    .createIndex('content_items_path_unique')
    .on('content_items')
    .column('path')
    .unique()
    .execute();

  // Sibling slugs need only be unique under the same parent — this is what lets
  // /admissions/apply and /financial-aid/apply coexist.
  //
  // Raw SQL because SQLite's NULLS NOT DISTINCT is not available: with a plain unique index, rows
  // where parent_id IS NULL would never collide, so two root items could share a slug. Two partial
  // indexes cover the null and non-null cases separately.
  await sql`
    CREATE UNIQUE INDEX content_items_parent_slug_unique
    ON content_items (parent_id, slug)
    WHERE parent_id IS NOT NULL
  `.execute(db);

  await sql`
    CREATE UNIQUE INDEX content_items_root_slug_unique
    ON content_items (slug)
    WHERE parent_id IS NULL
  `.execute(db);

  await db.schema
    .createIndex('content_items_type_idx')
    .on('content_items')
    .columns(['content_type_id', 'status'])
    .execute();

  await db.schema
    .createIndex('content_items_parent_idx')
    .on('content_items')
    .columns(['parent_id', 'position'])
    .execute();

  // -------------------------------------------------------------------------
  // Media
  // -------------------------------------------------------------------------

  await db.schema
    .createTable('media')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('storage_key', 'text', (col) => col.notNull().unique())
    .addColumn('filename', 'text', (col) => col.notNull())
    .addColumn('mime_type', 'text', (col) => col.notNull())
    .addColumn('size_bytes', 'integer', (col) => col.notNull())
    .addColumn('width', 'integer')
    .addColumn('height', 'integer')
    .addColumn('alt_text', 'text')
    .addColumn('title', 'text')
    .addColumn('hotspot_x', 'real')
    .addColumn('hotspot_y', 'real')
    .addColumn('crop_top', 'real')
    .addColumn('crop_right', 'real')
    .addColumn('crop_bottom', 'real')
    .addColumn('crop_left', 'real')
    .addColumn('uploaded_by', 'text', (col) => col.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'text', (col) => col.notNull())
    .addColumn('updated_at', 'text', (col) => col.notNull())
    .execute();

  await db.schema.createIndex('media_created_at_idx').on('media').column('created_at').execute();

  // -------------------------------------------------------------------------
  // Redirects
  // -------------------------------------------------------------------------

  await db.schema
    .createTable('redirects')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('from_path', 'text', (col) => col.notNull().unique())
    .addColumn('to_path', 'text', (col) => col.notNull())
    .addColumn('status_code', 'integer', (col) => col.notNull().defaultTo(301))
    .addColumn('source', 'text', (col) => col.notNull().defaultTo('manual'))
    .addColumn('content_item_id', 'text', (col) =>
      col.references('content_items.id').onDelete('cascade'),
    )
    .addColumn('created_at', 'text', (col) => col.notNull())
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  // Reverse creation order so foreign keys never block a drop.
  await db.schema.dropTable('redirects').ifExists().execute();
  await db.schema.dropTable('media').ifExists().execute();
  await db.schema.dropTable('content_items').ifExists().execute();
  await db.schema.dropTable('fields').ifExists().execute();
  await db.schema.dropTable('content_types').ifExists().execute();
  await db.schema.dropTable('sessions').ifExists().execute();
  await db.schema.dropTable('totp_secrets').ifExists().execute();
  await db.schema.dropTable('oauth_accounts').ifExists().execute();
  await db.schema.dropTable('user_credentials').ifExists().execute();
  await db.schema.dropTable('users').ifExists().execute();
}
