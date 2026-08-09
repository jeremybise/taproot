import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

/**
 * Timestamps are stored as ISO-8601 strings rather than native date types.
 *
 * SQLite and D1 have no date type at all, so something has to be chosen; ISO-8601 is the encoding
 * whose lexicographic order already matches chronological order, which is what lets every `order by`
 * and every range filter in the codebase treat these as ordinary indexed text.
 */
export type Timestamp = ColumnType<string, string | undefined, string>;

/**
 * Booleans are stored as integers (0/1) because SQLite and D1 have no boolean type. The `select`
 * side is typed as `number` deliberately: repositories convert explicitly via `toBool`/`fromBool`
 * so the conversion stays greppable instead of hiding in a plugin.
 */
export type SqlBool = ColumnType<number, number | undefined, number>;

/**
 * JSON payloads are TEXT, serialised and parsed explicitly at the repository rather than by a
 * plugin — `toSqlValue` throws on a plain object reaching the driver, so the conversion stays
 * greppable. Queries never read into these; see `content_item_values` and `content_item_text` for
 * why the answer is a derived index rather than `json_extract`.
 */
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
/**
 * What a key may do.
 *
 * `search:write` is the first scope that is not a read, and it is deliberately narrow: it admits
 * appending a row to `search_queries` and nothing else. It exists because a search log cannot be
 * built from the delivery response — that response is cached for a day, so the second search for a
 * term never reaches an origin and a request-counting log would report the most popular searches as
 * the rarest.
 */
export type ApiKeyScope = 'content:read' | 'search:write';

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
 *
 * Re-exported from `content/contentTypeKind.ts` rather than declared here, so the list of kinds is
 * written once and a Zod enum, a runtime guard and this type cannot drift apart. Imported as well as
 * re-exported, because `ContentTypesTable` below needs the name in local scope.
 */
