import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

/**
 * Timestamps are stored as ISO-8601 strings rather than native date types.
 *
 * SQLite/D1 have no date type at all, and Postgres `timestamptz` round-trips through `pg` as a
 * JS Date. Normalising on ISO strings at the column level means the repository layer does not
 * have to branch per dialect, and lexicographic ordering still matches chronological ordering.
 */
export type Timestamp = ColumnType<string, string | undefined, string>;

/**
 * Booleans are stored as integers (0/1) because SQLite and D1 have no boolean type. The `select`
 * side is typed as `number` deliberately: repositories convert explicitly via `toBool`/`fromBool`
 * so the conversion stays greppable instead of hiding in a plugin.
 */
export type SqlBool = ColumnType<number, number | undefined, number>;

/** JSON payloads are TEXT on SQLite/D1 and jsonb on Postgres; both round-trip as a string here. */
export type JsonText = ColumnType<string, string | undefined, string>;

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface UsersTable {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  /** Global fallback role. Phase 3 adds scoped assignments in a separate table. */
  role: 'admin' | 'editor' | 'contributor' | 'viewer';
  is_active: SqlBool;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface UserCredentialsTable {
  user_id: string;
  /** PBKDF2-SHA256, encoded as `pbkdf2$<iterations>$<salt-b64>$<hash-b64>`. */
  password_hash: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface OauthAccountsTable {
  provider: 'google' | 'github' | 'microsoft';
  provider_user_id: string;
  user_id: string;
  created_at: Timestamp;
}

export interface TotpSecretsTable {
  user_id: string;
  /** Base32-encoded shared secret. */
  secret: string;
  /** Null until the user completes enrolment by confirming a code. */
  verified_at: string | null;
  created_at: Timestamp;
}

export interface SessionsTable {
  /** SHA-256 of the session token. The raw token is only ever in the cookie. */
  id: string;
  user_id: string;
  expires_at: string;
  created_at: Timestamp;
}

// ---------------------------------------------------------------------------
// Content model
// ---------------------------------------------------------------------------

/**
 * How a content type behaves in the URL space and in the admin.
 *
 * - `page`       nests under a parent; path is the materialised chain of slugs (`/admissions/apply`)
 * - `collection` flat and type-prefixed (`/events/spring-open-house`)
 * - `singleton`  exactly one item ever exists; no create/delete, just edit. Not routable on its own.
 */
export type ContentTypeKind = 'page' | 'collection' | 'singleton';

export interface ContentTypesTable {
  id: string;
  /** Stable machine name used in API routes and code. Immutable after creation. */
  api_id: string;
  name: string;
  name_plural: string;
  description: string | null;
  kind: ContentTypeKind;
  icon: string | null;
  /**
   * URL prefix for `collection` types (e.g. `events`). Null for `page` and `singleton`.
   * Kept separate from `api_id` so the public URL can be renamed without breaking the API.
   */
  url_prefix: string | null;
  /** Field `api_id` whose value is shown as the item's label in admin lists. */
  title_field: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/**
 * The v1 field set from the scope doc. `relation` is first-class from day one rather than an
 * afterthought; `block` and `repeater` have their columns and validation seams here but their
 * editing UI arrives in Phase 2.
 */
export type FieldType =
  | 'text'
  | 'richtext'
  | 'number'
  | 'boolean'
  | 'date'
  | 'select'
  | 'media'
  | 'taxonomy'
  | 'relation'
  | 'block'
  | 'repeater';

export interface FieldsTable {
  id: string;
  content_type_id: string;
  /** Machine name; unique within its content type. Used as the key in `content_items.data`. */
  api_id: string;
  label: string;
  type: FieldType;
  help_text: string | null;
  position: number;
  required: SqlBool;
  localized: SqlBool;
  /** Type-specific options: select choices, relation target, min/max, etc. Validated by Zod. */
  config: JsonText;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export type ContentStatus = 'draft' | 'in_review' | 'scheduled' | 'published' | 'archived';

export interface ContentItemsTable {
  id: string;
  content_type_id: string;
  /** Unique among siblings under the same parent, not site-wide. */
  slug: string;
  /** Self-referential parent for hierarchical (`page`) types. */
  parent_id: string | null;
  /**
   * Denormalised materialised path: parent's path + own slug, leading slash, no trailing slash.
   * Indexed and unique. This is what the public catch-all route resolves against in one lookup.
   */
  path: string;
  /**
   * Depth in the tree, 0 for roots. Redundant with `path` but makes ordering a tree for display
   * a plain indexed sort instead of a recursive query.
   */
  depth: number;
  /** Sort order among siblings. */
  position: number;
  status: ContentStatus;
  title: string;
  /** Field values keyed by field `api_id`. Shape is validated against the content type. */
  data: JsonText;
  /** SEO overrides: meta title/description, OG image. Sidebar UI lands in Phase 1. */
  seo: JsonText;
  published_at: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface MediaTable {
  id: string;
  /** Key within the storage adapter's namespace, not a public URL. */
  storage_key: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  /** Feeds the Phase 4 accessibility checker. */
  alt_text: string | null;
  title: string | null;
  /**
   * Normalised (0-1) focal point and crop offsets, stored independently of pixels so one asset
   * drives a hero crop, a square thumb, and a portrait card without pre-generating any of them.
   * The editor UI for these lands as a Phase 1 fast-follow.
   */
  hotspot_x: number | null;
  hotspot_y: number | null;
  crop_top: number | null;
  crop_right: number | null;
  crop_bottom: number | null;
  crop_left: number | null;
  uploaded_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface RedirectsTable {
  id: string;
  from_path: string;
  to_path: string;
  status_code: number;
  /** `auto` rows are written by path changes; `manual` rows are author-created and never GC'd. */
  source: 'auto' | 'manual';
  /** Set for `auto` rows so a moved item's redirects can be traced back to it. */
  content_item_id: string | null;
  created_at: Timestamp;
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

/**
 * The full Kysely database interface.
 *
 * Phase 1 adds `revisions`, `taxonomies`, `terms`, `taxonomy_assignments`, and `menus`.
 * Phase 3 adds `role_assignments` and `audit_log`. Phase 3.5 adds `releases`.
 */
export interface Database {
  users: UsersTable;
  user_credentials: UserCredentialsTable;
  oauth_accounts: OauthAccountsTable;
  totp_secrets: TotpSecretsTable;
  sessions: SessionsTable;
  content_types: ContentTypesTable;
  fields: FieldsTable;
  content_items: ContentItemsTable;
  media: MediaTable;
  redirects: RedirectsTable;
}

export type User = Selectable<UsersTable>;
export type NewUser = Insertable<UsersTable>;
export type UserUpdate = Updateable<UsersTable>;

export type Session = Selectable<SessionsTable>;
export type NewSession = Insertable<SessionsTable>;

export type ContentTypeRow = Selectable<ContentTypesTable>;
export type NewContentType = Insertable<ContentTypesTable>;
export type ContentTypeUpdate = Updateable<ContentTypesTable>;

export type FieldRow = Selectable<FieldsTable>;
export type NewField = Insertable<FieldsTable>;
export type FieldUpdate = Updateable<FieldsTable>;

export type ContentItemRow = Selectable<ContentItemsTable>;
export type NewContentItem = Insertable<ContentItemsTable>;
export type ContentItemUpdate = Updateable<ContentItemsTable>;

export type MediaRow = Selectable<MediaTable>;
export type NewMedia = Insertable<MediaTable>;
export type MediaUpdate = Updateable<MediaTable>;

export type RedirectRow = Selectable<RedirectsTable>;
export type NewRedirect = Insertable<RedirectsTable>;
