import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDb, type TaprootDb } from '../db/client.js';
import { migrateToLatest } from '../db/migrations/index.js';
import { createUser } from '../auth/users.js';
import { createContentType, createField } from './types.js';
import { createItem, updateItem } from './items.js';
import { createRelease, stageItem, unstageItem, updateStagedItem } from './releases.js';
import {
  createPreviewToken,
  purgeExpiredPreviewTokens,
  resolvePreviewToken,
} from './preview.js';
import { hashSessionToken } from '../auth/session.js';
import { PREVIEW_PARAM } from '../pure.js';
import type { ContentTypeRow, FieldRow, User } from '../db/schema.js';

/**
 * Cross-origin preview.
 *
 * `?preview=1` worked only because the site and the CMS shared an origin, so the session cookie
 * came along and the route checked the *session* rather than the parameter. The token replaces that
 * session, and everything below is about it behaving like one: unguessable, expiring, and never
 * telling a prober which of their guesses was once real.
 */

let handle: TaprootDb;
let type: ContentTypeRow;
let fields: FieldRow[];
let editor: User;

beforeEach(async () => {
  handle = await createDb({ driver: 'sqlite', location: ':memory:' });
  const result = await migrateToLatest(handle.db);
  if (result.error) throw result.error;

  editor = await createUser(handle.db, {
    email: 'editor@example.edu',
    name: 'Erin',
    role: 'editor',
  });

  type = await createContentType(handle.db, {
    api_id: 'page',
    name: 'Page',
    name_plural: 'Pages',
    kind: 'page',
    description: null,
    icon: null,
    url_prefix: null,
    title_field: 'title',
  });

  fields = [
    await createField(handle.db, type.id, {
      api_id: 'body',
      label: 'Body',
      type: 'text',
      required: false,
      localized: false,
      position: 0,
      config: {},
      help_text: null,
    }),
  ];
});

afterEach(async () => {
  await handle.destroy();
});

async function draft(title = 'Notice') {
  return createItem(handle, type, fields, {
    contentTypeId: type.id,
    title,
    status: 'draft',
    data: { body: 'unpublished' },
  });
}

describe('a draft preview', () => {
  it('resolves to the item', async () => {
    const item = await draft();
    const { token } = await createPreviewToken(handle.db, {
      contentItemId: item.id,
      userId: editor.id,
    });

    const preview = await resolvePreviewToken(handle.db, token);
    expect(preview?.item.id).toBe(item.id);
    expect(preview?.releaseId).toBeNull();
  });

  /**
   * Absent, malformed, unknown, and expired must be indistinguishable. Telling them apart tells
   * whoever is guessing which guess was once real.
   */
  it('refuses anything that is not a live token, identically', async () => {
    expect(await resolvePreviewToken(handle.db, undefined)).toBeUndefined();
    expect(await resolvePreviewToken(handle.db, '')).toBeUndefined();
    expect(await resolvePreviewToken(handle.db, 'not-a-token')).toBeUndefined();
    expect(await resolvePreviewToken(handle.db, 'a'.repeat(64))).toBeUndefined();
  });

  it('stops working once it has expired', async () => {
    const item = await draft();
    const { token } = await createPreviewToken(handle.db, { contentItemId: item.id });

    await handle.db
      .updateTable('preview_tokens')
      .set({ expires_at: new Date(Date.now() - 1000).toISOString() })
      .execute();

    expect(await resolvePreviewToken(handle.db, token)).toBeUndefined();
  });

  /**
   * Deliberately not single-use. A preview link is opened, reloaded, and navigated back to —
   * burning it on first read would make the feature work once per click, which is how a security
   * measure becomes something people route around.
   */
  it('works more than once within its lifetime', async () => {
    const item = await draft();
    const { token } = await createPreviewToken(handle.db, { contentItemId: item.id });

    expect(await resolvePreviewToken(handle.db, token)).toBeDefined();
    expect(await resolvePreviewToken(handle.db, token)).toBeDefined();
  });

  it('stores only the hash, so a database dump is not a set of live previews', async () => {
    const item = await draft();
    const { token } = await createPreviewToken(handle.db, { contentItemId: item.id });

    const rows = await handle.db.selectFrom('preview_tokens').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).not.toBe(token);
  });

  it('dies with the item it points at', async () => {
    const item = await draft();
    const { token } = await createPreviewToken(handle.db, { contentItemId: item.id });

    await handle.db.deleteFrom('content_items').where('id', '=', item.id).execute();

    expect(await resolvePreviewToken(handle.db, token)).toBeUndefined();
  });
});

