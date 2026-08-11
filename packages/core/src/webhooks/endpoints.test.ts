import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDb, type TaprootDb } from '../db/client.js';
import { migrateToLatest } from '../db/migrations/index.js';
import {
  WebhookEndpointError,
  activeWebhookEndpoints,
  createWebhookEndpoint,
  endpointsForEvent,
  getWebhookEndpoint,
  listWebhookEndpoints,
  matchesEvent,
  rotateWebhookSecret,
  updateWebhookEndpoint,
  validateWebhookUrl,
} from './endpoints.js';

let handle: TaprootDb;

beforeEach(async () => {
  handle = await createDb({ driver: 'sqlite', location: ':memory:' });
  const result = await migrateToLatest(handle.db);
  if (result.error) throw result.error;
});

afterEach(async () => {
  await handle.destroy();
});

const base = { label: 'Site rebuild', url: 'https://example.edu/hooks', events: ['item.published'] };

describe('webhook endpoint URLs', () => {
  it('accepts https anywhere and http only on loopback', () => {
    expect(validateWebhookUrl('https://example.edu/hooks').protocol).toBe('https:');
    expect(validateWebhookUrl('http://localhost:4321/hooks').protocol).toBe('http:');
    expect(validateWebhookUrl('http://127.0.0.1:4321/hooks').protocol).toBe('http:');
  });

  /**
   * The payload names unpublished pages by title and path, so plain `http` to a public host puts an
   * editorial calendar on the wire in clear. Nearly always a typo, and the kind that looks like it
   * is working.
   */
  it('refuses plain http to a public host', () => {
    expect(() => validateWebhookUrl('http://example.edu/hooks')).toThrow(WebhookEndpointError);
  });

  it('refuses anything that is not http or https', () => {
    for (const url of ['ftp://example.edu', 'javascript:alert(1)', 'not a url', '']) {
      expect(() => validateWebhookUrl(url)).toThrow(WebhookEndpointError);
    }
  });
});

describe('webhook endpoints', () => {
  it('mints a recognisable secret and returns it exactly once', async () => {
    const { endpoint, secret } = await createWebhookEndpoint(handle.db, base);

    expect(secret.startsWith('whsec_')).toBe(true);
    // The created result is a summary — no secret rides along on the object itself.
    expect(endpoint).not.toHaveProperty('secret');
  });

  /**
   * The failure this guards is silent and total: `selectAll()` on this table returns a live signing
   * secret, and a route that hands one back puts it in browser history and every access log between
   * here and the admin's laptop.
   */
  it('never returns a secret from the list', async () => {
    await createWebhookEndpoint(handle.db, base);

    const [listed] = await listWebhookEndpoints(handle.db);
    expect(listed).not.toHaveProperty('secret');
    expect(JSON.stringify(listed)).not.toContain('whsec_');
  });

  it('refuses an empty event list rather than reading it as everything', async () => {
    await expect(createWebhookEndpoint(handle.db, { ...base, events: [] })).rejects.toThrow(
      WebhookEndpointError,
    );
  });

  it('refuses an event it does not know', async () => {
    await expect(
      createWebhookEndpoint(handle.db, { ...base, events: ['item.exploded'] }),
    ).rejects.toThrow(WebhookEndpointError);
  });

  it('sends only to endpoints that asked for the event', async () => {
    const { endpoint: publishes } = await createWebhookEndpoint(handle.db, base);
    const { endpoint: edits } = await createWebhookEndpoint(handle.db, {
      ...base,
      label: 'Search index',
      events: ['item.updated'],
    });

    const forPublish = await endpointsForEvent(handle.db, 'item.published');
    expect(forPublish.map((entry) => entry.id)).toEqual([publishes.id]);

    const forUpdate = await endpointsForEvent(handle.db, 'item.updated');
    expect(forUpdate.map((entry) => entry.id)).toEqual([edits.id]);
  });

  /**
   * A substring match over the stored list would read `item.publish` as a prefix of
   * `item.published`, which is why the narrowing is in JS rather than in SQL.
   */
  it('does not treat one event name as a prefix of another', async () => {
    await createWebhookEndpoint(handle.db, { ...base, events: ['item.unpublished'] });

    expect(await endpointsForEvent(handle.db, 'item.published')).toHaveLength(0);
    expect(await endpointsForEvent(handle.db, 'item.unpublished')).toHaveLength(1);
  });

  it('stops matching once paused, and matches again once resumed', async () => {
    const { endpoint } = await createWebhookEndpoint(handle.db, base);

    await updateWebhookEndpoint(handle.db, endpoint.id, { active: false });
    expect(await endpointsForEvent(handle.db, 'item.published')).toHaveLength(0);
    expect(await activeWebhookEndpoints(handle.db)).toHaveLength(0);

    await updateWebhookEndpoint(handle.db, endpoint.id, { active: true });
    expect(await endpointsForEvent(handle.db, 'item.published')).toHaveLength(1);
  });

  it('keeps the URL, the secret and the history when paused', async () => {
    const { endpoint, secret } = await createWebhookEndpoint(handle.db, base);
    await updateWebhookEndpoint(handle.db, endpoint.id, { active: false });

    const paused = (await getWebhookEndpoint(handle.db, endpoint.id))!;
    expect(paused.url).toBe(endpoint.url);
    expect(paused.secret).toBe(secret);
  });

  /**
   * No overlap, deliberately: a grace period is a leaked secret staying valid for exactly as long
   * as the convenience is worth.
   */
  it('replaces the secret outright when rotated', async () => {
    const { endpoint, secret } = await createWebhookEndpoint(handle.db, base);

    const replacement = await rotateWebhookSecret(handle.db, endpoint.id);
    expect(replacement).not.toBe(secret);

    const after = (await getWebhookEndpoint(handle.db, endpoint.id))!;
    expect(after.secret).toBe(replacement);
  });

  it('refuses to update an endpoint into an invalid URL', async () => {
    const { endpoint } = await createWebhookEndpoint(handle.db, base);

    await expect(
      updateWebhookEndpoint(handle.db, endpoint.id, { url: 'http://example.edu/hooks' }),
    ).rejects.toThrow(WebhookEndpointError);

    // And left the stored value alone rather than half-applying the patch.
    expect((await getWebhookEndpoint(handle.db, endpoint.id))!.url).toBe(`${base.url}`);
  });

  it('drops a stored event name this version does not recognise', async () => {
    const { endpoint } = await createWebhookEndpoint(handle.db, base);

    // Written straight to the column, which is how a row from a newer deployment would look.
    await handle.db
      .updateTable('webhook_endpoints')
      .set({ events: 'item.published,item.teleported' })
      .where('id', '=', endpoint.id)
      .execute();

    const hydrated = (await getWebhookEndpoint(handle.db, endpoint.id))!;
    expect(hydrated.events).toEqual(['item.published']);
    expect(matchesEvent(hydrated, 'item.published')).toBe(true);
  });
});
