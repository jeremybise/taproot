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
  /**
   * The user's role, site-wide.
   *
   * Flat on purpose. An earlier plan scoped role assignments to departments that owned content;
   * departments turned out to be classification, which taxonomies already do. See `guards.ts`.
   */
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
  /**
   * The highest time step already accepted.
   *
   * A code is valid for its whole period plus the drift window, so without this one observed over
   * a shoulder works again for up to ninety seconds. Refusing anything at or below the last spent
   * step makes each code single-use.
   */
  last_used_step: number | null;
  created_at: Timestamp;
}

/**
 * One failed sign-in attempt.
 *
 * Rows rather than a counter: a counter needs a window start and a reset rule, and two concurrent
 * requests reading-modifying-writing it lose attempts — on exactly the workload where concurrency
 * *is* the attack.
 */
export interface LoginAttemptsTable {
  id: string;
  /** Kind-scoped, e.g. `email:someone@example.edu` or `ip:203.0.113.4`. */
  identifier: string;
  created_at: Timestamp;
}

/**
 * A single-use token for setting a password.
 *
 * `id` is the SHA-256 of the token, as with `sessions` — the raw value only ever exists in the
 * link. `created_by` is null for a token nobody but the account holder asked for, which is the
 * shape an email-delivered reset will take.
 */
export interface PasswordResetTokensTable {
  id: string;
  user_id: string;
  expires_at: Timestamp;
  created_by: string | null;
  used_at: Timestamp | null;
  created_at: Timestamp;
}

/**
 * A half-finished sign-in: the password was right, the second factor is outstanding.
 *
 * A row rather than a signed cookie, because it has to be revocable and single-use — it represents
 * most of the way in, and a self-contained token would stay valid however the account changed
 * underneath it.
 */
export interface LoginChallengesTable {
  id: string;
  user_id: string;
  expires_at: Timestamp;
  created_at: Timestamp;
}

/** A single-use recovery code, hashed at rest. */
export interface TotpRecoveryCodesTable {
  id: string;
  user_id: string;
  used_at: Timestamp | null;
  created_at: Timestamp;
}

/**
 * A short-lived link that shows unpublished content on a site of another origin.
 *
 * A row rather than a signed token, following `login_challenges`: revocable, short-lived, and not
 * carrying its own validity however the account changes underneath it. `release_id` set means the
 * staged version inside that release rather than the item's own content — one mechanism for both,
 * because two nearly-identical ones drift until one stops checking something.
 */
export interface PreviewTokensTable {
  /** SHA-256 of the token. The raw value exists only in the link. */
  id: string;
  content_item_id: string;
  release_id: string | null;
  created_by: string | null;
  expires_at: Timestamp;
  created_at: Timestamp;

  /**
   * The editor's unsaved form state, for the split-view preview pane.
   *
   * A rendering input, not a version — see `0015_preview_draft` for why that distinction is
   * load-bearing and what must never be built on top of these. `draft_updated_at` is the flag for
   * "a snapshot exists"; the other four are read only when it is set.
   */
  title: string | null;
  slug: string | null;
  /** JSON. Validated with `requireComplete: false`, so richtext is sanitised but nothing is required. */
  data: string | null;
  /** JSON. */
  seo: string | null;
  draft_updated_at: Timestamp | null;
}

/**
 * What an API key is allowed to do.
 *
 * One scope today, and that is not a placeholder — it is everything the delivery API needs. A write
 * scope invented before anything writes would be a permission nobody has checked, which is worse
 * than an absent one because it reads as enforced.
 */
export type ApiKeyScope = 'content:read';

/**
 * A non-human principal.
 *
 * `id` **is** the SHA-256 of the token, as with `sessions` and `password_reset_tokens` — so
 * verification is one indexed lookup and a database dump holds no usable credentials. The raw value
 * exists once, in the response that created it.
 *
 * Deliberately not a row in `users`. A key cannot own content, cannot author a revision, and must
 * never satisfy a check written as "an editor did this"; giving it a user row would make all three
 * true by accident.
 */
