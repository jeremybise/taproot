import type { Kysely } from 'kysely';

import type {
  ContentStatus,
  ContentTypeKind,
  Database,
  FieldRow,
  MediaRow,
} from '../db/schema.js';
import type { StorageAdapter } from '../storage/types.js';
import { parseJson } from '../db/values.js';
import { getContentType } from './types.js';
import { getItemByPath, getRedirect, visibleToPublic, type ContentItem } from './items.js';
import { resolveMenu, type ResolvedMenuItem } from './menus.js';
import { ancestorPaths, normalizePath } from './paths.js';
import { resolveItemBlocks } from './reusableBlocks.js';
import { resolveSeo } from './seo.js';

/**
 * The delivery layer: everything a page needs, in one answer.
 *
 * This exists because a consumer reading over HTTP cannot afford the shape the embedded demo site
 * used. `apps/web/src/pages/[...path].astro` makes twelve-plus separate queries to render one page —
 * the item, its type, its children, one lookup *per ancestor* for breadcrumbs, the blocks, an
 * `og:image` row, and the redirect fallback — which is fine against a local database and
 * indefensible as twelve HTTP round trips.
 *
 * It lives in core rather than in the route for the reason `resolveSeo` does: the studio's own
 * preview and the delivery API must resolve identically, and a rule implemented twice is one that
 * will disagree. `visibleToPublic` stays the single visibility predicate — nothing here reimplements
 * "what may a visitor see".
 *
 * **References are returned as lookup maps, not inlined into `data`.** Replacing a media id with an
 * object would read more nicely in a template and would be wrong three ways: `data` would stop
 * matching the field types the CMS validates against (and therefore the generated types), an image
 * used twice would be serialised twice, and the payload could no longer be handed back to a write.
 * The maps deduplicate, and the consumer looks up by the id it already has.
 */

export interface DeliveryMedia {
  id: string;
  /** Absolute. A relative URL is useless to a consumer on another origin. */
  url: string;
  alt: string | null;
  title: string | null;
  mimeType: string;
  width: number | null;
  height: number | null;
  /** Normalised focal point and crop, so a consumer can resolve its own aspect ratios. */
  hotspot: { x: number; y: number } | null;
  crop: { top: number; right: number; bottom: number; left: number } | null;
}

/** A content item referenced through a relation field, or sitting in a breadcrumb. */
export interface DeliveryItemRef {
  id: string;
  title: string;
  path: string;
  status: ContentStatus;
}

export interface DeliveryTermRef {
  id: string;
  name: string;
  slug: string;
  taxonomyApiId: string;
}

export interface DeliveryField {
  apiId: string;
  label: string;
  type: FieldRow['type'];
  required: boolean;
  helpText: string | null;
  position: number;
  config: Record<string, unknown>;
}

export interface DeliveryItem {
  id: string;
  title: string;
  slug: string;
  path: string;
  status: ContentStatus;
  publishedAt: string | null;
  updatedAt: string;
  contentType: {
    apiId: string;
    name: string;
    namePlural: string;
    kind: ContentTypeKind;
  };
  fields: DeliveryField[];
  /** Field values keyed by `api_id`, with blocks already dereferenced. */
  data: Record<string, unknown>;
  seo: {
    title: string;
    description: string | null;
    ogImageId: string | null;
    noIndex: boolean;
  };
}

export type DeliveryResult =
  | {
      kind: 'item';
      item: DeliveryItem;
      /** Ancestors, outermost first. Excludes the item itself. */
      breadcrumbs: DeliveryItemRef[];
      /** Visible children, for "in this section" navigation. */
      children: DeliveryItemRef[];
      media: Record<string, DeliveryMedia>;
      references: Record<string, DeliveryItemRef>;
      terms: Record<string, DeliveryTermRef>;
    }
  | { kind: 'redirect'; to: string; status: number }
  | { kind: 'not_found' };

export interface DeliveryOptions {
  /** Absolute origin for media URLs. */
  origin: string;
  storage: StorageAdapter;
  /**
   * Include content a visitor cannot see.
   *
   * Off by default, and the default is the security property: a delivery route that forgot to pass
   * this serves published content, not drafts.
   */
  includeUnpublished?: boolean;
}

/**
 * Resolve a request path to everything needed to render it.
 *
 * Resolution order matches the embedded route exactly, and the order matters: an item wins over a
 * redirect, because a redirect exists to say content moved *away* from a path and a live page now
 * occupying it should be served. Term archives are the consumer's business — Taproot has no opinion
 * about which taxonomies deserve public pages — so this returns `not_found` for one and the site
 * decides what to do next.
 */
