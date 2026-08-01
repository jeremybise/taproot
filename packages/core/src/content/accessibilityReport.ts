import type { Kysely } from 'kysely';

import type { ContentTypeRow, Database, FieldRow } from '../db/schema.js';
import {
  checkItemAccessibility,
  countBySeverity,
  referencedMediaIds,
  type A11yContext,
  type A11yIssue,
  type A11yMediaInfo,
  type A11yRule,
} from './accessibility.js';
import { listItems, type ContentItem, type ItemFilters } from './items.js';
import { listMedia } from './media.js';
import { listReusableBlocks } from './reusableBlocks.js';
import { blockTypeRegistry, listContentTypes } from './types.js';

/**
 * The site-wide accessibility report: the same rules, run over many items at once.
 *
 * Split from `accessibility.ts` on purpose. The rules there are a pure function of a value, which
 * is what lets the editor's panel run them on every keystroke and what makes them testable without
 * a database. This file is the other half — finding the content and resolving what the rules need
 * to look at — and it is the only half that needs a connection.
 *
 * **Never cached, always recomputed.** Same reasoning as `releasePreflight`: a stored list of
 * reasons still accuses somebody an hour after they fixed it, and there is no invalidation that
 * covers "somebody edited the reusable block this page references". The cost is real and stated on
 * the screen rather than hidden — this is a scan, not an indexed query.
 */

export interface AccessibilityReportOptions {
  contentTypeId?: string;
  /**
   * Restrict to what the public can actually see, through the same `visibleToPublic` rule every
   * other reader uses. The default, because a draft nobody has finished is not yet a problem
   * anybody has.
   */
  visibleOnly?: boolean;
  /** Show only items with an issue of this rule. Applied after the scan — see `AuditedItem`. */
  rule?: A11yRule;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface AuditedItem {
  item: ContentItem;
  contentType: ContentTypeRow;
  issues: A11yIssue[];
}

export interface AccessibilityReport {
  /** Items on this page **that have issues**, in path order. */
  items: AuditedItem[];
  /** How many items the filters matched, of which this page scanned `scanned`. */
  totalItems: number;
  scanned: number;
  errors: number;
  warnings: number;
}

/**
 * Audit one page of content items.
 *
 * Paginated because it has to be: every item's `data` is read and walked, so the honest bound is
 * "a page at a time, and the screen says how far it got". A site-wide issue *total* is deliberately
 * not offered — it would mean reading every row of the table to render a number, and a total that
 * is quietly capped is worse than no total at all.
 *
 * Queries are per page, not per item: one for the items, one for every content type's fields, one
 * for the block registry, one for the library, and one for the media those items reference.
 */
export async function auditContentItems(
  db: Kysely<Database>,
  options: AccessibilityReportOptions = {},
): Promise<AccessibilityReport> {
  const limit = options.limit ?? 50;

  const filters: ItemFilters & { limit: number; offset: number } = {
    contentTypeId: options.contentTypeId,
    visibleOnly: options.visibleOnly ?? true,
    search: options.search,
    limit,
    offset: options.offset ?? 0,
  };

  const { items, total } = await listItems(db, filters);
  if (items.length === 0) {
    return { items: [], totalItems: total, scanned: 0, errors: 0, warnings: 0 };
  }

  const context = await resolveScanContext(db, items);

  const audited: AuditedItem[] = [];
  let errors = 0;
  let warnings = 0;

  for (const item of items) {
    const contentType = context.contentTypes.get(item.content_type_id);
    if (!contentType) continue;

    let issues = checkItemAccessibility(contentType.fields, item.data, context.a11y);
    if (options.rule) issues = issues.filter((issue) => issue.rule === options.rule);
    if (issues.length === 0) continue;

    const counts = countBySeverity(issues);
    errors += counts.errors;
    warnings += counts.warnings;

    audited.push({ item, contentType, issues });
  }

  return { items: audited, totalItems: total, scanned: items.length, errors, warnings };
}

/**
 * Everything the rules need to look at, resolved once for a whole page of items.
 *
 * The media lookup is built from the ids those items actually reference — `referencedMediaIds`
 * walking the same tree the check does — rather than from a page of the library, which would leave
 * an item pointing at an older asset reporting every one of its images as undescribed.
 */
async function resolveScanContext(
  db: Kysely<Database>,
  items: ContentItem[],
): Promise<{ contentTypes: Map<string, ContentTypeWithFields>; a11y: A11yContext }> {
  const [contentTypes, blocks, library] = await Promise.all([
    contentTypesWithFields(db),
    blockTypeRegistry(db),
    listReusableBlocks(db),
  ]);

  const blockTypes = new Map(
    [...blocks].map(([apiId, type]) => [apiId, { name: type.name, fields: type.fields }]),
  );
  const reusableBlocks = new Map(
    library.map((entry) => [
      entry.id,
      { id: entry.id, name: entry.name, type: entry.block_type, data: entry.data },
    ]),
  );

  const ids = new Set<string>();
  for (const item of items) {
    const type = contentTypes.get(item.content_type_id);
    if (!type) continue;
    for (const id of referencedMediaIds(type.fields, item.data, { blockTypes, reusableBlocks })) {
      ids.add(id);
    }
  }

  const altById = new Map<string, A11yMediaInfo>();
  if (ids.size > 0) {
    const { media } = await listMedia(db, { ids: [...ids], limit: ids.size });
    for (const row of media) {
      altById.set(row.id, {
        filename: row.filename,
        mimeType: row.mime_type,
        altText: row.alt_text,
      });
    }
  }

  return { contentTypes, a11y: { altById, blockTypes, reusableBlocks } };
}

interface ContentTypeWithFields extends ContentTypeRow {
  fields: FieldRow[];
}

/**
 * Every content type with its fields, keyed by id.
 *
 * Two queries rather than one per item, following `blockTypeRegistry`: a page of fifty items across
 * four types should cost two lookups, not fifty.
 */
async function contentTypesWithFields(
  db: Kysely<Database>,
): Promise<Map<string, ContentTypeWithFields>> {
  const types = await listContentTypes(db, { includeBlocks: true });
  if (types.length === 0) return new Map();

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
    const list = byType.get(field.content_type_id);
    if (list) list.push(field);
    else byType.set(field.content_type_id, [field]);
  }