export interface ApiKeysTable {
  id: string;
  label: string;
  /** The first characters of the raw token, in the clear, so a key is recognisable in a list. */
  token_prefix: string;
  /** JSON array of `ApiKeyScope`. */
  scopes: JsonText;
  /** Null means it never expires — the safe default, since silent expiry takes a site down. */
  expires_at: string | null;
  /** Revoked rather than deleted, so audit entries naming this key still resolve. */
  revoked_at: string | null;
  /** Written coarsely; see `touchApiKey` for why it is not exact. */
  last_used_at: string | null;
  created_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/**
 * One entry in the append-only audit log.
 *
 * `actor_email` and `subject_label` are copied in at write time rather than joined at read time,
 * because a log records what was true *then*: an entry stays readable after the person and the
 * thing it describes are both gone. `subject_id` has no foreign key for the same reason — a
 * cascade would delete the evidence along with the subject.
 */
export interface AuditLogTable {
  id: string;
  actor_id: string | null;
  actor_email: string | null;
  action: string;
  subject_type: string;
  subject_id: string | null;
  subject_label: string | null;
  /** JSON text, or null. */
  detail: string | null;
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
 * How a content type's instances are addressed.
 *
 * - `page`       nests under a parent; path is the materialised chain of slugs (`/admissions/apply`)
 * - `collection` flat and type-prefixed (`/events/spring-open-house`)
 * - `singleton`  exactly one item ever exists; no create/delete, just edit. Not routable on its own.
 * - `block`      never addressed at all. Instances live inside another item's `data`, placed into a
 *                `block` field, and have no row in `content_items`.
 *
 * A block type is a user-defined schema with fields that content conforms to — which is exactly
 * what a content type is, so it reuses the same table, the same field builder, the same validation,
 * and the same API rather than growing a parallel set of all four. `kind` already answers "how does
 * this type's content get addressed", and "it does not" is a coherent fourth answer.
 *
 * The cost is that every read of `content_types` meant for *content* has to exclude blocks, so
 * `listContentTypes` excludes them by default and callers opt in — the safe behaviour is the one
 * you get by not thinking about it.
 */
export type ContentTypeKind = 'page' | 'collection' | 'singleton' | 'block';

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
  /**
   * Where a `singleton` renders on the public site, for preview. Null for every other kind.
   *
   * A singleton's `path` is the synthetic `/__singleton/{api_id}`, so it cannot say where it is
   * shown — a homepage built from blocks lives at `/`, and only the site knows that. Null means
   * "this singleton has no page", which is the right answer for a settings record and the reason
   * the default is off rather than on. Read through `previewPathFor`, never directly, so the
   * preview pane and the mint endpoint cannot disagree about which address to frame.
   */
  preview_path: string | null;
  /** Field `api_id` whose value is shown as the item's label in admin lists. */
  title_field: string | null;
  /** Order in the admin sidebar, where each content type is its own entry. Ties break by name. */
  position: number;
  /**
   * Social-card image used by items of this type that have not set their own.
   *
   * Most items never need a bespoke card, so the useful default lives at the type level rather
   * than being copied onto every item at creation — changing it here updates every item that has
   * not overridden it, which copying would not.
   */
  default_og_image_id: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/**
 * The v1 field set from the scope doc. Every one of these has an editing control except
 * `repeater`, which has its column and validation seam and nothing to author with — see
 * `DEFERRED_FIELD_TYPES`, which is the single place that fact is recorded.
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
  /** SEO overrides: meta title/description, OG image. Authored through the editor's SEO panel. */
  seo: JsonText;
  /** When it went live. Written at the moment it happens. */
  published_at: string | null;
  /**
   * When a `scheduled` item should go live.
   *
   * Separate from `published_at` on purpose: one is a record and the other an intention, and
   * sharing a column would make "published two hours ago" and "goes live in two hours" the same
   * value distinguished only by a status the scheduler is mid-way through changing.
   */
  publish_at: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/**
 * A block instance promoted to a shared library.
 *
 * The row owns its `data`; an item that places it stores only a reference. That is the whole
 * point — an ordinary block's content belongs to the page and is versioned with it, while this
 * belongs to the library, and editing it changes every page that references it at once.
 */
export interface ReusableBlocksTable {
  id: string;
  /** How editors find it in the library. Not a machine name; renaming is safe. */
  name: string;
  description: string | null;
  /** The block type's `api_id`, matching how block instances name their type in `data`. */
  block_type: string;
  data: JsonText;
  created_by: string | null;
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
  /**
   * What a screen reader announces in place of the image.
   *
   * Three states, not two: `null` is "nobody has described it", `''` is "somebody decided it needs
   * no description", and an actual string is the description. The accessibility checker reports the
   * first and leaves the second alone — collapsing them makes every divider and icon a permanent
   * complaint. Ask through `needsAltText`, never `!alt_text`, which cannot tell them apart.
   */
  alt_text: string | null;
  title: string | null;
  /**
   * Normalised (0-1) focal point and crop offsets, stored independently of pixels so one asset
   * drives a hero crop, a square thumb, and a portrait card without pre-generating any of them.
   * Authored in the hotspot editor and resolved for rendering by `TaprootImage`.
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

/** What produced a revision. A restore appends a new revision rather than rewinding the log. */
export type RevisionReason = 'create' | 'save' | 'restore';

/**
 * An append-only snapshot of a content item's authored content, taken after every save.
 *
 * Only authored content is captured — not `path`, `depth`, or `position`, which are derived from
 * the slug and parent at write time. A restore recomputes them through the normal update path so
 * descendants and redirects stay consistent; `path` is kept for display alone.
 */
export interface RevisionsTable {
  id: string;
  content_item_id: string;
  /** 1-based and monotonic per item, unique with `content_item_id`. Never reused. */
  revision_number: number;
  title: string;
  slug: string;
  /** Where the item lived when the snapshot was taken. Display only; never restored verbatim. */
  path: string;
  status: ContentStatus;
  data: JsonText;
  seo: JsonText;
  reason: RevisionReason;
  /** The revision number this one restored, set only when `reason` is `restore`. */
  restored_from: number | null;
  created_by: string | null;
  created_at: Timestamp;
}

// ---------------------------------------------------------------------------
// Content Releases
// ---------------------------------------------------------------------------

/**
 * Where a release is in its life.
 *
 * `blocked` is the only one that needs explaining: a scheduled release whose moment arrived and
 * whose pre-flight refused it. It exists for the unattended case alone — a release that fails
 * pre-flight while an editor is looking at the screen simply shows them the reasons and stays put,
 * because there is somebody there to act. One that fails at 3am has nobody, and leaving it
 * `scheduled` would mean sweeping the same broken content every minute until someone noticed.
 */
export type ReleaseStatus = 'open' | 'scheduled' | 'published' | 'blocked';

/**
 * A named batch of content staged to go live together.
 *
 * The reasons a release cannot simply be "a list of item ids to publish" are all in
 * `ReleaseItemsTable`: the point is that the *content* waits with it, so a live page can be edited
 * for a launch without the edit reaching visitors in the meantime.
 */
export interface ReleasesTable {
  id: string;
  name: string;
  description: string | null;
  status: ReleaseStatus;
  /** When a `scheduled` release should go live. Mirrors `content_items.publish_at`. */
  publish_at: string | null;
  published_at: string | null;
  created_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/**
 * One item's pending version, waiting inside a release.
 *
 * Carries its own authored content rather than pointing at a revision. A revision is a frozen
 * record of what the live item *has been*; a staged version is editable and has never been live,
 * so referencing one would mean every edit to unpublished content wrote a line into the history of
 * a page that never showed it.
 *
 * `parent_id` is deliberately absent, matching `RevisionsTable`. A staged `slug` is captured
 * because it is authored beside the title, and publishing one cascades paths and writes redirects
 * through the ordinary update path.
 */
export interface ReleaseItemsTable {
  id: string;
  release_id: string;
  content_item_id: string;
  title: string;
  slug: string;
  data: JsonText;
  seo: JsonText;
  staged_by: string | null;
  /**
   * When this staged version reached its item, or null if it has not.
   *
   * Per-item because a release publish is N writes and cannot be one statement — each item's update
   * is already its own batch of path rewrites, redirects, and a revision, and D1 has no interactive
   * transaction to wrap them in. Pre-flight validation is what stops "item 4 of 12 fails" from
   * happening; this is what makes the residue of a genuine mid-flight failure resumable.
   */
  published_at: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

// ---------------------------------------------------------------------------
// Taxonomies
// ---------------------------------------------------------------------------

/**
 * A term tree, attachable to any content type through a `taxonomy` field.
 *
 * There is no join table between taxonomies and content types: a type is attached to a taxonomy by
 * having a field configured with its id, which means per-type settings (required, single vs
 * multiple) ride on the existing field system rather than a parallel one.
 */
export interface TaxonomiesTable {
  id: string;
  /** Stable machine name. Immutable after creation. */
  api_id: string;
  name: string;
  name_plural: string;
  description: string | null;
  /** Whether terms may nest. A flat tag list and a department tree differ only in this. */
  hierarchical: SqlBool;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface TermsTable {
  id: string;
  taxonomy_id: string;
  parent_id: string | null;
  /** Unique among siblings within its taxonomy, not globally. */
  slug: string;
  name: string;
  description: string | null;
  depth: number;
  position: number;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/**
 * A derived index of which items carry which terms, rebuilt from `content_items.data` on save.
 *
 * Not the source of truth — see the 0003 migration for why the authored value stays in `data`.
 * `field_api_id` is part of the key so two taxonomy fields pointing at the same taxonomy stay
 * independently rebuildable.
 */
export interface TaxonomyAssignmentsTable {
  content_item_id: string;
  field_api_id: string;
  term_id: string;
}

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------

/** What a menu item points at. Exactly one of the matching columns is set. */
export type MenuTargetType = 'item' | 'term' | 'url';

export interface MenusTable {
  id: string;
  /** Stable machine name — how a template asks for this menu. Immutable after creation. */
  api_id: string;
  name: string;
  description: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/**
 * One entry in a menu.
 *
 * References its target rather than storing a URL, so a moved page keeps its menu entry pointing
 * at the right place and an unpublished one drops out of the public menu on its own.
 */
export interface MenuItemsTable {
  id: string;
  menu_id: string;
  /** Self-referential parent, for dropdowns. */
  parent_id: string | null;
  position: number;
  depth: number;
  /** Null means "use the target's own title", which keeps a renamed page's entry current. */
  label: string | null;
  target_type: MenuTargetType;
  /** Nulled rather than cascaded when the target is deleted, so the broken entry stays visible. */
  content_item_id: string | null;
  term_id: string | null;
  url: string | null;
  open_in_new_tab: SqlBool;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/**
 * Deployment-wide settings. Exactly one row, id `site` — see `0016_settings`.
 *
 * Every column is nullable and every null means "the built-in default", which is deliberately not
 * the same as an empty string: clearing the title has to put "Taproot" back rather than leave the
 * admin nameless.
 */
export interface SettingsTable {
  id: string;
  title: string | null;
  logo_media_id: string | null;
  /** Hex, one per palette. Null is the accent as written in `admin.css`. */
  accent_light: string | null;
  accent_dark: string | null;
  updated_at: Timestamp;
  updated_by: string | null;
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

/**
 * The full Kysely database interface.
 *
 * Phase 3 added `audit_log`; Phase 3.5 adds `releases` and `release_items`. There is deliberately
 * no `departments` or `role_assignments` table — roles are flat and site-wide, and departments are
 * classification, which `taxonomies` already covers. See SCOPE.md.
 */
export interface Database {
  users: UsersTable;
  api_keys: ApiKeysTable;
  preview_tokens: PreviewTokensTable;
  audit_log: AuditLogTable;
  login_attempts: LoginAttemptsTable;
  login_challenges: LoginChallengesTable;
  totp_recovery_codes: TotpRecoveryCodesTable;
  password_reset_tokens: PasswordResetTokensTable;
  user_credentials: UserCredentialsTable;
  oauth_accounts: OauthAccountsTable;
  totp_secrets: TotpSecretsTable;
  sessions: SessionsTable;
  content_types: ContentTypesTable;
  fields: FieldsTable;
  content_items: ContentItemsTable;
  reusable_blocks: ReusableBlocksTable;
  media: MediaTable;
  redirects: RedirectsTable;
  revisions: RevisionsTable;
  releases: ReleasesTable;
  release_items: ReleaseItemsTable;
  taxonomies: TaxonomiesTable;
  terms: TermsTable;
  taxonomy_assignments: TaxonomyAssignmentsTable;
  menus: MenusTable;
  menu_items: MenuItemsTable;
  settings: SettingsTable;
}

export type User = Selectable<UsersTable>;
export type ApiKeyRow = Selectable<ApiKeysTable>;
export type AuditLogRow = Selectable<AuditLogTable>;
export type PasswordResetTokenRow = Selectable<PasswordResetTokensTable>;
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

export type ReusableBlockRow = Selectable<ReusableBlocksTable>;
export type NewReusableBlock = Insertable<ReusableBlocksTable>;
export type ReusableBlockUpdate = Updateable<ReusableBlocksTable>;

export type MediaRow = Selectable<MediaTable>;
export type NewMedia = Insertable<MediaTable>;
export type MediaUpdate = Updateable<MediaTable>;

export type RedirectRow = Selectable<RedirectsTable>;
export type NewRedirect = Insertable<RedirectsTable>;

export type RevisionRow = Selectable<RevisionsTable>;
export type NewRevision = Insertable<RevisionsTable>;

export type ReleaseRow = Selectable<ReleasesTable>;
export type NewRelease = Insertable<ReleasesTable>;
export type ReleaseUpdate = Updateable<ReleasesTable>;

export type ReleaseItemRow = Selectable<ReleaseItemsTable>;
export type NewReleaseItem = Insertable<ReleaseItemsTable>;
export type ReleaseItemUpdate = Updateable<ReleaseItemsTable>;

export type TaxonomyRow = Selectable<TaxonomiesTable>;
export type NewTaxonomy = Insertable<TaxonomiesTable>;
export type TaxonomyUpdate = Updateable<TaxonomiesTable>;

export type TermRow = Selectable<TermsTable>;
export type NewTerm = Insertable<TermsTable>;
export type TermUpdate = Updateable<TermsTable>;

export type TaxonomyAssignmentRow = Selectable<TaxonomyAssignmentsTable>;

export type MenuRow = Selectable<MenusTable>;
export type NewMenu = Insertable<MenusTable>;
export type MenuUpdate = Updateable<MenusTable>;

export type MenuItemRow = Selectable<MenuItemsTable>;
export type NewMenuItem = Insertable<MenuItemsTable>;
export type MenuItemUpdate = Updateable<MenuItemsTable>;
