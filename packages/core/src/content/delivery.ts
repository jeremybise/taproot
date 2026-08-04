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
import { repeaterRowFields } from '../validation/fields.js';
import { parseVisibility, type VisibilityCondition } from '../validation/visibility.js';
import { resolveItemQueries, type DeliveryQueryResult } from './itemQueries.js';
import { blockTypeRegistry, getContentType } from './types.js';
import { getItemByPath, getRedirect, visibleToPublic, type ContentItem } from './items.js';
import { resolveMenu, type ResolvedMenuItem } from './menus.js';
import { ancestorPaths, normalizePath } from './paths.js';
import {
  collectRichTextRefs,
  resolveRichTextRefs,
  type RichTextTargets,
} from './richTextRefs.js';
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
  /**
   * The item's own field values — present **only** for items matched by a `query` field.
   *
   * A breadcrumb or a relation target is a name and a URL, and that is all any consumer has ever
   * needed of one. A query result is a card: a thumbnail, a date, a location. Carrying the data on
   * the same ref rather than in a second map means an item that is both — a related page that also
   * matches a listing — is one entry rather than two that could disagree.
   *
   * `block` and `query` fields are stripped; media, relation and term ids inside it resolve through
   * the payload's own maps exactly as the host item's do, one level deep.
   */
  data?: Record<string, unknown>;
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
  /**
   * The condition under which the editor shows this field, or null.
   *
   * Sent because a hidden field's **value is still stored and still delivered** — dropping it would
   * make a content-type edit silently wipe content — so a consumer that wants to honour the
   * editor's intent needs the rule as well as the data. Most will not: the usual template reads the
   * controlling boolean itself, which is what `show_website_banner` is for. Taproot ships no
   * templates and does not get to decide.
   */
  visibleWhen: VisibilityCondition | null;
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
      /**
       * Answers to the page's `query` fields, keyed by `queryKey(containerId, fieldApiId)`.
       *
       * A fourth top-level map rather than results written into `data[apiId]`, because that slot
       * holds the saved *rule* and has to keep the stored shape — the payload stays usable for a
       * write, and the generated types keep describing what is actually sent. Overwriting it with
       * an answer would break both, and worse than the rich-text exception does, since a rule
       * replaced by its results does not round-trip at all.
       *
       * The key is composite because a query field can sit inside a block, and the same block type
       * placed twice on one page is two placements with two answers. `containerId` is the item's id
       * at the top level and the block instance's id inside a block — both of which a consumer
       * already holds when it comes to render one.
       */
      queries: Record<string, DeliveryQueryResult>;
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

  /**
   * Queries run **before** the reference walk, and that ordering is the whole design.
   *
   * A matched event's thumbnail is a media id inside *its* data, not inside this page's — so the
   * ids have to be in `collected` before the loaders below, or every listing would ship image ids
   * that resolve to nothing. Running it after would mean a second round of loaders, which is the
   * N+1 this avoids.
   *
   * It also has to run after `resolveItemBlocks`, so a query inside a reusable block is found at
   * all.
   */
  const blockTypes = await blockTypeRegistry(db);
  const resolvedQueries = await resolveItemQueries(db, contentType.fields, data, item.id, {
    blockTypes,
    includeUnpublished: options.includeUnpublished,
  });

  const collected = collectReferences(contentType.fields, data);
  // The social image is referenced from `seo`, not from a field, so it would be missed by a walk
  // over `data` alone — and it is the one image every page needs absolutely.
  const seo = resolveSeo(item, contentType);
  if (seo.ogImageId) collected.mediaIds.add(seo.ogImageId);

  // Each result's own references, one level deep — its hero image and its department term, not the
  // references of whatever *those* point at in turn.
  for (const result of resolvedQueries.items) {
    collectReferences(result.fields, result.data, collected);
  }

  const [media, references, terms, linkTargets] = await Promise.all([
    loadMedia(db, [...collected.mediaIds], options),
    loadItemRefs(db, [...collected.itemIds]),
    loadTermRefs(db, [...collected.termIds]),
    loadLinkTargets(db, [...collected.itemIds], options),
  ]);

  /**
   * Internal links, resolved to the paths they currently point at.
   *
   * Done here rather than left to the consumer because of the failure mode: a marker left in the
   * markup ships `taproot:item:…` to a visitor the moment a site forgets to call a helper. See
   * `richTextRefs.ts` for why that outweighs the usual "references are lookup maps" rule.
   *
   * The ids are still in `references` and `media` for anyone who wants them, and a target this
   * cannot resolve leaves its text behind without a link.
   */
  const resolvedData = resolveRichTextData(contentType.fields, data, {
    items: linkTargets,
    media: new Map(Object.entries(media).map(([id, asset]) => [id, asset.url])),
  });

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
      data: resolvedData,
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
    /**
     * Query results are folded in rather than replacing what `loadItemRefs` found.
     *
     * An item can be both a relation target and a query match on one page. Two entries for one id
     * is impossible in a map, so the question is which wins — and the answer has to be the one
     * carrying `data`, or a listing card silently loses its date because the same event happened to
     * be linked from a paragraph above it.
     */
    references: {
      ...references,
      ...Object.fromEntries(
        resolvedQueries.items.map(({ item: row, data: resultData }) => [
          row.id,
          { ...toItemRef(row), data: resultData },
        ]),
      ),
    },
    terms,
    queries: resolvedQueries.queries,
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
      /**
       * A link's target is a reference when it names one, and nothing when it is an address.
       *
       * Missing this case would ship an id the consumer has no way to turn into a URL — the maps are
       * the only route from `{ kind: 'item', id }` to a path, so a link field that never reached
       * here would render as a dead button on a page nobody could see was broken.
       */
      case 'link':
        for (const link of ids) {
          if (typeof link !== 'object' || link === null) continue;
          const { kind, id } = link as { kind?: unknown; id?: unknown };
          if (typeof id !== 'string') continue;
          if (kind === 'item') into.itemIds.add(id);
          else if (kind === 'media') into.mediaIds.add(id);
        }
        break;
      case 'block':
        for (const block of ids) collectFromBlock(block, into);
        break;
      case 'repeater':
        for (const row of ids) collectFromRepeater(field, row, into);
        break;
      /**
       * Rich text can carry internal links, so it holds references like any other field.
       *
       * It reached `default` before, which was right when the only thing in a rich-text value was
       * prose. A `taproot:item:` href is a reference the payload has to resolve, and one this walk
       * cannot find by looking for id-shaped strings — the id is inside an attribute inside markup.
       */
      case 'richtext':
        for (const value of ids) {
          if (typeof value !== 'string') continue;
          const refs = collectRichTextRefs(value);
          for (const id of refs.itemIds) into.itemIds.add(id);
          for (const id of refs.mediaIds) into.mediaIds.add(id);
        }
        break;
      /**
       * A query names the terms it filters by, and those are references like any other.
       *
       * The *results* are not collected here — they are not in `data` at all, and finding them
       * means running the query, which `resolveItemQueries` does before this walk so their ids are
       * already in `into`. What is here is the rule's own vocabulary: a heading reading "Events in
       * Arts" needs the term's name, and the `terms` map is the only route from an id to one.
       */
      case 'query':
        for (const saved of ids) {
          if (typeof saved !== 'object' || saved === null) continue;
          const termIds = (saved as { termIds?: unknown }).termIds;
          if (!Array.isArray(termIds)) continue;
          for (const id of termIds) if (typeof id === 'string') into.termIds.add(id);
        }
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

  /**
   * The values are under `data`, not on the row.
   *
   * A row is `{ id, data }`, and this walked the envelope — so `data['shot']` was looked for at
   * `row['shot']`, found nothing, and every media, relation and taxonomy id inside a repeater was
   * left out of the lookup maps. The consumer then received a bare id with nothing to resolve it
   * against, which renders as a missing image rather than as an error. The same envelope mistake
   * `typegen` made, and invisible from inside a *block*, where `collectLoose` walks structurally and
   * picks the id up regardless — so only a top-level repeater was affected.
   */
  const rowData = (row as { data?: unknown }).data;
  if (typeof rowData !== 'object' || rowData === null) return;

  // `repeaterRowFields` rather than the raw config: sub-fields are stored in the `repeaterSubField`
  // shape, not as `FieldRow`s, and reading them as rows is what once emitted properties literally
  // named `undefined` in the generated types.
  const subFields = repeaterRowFields(field);
  if (subFields.length > 0) {
    collectReferences(subFields, rowData as Record<string, unknown>, into);
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
      return;
    }

    /**
     * A block's rich-text values arrive here as prose, and their links have to be found too.
     *
     * The id test above is anchored, deliberately — it is what stops a paragraph being offered as a
     * lookup key — so an id inside an `href` inside markup can never match it. This is the parsed
     * answer to the same question, and it runs only for strings that mention the scheme at all.
     */
    const refs = collectRichTextRefs(value);
    for (const id of refs.itemIds) into.itemIds.add(id);
    for (const id of refs.mediaIds) into.mediaIds.add(id);
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

