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
  writePreviewDraft,
} from './preview.js';
import { hashSessionToken } from '../auth/session.js';
import { PREVIEW_MESSAGE, PREVIEW_PARAM } from '../pure.js';
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
    summary_template: '{{ title }}',
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

describe('an unsaved editor snapshot', () => {
  const snapshot = {
    title: 'Notice',
    slug: 'notice',
    data: { body: 'typing right now' },
    seo: {},
  };

  it('is merged over the live row', async () => {
    const item = await draft();
    const { token } = await createPreviewToken(handle.db, {
      contentItemId: item.id,
      userId: editor.id,
    });

    expect(await writePreviewDraft(handle.db, { token, userId: editor.id, draft: snapshot })).
      toMatchObject({ ok: true });

    const preview = await resolvePreviewToken(handle.db, token);
    expect(preview?.item.data).toEqual({ body: 'typing right now' });
    expect(preview?.draft).toBe(true);
  });

  /**
   * The whole of the "this is not a version" argument, asserted rather than intended.
   *
   * A snapshot that touched either table would be a draft store, and Content Releases is the
   * feature it would be duplicating badly.
   */
  it('leaves content_items and release_items byte-identical', async () => {
    const item = await createItem(handle, type, fields, {
      contentTypeId: type.id,
      title: 'Tuition',
      status: 'published',
      data: { body: 'this year' },
    });
    const release = await createRelease(handle.db, { name: 'Next year' });
    await stageItem(handle.db, release.id, item.id);
    await updateStagedItem(handle.db, release.id, item.id, { data: { body: 'next year' } });

    const before = {
      items: await handle.db.selectFrom('content_items').selectAll().execute(),
      staged: await handle.db.selectFrom('release_items').selectAll().execute(),
    };

    const { token } = await createPreviewToken(handle.db, {
      contentItemId: item.id,
      releaseId: release.id,
      userId: editor.id,
    });
    await writePreviewDraft(handle.db, {
      token,
      userId: editor.id,
      draft: { ...snapshot, data: { body: 'not saved anywhere' } },
    });

    expect(await handle.db.selectFrom('content_items').selectAll().execute()).toEqual(before.items);
    expect(await handle.db.selectFrom('release_items').selectAll().execute()).toEqual(before.staged);
  });

  /**
   * Three layers, in the order an editor experiences them.
   *
   * Somebody in split view on a staged version is editing *that* version, so the draft goes over it
   * and the release survives. Resolving the draft against the live row instead would show a page
   * that is neither what they are editing nor what will ship.
   */
  it('wins over a release’s staged version, and keeps the release', async () => {
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
    await writePreviewDraft(handle.db, {
      token,
      userId: editor.id,
      draft: { ...snapshot, data: { body: 'next year, reworded' } },
    });

    const preview = await resolvePreviewToken(handle.db, token);
    expect(preview?.item.data).toEqual({ body: 'next year, reworded' });
    expect(preview?.releaseId).toBe(release.id);
  });

  /** `path` and `status` are not staged by a release and are not staged by a draft either. */
  it('cannot move the page or change its status', async () => {
    const item = await draft();
    const { token } = await createPreviewToken(handle.db, {
      contentItemId: item.id,
      userId: editor.id,
    });

    await writePreviewDraft(handle.db, {
      token,
      userId: editor.id,
      draft: { ...snapshot, slug: 'somewhere-else' },
    });

    const preview = await resolvePreviewToken(handle.db, token);
    expect(preview?.item.slug).toBe('somewhere-else');
    expect(preview?.item.path).toBe(item.path);
    expect(preview?.item.status).toBe('draft');
  });

  it('refuses an expired token', async () => {
    const item = await draft();
    const { token } = await createPreviewToken(handle.db, {
      contentItemId: item.id,
      userId: editor.id,
    });

    await handle.db
      .updateTable('preview_tokens')
      .set({ expires_at: new Date(Date.now() - 1000).toISOString() })
      .execute();

    expect(await writePreviewDraft(handle.db, { token, userId: editor.id, draft: snapshot })).
      toEqual({ ok: false, reason: 'unknown' });
  });

  /**
   * Identically to an unknown one. A distinct answer here confirms the token exists, which is the
   * thing `resolvePreviewToken` declines to say and this must not say either.
   */
  it('refuses another person’s token, indistinguishably from one that never existed', async () => {
    const other = await createUser(handle.db, {
      email: 'other@example.edu',
      name: 'Sam',
      role: 'editor',
    });
    const item = await draft();
    const { token } = await createPreviewToken(handle.db, {
      contentItemId: item.id,
      userId: editor.id,
    });

    const foreign = await writePreviewDraft(handle.db, {
      token,
      userId: other.id,
      draft: snapshot,
    });
    const unknown = await writePreviewDraft(handle.db, {
      token: 'a'.repeat(64),
      userId: other.id,
      draft: snapshot,
    });

    expect(foreign).toEqual(unknown);
    expect(foreign).toEqual({ ok: false, reason: 'unknown' });
  });

  it('sanitises richtext on the way in', async () => {
    const rich = await createField(handle.db, type.id, {
      api_id: 'intro',
      label: 'Intro',
      type: 'richtext',
      required: false,
      localized: false,
      position: 1,
      config: {},
      help_text: null,
    });
    const item = await draft();
    const { token } = await createPreviewToken(handle.db, {
      contentItemId: item.id,
      userId: editor.id,
    });

    await writePreviewDraft(handle.db, {
      token,
      userId: editor.id,
      draft: { ...snapshot, data: { intro: '<p>hi</p><script>alert(1)</script>' } },
    });

    // The consumer renders this with `set:html`, so an unsanitised snapshot is stored XSS against
    // every editor previewing the page.
    const preview = await resolvePreviewToken(handle.db, token);
    expect(preview?.item.data[rich.api_id]).toBe('<p>hi</p>');
  });

  it('accepts a draft missing a required field', async () => {
    await createField(handle.db, type.id, {
      api_id: 'summary',
      label: 'Summary',
      type: 'text',
      required: true,
      localized: false,
      position: 1,
      config: {},
      help_text: null,
    });
    const item = await draft();
    const { token } = await createPreviewToken(handle.db, {
      contentItemId: item.id,
      userId: editor.id,
    });

    // The point of the whole feature: a preview of a page before its last keystroke.
    expect(await writePreviewDraft(handle.db, { token, userId: editor.id, draft: snapshot })).
      toMatchObject({ ok: true });
  });

  it('reports an over-length value without clearing what is already there', async () => {
    await createField(handle.db, type.id, {
      api_id: 'code',
      label: 'Code',
      type: 'text',
      required: false,
      localized: false,
      position: 1,
      config: { maxLength: 3 },
      help_text: null,
    });
    const item = await draft();
    const { token } = await createPreviewToken(handle.db, {
      contentItemId: item.id,
      userId: editor.id,
    });

    await writePreviewDraft(handle.db, { token, userId: editor.id, draft: snapshot });
    const rejected = await writePreviewDraft(handle.db, {
      token,
      userId: editor.id,
      draft: { ...snapshot, data: { body: 'newer', code: 'far too long' } },
    });

    expect(rejected).toMatchObject({ ok: false, reason: 'invalid' });
    // The previous snapshot survives, so the pane goes on showing the last good state rather than
    // going blank while somebody is briefly over a limit they will hit on save anyway.
    const preview = await resolvePreviewToken(handle.db, token);
    expect(preview?.item.data).toEqual({ body: 'typing right now' });
  });

  it('slides the expiry, so an editor who is still typing keeps their preview', async () => {
    const item = await draft();
    const { token } = await createPreviewToken(handle.db, {
      contentItemId: item.id,
      userId: editor.id,
    });

    // Nearly dead: the thirty minutes exist so a shared *link* goes stale, and somebody with the
    // editor open is not a stale link.
    const nearly = new Date(Date.now() + 1000).toISOString();
    await handle.db.updateTable('preview_tokens').set({ expires_at: nearly }).execute();

    const result = await writePreviewDraft(handle.db, { token, userId: editor.id, draft: snapshot });
    expect(result.ok).toBe(true);

    const row = await handle.db.selectFrom('preview_tokens').selectAll().executeTakeFirst();
    expect(new Date(row!.expires_at).getTime()).toBeGreaterThan(new Date(nearly).getTime());
  });

  /** The shipped 302 flow has no snapshot, and must resolve exactly as it did before. */
  it('leaves a token with no snapshot resolving as it always did', async () => {
    const item = await draft();
    const { token } = await createPreviewToken(handle.db, { contentItemId: item.id });

    const preview = await resolvePreviewToken(handle.db, token);
    expect(preview?.item.data).toEqual({ body: 'unpublished' });
    expect(preview?.draft).toBe(false);
  });
});