import type { ContentTypeKind } from '../content/contentTypeKind.js';
export type { ContentTypeKind };

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
  /**
   * Whether a `collection`'s items have pages of their own. 1 for every other kind.
   *
   * Off is what a staff directory wants: the people are real content items, listed on a page the
   * site builds, and none of them is a URL. Read through `typeHasItemPages`, never directly — the
   * delivery resolver, the listing filters and the preview link all gate on it, and a call site
   * reading the column itself is one that will forget the kind check.
   */
  item_pages: number;
  /**
   * How an item or block instance of this type is summarised in one line, as a template.
   *
   * `{{ api_id }}` tokens filled from the item's `data` — `{{ headline }} · {{ link }}` — rendered by
   * `renderSummary` and always as **text**. Null means "use the item's own title", which is right for
   * most content types; a block instance has no title, so its type's name is the floor instead.
   *
   * This replaced `title_field`, which named a single field, was offered by the settings screen as
   * "which field labels an item in admin lists", and was read by no list at all. See
   * `0027_summary_template` for why it was widened rather than merely wired up.
   */
  summary_template: string | null;
  /**
   * Which columns this type's admin list shows, as a JSON array of keys.
   *
   * A key is either a field's `api_id` or a built-in name (`title`, `path`, `status`, `updated`,
   * `created`). Null means the five built-ins every list showed before this was configurable, which
   * is what keeps the migration from changing every screen somebody was used to.
   *
   * Read through `resolveListColumns`, never parsed at a call site: a key naming a field that has
   * since been deleted is dropped rather than rendering an empty column, and that rule has to hold
   * everywhere.
   */
  list_columns: JsonText | null;
  /** One of `ITEM_SORTS`. Null means `path`, the order every list had before this. */
  list_sort: string | null;
  /**
   * The field `field_asc` / `field_desc` order by.
   *
   * Null for every other order. A field named here and later deleted drops the sort back to `path`
   * rather than erroring — the same rule a query field's `dateFieldApiId` follows, and for the same
   * reason: a live screen must not break for a configuration change made weeks earlier elsewhere.
   */
  list_sort_field: string | null;
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
 * The v1 field set from the scope doc, plus `link`. Which of these can be authored is recorded in
 * exactly one place — `DEFERRED_FIELD_TYPES` — and it is currently empty.
 *
 * `link` is not a `relation` with extra options: a relation names a content item and cannot express
 * an external address, a file, or "open in a new tab", which between them are most of what a button
 * is. It stores whichever of the three a link actually is, discriminated by `kind`.
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
  | 'link'
  /**
   * A reference to a reusable text snippet, by its `api_id`.
   *
   * The structured half of the same feature `{{ tuition }}` tokens provide. A token is right when
   * the value goes *inside a sentence*; this is right when the value **is** the field — a chart's
   * data point, a figure in a stat block — where the consumer wants `4500` rather than the sentence
   * "$4,500" it would have to parse back.
   *
   * Stores the `api_id` rather than the row's uuid, which is the one place this deviates from
   * `relation` and `media`. The token syntax already makes `api_id` the public name of a snippet and
   * the delivery map has to be keyed by it regardless, so storing a uuid here would be a second
   * spelling of one fact. It is safe because `api_id` is immutable.
   */
  | 'snippet'
  /**
   * A third-party page framed in an `<iframe>` — a video, a map, a form.
   *
   * **The alternative was a raw HTML field, and it was rejected rather than deferred.** Richtext is
   * sanitised inside `validateItemData` precisely because a stored value rendered with `set:html` is
   * stored XSS against every visitor and every editor; a field type whose whole purpose is to skip
   * that would be the first write path in Taproot that does. It would also hand script execution to
   * `contributor`, the lowest role there is, since roles are flat and site-wide — and gating it
   * would need "a field only some roles may edit", which does not exist here.
   *
   * So this stores a **URL and a title**, never markup, and the consumer's `TaprootEmbed` builds the
   * frame. That is what lets the `<iframe>`'s `sandbox`, `title`, `referrerpolicy` and host be facts
   * the CMS guarantees rather than things an author remembered. The two differ only in whether an
   * allowlist exists, and the allowlist is the cheap part.
   *
   * Anything with a *protocol* rather than just a URL — a vendor script that measures the parent
   * page, an embed injected by a `<script>` in the host document — is a block component on the site,
   * where a developer writes it in git. `BLOCK_COMPONENTS` is that escape hatch and is strictly
   * better than a raw HTML field for the purpose: arbitrary JS, reviewed, and no author can inject
   * anything.
   */
  | 'embed'
  | 'block'
  | 'repeater'
  /**
   * A saved question about content, resolved at delivery — "the six soonest Arts events".
   *
   * Not a `relation` with filters. A relation names items an editor chose, and the set is only
   * right until somebody publishes another one; a query names a *rule*, and its answer changes
   * without anybody editing the page it sits on. That difference is the whole feature, and it is
   * also why the two coexist rather than one absorbing the other.
   */
  | 'query';

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
  /**
   * When this field is shown, as one condition on a sibling — `{ field, operator, value? }`, or
   * null for unconditional.
   *
   * Its own column rather than a key in `config` because it means the same thing for every field
   * type, so `config` would carry twelve identical copies. See `validation/visibility.ts` for the
   * evaluator both the editor and `validateItemData` call, and `0018_field_visibility` for why a
   * hidden field's value is kept rather than dropped.
   */
  visible_when: string | null;
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

/**
 * A value defined once and used in prose across the site — current tuition, a deadline, a phone
 * number.
 *
 * The same argument as `reusable_blocks` one size down: a reusable block owns a *region* of a page,
 * and this owns a *value inside a sentence*. Content stores `{{ api_id }}` and no copy, so changing
 * the row changes every page at once, and there is never a stale second copy to disagree with it.
 */