/**
 * Where each linked item currently lives, for rewriting rich-text hrefs.
 *
 * Separate from `loadItemRefs`, which always filters by visibility because a "related programmes"
 * list must never name a draft. A link is different in preview: an editor assembling a new section
 * links between drafts, and unwrapping every one of those would make the preview a worse picture of
 * the page than the editor already had. So this follows `includeUnpublished` — outside a preview it
 * filters exactly as relations do, and an unpublished target unwraps rather than sending a reader to
 * a page that is not there.
 */
async function loadLinkTargets(
  db: Kysely<Database>,
  ids: string[],
  options: DeliveryOptions,
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();

  let query = db.selectFrom('content_items').select(['id', 'path']).where('id', 'in', ids);
  if (!options.includeUnpublished) query = query.where(visibleToPublic);

  return new Map((await query.execute()).map((row) => [row.id, row.path]));
}

/**
 * Apply link resolution to every rich-text value, wherever it sits.
 *
 * Mirrors `collectReferences`' walk rather than inventing a second one: a value the collector reaches
 * and this does not is a link that was looked up and then never rewritten, which is the shape of bug
 * that only shows up on the one page nobody reopened.
 */
function resolveRichTextData(
  fields: FieldRow[],
  data: Record<string, unknown>,
  targets: RichTextTargets,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...data };

  for (const field of fields) {
    const value = out[field.api_id];
    if (value === undefined || value === null) continue;

    if (field.type === 'richtext') {
      out[field.api_id] =
        typeof value === 'string' ? resolveRichTextRefs(value, targets) : value;
      continue;
    }

    // Blocks and repeaters hold their own values, and a block's field definitions are not in scope
    // here — so this walks structurally, exactly as `collectLoose` does on the way in.
    if (field.type === 'block' || field.type === 'repeater') {
      out[field.api_id] = resolveLoose(value, targets);
    }
  }

  return out;
}

function resolveLoose(value: unknown, targets: RichTextTargets): unknown {
  if (typeof value === 'string') return resolveRichTextRefs(value, targets);
  if (Array.isArray(value)) return value.map((entry) => resolveLoose(entry, targets));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, resolveLoose(entry, targets)]),
    );
  }
  return value;
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
    visibleWhen: parseVisibility(field.visible_when),
  };
}