export async function resolveDelivery(
  db: Kysely<Database>,
  path: string,
  options: DeliveryOptions,
): Promise<DeliveryResult> {
  const normalized = normalizePath(path);

  const item = await getItemByPath(db, normalized, {
    publishedOnly: !options.includeUnpublished,
  });

  if (!item) {
    const redirect = await getRedirect(db, normalized);
    if (redirect) return { kind: 'redirect', to: redirect.to, status: redirect.status };
    return { kind: 'not_found' };
  }

  return buildItemPayload(db, item, options);
}

/**
 * The payload for an item already in hand.
 *
 * Split from `resolveDelivery` so a preview by id — and, in 3.75b, a release's staged version — can
 * produce exactly the same shape without going through a path lookup. One builder, so a preview
 * cannot drift from the page it is previewing.
 */
export async function buildItemPayload(
  db: Kysely<Database>,
  item: ContentItem,
  options: DeliveryOptions,
): Promise<Extract<DeliveryResult, { kind: 'item' }>> {
  const contentType = await getContentType(db, item.content_type_id);
  if (!contentType) {
    throw new Error(`Content item ${item.id} references a content type that no longer exists.`);
  }

  // Blocks first: reusable-block references have to be dereferenced before anything walks the data
  // looking for media and relation ids, or the ids inside a shared block are missed.
  const data = await resolveItemBlocks(db, contentType.fields, item.data);

  /**
   * Breadcrumbs in one query rather than one per ancestor.
   *
   * The embedded route walks `ancestorPaths` with a lookup each, which is four round trips for a
   * page four levels deep. `path` is indexed and unique, so `in` costs the same as one of them.
   */
  const ancestors = ancestorPaths(item.path);
  const breadcrumbRows = ancestors.length
    ? await db
        .selectFrom('content_items')
        .select(['id', 'title', 'path', 'status'])
        .where('path', 'in', ancestors)
        .execute()
    : [];

  const byPath = new Map(breadcrumbRows.map((row) => [row.path, row]));
  const breadcrumbs = ancestors
    .map((ancestorPath) => byPath.get(ancestorPath))
    .filter((row): row is (typeof breadcrumbRows)[number] => row !== undefined)
    .map(toItemRef);

  let childQuery = db
    .selectFrom('content_items')
    .select(['id', 'title', 'path', 'status'])
    .where('parent_id', '=', item.id)
    .orderBy('position')
    .orderBy('title');

  // Children follow the same visibility rule as everything else. A published page listing its
  // unpublished children would leak their titles and paths.
  if (!options.includeUnpublished) childQuery = childQuery.where(visibleToPublic);
  const children = (await childQuery.execute()).map(toItemRef);

  const collected = collectReferences(contentType.fields, data);
  // The social image is referenced from `seo`, not from a field, so it would be missed by a walk
  // over `data` alone — and it is the one image every page needs absolutely.
  const seo = resolveSeo(item, contentType);
  if (seo.ogImageId) collected.mediaIds.add(seo.ogImageId);

  const [media, references, terms] = await Promise.all([
    loadMedia(db, [...collected.mediaIds], options),
    loadItemRefs(db, [...collected.itemIds]),
    loadTermRefs(db, [...collected.termIds]),
  ]);

  return {
    kind: 'item',
    item: {
      id: item.id,
      title: item.title,
      slug: item.slug,
      path: item.path,
      status: item.status,
      publishedAt: item.published_at,
      updatedAt: item.updated_at,
      contentType: {
        apiId: contentType.api_id,
        name: contentType.name,
        namePlural: contentType.name_plural,
        kind: contentType.kind,
      },
      fields: contentType.fields.map(toDeliveryField),
      data,
      seo: {
        title: seo.title,
        description: seo.description ?? null,
        ogImageId: seo.ogImageId ?? null,
        noIndex: seo.noIndex,
      },
    },
    breadcrumbs,
    children,
    media,
    references,
    terms,
  };
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export interface DeliveryTypeSchema {
  apiId: string;
  name: string;
  namePlural: string;
  kind: ContentTypeKind;
  urlPrefix: string | null;
  fields: DeliveryField[];
}

export interface DeliverySchema {
  contentTypes: DeliveryTypeSchema[];
  blockTypes: DeliveryTypeSchema[];
}

/**
 * The whole content model, for generating a consumer's types.
 *
 * SCOPE calls type generation "the point of the split rather than a nicety". Today's client is typed
 * over table rows — `data: Record<string, unknown>` — which tells a consumer nothing about *their*
 * content. A site with an `event` type wants `Event`, with the fields it declared.
 *
 * Block types are included because a block field's values need types too, and a block type is a
 * content type whose instances are never addressed. They are asked for explicitly rather than by
 * flipping `listContentTypes`' default, which is load-bearing everywhere else.
 *
 * Fields come back in one query for every type rather than one query per type — the same shape
 * `blockTypeRegistry` uses, and the reason it exists.
 */
export async function deliverySchema(db: Kysely<Database>): Promise<DeliverySchema> {
  const types = await db
    .selectFrom('content_types')
    .selectAll()
    .orderBy('position')
    .orderBy('name')
    .execute();

  if (types.length === 0) return { contentTypes: [], blockTypes: [] };

  const fields = await db
    .selectFrom('fields')
    .selectAll()
    .where(
      'content_type_id',
      'in',
      types.map((type) => type.id),
    )
    .orderBy('position')
    .orderBy('created_at')
    .execute();

  const byType = new Map<string, FieldRow[]>();
  for (const field of fields) {
    const list = byType.get(field.content_type_id) ?? [];
    list.push(field);
    byType.set(field.content_type_id, list);
  }

  const shape = (type: (typeof types)[number]): DeliveryTypeSchema => ({
    apiId: type.api_id,
    name: type.name,
    namePlural: type.name_plural,
    kind: type.kind,
    urlPrefix: type.url_prefix,
    fields: (byType.get(type.id) ?? []).map(toDeliveryField),
  });

  return {
    contentTypes: types.filter((type) => type.kind !== 'block').map(shape),
    blockTypes: types.filter((type) => type.kind === 'block').map(shape),
  };
}

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------

/**
 * A menu entry with its target described rather than turned into a URL.
 *
 * This is the answer to the question SCOPE flagged to decide rather than discover: `resolveMenu`
 * takes a `termHref` **callback**, and a function cannot cross an HTTP boundary.
 *
 * The alternative was to revisit "Taproot has no opinion about term URLs" and let the CMS hold a
 * setting for which taxonomies get public pages. That would have been the wrong trade. Which
 * taxonomies deserve URLs depends on the routes a site actually serves — a review status or an
 * internal owner classifies content without wanting a page each — so it is the consumer's judgement,
 * and moving it server-side would make Taproot assert something it cannot know. Returning the term
 * unresolved keeps the decision exactly where it was, on the other side of the wire.
 */
export type DeliveryMenuTarget =
  | { type: 'item'; path: string }
  | { type: 'term'; id: string; name: string; slug: string; taxonomyApiId: string }
  | { type: 'url'; url: string };

export interface DeliveryMenuItem {
  id: string;
  label: string;
  openInNewTab: boolean;
  target: DeliveryMenuTarget;
  children: DeliveryMenuItem[];
}

/**
 * Every term is treated as routable while resolving, then the href is thrown away.
 *
 * `resolveMenu` drops term entries it cannot build a URL for, which is right when it is rendering a
 * menu and wrong here: the consumer has not been asked yet. Passing a placeholder keeps them in the
 * tree; the value itself never reaches anybody, because `toDeliveryMenuItem` reads `term` and
 * ignores `href` for term entries.
 */
const TERM_PLACEHOLDER = '#term';

export async function deliverMenu(
  db: Kysely<Database>,
  apiId: string,
): Promise<DeliveryMenuItem[]> {
  const tree = await resolveMenu(db, apiId, {
    publishedOnly: true,
    termHref: () => TERM_PLACEHOLDER,
  });

  return tree.map(toDeliveryMenuItem).filter((entry): entry is DeliveryMenuItem => entry !== null);
}

function toDeliveryMenuItem(entry: ResolvedMenuItem): DeliveryMenuItem | null {
  let target: DeliveryMenuTarget | null = null;

  if (entry.targetType === 'term' && entry.term) {
    target = { type: 'term', ...entry.term };
  } else if (entry.targetType === 'item' && entry.href) {
    target = { type: 'item', path: entry.href };
  } else if (entry.targetType === 'url' && entry.href) {
    target = { type: 'url', url: entry.href };
  }

  // A broken entry is simply absent. The admin is where a broken menu row is meant to be visible
  // and fixed; a consumer can do nothing with one but render a dead link.
  if (!target) return null;

  return {
    id: entry.id,
    label: entry.label,
    openInNewTab: entry.openInNewTab,
    target,
    children: entry.children
      .map(toDeliveryMenuItem)
      .filter((child): child is DeliveryMenuItem => child !== null),
  };
}

/**
 * Turn delivered menu entries into hrefs, applying the site's own term-URL policy.
 *
 * The other half of the callback that could not cross the wire — the consumer supplies exactly the
 * `termHref` it would have passed to `resolveMenu`, and gets the same result. Shipped here so both
 * sides of the boundary share one implementation; it moves into the consumer package in 3.75b.
 */
export function applyTermHrefs(
  items: DeliveryMenuItem[],
  termHref: (term: { id: string; name: string; slug: string; taxonomyApiId: string }) => string | null,
): { id: string; label: string; href: string; openInNewTab: boolean; children: ReturnType<typeof applyTermHrefs> }[] {
  return items
    .map((entry) => {
      const href =
        entry.target.type === 'item'
          ? entry.target.path
          : entry.target.type === 'url'
            ? entry.target.url
            : termHref(entry.target);

      // A term the site publishes no page for drops out, which is what `resolveMenu` does with the
      // same answer. Nothing is wrong — there is simply nowhere to link to.
      if (href === null) return null;

      return {
        id: entry.id,
        label: entry.label,
        href,
        openInNewTab: entry.openInNewTab,
        children: applyTermHrefs(entry.children, termHref),
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
}

// ---------------------------------------------------------------------------
// Reference collection
// ---------------------------------------------------------------------------

export interface CollectedReferences {
  mediaIds: Set<string>;
  itemIds: Set<string>;
  termIds: Set<string>;
}

/**
 * Walk a resolved data blob and collect every id it points at.
 *
 * Driven by the field definitions rather than by pattern-matching strings, which is the difference
 * between finding real references and finding anything that looks like a uuid. The same distinction
 * `itemsReferencing` makes when it reads the `fields` table before searching `data`: a bare `LIKE`
 * would also match an id sitting in a body of text and report a relationship that does not exist.
 *
 * Recurses through blocks and repeaters, because both hold values belonging to fields of their own.
 * Blocks must already be dereferenced — a reusable block still stored as `{ ref }` carries none of
 * its content here.
 */
export function collectReferences(
  fields: FieldRow[],
  data: Record<string, unknown>,
  into: CollectedReferences = { mediaIds: new Set(), itemIds: new Set(), termIds: new Set() },
): CollectedReferences {
  for (const field of fields) {
    const value = data[field.api_id];
    if (value === undefined || value === null) continue;

    // A media or relation field stores a bare id when single and an array when multiple, following
    // its own config — so both shapes are read rather than one being assumed.
    const ids = Array.isArray(value) ? value : [value];

    switch (field.type) {
      case 'media':
        for (const id of ids) if (typeof id === 'string') into.mediaIds.add(id);
        break;
      case 'relation':
        for (const id of ids) if (typeof id === 'string') into.itemIds.add(id);
        break;
      case 'taxonomy':
        for (const id of ids) if (typeof id === 'string') into.termIds.add(id);
        break;
      case 'block':
        for (const block of ids) collectFromBlock(block, into);
        break;
      case 'repeater':
        for (const row of ids) collectFromRepeater(field, row, into);
        break;
      default:
        break;
    }
  }

  return into;
}

/**
 * A block instance, whose field values belong to its *type* rather than to the field holding it.
 *
 * The block's own field definitions are not available here, so this walks the values structurally.
 * That is the one place a heuristic is unavoidable — but it stays bounded to values inside a block,
 * never the whole document, and it can only ever over-collect an id that then resolves to nothing
 * and is omitted from the map.
 */
function collectFromBlock(block: unknown, into: CollectedReferences): void {
  if (typeof block !== 'object' || block === null) return;
  const record = block as Record<string, unknown>;

  for (const [key, value] of Object.entries(record)) {
    if (key === 'id' || key === 'type' || key === 'ref') continue;
    collectLoose(value, into);
  }
}

function collectFromRepeater(field: FieldRow, row: unknown, into: CollectedReferences): void {
  if (typeof row !== 'object' || row === null) return;
  const config = parseJson<{ fields?: FieldRow[] }>(field.config, {});
  // A repeater's sub-fields live in its own config rather than the `fields` table, so the
  // definitions are right here and the walk stays definition-driven.
  if (Array.isArray(config.fields)) {
    collectReferences(config.fields, row as Record<string, unknown>, into);
  }
}

/**
 * Structural collection, used only inside a block.
 *
 * Every string that could be an id is offered to all three sets. Over-collecting is safe — an id
 * that resolves to nothing is simply absent from the map — and under-collecting would mean a
 * consumer rendering a block with a missing image.
 */
function collectLoose(value: unknown, into: CollectedReferences): void {
  if (typeof value === 'string') {
    // Only values shaped like an id, so prose is not offered as a lookup key.
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
      into.mediaIds.add(value);
      into.itemIds.add(value);
      into.termIds.add(value);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) collectLoose(entry, into);
    return;
  }

  if (typeof value === 'object' && value !== null) {
    for (const entry of Object.values(value)) collectLoose(entry, into);
  }
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

async function loadMedia(
  db: Kysely<Database>,
  ids: string[],
  options: DeliveryOptions,
): Promise<Record<string, DeliveryMedia>> {
  if (ids.length === 0) return {};

  const rows = await db.selectFrom('media').selectAll().where('id', 'in', ids).execute();

  const out: Record<string, DeliveryMedia> = {};
  for (const row of rows) out[row.id] = toDeliveryMedia(row, options);
  return out;
}

function toDeliveryMedia(row: MediaRow, options: DeliveryOptions): DeliveryMedia {
  return {
    id: row.id,
    /**
     * Absolute, always.
     *
     * The storage adapter may already return an absolute URL (R2 with a custom domain) or a path
     * (the Worker-served route, and local development). `new URL(value, origin)` handles both and
     * leaves an already-absolute URL alone — which is what makes one code path correct for every
     * deployment shape.
     */
    url: new URL(options.storage.publicUrl(row.storage_key), options.origin).toString(),
    alt: row.alt_text,
    title: row.title,
    mimeType: row.mime_type,
    width: row.width,
    height: row.height,
    hotspot:
      row.hotspot_x !== null && row.hotspot_y !== null
        ? { x: row.hotspot_x, y: row.hotspot_y }
        : null,
    crop:
      row.crop_top !== null &&
      row.crop_right !== null &&
      row.crop_bottom !== null &&
      row.crop_left !== null
        ? {
            top: row.crop_top,
            right: row.crop_right,
            bottom: row.crop_bottom,
            left: row.crop_left,
          }
        : null,
  };
}

async function loadItemRefs(
  db: Kysely<Database>,
  ids: string[],
): Promise<Record<string, DeliveryItemRef>> {
  if (ids.length === 0) return {};

  const rows = await db
    .selectFrom('content_items')
    .select(['id', 'title', 'path', 'status'])
    /**
     * Relation targets are filtered by visibility too.
     *
     * A "related programmes" list must not name a draft. This is the same predicate the item lookup
     * uses, which is the point of it being one function: a consumer cannot be handed something a
     * visitor could not otherwise see.
     */
    .where(visibleToPublic)
    .where('id', 'in', ids)
    .execute();

  const out: Record<string, DeliveryItemRef> = {};
  for (const row of rows) out[row.id] = toItemRef(row);
  return out;
}

async function loadTermRefs(
  db: Kysely<Database>,
  ids: string[],
): Promise<Record<string, DeliveryTermRef>> {
  if (ids.length === 0) return {};

  const rows = await db
    .selectFrom('terms')
    .innerJoin('taxonomies', 'taxonomies.id', 'terms.taxonomy_id')
    .select([
      'terms.id as id',
      'terms.name as name',
      'terms.slug as slug',
      'taxonomies.api_id as taxonomy_api_id',
    ])
    .where('terms.id', 'in', ids)
    .execute();

  const out: Record<string, DeliveryTermRef> = {};
  for (const row of rows) {
    out[row.id] = {
      id: row.id,
      name: row.name,
      slug: row.slug,
      taxonomyApiId: row.taxonomy_api_id,
    };
  }
  return out;
}

function toItemRef(row: {
  id: string;
  title: string;
  path: string;
  status: string;
}): DeliveryItemRef {
  return {
    id: row.id,
    title: row.title,
    path: row.path,
    status: row.status as ContentStatus,
  };
}

function toDeliveryField(field: FieldRow): DeliveryField {
  return {
    apiId: field.api_id,
    label: field.label,
    type: field.type,
    required: field.required === 1,
    helpText: field.help_text,
    position: field.position,
    config: parseJson<Record<string, unknown>>(field.config, {}),
  };
}
