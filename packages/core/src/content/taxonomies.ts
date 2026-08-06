import { sql, type Kysely } from 'kysely';

import type { BatchStatement } from '../db/batch.js';
import type { Database, TaxonomyRow, TermRow } from '../db/schema.js';
import { fromBool, now } from '../db/values.js';
import { newId } from '../ids.js';
import { slugify, uniqueSlug } from './paths.js';

/**
 * Taxonomies and their term trees.
 *
 * Terms deliberately carry no materialised path, unlike content items — see the 0003 migration for
 * the reasoning. Every tree query here runs off `parent_id` with a recursive CTE, the same
 * `WITH RECURSIVE` form that works identically on both drivers.
 */

export class TaxonomyError extends Error {
  override name = 'TaxonomyError';
  constructor(
    message: string,
    readonly code:
      | 'not_found'
      | 'duplicate_api_id'
      | 'cycle'
      | 'invalid_parent'
      | 'not_hierarchical'
      | 'in_use' = 'not_found',
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Taxonomies
// ---------------------------------------------------------------------------

export async function listTaxonomies(db: Kysely<Database>): Promise<TaxonomyRow[]> {
  return db.selectFrom('taxonomies').selectAll().orderBy('name').execute();
}

export async function getTaxonomy(
  db: Kysely<Database>,
  id: string,
): Promise<TaxonomyRow | undefined> {
  return db.selectFrom('taxonomies').selectAll().where('id', '=', id).executeTakeFirst();
}

export async function getTaxonomyByApiId(
  db: Kysely<Database>,
  apiId: string,
): Promise<TaxonomyRow | undefined> {
  return db.selectFrom('taxonomies').selectAll().where('api_id', '=', apiId).executeTakeFirst();
}

export interface TaxonomyInput {
  api_id: string;
  name: string;
  name_plural: string;
  description?: string | null;
  hierarchical?: boolean;
}

export async function createTaxonomy(
  db: Kysely<Database>,
  input: TaxonomyInput,
): Promise<TaxonomyRow> {
  const apiId = slugify(input.api_id) || slugify(input.name);
  if (!apiId) {
    throw new TaxonomyError(
      'A taxonomy needs an API id made of letters, numbers, or hyphens.',
      'duplicate_api_id',
    );
  }

  const existing = await getTaxonomyByApiId(db, apiId);
  if (existing) {
    throw new TaxonomyError(
      `A taxonomy with the API id "${apiId}" already exists.`,
      'duplicate_api_id',
    );
  }

  const timestamp = now();
  const row: TaxonomyRow = {
    id: newId(),
    api_id: apiId,
    name: input.name,
    name_plural: input.name_plural,
    description: input.description ?? null,
    hierarchical: fromBool(input.hierarchical ?? true),
    created_at: timestamp,
    updated_at: timestamp,
  };

  await db.insertInto('taxonomies').values(row).execute();
  return row;
}

/** `api_id` is immutable for the same reason a content type's is: code and integrations use it. */
export async function updateTaxonomy(
  db: Kysely<Database>,
  id: string,
  input: Partial<Omit<TaxonomyInput, 'api_id'>>,
): Promise<TaxonomyRow> {
  const existing = await getTaxonomy(db, id);
  if (!existing) throw new TaxonomyError(`Taxonomy ${id} not found.`, 'not_found');

  const patch = {
    name: input.name ?? existing.name,
    name_plural: input.name_plural ?? existing.name_plural,
    description:
      input.description === undefined ? existing.description : (input.description ?? null),
    hierarchical:
      input.hierarchical === undefined ? existing.hierarchical : fromBool(input.hierarchical),
    updated_at: now(),
  };

  await db.updateTable('taxonomies').set(patch).where('id', '=', id).execute();
  return { ...existing, ...patch };
}

/**
 * Delete a taxonomy.
 *
 * Refuses while a field still points at it. The FK would cascade terms away happily, but every
 * content item tagged with them would keep stale ids in `data` and the field would silently
 * reference a taxonomy that no longer exists.
 */
export async function deleteTaxonomy(db: Kysely<Database>, id: string): Promise<void> {
  const fields = await db.selectFrom('fields').selectAll().where('type', '=', 'taxonomy').execute();

  const referencing = fields.filter((field) => {
    try {
      return (JSON.parse(field.config) as { taxonomyId?: string | null }).taxonomyId === id;
    } catch {
      return false;
    }
  });

  if (referencing.length > 0) {
    throw new TaxonomyError(
      `Cannot delete this taxonomy while ${referencing.length} field(s) still reference it. ` +
        'Remove or repoint those fields first.',
      'in_use',
    );
  }

  await db.deleteFrom('taxonomies').where('id', '=', id).execute();
}

// ---------------------------------------------------------------------------
// Terms
// ---------------------------------------------------------------------------

export interface TermNode extends TermRow {
  children: TermNode[];
}

export async function listTerms(db: Kysely<Database>, taxonomyId: string): Promise<TermRow[]> {
  return db
    .selectFrom('terms')
    .selectAll()
    .where('taxonomy_id', '=', taxonomyId)
    // Depth first, then position: a flat list in this order already reads as an indented tree,
    // which is what both the admin list and a <select> of parents want.
    .orderBy('depth')
    .orderBy('position')
    .orderBy('name')
    .execute();
}

export async function getTerm(db: Kysely<Database>, id: string): Promise<TermRow | undefined> {
  return db.selectFrom('terms').selectAll().where('id', '=', id).executeTakeFirst();
}

/** Assemble the flat rows into a tree. Done in memory — one query, no N+1 over depth. */
export function buildTermTree(terms: TermRow[]): TermNode[] {
  const nodes = new Map<string, TermNode>();
  for (const term of terms) nodes.set(term.id, { ...term, children: [] });

  const roots: TermNode[] = [];
  for (const term of terms) {
    const node = nodes.get(term.id)!;
    const parent = term.parent_id ? nodes.get(term.parent_id) : undefined;
    // A term whose parent is missing from this set is treated as a root rather than dropped, so a
    // partially-loaded or orphaned branch stays visible and fixable in the admin.
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  return roots;
}

/**
 * A term and every descendant, in one recursive query.
 *
 * "Everything under Academics" has to be one round trip rather than a walk, because it backs
 * ordinary reads: filtering a content list by a branch, and counting a term's usage before
 * offering to delete it.
 */
export async function getTermSubtree(
  db: Kysely<Database>,
  rootId: string,
): Promise<{ id: string; depth: number }[]> {
  const result = await sql<{ id: string; depth: number }>`
    WITH RECURSIVE term_subtree(id, depth) AS (
      SELECT id, depth FROM terms WHERE id = ${rootId}
      UNION ALL
      SELECT t.id, t.depth
      FROM terms t
      JOIN term_subtree s ON t.parent_id = s.id
    )
    SELECT id, depth FROM term_subtree
  `.execute(db);

  return result.rows;
}

export interface CreateTermInput {
  name: string;
  slug?: string;
  parentId?: string | null;
  description?: string | null;
}

export async function createTerm(
  db: Kysely<Database>,
  taxonomyId: string,
  input: CreateTermInput,
): Promise<TermRow> {
  const taxonomy = await getTaxonomy(db, taxonomyId);
  if (!taxonomy) throw new TaxonomyError(`Taxonomy ${taxonomyId} not found.`, 'not_found');

  let parentId = input.parentId ?? null;
  if (parentId && !taxonomy.hierarchical) {
    throw new TaxonomyError(
      `"${taxonomy.name}" is a flat taxonomy, so its terms cannot be nested.`,
      'not_hierarchical',
    );
  }

  const parent = parentId ? await getTerm(db, parentId) : undefined;
  if (parentId && !parent) {
    throw new TaxonomyError(`Parent term ${parentId} not found.`, 'invalid_parent');
  }
  if (parent && parent.taxonomy_id !== taxonomyId) {
    throw new TaxonomyError(
      'A term cannot be nested under a term from a different taxonomy.',
      'invalid_parent',
    );
  }
  if (!parent) parentId = null;

  const siblings = await siblingTermSlugs(db, taxonomyId, parentId);
  // Blank means "derive from the name", matching how content item slugs behave.
  const slug = uniqueSlug(blankToUndefined(input.slug) || slugify(input.name), siblings);

  const timestamp = now();
  const row: TermRow = {
    id: newId(),
    taxonomy_id: taxonomyId,
    parent_id: parentId,
    slug,
    name: input.name,
    description: input.description ?? null,
    depth: parent ? parent.depth + 1 : 0,
    position: siblings.length,
    created_at: timestamp,
    updated_at: timestamp,
  };

  await db.insertInto('terms').values(row).execute();
  return row;
}

export interface UpdateTermInput {
  name?: string;
  slug?: string;
  parentId?: string | null;
  description?: string | null;
}

/**
 * Update a term, re-depthing its subtree when it moves.
 *
 * Without a materialised path there is nothing to rewrite on a move except `depth`, which still
 * has to cascade — a branch dragged one level up leaves every descendant claiming a depth that no
 * longer matches its position, and the admin renders the tree from it.
 */
export async function updateTerm(
  handle: { db: Kysely<Database>; batch(statements: BatchStatement[]): Promise<void> },
  id: string,
  input: UpdateTermInput,
): Promise<TermRow> {
  const { db } = handle;

  const existing = await getTerm(db, id);
  if (!existing) throw new TaxonomyError(`Term ${id} not found.`, 'not_found');

  const timestamp = now();
  const parentChanged =
    input.parentId !== undefined && (input.parentId ?? null) !== existing.parent_id;

  let parentId = existing.parent_id;
  let depth = existing.depth;
  const statements: BatchStatement[] = [];

  if (parentChanged) {
    const nextParentId = input.parentId ?? null;

    // Reading the subtree first is what makes the cycle check possible: a batch cannot read its
    // own writes, so the whole move is decided before a single statement is built.
    const subtree = await getTermSubtree(db, id);
    if (nextParentId && subtree.some((node) => node.id === nextParentId)) {
      throw new TaxonomyError(
        'A term cannot be moved underneath itself or one of its own descendants.',
        'cycle',
      );
    }

    const parent = nextParentId ? await getTerm(db, nextParentId) : undefined;
    if (nextParentId && !parent) {
      throw new TaxonomyError(`Parent term ${nextParentId} not found.`, 'invalid_parent');
    }
    if (parent && parent.taxonomy_id !== existing.taxonomy_id) {
      throw new TaxonomyError(
        'A term cannot be nested under a term from a different taxonomy.',
        'invalid_parent',
      );
    }

    parentId = nextParentId;
    depth = parent ? parent.depth + 1 : 0;

    // Shift every descendant by the same delta the moved node shifted.
    const delta = depth - existing.depth;
    if (delta !== 0) {
      for (const node of subtree) {
        if (node.id === id) continue;
        statements.push(
          db
            .updateTable('terms')
            .set({ depth: node.depth + delta, updated_at: timestamp })
            .where('id', '=', node.id),
        );
      }
    }
  }

  const submittedSlug = blankToUndefined(input.slug);
  let slug = existing.slug;
  if (submittedSlug || parentChanged) {
    const desired = submittedSlug ? slugify(submittedSlug) || existing.slug : existing.slug;
    if (desired !== existing.slug || parentChanged) {
      const taken = await siblingTermSlugs(db, existing.taxonomy_id, parentId, id);
      slug = uniqueSlug(desired, taken);
    }
  }

  const patch = {
    name: input.name ?? existing.name,
    slug,
    parent_id: parentId,
    depth,
    description:
      input.description === undefined ? existing.description : (input.description ?? null),
    updated_at: timestamp,
  };

  statements.push(db.updateTable('terms').set(patch).where('id', '=', id));
  await handle.batch(statements);

  return { ...existing, ...patch };
}

/**
 * Delete a term.
 *
 * Children are re-parented to the deleted term's parent rather than cascaded away — the FK is
 * `set null`, which would silently promote a whole branch to the root and lose its place in the
 * tree. Assignments to the term go with it, which is the intended meaning of removing a tag.
 */
export async function deleteTerm(
  handle: { db: Kysely<Database>; batch(statements: BatchStatement[]): Promise<void> },
  id: string,
): Promise<void> {
  const { db } = handle;

  const existing = await getTerm(db, id);
  if (!existing) throw new TaxonomyError(`Term ${id} not found.`, 'not_found');

  const children = await db.selectFrom('terms').selectAll().where('parent_id', '=', id).execute();
  const timestamp = now();

  const statements: BatchStatement[] = children.map((child) =>
    db
      .updateTable('terms')
      .set({ parent_id: existing.parent_id, depth: existing.depth, updated_at: timestamp })
      .where('id', '=', child.id),
  );

  // Descendants deeper than the immediate children shift up by one alongside them.
  const subtree = await getTermSubtree(db, id);
  for (const node of subtree) {
    if (node.id === id || children.some((child) => child.id === node.id)) continue;
    statements.push(
      db
        .updateTable('terms')
        .set({ depth: node.depth - 1, updated_at: timestamp })
        .where('id', '=', node.id),
    );
  }

  statements.push(db.deleteFrom('terms').where('id', '=', id));
  await handle.batch(statements);
}

/** Persist a new sibling order. Positions are rewritten to match array order. */
export async function reorderTerms(
  handle: { db: Kysely<Database>; batch(statements: BatchStatement[]): Promise<void> },
  orderedTermIds: string[],
): Promise<void> {
  const timestamp = now();
  await handle.batch(
    orderedTermIds.map((termId, index) =>
      handle.db
        .updateTable('terms')
        .set({ position: index, updated_at: timestamp })
        .where('id', '=', termId),
    ),
  );
}

// ---------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------

/**
 * Every item id carrying any term in a branch.
 *
 * Classification only. A term says what content is about, never who may edit it: roles are flat
 * and site-wide, and nothing anywhere derives a permission from a term. See SCOPE.md.
 */
/**
 * A term and everything beneath it, as ids.
 *
 * What a term filter actually means: filing something under "Sciences" should find it when someone
 * filters by "Academics". Separated from `itemIdsInTermBranch` because the item list wants to
 * *narrow a query* by the branch rather than pull every member id into memory and filter in JS —
 * which is what the public term archive does, and what stops being reasonable at a few thousand
 * items.
 */
export async function termIdsForBranch(
  db: Kysely<Database>,
  rootTermId: string,
): Promise<string[]> {
  const subtree = await getTermSubtree(db, rootTermId);
  return subtree.map((node) => node.id);
}

export async function itemIdsInTermBranch(
  db: Kysely<Database>,
  rootTermId: string,
): Promise<string[]> {
  const subtree = await getTermSubtree(db, rootTermId);
  if (subtree.length === 0) return [];

  const rows = await db
    .selectFrom('taxonomy_assignments')
    .select('content_item_id')
    .distinct()
    .where(
      'term_id',
      'in',
      subtree.map((node) => node.id),
    )
    .execute();

  return rows.map((row) => row.content_item_id);
}

/**
 * Read a taxonomy field's value out of an item's `data` as a list of term ids.
 *
 * The field config decides whether the stored value is a single id or an array, so both shapes
 * have to be accepted here rather than assuming one — and a value saved before the config was
 * flipped between them still has to read correctly.
 */
export function termIdsFromValue(value: unknown): string[] {
  if (typeof value === 'string') return value ? [value] : [];
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string');
  return [];
}

export interface AssignmentPlan {
  statements: BatchStatement[];
  /** Referenced term ids that do not exist, keyed by the field `api_id` that referenced them. */
  missing: Record<string, string[]>;
}

/**
 * Build the statements that rebuild one item's assignment index from its authored data.
 *
 * The delete is unconditional rather than scoped to the taxonomy fields currently on the type.
 * Removing a taxonomy field from a content type would otherwise strand that field's rows in the
 * index forever, and a stale row here is invisible until it wrongly answers a filtered listing —
 * showing an editor content that is no longer tagged the way the index claims.
 *
 * Returned as statements so the index lands in the same atomic batch as the item write. The reads
 * it needs — checking the referenced terms exist — all happen here, before the batch is built.
 */
export async function planAssignmentIndex(
  db: Kysely<Database>,
  contentItemId: string,
  fields: { api_id: string; type: string }[],
  data: Record<string, unknown>,
): Promise<AssignmentPlan> {
  const statements: BatchStatement[] = [
    db.deleteFrom('taxonomy_assignments').where('content_item_id', '=', contentItemId),
  ];

  const perField = fields
    .filter((field) => field.type === 'taxonomy')
    .map((field) => ({ apiId: field.api_id, termIds: termIdsFromValue(data[field.api_id]) }))
    .filter((entry) => entry.termIds.length > 0);

  if (perField.length === 0) return { statements, missing: {} };

  const referenced = [...new Set(perField.flatMap((entry) => entry.termIds))];
  const found = await db
    .selectFrom('terms')
    .select('id')
    .where('id', 'in', referenced)
    .execute();
  const known = new Set(found.map((row) => row.id));

  const missing: Record<string, string[]> = {};
  for (const entry of perField) {
    const absent = entry.termIds.filter((termId) => !known.has(termId));
    if (absent.length > 0) missing[entry.apiId] = absent;
  }

  if (Object.keys(missing).length > 0) return { statements, missing };

  for (const entry of perField) {
    // De-duplicated because the primary key would reject a repeat, and an author picking the same
    // term twice in a multi-select is a mistake to absorb rather than an error to raise.
    for (const termId of new Set(entry.termIds)) {
      statements.push(
        db.insertInto('taxonomy_assignments').values({
          content_item_id: contentItemId,
          field_api_id: entry.apiId,
          term_id: termId,
        }),
      );
    }
  }

  return { statements, missing };
}

/** The terms assigned to one item, across every taxonomy field it has. */
export async function termsForItem(
  db: Kysely<Database>,
  contentItemId: string,
): Promise<(TermRow & { field_api_id: string })[]> {
  const rows = await db
    .selectFrom('taxonomy_assignments')
    .innerJoin('terms', 'terms.id', 'taxonomy_assignments.term_id')
    .selectAll('terms')
    .select('taxonomy_assignments.field_api_id')
    .where('content_item_id', '=', contentItemId)
    .orderBy('terms.depth')
    .orderBy('terms.position')
    .execute();

  return rows;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function blankToUndefined(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

async function siblingTermSlugs(
  db: Kysely<Database>,
  taxonomyId: string,
  parentId: string | null,
  excludeId?: string,
): Promise<string[]> {
  let query = db.selectFrom('terms').select('slug').where('taxonomy_id', '=', taxonomyId);

  query =
    parentId === null ? query.where('parent_id', 'is', null) : query.where('parent_id', '=', parentId);

  if (excludeId) query = query.where('id', '!=', excludeId);

  return (await query.execute()).map((row) => row.slug);
}
