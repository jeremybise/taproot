import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDb, type TaprootDb } from '../db/client.js';
import { migrateToLatest } from '../db/migrations/index.js';
import type { ContentTypeRow, FieldRow } from '../db/schema.js';
import { createContentType, createField } from './types.js';
import { createItem, getRedirect, updateItem } from './items.js';
import {
  createRedirect,
  deleteRedirect,
  listRedirects,
  redirectIsShadowed,
  updateRedirect,
} from './redirects.js';

/**
 * Author-created redirects.
 *
 * The automatic half has been tested since Phase 1. This covers the half a person types in, and
 * in particular the two ways a hand-written redirect goes wrong that an automatic one cannot:
 * pointing somewhere that points back, and being written for a URL a live page already answers.
 */

let handle: TaprootDb;

beforeEach(async () => {
  handle = await createDb({ driver: 'sqlite', location: ':memory:' });
  const result = await migrateToLatest(handle.db);
  if (result.error) throw result.error;
});

afterEach(async () => {
  await handle.destroy();
});

async function seedPageType(): Promise<{ type: ContentTypeRow; fields: FieldRow[] }> {
  const type = await createContentType(handle.db, {
    api_id: 'page',
    name: 'Page',
    name_plural: 'Pages',
    kind: 'page',
    description: null,
    icon: null,
    url_prefix: null,
    title_field: 'title',
  });

  const body = await createField(handle.db, type.id, {
    api_id: 'body',
    label: 'Body',
    type: 'text',
    required: false,
    localized: false,
    position: 0,
    config: {},
    help_text: null,
  });

  return { type, fields: [body] };
}

describe('creating', () => {
  it('stores a manual redirect and resolves it', async () => {
    await createRedirect(handle.db, { fromPath: '/old-site/apply.html', toPath: '/apply' });

    const resolved = await getRedirect(handle.db, '/old-site/apply.html');
    expect(resolved?.to).toBe('/apply');
    expect(resolved?.status).toBe(301);
  });

  it('marks it manual, which is what keeps it from being cleaned up', async () => {
    const redirect = await createRedirect(handle.db, { fromPath: '/a', toPath: '/b' });
    expect(redirect.source).toBe('manual');
  });

  it('normalises both paths', async () => {
    const redirect = await createRedirect(handle.db, { fromPath: 'old//page/', toPath: 'new/page' });
    expect(redirect.from_path).toBe('/old/page');
    expect(redirect.to_path).toBe('/new/page');
  });

  it('accepts an absolute http(s) target', async () => {
    const redirect = await createRedirect(handle.db, {
      fromPath: '/store',
      toPath: 'https://shop.example.edu/',
    });
    expect(redirect.to_path).toBe('https://shop.example.edu/');
  });

  it('refuses a javascript: target', async () => {
    // `to_path` goes into a Location header. A script URL here is stored XSS on a path nobody is
    // watching, which is the same reason menu items reject it.
    await expect(
      createRedirect(handle.db, { fromPath: '/x', toPath: 'javascript:alert(1)' }),
    ).rejects.toThrow(/path or an http/);
  });

  it('refuses a redirect to itself', async () => {
    await expect(createRedirect(handle.db, { fromPath: '/a', toPath: '/a' })).rejects.toThrow(
      /point at itself/,
    );
  });

  it('refuses to redirect the home page', async () => {
    // Nothing would resolve past it, so the site would have no root.
    await expect(createRedirect(handle.db, { fromPath: '/', toPath: '/home' })).rejects.toThrow(
      /home page cannot redirect/,
    );
  });

  it('refuses a duplicate from_path', async () => {
    await createRedirect(handle.db, { fromPath: '/a', toPath: '/b' });
    await expect(createRedirect(handle.db, { fromPath: '/a', toPath: '/c' })).rejects.toThrow(
      /already exists/,
    );
  });

  it('refuses a loop, however many hops it takes', async () => {
    /**
     * The mistake this exists for: each row looks correct on its own, and the loop only exists in
     * the relationship between them. A browser following it gives up with an error page.
     */
    await createRedirect(handle.db, { fromPath: '/a', toPath: '/b' });
    await createRedirect(handle.db, { fromPath: '/b', toPath: '/c' });

    await expect(createRedirect(handle.db, { fromPath: '/c', toPath: '/a' })).rejects.toThrow(
      /redirect loop/,
    );
  });

  it('allows a chain that terminates', async () => {
    await createRedirect(handle.db, { fromPath: '/a', toPath: '/b' });
    await expect(
      createRedirect(handle.db, { fromPath: '/b', toPath: '/c' }),
    ).resolves.toBeDefined();
  });
});