  return new Map(types.map((type) => [type.id, { ...type, fields: byType.get(type.id) ?? [] }]));
}

export interface UndescribedImage {
  id: string;
  filename: string;
  storage_key: string;
}

/**
 * Images in the library that nobody has described and nobody has marked decorative.
 *
 * A real query rather than a scan, which is what lets it carry an honest total while the item audit
 * above cannot. It is also the only part of the report that finds a problem *before* it reaches a
 * page: an image uploaded and not yet placed appears in no item's data, so the walk cannot see it —
 * and it will be undescribed on whatever page it eventually lands on.
 *
 * `alt_text is null` rather than `= ''` or falsy: `''` is a deliberate "this is decorative", and
 * the two are what `needsAltText` exists to keep apart. Expressed in SQL here because the whole
 * point is not loading the table to answer it.
 */
export async function undescribedImages(
  db: Kysely<Database>,
  options: { limit?: number } = {},
): Promise<{ images: UndescribedImage[]; total: number }> {
  const query = db
    .selectFrom('media')
    .where('alt_text', 'is', null)
    .where('mime_type', 'like', 'image/%');

  const [countRow, rows] = await Promise.all([
    query.select((eb) => eb.fn.countAll<number>().as('count')).executeTakeFirst(),
    query
      .select(['id', 'filename', 'storage_key'])
      .orderBy('created_at', 'desc')
      .limit(options.limit ?? 50)
      .execute(),
  ]);

  return { images: rows, total: Number(countRow?.count ?? 0) };
}