describe('housekeeping', () => {
  it('collects a token carrying a snapshot, so a draft cannot outlive its token', async () => {
    const item = await draft();
    const { token } = await createPreviewToken(handle.db, {
      contentItemId: item.id,
      userId: editor.id,
    });
    await writePreviewDraft(handle.db, {
      token,
      userId: editor.id,
      draft: { title: 'x', slug: 'x', data: {}, seo: {} },
    });

    await handle.db
      .updateTable('preview_tokens')
      .set({ expires_at: new Date(Date.now() - 1000).toISOString() })
      .execute();

    expect(await purgeExpiredPreviewTokens(handle.db)).toBe(1);
    expect(await handle.db.selectFrom('preview_tokens').selectAll().execute()).toHaveLength(0);
  });

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

  /**
   * Same argument for the handshake vocabulary. Its failure mode is worse, though: a mismatched
   * name makes the bridge silently never answer, and the pane falls back to remounting the frame —
   * so the only symptom is a preview that lost its scroll position, which nobody reports as a bug.
   */
  it('and so is the postMessage vocabulary', async () => {
    const { PREVIEW_MESSAGE: fromContent } = await import('./preview.js');
    expect(fromContent).toBe(PREVIEW_MESSAGE);
    expect(Object.values(PREVIEW_MESSAGE).every((name) => name.startsWith('taproot:preview:'))).
      toBe(true);
  });
});