describe('editing and deleting', () => {
  it('updates a redirect', async () => {
    const redirect = await createRedirect(handle.db, { fromPath: '/a', toPath: '/b' });
    const updated = await updateRedirect(handle.db, redirect.id, {
      toPath: '/c',
      statusCode: 302,
    });

    expect(updated.to_path).toBe('/c');
    expect(updated.status_code).toBe(302);
  });

  it('refuses an edit that would create a loop', async () => {
    await createRedirect(handle.db, { fromPath: '/a', toPath: '/b' });
    const second = await createRedirect(handle.db, { fromPath: '/b', toPath: '/c' });

    await expect(updateRedirect(handle.db, second.id, { toPath: '/a' })).rejects.toThrow(
      /redirect loop/,
    );
  });

  it('deletes one', async () => {
    const redirect = await createRedirect(handle.db, { fromPath: '/a', toPath: '/b' });
    await deleteRedirect(handle.db, redirect.id);
    expect(await getRedirect(handle.db, '/a')).toBeUndefined();
  });

  it('searches either path', async () => {
    await createRedirect(handle.db, { fromPath: '/old/apply', toPath: '/admissions' });
    await createRedirect(handle.db, { fromPath: '/legacy', toPath: '/apply-now' });

    expect((await listRedirects(handle.db, { search: 'apply' })).total).toBe(2);
    expect((await listRedirects(handle.db, { search: 'legacy' })).total).toBe(1);
  });
});

describe('living alongside the automatic half', () => {
  it('collapses a manual redirect when its target moves', async () => {
    /**
     * The whole reason this reuses `buildRedirectStatements` rather than reimplementing it: a
     * hand-written redirect has to take part in the same chain collapse an automatic one does, or
     * a migration's redirects rot the first time anyone renames a page.
     */
    const { type, fields } = await seedPageType();
    const item = await createItem(handle, type, fields, {
      contentTypeId: type.id,
      title: 'Apply',
    });

    await createRedirect(handle.db, { fromPath: '/old-site/apply.html', toPath: '/apply' });

    await updateItem(handle, type, fields, item.id, { slug: 'how-to-apply' });

    // Not /old-site/apply.html → /apply → /how-to-apply, which is a hop the browser has to walk
    // and a search engine penalises.
    expect((await getRedirect(handle.db, '/old-site/apply.html'))?.to).toBe('/how-to-apply');
  });

  it('keeps a manual redirect when a page moves onto its path', async () => {
    /**
     * A move deletes redirects *leaving* the path it has just filled, because a live item answers
     * first and the row is dead weight. That sweep used to take manual rows too, contradicting the
     * schema's own promise that they are never GC'd — and losing an author's work silently.
     */
    const { type, fields } = await seedPageType();
    await createRedirect(handle.db, { fromPath: '/apply', toPath: '/elsewhere' });

    const item = await createItem(handle, type, fields, {
      contentTypeId: type.id,
      title: 'Temporary',
    });
    await updateItem(handle, type, fields, item.id, { slug: 'apply' });

    const { redirects } = await listRedirects(handle.db);
    expect(redirects.some((redirect) => redirect.from_path === '/apply')).toBe(true);
  });

  it('reports a redirect a live page is sitting on top of', async () => {
    // Not an error: the catch-all resolves an item before the redirect table, so the row is inert
    // rather than wrong, and becomes useful again if the item moves away.
    const { type, fields } = await seedPageType();
    await createItem(handle, type, fields, { contentTypeId: type.id, title: 'Apply' });

    await createRedirect(handle.db, { fromPath: '/apply', toPath: '/admissions' });

    expect(await redirectIsShadowed(handle.db, '/apply')).toBe(true);
    expect(await redirectIsShadowed(handle.db, '/nothing-here')).toBe(false);
  });
});
