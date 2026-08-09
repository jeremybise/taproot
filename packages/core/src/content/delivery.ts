import type { Kysely } from 'kysely';

import type {
  ContentStatus,
  ContentTypeKind,
  Database,
  FieldRow,
  MediaRow,
  TermRow,
} from '../db/schema.js';
import type { StorageAdapter } from '../storage/types.js';
import { parseJson } from '../db/values.js';
import { repeaterRowFields } from '../validation/fields.js';
import { parseVisibility, type VisibilityCondition } from '../validation/visibility.js';
import {
  SITE_TAG,
  blockTag,
  itemTag,
  menuTag,
  normalizeCacheTags,
  snippetTag,
  typeTag,
} from './cacheTags.js';
import {
  resolveItemQueries,
  resultData,
  resultFields,
  type DeliveryQueryResult,
} from './itemQueries.js';
import type { ItemSort } from './itemSort.js';
import { blockTypeRegistry, getContentType } from './types.js';
import {
  getItemByPath,
  getRedirect,
  listItemSummaries,
  listItems,
  typeHasItemPages,
  visibleToPublic,
  type ContentItem,
} from './items.js';
import { resolveMenu, type ResolvedMenuItem } from './menus.js';
import { snippetsByApiId, type ResolvedSnippet } from './snippets.js';
import { replaceSnippetTokens, snippetTokensIn } from './snippetTokens.js';
import {
  buildTermTree,
  getTaxonomy,
  getTaxonomyByApiId,
  listTaxonomies,
  listTerms,
  type TermNode,
} from './taxonomies.js';
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
      /**
       * The reusable text snippets this page's content refers to, keyed by `api_id`.
       *
       * A fifth top-level map, and — unlike `queries` — the values have **already been substituted
       * into `data`**. That is the rich-text exception rather than a new one: a `{{ tuition }}` left
       * in place ships braces to a visitor the moment a site forgets a helper, and delivery is
       * read-only so nothing round-trips it back. The same reasoning, and the same trade, as
       * `taproot:item:` markers.
       *
       * The map is here anyway because prose gets `display` and some consumers need `value`: a chart
       * block plots `snippets.tuition.value` as a real number, where the substituted text would hand
       * it "$4,500" to parse back. Block components live in git and are written by a developer,
       * which is the escape hatch the `embed` field already documents.
       *
       * Only snippets the page actually refers to travel, collected on the same walk as everything
       * else.
       */
      snippets: Record<string, ResolvedSnippet>;
      /**
       * Everything this page's content depends on, as cache tags.
       *
       * In the payload rather than only in a response header because **two** caches need it: the
       * studio tags its own cached JSON, and a consumer tags the HTML it renders from that JSON.
       * The site cannot derive this list — it would have to know that a breadcrumb came from an
       * ancestor row, that a listing depends on a type rather than on the items it matched, and
       * that a block was filled in from the library. The side that resolved the page knows all
       * three, so it says so.
       *
       * Purely a caching hint: a consumer that ignores it renders exactly the same page and simply
       * relies on the shared TTL to expire, which is what every site did before this existed.
       */
      cacheTags: string[];
    }
  | { kind: 'redirect'; to: string; status: number }
  | { kind: 'not_found' };

/**
 * The registry an item with no placed blocks gets instead of a database round trip.
 *
 * Frozen and shared rather than a fresh `new Map()` per request, so nothing can start writing into
 * it and quietly depend on a map that is sometimes the real registry and sometimes not.
 */
