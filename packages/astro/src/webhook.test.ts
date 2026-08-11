import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTaprootWebhookHandler } from './webhook.js';
import { WEBHOOK_SIGNATURE_HEADER, signWebhook } from '@taprootcms/core/pure';
import type { WebhookEventPayload } from '@taprootcms/core/pure';

/**
 * The consumer's half of a delivery.
 *
 * This handler exists because the four lines it replaces are the ones people get wrong, and every
 * way of getting them wrong is silent — so the tests are about the silent failures rather than
 * about the happy path.
 */

const SECRET = 'whsec_shared-secret-value';

const EVENT: WebhookEventPayload = {
  id: 'delivery-1',
  event: 'item.published',
  createdAt: '2026-08-11T09:00:00.000Z',
  subject: {
    kind: 'item',
    id: 'item-1',
    title: 'Apply',
    path: '/admissions/apply',
    slug: 'apply',
    status: 'published',
    contentType: 'page',
  },
};

async function signedRequest(
  body = JSON.stringify(EVENT),
  secret = SECRET,
): Promise<Request> {
  return new Request('https://site.example/taproot/events', {
    method: 'POST',
    headers: { [WEBHOOK_SIGNATURE_HEADER]: await signWebhook(secret, body) },
    body,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createTaprootWebhookHandler', () => {
  it('hands over a verified event and answers 204', async () => {
    const onEvent = vi.fn();
    const POST = createTaprootWebhookHandler({ secret: SECRET, onEvent });

    const response = await POST({ request: await signedRequest() });

    expect(response.status).toBe(204);
    expect(onEvent).toHaveBeenCalledOnce();
    expect(onEvent.mock.calls[0]![0]).toMatchObject({ event: 'item.published' });
  });

  it('refuses a body that was changed after signing', async () => {
    const onEvent = vi.fn();
    const POST = createTaprootWebhookHandler({ secret: SECRET, onEvent });

    const signed = JSON.stringify(EVENT);
    const request = new Request('https://site.example/taproot/events', {
      method: 'POST',
      headers: { [WEBHOOK_SIGNATURE_HEADER]: await signWebhook(SECRET, signed) },
      body: signed.replace('item.published', 'item.deleted'),
    });

    expect((await POST({ request })).status).toBe(401);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('refuses a signature made with a different secret', async () => {
    const onEvent = vi.fn();
    const POST = createTaprootWebhookHandler({ secret: SECRET, onEvent });

    const response = await POST({ request: await signedRequest(undefined, 'whsec_wrong') });

    expect(response.status).toBe(401);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('refuses an unsigned request', async () => {
    const onEvent = vi.fn();
    const POST = createTaprootWebhookHandler({ secret: SECRET, onEvent });

    const request = new Request('https://site.example/taproot/events', {
      method: 'POST',
      body: JSON.stringify(EVENT),
    });

    expect((await POST({ request })).status).toBe(401);
    expect(onEvent).not.toHaveBeenCalled();
  });

  /**
   * 404 rather than 401 with nothing configured, exactly as the purge handler does: a site that has
   * not set this up should look like a site with no such route rather than one guarding something
   * worth guessing at.
   */
  it('looks like no route at all when no secret is configured', async () => {
    const onEvent = vi.fn();
    const POST = createTaprootWebhookHandler({ onEvent });

    expect((await POST({ request: await signedRequest() })).status).toBe(404);
    expect(onEvent).not.toHaveBeenCalled();
  });

  /**
   * The whole shape of the contract. Taproot reads a 2xx as "this landed" and stops retrying, so a
   * handler that threw must not be reported as a success — the CMS's retry queue is the only thing
   * that can replay it, and its only signal is this status.
   */
  it('answers 500 when the handler throws, so the delivery is retried', async () => {
    const POST = createTaprootWebhookHandler({
      secret: SECRET,
      onEvent: () => {
        throw new Error('index unavailable');
      },
    });

    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect((await POST({ request: await signedRequest() })).status).toBe(500);
  });

  it('waits for the handler before answering', async () => {
    let finished = false;
    const POST = createTaprootWebhookHandler({
      secret: SECRET,
      onEvent: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        finished = true;
      },
    });

    await POST({ request: await signedRequest() });

    expect(finished).toBe(true);
  });

  /**
   * A signed request whose body is not JSON means the two sides disagree about the protocol rather
   * than that somebody is probing — so it is worth distinguishing from a 401.
   */
  it('answers 400 to a signed body that is not an event', async () => {
    const POST = createTaprootWebhookHandler({ secret: SECRET, onEvent: vi.fn() });

    expect((await POST({ request: await signedRequest('not json') })).status).toBe(400);
  });

  it('is never cached, whatever the answer', async () => {
    const POST = createTaprootWebhookHandler({ secret: SECRET, onEvent: vi.fn() });

    for (const request of [await signedRequest(), await signedRequest(undefined, 'nope')]) {
      const response = await POST({ request });
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
  });
});