describe('a release preview', () => {
  /**
   * One mechanism for both, which is the point. Phase 3.5 added a second thing worth previewing,
   * and giving it its own token is how two nearly-identical paths drift until one of them stops
   * checking something.
   */
  it('shows the staged version rather than the live page', async () => {
    const item = await createItem(handle, type, fields, {
      contentTypeId: type.id,
      title: 'Tuition',
      status: 'published',
      data: { body: 'this year' },
    });

    const release = await createRelease(handle.db, { name: 'Next year' });
    await stageItem(handle.db, release.id, item.id);
    await updateStagedItem(handle.db, release.id, item.id, { data: { body: 'next year' } });

    const { token } = await createPreviewToken(handle.db, {
      contentItemId: item.id,
      releaseId: release.id,
      userId: editor.id,
    });

    const preview = await resolvePreviewToken(handle.db, token);
    expect(preview?.item.data).toEqual({ body: 'next year' });
    expect(preview?.releaseId).toBe(release.id);

    // And the live row is untouched, which is the whole reason releases exist.
    const live = await handle.db
      .selectFrom('content_items')
      .select('data')
      .where('id', '=', item.id)
      .executeTakeFirst();
    expect(JSON.parse(live!.data)).toEqual({ body: 'this year' });
  });

  /**
   * Merged over the live row rather than fabricated, so everything a release does *not* stage —
   * status, path, parent — stays true. A preview that invented those would be a preview of a page
   * that will never exist.
   */
  it('keeps the live item’s status and path', async () => {
    const item = await createItem(handle, type, fields, {
      contentTypeId: type.id,
      title: 'Tuition',
      status: 'published',
      data: { body: 'x' },
    });
    const release = await createRelease(handle.db, { name: 'Next year' });
    await stageItem(handle.db, release.id, item.id);

    const { token } = await createPreviewToken(handle.db, {
      contentItemId: item.id,
      releaseId: release.id,
    });

    const preview = await resolvePreviewToken(handle.db, token);
    expect(preview?.item.status).toBe('published');
    expect(preview?.item.path).toBe(item.path);
  });

  it('falls back to the live item when the staged version has been removed', async () => {
    const item = await draft();
    const release = await createRelease(handle.db, { name: 'Next year' });
    await stageItem(handle.db, release.id, item.id);

    const { token } = await createPreviewToken(handle.db, {
      contentItemId: item.id,
      releaseId: release.id,
    });

    await unstageItem(handle.db, release.id, item.id);

    // The page still exists, and showing it beats an error about a release the reader did not ask
    // about.
    const preview = await resolvePreviewToken(handle.db, token);
    expect(preview?.item.id).toBe(item.id);
    expect(preview?.releaseId).toBeNull();
  });
});

describe('housekeeping', () => {
  it('purges expired tokens and leaves live ones alone', async () => {
    const item = await draft();
    const { token: stale } = await createPreviewToken(handle.db, { contentItemId: item.id });
    const { token: live } = await createPreviewToken(handle.db, { contentItemId: item.id });

    // Age exactly one of them, by its own id — the hash is deterministic, so the test can name the
    // row it means rather than reaching for whichever came back first.
    await handle.db
      .updateTable('preview_tokens')
      .set({ expires_at: new Date(Date.now() - 1000).toISOString() })
      .where('id', '=', await hashSessionToken(stale))
      .execute();

    expect(await purgeExpiredPreviewTokens(handle.db)).toBe(1);
    expect(await resolvePreviewToken(handle.db, stale)).toBeUndefined();
    expect(await resolvePreviewToken(handle.db, live)).toBeDefined();
  });
});

describe('the parameter name', () => {
  /**
   * Declared in `pure.ts` and re-exported here, because that is the only entry both sides of the
   * wire can import — the server through the main barrel, the client through `/pure`. A second copy
   * is how the two ends stop agreeing on a name.
   */
  it('is one string, reachable from both entries', async () => {
    const { PREVIEW_PARAM: fromContent } = await import('./preview.js');
    expect(fromContent).toBe(PREVIEW_PARAM);
    expect(PREVIEW_PARAM).toBe('taproot_preview');
  });
});