const NO_BLOCK_TYPES: ReadonlyMap<string, { fields: FieldRow[] }> = new Map();

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

  /**
   * Routable only, so a collection with item pages turned off has no page here at all.
   *
   * That is the whole of what the setting buys: a staff directory's people are content items with
   * paths, and a consumer's catch-all would otherwise render each of them as a page nobody
   * designed — a bare field dump at `/people/anybody`, indexed by crawlers and linked from search.
   * Refusing it here rather than leaving it to the site means the route does not exist rather than
   * every consumer having to know not to serve it.
   *
   * It falls through to the redirect lookup below like any other miss, which is right: a path that
   * once belonged to a routable item and was moved still has somewhere to send a visitor.
   */
  const item = await getItemByPath(db, normalized, {
    publishedOnly: !options.includeUnpublished,
    routableOnly: true,
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
  /**
   * The block type registry, loaded only when something can consume it.
   *
   * This used to run unconditionally, which is two queries on **every** page view — a `content_types`
   * lookup plus every one of their fields — including on a page with no blocks on it and no listing
   * anywhere near it. Both were pure waste on the most common page there is.
   *
   * The gate is exact rather than approximate, and `findQueries` is what makes it so: the registry's
   * only consumer is `resolveItemQueries`, which touches `blockTypes` in one branch — descending
   * into a `block` field's placed instances. A top-level `query` field never reads it, and a
   * repeater cannot hold one, because `query` is excluded from `REPEATER_SUB_FIELD_TYPES` and that
   * exclusion is the recursion bound rather than an oversight. So "are there blocks actually placed
   * on this item" is the whole question, and when the answer is no there is nothing the map could
   * have been asked for.
   *
   * Checked against the item's **data**, not just its schema, and this is the one place that is the
   * right way round. The usual rule points the other way — `reachableFields` walks the schema
   * because an editor adds a block *after* the page has rendered and the control inside it has to
   * work when they do. Nothing is being composed here: delivery answers what this item *is*, so a
   * type that declares a block field nobody has filled in genuinely has no blocks to descend into.
   */
  const hasPlacedBlocks = contentType.fields.some((field) => {
    if (field.type !== 'block') return false;
    const value = data[field.api_id];
    return Array.isArray(value) && value.length > 0;
  });

  const blockTypes = hasPlacedBlocks ? await blockTypeRegistry(db) : NO_BLOCK_TYPES;
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

  const [media, { references, linkTargets }, terms] = await Promise.all([
    loadMedia(db, [...collected.mediaIds], options),
    loadItemReferences(db, [...collected.itemIds], options),
    loadTermRefs(db, [...collected.termIds]),
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
  const linkedData = resolveRichTextData(contentType.fields, data, {
    items: linkTargets,
    media: new Map(Object.entries(media).map(([id, asset]) => [id, asset.url])),
  });

  /**
   * Reusable text snippets, substituted after link resolution.
   *
   * **After, not before**, and the order matters in one direction only: a snippet's value is
   * ordinary text and can never introduce a `taproot:` marker, while a resolved link's title could
   * in principle contain braces. Substituting last means a snippet is expanded exactly once, and a
   * value that happens to look like a token cannot be expanded again — which is the recursion this
   * would otherwise need a depth bound for.
   *
   * Collected from the already-linked data so the walk sees the same strings that will be shipped.
   */
  const snippetNames = collectSnippetNames(contentType.fields, linkedData);
  const snippets = await snippetsByApiId(db, snippetNames);
  const resolvedData = applySnippets(contentType.fields, linkedData, snippets);

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
    snippets,
    cacheTags: normalizeCacheTags([
      /**
       * Every cacheable response carries it, which is what makes `SITE_TAG` mean anything.
       *
       * It was emitted nowhere for a whole phase while two write paths purged it — a release
       * publish and the scheduler sweep — so both cleared exactly zero entries. Cloudflare accepts
       * a purge for a tag no response carries and reports success, which is the failure this
       * repository already names for cache tags: a mismatch makes the purge succeed, report
       * success, and clear nothing. The only defence is asserting the tag is on the wire, which
       * `deliveryRoutes.test.ts` now does.
       */
      SITE_TAG,

      itemTag(item.id),
      typeTag(contentType.api_id),

      // Every type this page lists, so publishing a new member invalidates the listing rather than
      // only the members it already showed.
      ...resolvedQueries.targetTypeApiIds.map(typeTag),

      // A renamed or moved ancestor changes this page's breadcrumbs; a published or unpublished
      // child changes its "in this section" list. Both are edits to a different row entirely.
      ...breadcrumbs.map((crumb) => itemTag(crumb.id)),
      ...children.map((child) => itemTag(child.id)),

      // Relation targets and query matches: a card renders another item's title and date, so that
      // item's edit has to reach this page.
      ...Object.keys(references).map(itemTag),
      ...resolvedQueries.items.map(({ item: row }) => itemTag(row.id)),

      // The gap the ETag cannot see: a library entry edited in place changes what every referencing
      // page renders without touching a single one of their rows.
      ...collectReusableIds(resolvedData).map(blockTag),

      // The same gap for a text snippet. Taken from the map rather than re-walking the payload:
      // substitution has already replaced the tokens, so by this point the resolved data no longer
      // says which snippets it used — the map is the only remaining record.
      ...Object.keys(snippets).map(snippetTag),
    ]),
  };
}

/**
 * Reusable block library ids actually placed on this page.
 *
 * Read off the resolved payload rather than tracked through `resolveItemBlocks`, because a block
 * field can sit inside a block type and the envelope is the same at every depth — `resolveItemBlocks`
 * would have to report from a recursion that does not currently have one. A structural walk for
 * `reusable.id` finds them wherever they ended up, which is the same argument `collectLoose` makes
 * about ids inside blocks.
 */
function collectReusableIds(value: unknown, into = new Set<string>()): string[] {
  if (Array.isArray(value)) {
    for (const entry of value) collectReusableIds(entry, into);
  } else if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const reusable = record.reusable as { id?: unknown } | undefined;
    if (reusable && typeof reusable.id === 'string') into.add(reusable.id);
    for (const entry of Object.values(record)) collectReusableIds(entry, into);
  }
  return [...into];
}

// ---------------------------------------------------------------------------
// Listings
// ---------------------------------------------------------------------------

/**
 * One item in a delivered listing.
 *
 * A **superset of `DeliveryItemRef`**, deliberately: a card component written against a query
 * field's results renders one of these unchanged, which is the whole point of not inventing a second
 * shape. The three extra keys are what a listing has always sent and an index page uses — `slug` for
 * a site building its own URLs, and the two timestamps for "posted on" lines and date sorting a
 * consumer does itself.
 */
export interface DeliveryListItem extends DeliveryItemRef {
  slug: string;
  publishedAt: string | null;
  updatedAt: string;
}

export interface DeliveryList {
  items: DeliveryListItem[];
  /** Matching rows in total, which is what a pager needs and `items.length` is not. */
  total: number;
  /**
   * The lookup maps, present **only** when `includeData` was asked for.
   *
   * Absent rather than empty when it was not, because there is nothing to look anything up in: a
   * summary carries no ids. An empty object would read as "asked, and this site has no media",
   * which is a different fact.
   */
  media?: Record<string, DeliveryMedia>;
  references?: Record<string, DeliveryItemRef>;
  terms?: Record<string, DeliveryTermRef>;
}

export interface DeliverItemsOptions extends DeliveryOptions {
  contentTypeId?: string;
  /** Already expanded to whole branches by the caller, as `ItemFilters.termIds` requires. */
  termIds?: string[];
  search?: string;
  sort?: ItemSort;
  limit?: number;
  offset?: number;
  /** Narrow to types whose items have pages — see `ItemFilters.contentTypeHasItemPages`. */
  contentTypeHasItemPages?: boolean;
  /**
   * Send each item's own field values, and the maps their ids resolve through.
   *
   * Off by default, and the default is the one that matters: a menu picker asking for two hundred
   * candidates by title must not start paying for two hundred page bodies. Opt in when rendering
   * cards — a directory needs the photo, the position and the department, and the alternative is N
   * calls to `resolve`.
   */
  includeData?: boolean;
}

/**
 * A filtered listing, optionally carrying enough to render a card grid.
 *
 * Lives in core rather than in the route for the reason `resolveSeo` does: the shape a listing sends
 * has to be the shape a query field's results already send, and two implementations of "what a
 * listed item is" would drift on the first field type either of them forgot.
 *
 * **The data path costs three extra queries at most, not three per item.** Every listed item's
 * media, relations and terms are collected across the whole page and loaded in one query each —
 * which is the same batching `resolveDelivery` does, and the reason a listing of fifty is not fifty
 * round trips. The content types are loaded once per *distinct* type on the page, so a listing
 * narrowed to one type — which is what a directory is — loads exactly one.
 */
export async function deliverItems(
  db: Kysely<Database>,
  options: DeliverItemsOptions,
): Promise<DeliveryList> {
  const filters = {
    contentTypeId: options.contentTypeId,
    termIds: options.termIds,
    search: options.search,
    sort: options.sort,
    visibleOnly: true,
    /**
     * Only kinds that have a public URL.
     *
     * A singleton's `path` is the synthetic `/__singleton/{api_id}`, which nothing serves — so
     * including one hands a consumer a link that 404s. Its content is still reachable through
     * `resolve` with that path, which is the deliberate way to ask for it.
     */
    contentTypeKinds: ['page', 'collection'] as ContentTypeKind[],
    contentTypeHasItemPages: options.contentTypeHasItemPages,
    limit: options.limit,
    offset: options.offset,
  };

  if (!options.includeData) {
    const { items, total } = await listItemSummaries(db, filters);
    return { items: items.map(toListItem), total };
  }

  const { items, total } = await listItems(db, filters);
  if (items.length === 0) return { items: [], total, media: {}, references: {}, terms: {} };

  /**
   * The fields to carry, per distinct content type on this page.
   *
   * One load per type rather than per item — a listing of fifty events is one type — and in parallel
   * for the mixed case, where an index page spanning three types would otherwise pay three serial
   * round trips for three questions that have nothing to say to each other.
   */
  const typeIds = [...new Set(items.map((item) => item.content_type_id))];
  const loaded = await Promise.all(typeIds.map((id) => getContentType(db, id)));
  const carriedByType = new Map<string, FieldRow[]>();
  for (const type of loaded) {
    if (type) carriedByType.set(type.id, resultFields(type.fields));
  }

  const prepared = items.map((item) => {
    const fields = carriedByType.get(item.content_type_id) ?? [];
    return { item, fields, data: resultData(fields, item.data) };
  });

  /**
   * Each listed item's own references, one level deep — its photo and its department, not the
   * references of whatever *those* point at in turn. Exactly what a query result collects.
   *
   * The empty first call is how the accumulator is made: `collectReferences` folds into the set it
   * is given, so the page's ids arrive as one union and the loaders below run once for the listing
   * rather than once per row.
   */
  const collected = collectReferences([], {});
  for (const entry of prepared) collectReferences(entry.fields, entry.data, collected);

  const [media, { references, linkTargets }, terms] = await Promise.all([
    loadMedia(db, [...collected.mediaIds], options),
    loadItemReferences(db, [...collected.itemIds], options),
    loadTermRefs(db, [...collected.termIds]),
  ]);

  const mediaUrls = new Map(Object.entries(media).map(([id, asset]) => [id, asset.url]));

  return {
    items: prepared.map((entry) => ({
      ...toListItem(entry.item),
      // Resolved here for the reason `resolveDelivery` resolves the host item's: a marker left in
      // the markup ships `taproot:item:…` to a visitor the moment a site forgets a helper, and a
      // card carrying a summary field is exactly where that would go unnoticed.
      data: resolveRichTextData(entry.fields, entry.data, { items: linkTargets, media: mediaUrls }),
    })),
    total,
    media,
    references,
    terms,
  };
}

function toListItem(item: {
  id: string;
  title: string;
  slug: string;
  path: string;
  status: ContentStatus;
  published_at: string | null;
  updated_at: string;
}): DeliveryListItem {
  return {
    id: item.id,
    title: item.title,
    slug: item.slug,
    path: item.path,
    status: item.status,
    publishedAt: item.published_at,
    updatedAt: item.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export interface DeliveryTypeSchema {
  /**
   * The row id, which is what a `relation` or `query` field's `config` names its target by.
   *
   * Sent so a consumer reading the model can follow that reference. Without it `config` hands over a
   * uuid with nothing on this side of the wire to match it against — the caller has to open the
   * admin and read the name off a screen, which is the manual step a schema exists to remove.
   */
  id: string;
  apiId: string;
  name: string;
  namePlural: string;
  kind: ContentTypeKind;
  urlPrefix: string | null;
  /**
   * Whether this type's items are served at their own URLs.
   *
   * False for a collection whose item pages are turned off — a staff directory — and for every kind
   * that never had them. A consumer rendering a listing reads it to decide whether a card's title is
   * a link: the CMS is the authority on that, and a site restating it is the two-implementations
   * problem in miniature. `resolve` answers `not_found` at those items' paths, so a link built
   * anyway is a 404 rather than a silent field dump.
   */
  hasItemPages: boolean;
  fields: DeliveryField[];
}

/**
 * A taxonomy, as the schema lists it.
 *
 * Its terms are deliberately not here: a vocabulary can hold hundreds, the schema is read to learn
 * the *model*, and `GET /delivery/taxonomy/{apiIdOrId}/terms` answers the other question — with
 * counts, and narrowed to the type a facet sits beside.
 */
export interface DeliveryTaxonomySummary {
  id: string;
  apiId: string;
  name: string;
  namePlural: string;
  hierarchical: boolean;
}

export interface DeliverySchema {
  contentTypes: DeliveryTypeSchema[];
  blockTypes: DeliveryTypeSchema[];
  /**
   * Every taxonomy, which is what makes a `taxonomy` field's `config.taxonomyId` resolvable.
   *
   * The alternative was resolving it *into* each field's config as a `taxonomyApiId`, and it was
   * rejected on cost: `toDeliveryField` also builds the `fields` array on every `resolve`, so the
   * lookup would land on the hot path of every page view to serve a question only a schema reader
   * asks. Listing them once here costs one query on an endpoint that is `no-store` and read at build
   * time — and answers "what taxonomies exist" as well, which nothing else did.
   */
  taxonomies: DeliveryTaxonomySummary[];
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

  // Loaded regardless of whether any type carries a taxonomy field: a site with vocabularies and no
  // field using them yet is an ordinary state, and this endpoint is where "what exists" is answered.
  const taxonomies = (await listTaxonomies(db)).map(
    (taxonomy): DeliveryTaxonomySummary => ({
      id: taxonomy.id,
      apiId: taxonomy.api_id,
      name: taxonomy.name,
      namePlural: taxonomy.name_plural,
      hierarchical: taxonomy.hierarchical === 1,
    }),
  );

  if (types.length === 0) return { contentTypes: [], blockTypes: [], taxonomies };

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
    id: type.id,
    apiId: type.api_id,
    name: type.name,
    namePlural: type.name_plural,
    kind: type.kind,
    urlPrefix: type.url_prefix,
    hasItemPages: typeHasItemPages(type),
    fields: (byType.get(type.id) ?? []).map(toDeliveryField),
  });

  return {
    contentTypes: types.filter((type) => type.kind !== 'block').map(shape),
    blockTypes: types.filter((type) => type.kind === 'block').map(shape),
    taxonomies,
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
): Promise<{ items: DeliveryMenuItem[]; cacheTags: string[] }> {
  const tree = await resolveMenu(db, apiId, {
    publishedOnly: true,
    termHref: () => TERM_PLACEHOLDER,
  });

  const items = tree
    .map(toDeliveryMenuItem)
    .filter((entry): entry is DeliveryMenuItem => entry !== null);

  /**
   * The tags come out of the same walk, never a second `resolveMenu`.
   *
   * Computing them separately was the obvious shape and doubles the cost of the one endpoint every
   * page view already pays for — three more queries to make a caching improvement, which is a net
   * loss on exactly the request it was meant to speed up.
   *
   * They are read off the *resolved* tree rather than the delivered one because the delivered shape
   * deliberately drops the ids: a menu target is exposed to a consumer as a `path`, and a path is
   * the thing that changes when a page moves, so it cannot identify what to purge.
   */
  // `SITE_TAG` for the reason `resolveDelivery` carries it: a tag nothing emits purges nothing. A
  // menu is the response most exposed to that, having no `updated_at` to build a validator from —
  // so a purge is the only thing that can invalidate one inside its TTL.
  const tags = [SITE_TAG, menuTag(apiId)];
  const walk = (entries: ResolvedMenuItem[]) => {
    for (const entry of entries) {
      if (entry.contentItemId) tags.push(itemTag(entry.contentItemId));
      if (entry.children.length > 0) walk(entry.children);
    }
  };
  walk(tree);

  return { items, cacheTags: normalizeCacheTags(tags) };
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
// Taxonomy terms
// ---------------------------------------------------------------------------

/**
 * A term as a facet control needs it: what `resolve` puts in its `terms` map, plus its place in the
 * tree and — when asked for — how much content is under it.
 *
 * `parentId` rather than nested children, because the flat form is what both renderings need. A
 * `<select>` wants a list with indentation and a checkbox tree wants nesting, and a consumer can
 * build either from parents; going the other way means flattening a tree somebody else shaped.
 */
export interface DeliveryTaxonomyTerm extends DeliveryTermRef {
  parentId: string | null;
  /**
   * Items a visitor can see under this term **and everything beneath it**, present only when
   * counts were requested.
   *
   * Branch-wide and de-duplicated, because that is what filtering by this term returns — a count
   * that meant "filed directly here" would label a facet with a number the grid then disagrees
   * with, which is the same failure the status facets exist to avoid. An item filed under both a
   * parent and its child counts once.
   */
  itemCount?: number;
}

export interface DeliveryTaxonomy {
  apiId: string;
  name: string;
  namePlural: string;
  hierarchical: boolean;
  /** Depth-first, parents before their children, in the order the admin shows them. */
  terms: DeliveryTaxonomyTerm[];
}

export interface DeliverTermsOptions {
  /**
   * Count the content under each term. One extra query, and not free — it reads every visible
   * assignment in the taxonomy — so it is opt-in rather than always on.
   */
  counts?: boolean;
  /**
   * Count only items of this content type.
   *
   * Load-bearing for a facet beside a filtered grid: a directory listing `type=person` filtered by
   * department must not offer "Biology (12)" when twelve counts news stories too. The caller passes
   * whatever type its listing is narrowed to, and the two numbers then describe the same set.
   */
  contentTypeId?: string;
}

/**
 * A taxonomy's terms, for a consumer building a facet.
 *
 * Answers "what departments exist", which nothing else on the delivery API could: a site had to
 * hard-code the list and went stale, silently, the moment an editor added one. `undefined` for a
 * taxonomy that does not exist, so the route can 404 rather than answer an empty list — which would
 * read as "no terms yet" and hide a misspelled `api_id` indefinitely.
 *
 * **Takes an `api_id` or an id**, exactly as `?term=` takes a slug or an id, and for a sharper
 * reason than symmetry: a `taxonomy` field's schema entry carries `config.taxonomyId` and no
 * `api_id`, so a consumer that reads the content model — which is the one that most wants this
 * endpoint — holds the uuid and nothing else. Accepting only the name meant going from a field to
 * its terms was impossible without a human reading the admin. They cannot collide: an `api_id` is a
 * slug and an id is a uuid.
 */
export async function deliverTaxonomyTerms(
  db: Kysely<Database>,
  apiIdOrId: string,
  options: DeliverTermsOptions = {},
): Promise<DeliveryTaxonomy | undefined> {
  const taxonomy =
    (await getTaxonomyByApiId(db, apiIdOrId)) ?? (await getTaxonomy(db, apiIdOrId));
  if (!taxonomy) return undefined;

  const rows = await listTerms(db, taxonomy.id);

  const counts = options.counts
    ? await countItemsPerTerm(db, rows, options.contentTypeId)
    : undefined;

  /**
   * Flattened out of the tree rather than sent in table order, so a consumer rendering the list
   * without reading `parentId` still gets something coherent — a child directly under its parent,
   * in the order an editor arranged them.
   */
  const ordered: DeliveryTaxonomyTerm[] = [];
  const walk = (nodes: TermNode[]) => {
    for (const node of nodes) {
      ordered.push({
        id: node.id,
        name: node.name,
        slug: node.slug,
        taxonomyApiId: taxonomy.api_id,
        parentId: node.parent_id,
        ...(counts ? { itemCount: counts.get(node.id) ?? 0 } : {}),
      });
      walk(node.children);
    }
  };
  walk(buildTermTree(rows));

  return {
    apiId: taxonomy.api_id,
    name: taxonomy.name,
    namePlural: taxonomy.name_plural,
    hierarchical: taxonomy.hierarchical === 1,
    terms: ordered,
  };
}

/**
 * How many visible items sit under each term, counting its whole branch once.
 *
 * One query for the taxonomy, then the branch union in memory. The alternative — a recursive CTE per
 * term, or one big CTE with `count(distinct)` — would push the work into SQL and needs
 * `visibleToPublic` spelled as a raw string to get there, which is a second implementation of the
 * rule that decides what the public can see. That rule is exactly the kind this repo keeps in one
 * expression, so the join stays a Kysely query and the rollup happens here.
 *
 * Summing children's counts would be simpler and wrong: an item filed under both "Sciences" and
 * "Biology" is one item, and a sum reports two. The union is over item ids for that reason.
 */
async function countItemsPerTerm(
  db: Kysely<Database>,
  terms: TermRow[],
  contentTypeId?: string,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (terms.length === 0) return counts;

  let query = db
    .selectFrom('taxonomy_assignments')
    .innerJoin('content_items', 'content_items.id', 'taxonomy_assignments.content_item_id')
    .innerJoin('content_types', 'content_types.id', 'content_items.content_type_id')
    .select(['taxonomy_assignments.term_id', 'taxonomy_assignments.content_item_id'])
    .where(
      'taxonomy_assignments.term_id',
      'in',
      terms.map((term) => term.id),
    )
    // The same two narrowings the listing applies, or the number beside a facet describes a
    // different set from the rows clicking it returns.
    .where('content_types.kind', 'in', ['page', 'collection'])
    .where(visibleToPublic);

  if (contentTypeId) query = query.where('content_items.content_type_id', '=', contentTypeId);

  const assignments = await query.execute();

  const direct = new Map<string, Set<string>>();
  for (const row of assignments) {
    const set = direct.get(row.term_id) ?? new Set<string>();
    set.add(row.content_item_id);
    direct.set(row.term_id, set);
  }

  const children = new Map<string, TermRow[]>();
  for (const term of terms) {
    if (!term.parent_id) continue;
    children.set(term.parent_id, [...(children.get(term.parent_id) ?? []), term]);
  }

  const union = (term: TermRow): Set<string> => {
    const ids = new Set(direct.get(term.id) ?? []);
    for (const child of children.get(term.id) ?? []) {
      for (const id of union(child)) ids.add(id);
    }
    counts.set(term.id, ids.size);
    return ids;
  };

  for (const term of terms) {
    if (!term.parent_id) union(term);
  }

  /**
   * A term whose parent is missing is still counted.
   *
   * `parent_id` is nulled rather than cascaded when a parent goes, so this should not happen — but a
   * term left out of the map would report `0` on a facet that returns results when clicked, and
   * "the tree looked odd" is a better failure than "the count lies".
   */
  for (const term of terms) {
    if (!counts.has(term.id)) union(term);
  }

  return counts;
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
 * Relation targets and rich-text link targets, which outside a preview are one query.
 *
 * These were two: one selecting `id, title, path, status` under `visibleToPublic` for the reference
 * map, and one selecting `id, path` for rewriting rich-text hrefs. On a public page view they ran
 * over the *same* id set with the *same* predicate and differed only in columns — a whole extra
 * round trip to D1 for a strict subset of what the first one had already fetched.
 *
 * The two genuinely differ under a preview, and that difference is the reason they were written
 * apart. A "related programmes" list must never name a draft, so references filter by visibility
 * always. A link is different: an editor assembling a new section links between drafts, and
 * unwrapping every one of those would make the preview a worse picture of the page than the editor
 * already had — so link targets follow `includeUnpublished`.
 *
 * So the wider set is fetched only when it is actually wider. The tempting alternative — fetch every
 * id once and decide visibility per row in JavaScript — is the one to avoid: `visibleToPublic` is a
 * SQL predicate that knows about `scheduled` items whose moment has passed, and a second copy of
 * that rule in JS would be free to disagree with the one every other read uses. Preview pays the
 * extra query; a visitor does not, and a preview is `no-store` anyway.
 */
async function loadItemReferences(
  db: Kysely<Database>,
  ids: string[],
  options: DeliveryOptions,
): Promise<{ references: Record<string, DeliveryItemRef>; linkTargets: Map<string, string> }> {
  if (ids.length === 0) return { references: {}, linkTargets: new Map() };

  const visible = await db
    .selectFrom('content_items')
    .select(['id', 'title', 'path', 'status'])
    /**
     * The same predicate the item lookup uses, which is the point of it being one function: a
     * consumer cannot be handed something a visitor could not otherwise see.
     */
    .where(visibleToPublic)
    .where('id', 'in', ids)
    .execute();

  const references: Record<string, DeliveryItemRef> = {};
  for (const row of visible) references[row.id] = toItemRef(row);

  if (!options.includeUnpublished) {
    return { references, linkTargets: new Map(visible.map((row) => [row.id, row.path])) };
  }

  const all = await db
    .selectFrom('content_items')
    .select(['id', 'path'])
    .where('id', 'in', ids)
    .execute();

  return { references, linkTargets: new Map(all.map((row) => [row.id, row.path])) };
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

/**
 * Which snippets a page's values refer to.
 *
 * Mirrors `resolveRichTextData`'s walk deliberately — the same field types at the top level, the
 * same structural descent into blocks and repeaters. A value one walk reaches and the other does not
 * is a token collected and never substituted, or substituted from a map that never loaded it, and
 * both show up as literal braces on one page rather than as an error anywhere.
 *
 * `text` and `richtext` at the top level: those are where prose lives, and where an editor would
 * think to type one. Inside a block or a repeater row the walk is structural rather than
 * definition-driven — a block's field definitions are not in scope here — so it reaches every
 * string, exactly as `collectLoose` and `resolveLoose` already do on their own passes.
 */
function collectSnippetNames(fields: FieldRow[], data: Record<string, unknown>): string[] {
  const found = new Set<string>();

  const walkLoose = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const name of snippetTokensIn(value)) found.add(name);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) walkLoose(entry);
      return;
    }
    if (typeof value === 'object' && value !== null) {
      for (const entry of Object.values(value)) walkLoose(entry);
    }
  };

  for (const field of fields) {
    const value = data[field.api_id];
    if (value === undefined || value === null) continue;

    if (field.type === 'text' || field.type === 'richtext') {
      if (typeof value === 'string') for (const name of snippetTokensIn(value)) found.add(name);
      continue;
    }

    if (field.type === 'block' || field.type === 'repeater') walkLoose(value);
  }

  return [...found];
}

/** Substitute every known token, on the same walk `collectSnippetNames` used. */
function applySnippets(
  fields: FieldRow[],
  data: Record<string, unknown>,
  snippets: Record<string, ResolvedSnippet>,
): Record<string, unknown> {
  // An unknown name resolves to `undefined`, which `replaceSnippetTokens` leaves written as-is —
  // never to `''`, which would delete the token and the fact that anything was wrong with it.
  const resolve = (apiId: string) => snippets[apiId]?.display;

  const applyLoose = (value: unknown): unknown => {
    if (typeof value === 'string') return replaceSnippetTokens(value, resolve);
    if (Array.isArray(value)) return value.map(applyLoose);
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, applyLoose(entry)]));
    }
    return value;
  };

  const out: Record<string, unknown> = { ...data };

  for (const field of fields) {
    const value = out[field.api_id];
    if (value === undefined || value === null) continue;

    if (field.type === 'text' || field.type === 'richtext') {
      if (typeof value === 'string') out[field.api_id] = replaceSnippetTokens(value, resolve);
      continue;
    }

    if (field.type === 'block' || field.type === 'repeater') out[field.api_id] = applyLoose(value);
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
