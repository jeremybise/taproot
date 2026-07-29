import type { Kysely } from 'kysely';

import type { BatchStatement } from '../db/batch.js';
import type {
  ContentStatus,
  Database,
  MenuItemRow,
  MenuRow,
  MenuTargetType,
} from '../db/schema.js';
import { fromBool, now, toBool } from '../db/values.js';
import { newId } from '../ids.js';
import { slugify } from './paths.js';

/**
 * Menus.
 *
 * A menu item references its target instead of storing a URL, so the path is resolved at render
 * time. That is the whole design: a moved page keeps its place in the navigation, and an
 * unpublished one leaves the public menu without anyone editing the menu.
 */

export class MenuError extends Error {
  override name = 'MenuError';
  constructor(
    message: string,
    readonly code:
      | 'not_found'
      | 'duplicate_api_id'
      | 'invalid_target'
      | 'cycle'
      | 'wrong_menu' = 'not_found',
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------

export async function listMenus(db: Kysely<Database>): Promise<MenuRow[]> {
  return db.selectFrom('menus').selectAll().orderBy('name').execute();
}

export async function getMenu(db: Kysely<Database>, id: string): Promise<MenuRow | undefined> {
  return db.selectFrom('menus').selectAll().where('id', '=', id).executeTakeFirst();
}

export async function getMenuByApiId(
  db: Kysely<Database>,
  apiId: string,
): Promise<MenuRow | undefined> {
  return db.selectFrom('menus').selectAll().where('api_id', '=', apiId).executeTakeFirst();
}

export interface MenuInput {
  api_id: string;
  name: string;
  description?: string | null;
}

export async function createMenu(db: Kysely<Database>, input: MenuInput): Promise<MenuRow> {
  const apiId = slugify(input.api_id) || slugify(input.name);
  if (!apiId) {
    throw new MenuError(
      'A menu needs an API id made of letters, numbers, or hyphens.',
      'duplicate_api_id',
    );
  }

  if (await getMenuByApiId(db, apiId)) {
    throw new MenuError(`A menu with the API id "${apiId}" already exists.`, 'duplicate_api_id');
  }

  const timestamp = now();
  const row: MenuRow = {
    id: newId(),
    api_id: apiId,
    name: input.name,
    description: input.description ?? null,
    created_at: timestamp,
    updated_at: timestamp,
  };

  await db.insertInto('menus').values(row).execute();
  return row;
}

/** `api_id` is immutable — templates ask for menus by it. */
export async function updateMenu(
  db: Kysely<Database>,
  id: string,
  input: Partial<Omit<MenuInput, 'api_id'>>,
): Promise<MenuRow> {
  const existing = await getMenu(db, id);
  if (!existing) throw new MenuError(`Menu ${id} not found.`, 'not_found');

  const patch = {
    name: input.name ?? existing.name,
    description:
      input.description === undefined ? existing.description : (input.description ?? null),
    updated_at: now(),
  };

  await db.updateTable('menus').set(patch).where('id', '=', id).execute();
  return { ...existing, ...patch };
}

export async function deleteMenu(db: Kysely<Database>, id: string): Promise<void> {
  await db.deleteFrom('menus').where('id', '=', id).execute();
}

// ---------------------------------------------------------------------------
// Menu items
// ---------------------------------------------------------------------------

export async function listMenuItems(
  db: Kysely<Database>,
  menuId: string,
): Promise<MenuItemRow[]> {
  return db
    .selectFrom('menu_items')
    .selectAll()
    .where('menu_id', '=', menuId)
    .orderBy('depth')
    .orderBy('position')
    .execute();
}

export async function getMenuItem(
  db: Kysely<Database>,
  id: string,
): Promise<MenuItemRow | undefined> {
  return db.selectFrom('menu_items').selectAll().where('id', '=', id).executeTakeFirst();
}

export interface MenuItemInput {
  targetType: MenuTargetType;
  label?: string | null;
  contentItemId?: string | null;
  termId?: string | null;
  url?: string | null;
  parentId?: string | null;
  openInNewTab?: boolean;
}

/**
 * Normalise and check a target, so exactly the column matching `target_type` is set.
 *
 * Done here rather than as a CHECK constraint because SQLite, D1, and Postgres disagree about
 * enough constraint syntax to make one portable expression awkward — and because a rejected save
 * should explain what was wrong rather than surface a constraint name.
 */
function resolveTarget(input: MenuItemInput): Pick<
  MenuItemRow,
  'target_type' | 'content_item_id' | 'term_id' | 'url'
> {
  switch (input.targetType) {
    case 'item':
      if (!input.contentItemId) {
        throw new MenuError('Choose the page this menu item links to.', 'invalid_target');
      }
      return {
        target_type: 'item',
        content_item_id: input.contentItemId,
        term_id: null,
        url: null,
      };

    case 'term':
      if (!input.termId) {
        throw new MenuError('Choose the term this menu item links to.', 'invalid_target');
      }
      return { target_type: 'term', content_item_id: null, term_id: input.termId, url: null };

    case 'url': {
      const url = input.url?.trim();
      if (!url) {
        throw new MenuError('Enter the address this menu item links to.', 'invalid_target');
      }
      /**
       * `javascript:` and `data:` are rejected outright. A menu item's URL is authored by an
       * editor and rendered into an `href` on every page of the site, which makes it the most
       * inviting stored-XSS surface in the CMS.
       */
      if (/^\s*(javascript|data|vbscript):/i.test(url)) {
        throw new MenuError(
          'That address uses a scheme that is not allowed in a link. Use http://, https://, ' +
            'mailto:, tel:, or a path beginning with /.',
          'invalid_target',
        );
      }
      return { target_type: 'url', content_item_id: null, term_id: null, url };
    }

    default: {
      const exhaustive: never = input.targetType;
      throw new MenuError(`Unknown menu target type: ${String(exhaustive)}`, 'invalid_target');
    }
  }
}

export async function createMenuItem(
  db: Kysely<Database>,
  menuId: string,
  input: MenuItemInput,
): Promise<MenuItemRow> {
  const menu = await getMenu(db, menuId);
  if (!menu) throw new MenuError(`Menu ${menuId} not found.`, 'not_found');

  const target = resolveTarget(input);

  const parentId = input.parentId ?? null;
  const parent = parentId ? await getMenuItem(db, parentId) : undefined;
  if (parentId && !parent) {
    throw new MenuError(`Parent menu item ${parentId} not found.`, 'not_found');
  }
  if (parent && parent.menu_id !== menuId) {
    throw new MenuError('A menu item cannot be nested under an item in another menu.', 'wrong_menu');
  }

  const siblings = await db
    .selectFrom('menu_items')
    .select('id')
    .where('menu_id', '=', menuId)
    .where(parentId === null ? 'parent_id' : 'parent_id', parentId === null ? 'is' : '=', parentId)
    .execute();

  const timestamp = now();
  const row: MenuItemRow = {
    id: newId(),
    menu_id: menuId,
    parent_id: parentId,
    position: siblings.length,
    depth: parent ? parent.depth + 1 : 0,
    label: input.label?.trim() || null,
    ...target,
    open_in_new_tab: fromBool(input.openInNewTab),
    created_at: timestamp,
    updated_at: timestamp,
  };

  await db.insertInto('menu_items').values(row).execute();
  return row;
}

export async function updateMenuItem(
  handle: { db: Kysely<Database>; batch(statements: BatchStatement[]): Promise<void> },
  id: string,
  input: Partial<MenuItemInput>,
): Promise<MenuItemRow> {
  const { db } = handle;

  const existing = await getMenuItem(db, id);
  if (!existing) throw new MenuError(`Menu item ${id} not found.`, 'not_found');

  const target = input.targetType
    ? resolveTarget({
        targetType: input.targetType,
        contentItemId: input.contentItemId ?? existing.content_item_id,
        termId: input.termId ?? existing.term_id,
        url: input.url ?? existing.url,
      })
    : {
        target_type: existing.target_type,
        content_item_id: existing.content_item_id,
        term_id: existing.term_id,
        url: existing.url,
      };

  const timestamp = now();
  const statements: BatchStatement[] = [];

  let parentId = existing.parent_id;
  let depth = existing.depth;

  if (input.parentId !== undefined && (input.parentId ?? null) !== existing.parent_id) {
    const nextParentId = input.parentId ?? null;

    // Reading the subtree before building any statement is what makes the cycle check possible —
    // a batch cannot read its own writes.
    const subtree = await menuItemSubtree(db, id);
    if (nextParentId && subtree.some((node) => node.id === nextParentId)) {
      throw new MenuError(
        'A menu item cannot be moved underneath itself or one of its own children.',
        'cycle',
      );
    }

    const parent = nextParentId ? await getMenuItem(db, nextParentId) : undefined;
    if (nextParentId && !parent) {
      throw new MenuError(`Parent menu item ${nextParentId} not found.`, 'not_found');
    }
    if (parent && parent.menu_id !== existing.menu_id) {
      throw new MenuError(
        'A menu item cannot be nested under an item in another menu.',
        'wrong_menu',
      );
    }

    parentId = nextParentId;
    depth = parent ? parent.depth + 1 : 0;

    const delta = depth - existing.depth;
    if (delta !== 0) {
      for (const node of subtree) {
        if (node.id === id) continue;
        statements.push(
          db
            .updateTable('menu_items')
            .set({ depth: node.depth + delta, updated_at: timestamp })
            .where('id', '=', node.id),
        );
      }
    }
  }

  const patch = {
    label: input.label === undefined ? existing.label : input.label?.trim() || null,
    parent_id: parentId,
    depth,
    ...target,
    open_in_new_tab:
      input.openInNewTab === undefined ? existing.open_in_new_tab : fromBool(input.openInNewTab),
    updated_at: timestamp,
  };

  statements.push(db.updateTable('menu_items').set(patch).where('id', '=', id));
  await handle.batch(statements);

  return { ...existing, ...patch };
}

/** Children go with the item — a dropdown's contents have no meaning without the thing they hang off. */
export async function deleteMenuItem(db: Kysely<Database>, id: string): Promise<void> {
  await db.deleteFrom('menu_items').where('id', '=', id).execute();
}

/** Move an item up or down among its siblings. */
export async function reorderMenuItems(
  handle: { db: Kysely<Database>; batch(statements: BatchStatement[]): Promise<void> },
  orderedIds: string[],
): Promise<void> {
  const timestamp = now();
  await handle.batch(
    orderedIds.map((id, index) =>
      handle.db
        .updateTable('menu_items')
        .set({ position: index, updated_at: timestamp })
        .where('id', '=', id),
    ),
  );
}

async function menuItemSubtree(
  db: Kysely<Database>,
  rootId: string,
): Promise<{ id: string; depth: number }[]> {
  const all = await db.selectFrom('menu_items').select(['id', 'parent_id', 'depth']).execute();

  const collected: { id: string; depth: number }[] = [];
  const walk = (id: string) => {
    const node = all.find((row) => row.id === id);
    if (!node) return;
    collected.push({ id: node.id, depth: node.depth });
    for (const child of all.filter((row) => row.parent_id === id)) walk(child.id);
  };
  walk(rootId);

  return collected;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface ResolvedMenuItem {
  id: string;
  label: string;
  /** Null when the target is gone or unpublished. Public rendering skips these. */
  href: string | null;
  openInNewTab: boolean;
  targetType: MenuTargetType;
  /**
   * Why there is no href, for the admin.
   *
   * - `deleted` — the referenced row is gone.
   * - `unpublished` — it exists but is not visible to the public.
   * - `no_route` — a term the site publishes no page for. Not an error: most taxonomies are
   *   internal classification, and whether a term has a public URL is the site's decision.
   */
  brokenReason: 'deleted' | 'unpublished' | 'no_route' | null;
  children: ResolvedMenuItem[];
}

/** A term, as handed to a site's `termHref` resolver. */
export interface TermLinkTarget {
  id: string;
  name: string;
  slug: string;
  taxonomyApiId: string;
}

export interface ResolveMenuOptions {
  /**
   * Drop entries whose target is not publicly visible. On for site rendering, off for the admin,
   * which needs to show a broken entry in order to let someone fix it.
   */
  publishedOnly?: boolean;
  /**
   * Where a term's page lives on this site, or null if it has none.
   *
   * **Taproot has no opinion about term URLs**, which is why this is a callback rather than a
   * convention baked in here. Plenty of taxonomies exist purely to classify content — a review
   * status, an internal owner, an audience segment — and publishing a page per term of those
   * would be wrong. Others genuinely want archives. Which is which depends on the routes the site
   * actually serves, so it is the site's call, not the CMS's.
   *
   * Omit it and term entries resolve to no href with `brokenReason: 'no_route'`, which is the
   * correct default: a CMS that invented URLs its host does not serve would produce menu links
   * that 404.
   *
   * `termArchivePath` is one ready-made convention to pass through, if it suits.
   */
  termHref?: (term: TermLinkTarget) => string | null;
}

/**
 * Resolve a menu into a tree of links.
 *
 * Everything is read in three queries regardless of menu size — the items, then the referenced
 * content, then the referenced terms — rather than resolving each entry as it is walked. A menu is
 * rendered on every page of the site, so an N+1 here would be an N+1 everywhere.
 */
export async function resolveMenu(
  db: Kysely<Database>,
  apiId: string,
  options: ResolveMenuOptions = {},
): Promise<ResolvedMenuItem[]> {
  const menu = await getMenuByApiId(db, apiId);
  if (!menu) return [];

  const items = await listMenuItems(db, menu.id);
  if (items.length === 0) return [];

  const itemIds = items.map((entry) => entry.content_item_id).filter((id): id is string => !!id);
  const termIds = items.map((entry) => entry.term_id).filter((id): id is string => !!id);

  const contentRows = itemIds.length
    ? await db
        .selectFrom('content_items')
        .select(['id', 'title', 'path', 'status'])
        .where('id', 'in', itemIds)
        .execute()
    : [];

  const termRows = termIds.length
    ? await db
        .selectFrom('terms')
        .innerJoin('taxonomies', 'taxonomies.id', 'terms.taxonomy_id')
        .select(['terms.id as id', 'terms.name as name', 'terms.slug as slug'])
        .select('taxonomies.api_id as taxonomy_api_id')
        .where('terms.id', 'in', termIds)
        .execute()
    : [];

  const contentById = new Map(contentRows.map((row) => [row.id, row]));
  const termById = new Map(termRows.map((row) => [row.id, row]));

  const publishedOnly = options.publishedOnly !== false;

  const resolved = items.map((entry) => {
    let href: string | null = null;
    let title: string | null = null;
    let brokenReason: ResolvedMenuItem['brokenReason'] = null;

    switch (entry.target_type) {
      case 'item': {
        const target = entry.content_item_id ? contentById.get(entry.content_item_id) : undefined;
        if (!target) {
          brokenReason = 'deleted';
        } else {
          // The href is resolved even for a draft, so the admin can still follow the link to the
          // page it points at. `brokenReason` is what decides whether visitors see the entry —
          // computed regardless of `publishedOnly`, or the admin could not tell a draft target
          // from a live one, which is exactly what it needs to show.
          href = target.path;
          title = target.title;
          if ((target.status as ContentStatus) !== 'published') brokenReason = 'unpublished';
        }
        break;
      }

      case 'term': {
        const target = entry.term_id ? termById.get(entry.term_id) : undefined;
        if (!target) {
          brokenReason = 'deleted';
        } else {
          title = target.name;
          // No resolver, or one that declines this term, means the site publishes no page for it.
          // Distinct from `deleted`: nothing is wrong, there is simply nowhere to link to.
          href =
            options.termHref?.({
              id: target.id,
              name: target.name,
              slug: target.slug,
              taxonomyApiId: target.taxonomy_api_id,
            }) ?? null;
          if (href === null) brokenReason = 'no_route';
        }
        break;
      }

      case 'url':
        href = entry.url;
        break;
    }

    return {
      row: entry,
      node: {
        id: entry.id,
        // The stored label wins; otherwise the target's own title, which is what keeps a renamed
        // page's menu entry current without anyone editing the menu.
        label: entry.label ?? title ?? 'Untitled',
        href,
        openInNewTab: toBool(entry.open_in_new_tab),
        targetType: entry.target_type,
        brokenReason,
        children: [] as ResolvedMenuItem[],
      } satisfies ResolvedMenuItem,
    };
  });

  // Filtered on `brokenReason` rather than a missing href, so an entry pointing at a draft is
  // dropped for visitors even though its href resolved fine.
  const visible = publishedOnly
    ? resolved.filter((entry) => entry.node.brokenReason === null && entry.node.href !== null)
    : resolved;

  const byId = new Map(visible.map((entry) => [entry.row.id, entry]));
  const roots: ResolvedMenuItem[] = [];

  for (const entry of visible) {
    const parent = entry.row.parent_id ? byId.get(entry.row.parent_id) : undefined;
    // An entry whose parent was filtered out is promoted rather than dropped: hiding a whole
    // dropdown because its heading is a draft would silently remove published pages from the nav.
    if (parent) parent.node.children.push(entry.node);
    else roots.push(entry.node);
  }

  return roots;
}

/**
 * One ready-made term-URL convention: `/{taxonomy}/{term}`.
 *
 * Offered, not imposed. Nothing in Taproot calls this — a site opts in by passing it (or anything
 * else) as `resolveMenu`'s `termHref`, and by serving the matching route. `apps/web` does both and
 * is the worked example; a site wanting `/topics/{term}`, term pages for one taxonomy only, or
 * none at all, writes its own resolver instead.
 */
export function termArchivePath(taxonomyApiId: string, termSlug: string): string {
  return `/${taxonomyApiId}/${termSlug}`;
}