export interface SnippetsTable {
  id: string;
  /**
   * The machine name content refers to, as `{{ api_id }}`. **Immutable after creation.**
   *
   * Unlike `reusable_blocks.name`, which is a label and safe to rename, this *is* the reference.
   * Renaming it would break every stored token, and rewriting them across `content_items.data` is a
   * second implementation of the problem snippets exist to remove.
   */
  api_id: string;
  /** How an editor finds it in a list. Renaming is safe — nothing refers to it. */
  name: string;
  description: string | null;
  kind: SnippetKind;
  /**
   * The canonical value: the string, the bare number, or an ISO date.
   *
   * Kept apart from `display` so one row serves both a sentence and a chart — prose substitutes the
   * display form while a block component plots this.
   */
  value: string;
  /**
   * How it reads in prose, when the derived form is not what the editor wants.
   *
   * Null means "derive it" — `renderSnippet` formats a number or a date, and uses `value` verbatim
   * for text. An editor who wants `$4,500` rather than `4,500`, or `Fall 2026` rather than a date,
   * sets it here.
   */
  display: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/**
 * What kind of value a snippet holds.
 *
 * `text` is the common case. `number` and `date` exist because the canonical value has a *use*
 * beyond reading — a chart plots a number, and a date can be compared — so storing them as free text
 * would mean every consumer parsing prose back into data.
 */
export type SnippetKind = 'text' | 'number' | 'date';

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

/**
 * Cache purges that failed and are waiting for the sweep to retry them — see
 * `0023_pending_purges` for why a fire-and-forget purge needs a durable second chance.
 */
export interface PendingPurgesTable {
  id: string;
  /** `self` for this deployment's own edge cache, `site` for a consumer's over HTTP. */
  target: PurgeTarget;
  /** Comma-separated, exactly as a `Cache-Tag` header spells them. Empty means purge everything. */
  tags: string;
  attempts: number;
  last_error: string | null;
  next_attempt_at: string;
  created_at: string;
}

/** Which cache a queued purge is replaying against. */
export type PurgeTarget = 'self' | 'site';

// Database
// ---------------------------------------------------------------------------

/**
 * The full Kysely database interface.
 *
 * Phase 3 added `audit_log`; Phase 3.5 adds `releases` and `release_items`. There is deliberately
 * no `departments` or `role_assignments` table — roles are flat and site-wide, and departments are
 * classification, which `taxonomies` already covers. See SCOPE.md.
 */
/**
 * A derived index of scalar field values — see `0019_item_values` for why it exists at all.
 *
 * Same status as `taxonomy_assignments`: **not the source of truth.** The authored value lives in
 * `content_items.data` and this is rebuilt from it inside the same atomic batch as the item write,
 * which is what keeps a restored revision correct. One row per value, so a multi-value `select`
 * contributes several.
 */
export interface ContentItemValuesTable {
  content_item_id: string;
  field_api_id: string;
  /** The canonical string form, always written. */
  value_text: string | null;
  /** Numbers, and booleans as 0/1 — so `10` sorts above `9` rather than below it. */
  value_num: number | null;
  /** ISO 8601, which is why it sorts correctly as text. */
  value_date: string | null;
}

/**
 * An item's searchable text, flattened out of `data` — see `0021_item_text`.
 *
 * One row per item, always written: an empty string means "indexed, holds no prose", where a
 * missing row means the item has never been indexed at all.
 */
export interface ContentItemTextTable {
  content_item_id: string;
  text: string;
}

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
  snippets: SnippetsTable;
  media: MediaTable;
  redirects: RedirectsTable;
  revisions: RevisionsTable;
  releases: ReleasesTable;
  release_items: ReleaseItemsTable;
  taxonomies: TaxonomiesTable;
  terms: TermsTable;
  taxonomy_assignments: TaxonomyAssignmentsTable;
  content_item_values: ContentItemValuesTable;
  content_item_text: ContentItemTextTable;
  menus: MenusTable;
  menu_items: MenuItemsTable;
  settings: SettingsTable;
  pending_purges: PendingPurgesTable;
  search_queries: SearchQueriesTable;
}

export type User = Selectable<UsersTable>;
export type ApiKeyRow = Selectable<ApiKeysTable>;
export type PendingPurgeRow = Selectable<PendingPurgesTable>;
export type AuditLogRow = Selectable<AuditLogTable>;

/** Where a logged search came from. See `0026_search_log` for why they are not one bucket. */
export type SearchSource = 'page' | 'suggest' | 'abandoned';

export interface SearchQueriesTable {
  id: string;
  /** As typed, trimmed and capped. */
  query: string;
  /** Folded for grouping, by `normalizeSearchQuery` and never by SQL's `lower()`. */
  normalized: string;
  result_count: number;
  source: string;
  created_at: Timestamp;
}

export type SearchQueryRow = Selectable<SearchQueriesTable>;
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
