import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDb, type TaprootDb } from '../db/client.js';
import { migrateToLatest } from '../db/migrations/index.js';
import { createWebhookEndpoint, type WebhookEndpoint } from './endpoints.js';
import {
  MAX_DELIVERY_ATTEMPTS,
  attemptWebhookDelivery,
  dispatchWebhookEvents,
  dueWebhookDeliveries,
  enqueueWebhookEvents,
  enqueueWebhookTest,
  listWebhookDeliveries,
  purgeExpiredWebhookDeliveries,
  webhookEndpointStats,
  webhookQueueStatus,
} from './delivery.js';
import {
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  verifyWebhookSignature,
} from './signature.js';
import type { WebhookEventInput } from './events.js';

let handle: TaprootDb;

beforeEach(async () => {
  handle = await createDb({ driver: 'sqlite', location: ':memory:' });
  const result = await migrateToLatest(handle.db);
  if (result.error) throw result.error;
});

afterEach(async () => {
  await handle.destroy();
});

const PUBLISHED: WebhookEventInput = {
  event: 'item.published',
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

async function anEndpoint(
  events: string[] = ['item.published'],
): Promise<{ endpoint: WebhookEndpoint; secret: string }> {
  const { endpoint, secret } = await createWebhookEndpoint(handle.db, {
    label: 'Site rebuild',
    url: 'https://example.edu/hooks',
    events,
  });

  // The summary has no secret on it by design, so the full row is fetched for the tests that sign.
  return { endpoint: { ...endpoint, secret }, secret };
}

/** A `fetch` double that records what it was called with and answers however the test says. */
function fakeFetch(responder: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];

  const doFetch = (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: init as RequestInit });
    return responder(String(url), init as RequestInit);
  }) as unknown as typeof globalThis.fetch;

  return { doFetch, calls };
}

describe('queueing an event', () => {
  it('writes nothing when nothing subscribes', async () => {
    expect(await enqueueWebhookEvents(handle.db, [PUBLISHED])).toEqual([]);
    expect((await listWebhookDeliveries(handle.db)).total).toBe(0);
  });

  it('writes nothing for an endpoint that asked for a different event', async () => {
    await anEndpoint(['item.deleted']);

    expect(await enqueueWebhookEvents(handle.db, [PUBLISHED])).toEqual([]);
  });

  it('writes one row per subscribed endpoint', async () => {
    await anEndpoint();
    await createWebhookEndpoint(handle.db, {
      label: 'Second',
      url: 'https://other.example/hooks',
      events: ['item.published'],
    });

    const pending = await enqueueWebhookEvents(handle.db, [PUBLISHED]);
    expect(pending).toHaveLength(2);
    expect((await listWebhookDeliveries(handle.db)).total).toBe(2);
  });

  /**
   * The property the whole table exists for, and the one that separates this queue from the purge
   * queue: the row is committed **before** any request goes out, so an isolate killed between the
   * response and the `fetch` leaves work the sweep finds rather than an event that never existed.
   */
  it('commits the row before anything is sent', async () => {
    await anEndpoint();

    const pending = await enqueueWebhookEvents(handle.db, [PUBLISHED]);

    // Nothing has been attempted, and the row is already durable and already due.
    expect(pending[0]!.delivery.attempts).toBe(0);
    expect(await dueWebhookDeliveries(handle.db)).toHaveLength(1);
  });

  /**
   * The id is minted before the payload because the payload carries it — that is what lets a
   * receiver deduplicate a retry from the body alone, without carrying the header alongside it.
   */
  it('puts the delivery id in the body as well as on the row', async () => {
    await anEndpoint();

    const [pending] = await enqueueWebhookEvents(handle.db, [PUBLISHED]);
    expect(JSON.parse(pending!.delivery.payload).id).toBe(pending!.delivery.id);
  });
});

describe('sending', () => {
  /**
   * The lesson from `SITE_TAG`: a test that the write path *declared* something passes while nothing
   * is on the wire. So this one reads the request the receiver would actually have got, and checks
   * the signature with the endpoint's own secret rather than with anything the sender computed.
   */
  it('signs the exact bytes, and names the event and the delivery in headers', async () => {
    const { endpoint, secret } = await anEndpoint();
    const [pending] = await enqueueWebhookEvents(handle.db, [PUBLISHED]);

    const { doFetch, calls } = fakeFetch(() => new Response(null, { status: 200 }));
    await attemptWebhookDelivery(handle.db, { ...pending!, endpoint }, { fetch: doFetch });

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    const headers = init.headers as Record<string, string>;

    expect(url).toBe('https://example.edu/hooks');
    expect(init.method).toBe('POST');
    expect(headers[WEBHOOK_EVENT_HEADER]).toBe('item.published');
    expect(headers[WEBHOOK_DELIVERY_HEADER]).toBe(pending!.delivery.id);

    expect(
      await verifyWebhookSignature({
        secret,
        body: init.body as string,
        header: headers[WEBHOOK_SIGNATURE_HEADER],
      }),
    ).toBe(true);

    // And the body is the event, not a re-serialisation of something else.
    expect(JSON.parse(init.body as string)).toMatchObject({
      event: 'item.published',
      subject: { kind: 'item', path: '/admissions/apply' },
    });
  });

  it('marks a 2xx delivered and stops retrying it', async () => {
    const { endpoint } = await anEndpoint();
    const [pending] = await enqueueWebhookEvents(handle.db, [PUBLISHED]);

    const { doFetch } = fakeFetch(() => new Response(null, { status: 202 }));
    const outcome = await attemptWebhookDelivery(
      handle.db,
      { ...pending!, endpoint },
      { fetch: doFetch },
    );

    expect(outcome.ok).toBe(true);

    const [row] = (await listWebhookDeliveries(handle.db)).deliveries;
    expect(row!.status).toBe('delivered');
    expect(row!.response_status).toBe(202);
    expect(row!.delivered_at).not.toBeNull();
    // Cleared, which is what keeps a settled row out of the due query without a second predicate.
    expect(row!.next_attempt_at).toBeNull();
    expect(await dueWebhookDeliveries(handle.db)).toHaveLength(0);
  });

  /**
   * A success is an update rather than a delete, which is what makes this table a log as well as a
   * queue — the first question anybody asks about a webhook is whether it arrived.
   */
  it('keeps a delivered row so the log can show it', async () => {
    const { endpoint } = await anEndpoint();
    const [pending] = await enqueueWebhookEvents(handle.db, [PUBLISHED]);

    const { doFetch } = fakeFetch(() => new Response(null, { status: 200 }));
    await attemptWebhookDelivery(handle.db, { ...pending!, endpoint }, { fetch: doFetch });

    expect((await listWebhookDeliveries(handle.db)).total).toBe(1);
  });

  /**
   * Following a redirect would re-send a signed body to wherever the receiver points, and would
   * hide the ordinary misconfiguration — an apex domain bouncing to `www` — behind a doubled
   * delivery that looks like it is working.
   */
  it('treats a redirect as a failure and says what to do about it', async () => {
    const { endpoint } = await anEndpoint();
    const [pending] = await enqueueWebhookEvents(handle.db, [PUBLISHED]);

    const { doFetch, calls } = fakeFetch(() => new Response(null, { status: 301 }));
    const outcome = await attemptWebhookDelivery(
      handle.db,
      { ...pending!, endpoint },
      { fetch: doFetch },
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('redirect');
    expect(calls[0]!.init.redirect).toBe('manual');
  });

  it('records a network failure and schedules another attempt', async () => {
    const { endpoint } = await anEndpoint();
    const [pending] = await enqueueWebhookEvents(handle.db, [PUBLISHED]);

    const { doFetch } = fakeFetch(() => {
      throw new Error('connection refused');
    });
    const outcome = await attemptWebhookDelivery(
      handle.db,
      { ...pending!, endpoint },
      { fetch: doFetch },
    );

    expect(outcome.ok).toBe(false);

    const [row] = (await listWebhookDeliveries(handle.db)).deliveries;
    expect(row!.status).toBe('pending');
    expect(row!.attempts).toBe(1);
    expect(row!.last_error).toBe('connection refused');
    expect(row!.next_attempt_at).not.toBeNull();
  });

  it('gives up after the ceiling and leaves something the screen can report', async () => {
    const { endpoint } = await anEndpoint();
    const [pending] = await enqueueWebhookEvents(handle.db, [PUBLISHED]);

    const { doFetch } = fakeFetch(() => new Response(null, { status: 500 }));

    let row = pending!.delivery;
    for (let attempt = 0; attempt < MAX_DELIVERY_ATTEMPTS; attempt += 1) {
      await attemptWebhookDelivery(handle.db, { delivery: row, endpoint }, { fetch: doFetch });
      row = (await listWebhookDeliveries(handle.db)).deliveries[0]!;
    }

    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(MAX_DELIVERY_ATTEMPTS);
    expect(row.next_attempt_at).toBeNull();

    const status = await webhookQueueStatus(handle.db);
    expect(status.failed).toBe(1);
    expect(status.pending).toBe(0);
    expect(status.lastError).toContain('500');
  });

  /**
   * Every attempt signs with the clock at the moment it is sent, never with the moment the row was
   * written — or a delivery retried after eight hours of backoff would arrive outside any sane
   * tolerance and be rejected as an attack by a correctly-written receiver.
   */
  it('signs a retry with a fresh timestamp', async () => {
    const { endpoint, secret } = await anEndpoint();
    const [pending] = await enqueueWebhookEvents(handle.db, [PUBLISHED]);

    const { doFetch, calls } = fakeFetch(() => new Response(null, { status: 500 }));

    await attemptWebhookDelivery(
      handle.db,
      { ...pending!, endpoint },
      { fetch: doFetch, timestamp: 1_000_000 },
    );

    const later = (await listWebhookDeliveries(handle.db)).deliveries[0]!;
    await attemptWebhookDelivery(
      handle.db,
      { delivery: later, endpoint },
      { fetch: doFetch, timestamp: 1_030_000 },
    );

    const [first, second] = calls.map(
      (call) => (call.init.headers as Record<string, string>)[WEBHOOK_SIGNATURE_HEADER]!,
    );

    expect(first).not.toBe(second);
    // Both are valid at their own moment, which is the property that matters.
    expect(
      await verifyWebhookSignature({
        secret,
        body: calls[1]!.init.body as string,
        header: second,
        now: 1_030_000,
      }),
    ).toBe(true);
  });
});

describe('dispatching a request’s events', () => {
  it('queues and sends in one call', async () => {
    const { endpoint } = await anEndpoint(['item.published', 'item.updated']);
    void endpoint;

    const { doFetch, calls } = fakeFetch(() => new Response(null, { status: 204 }));
    await dispatchWebhookEvents(
      handle.db,
      [PUBLISHED, { ...PUBLISHED, event: 'item.updated' }],
      { fetch: doFetch },
    );

    expect(calls).toHaveLength(2);
    const { deliveries } = await listWebhookDeliveries(handle.db);
    expect(deliveries.every((row) => row.status === 'delivered')).toBe(true);
  });

  /**
   * One endpoint lookup for the whole batch rather than one per event: a release publish emits an
   * event per item, so a query per event would scale a write path with how much it changed.
   */
  it('asks who is subscribed once, however many events there are', async () => {
    await anEndpoint(['item.published']);
    const spy = vi.spyOn(handle.db, 'selectFrom');

    const { doFetch } = fakeFetch(() => new Response(null, { status: 204 }));
    await dispatchWebhookEvents(
      handle.db,
      [PUBLISHED, { ...PUBLISHED, subject: { ...PUBLISHED.subject } }, PUBLISHED],
      { fetch: doFetch },
    );

    const endpointReads = spy.mock.calls.filter((call) => call[0] === 'webhook_endpoints');
    expect(endpointReads).toHaveLength(1);
    spy.mockRestore();
  });

  it('never throws when the database is unusable', async () => {
    await handle.destroy();

    await expect(dispatchWebhookEvents(handle.db, [PUBLISHED])).resolves.toBeUndefined();

    // Reopened so `afterEach` has something to close.
    handle = await createDb({ driver: 'sqlite', location: ':memory:' });
  });
});

describe('the test send', () => {
  /**
   * Not a subscription, so it reaches an endpoint that asked for nothing like it — and a paused one,
   * because "pause it, then work out why it was failing" is the order somebody does those in.
   */
  it('goes to the endpoint whatever it is subscribed to', async () => {
    const { endpoint } = await anEndpoint(['item.deleted']);

    const pending = await enqueueWebhookTest(handle.db, endpoint);
    expect(pending.delivery.event).toBe('ping');
    expect(JSON.parse(pending.delivery.payload).subject).toEqual({ kind: 'test' });
  });
});

describe('housekeeping', () => {
  it('counts deliveries per endpoint in one pass', async () => {
    const { endpoint } = await anEndpoint();
    const [pending] = await enqueueWebhookEvents(handle.db, [PUBLISHED]);

    const { doFetch } = fakeFetch(() => new Response(null, { status: 200 }));
    await attemptWebhookDelivery(handle.db, { ...pending!, endpoint }, { fetch: doFetch });
    await enqueueWebhookEvents(handle.db, [PUBLISHED]);

    const stats = (await webhookEndpointStats(handle.db)).get(endpoint.id)!;
    expect(stats.delivered).toBe(1);
    expect(stats.pending).toBe(1);
    expect(stats.failed).toBe(0);
    expect(stats.lastAt).not.toBeNull();
  });

  /**
   * Age is not the same question as settledness. A delivery still inside its backoff is work, and
   * sweeping it would drop the event silently — the one failure this module exists to prevent.
   */
  it('never sweeps a pending row, however old', async () => {
    const { endpoint } = await anEndpoint();
    void endpoint;
    await enqueueWebhookEvents(handle.db, [PUBLISHED]);

    await handle.db
      .updateTable('webhook_deliveries')
      .set({ created_at: '2000-01-01T00:00:00.000Z' })
      .execute();

    expect(await purgeExpiredWebhookDeliveries(handle.db)).toBe(0);
    expect((await listWebhookDeliveries(handle.db)).total).toBe(1);
  });

  it('sweeps a settled row once it is old enough', async () => {
    const { endpoint } = await anEndpoint();
    const [pending] = await enqueueWebhookEvents(handle.db, [PUBLISHED]);

    const { doFetch } = fakeFetch(() => new Response(null, { status: 200 }));
    await attemptWebhookDelivery(handle.db, { ...pending!, endpoint }, { fetch: doFetch });

    await handle.db
      .updateTable('webhook_deliveries')
      .set({ created_at: '2000-01-01T00:00:00.000Z' })
      .execute();

    expect(await purgeExpiredWebhookDeliveries(handle.db)).toBe(1);
    expect((await listWebhookDeliveries(handle.db)).total).toBe(0);
  });

  /**
   * `on delete cascade` rather than the audit log's deliberate lack of one. A delivery row is
   * operational — it exists to be retried and to be read on the endpoint's own screen — so once the
   * endpoint is gone there is nothing to retry against and no screen to read it on.
   */
  it('takes deliveries with the endpoint when it is deleted', async () => {
    const { endpoint } = await anEndpoint();
    await enqueueWebhookEvents(handle.db, [PUBLISHED]);

    await handle.db.deleteFrom('webhook_endpoints').where('id', '=', endpoint.id).execute();

    expect((await listWebhookDeliveries(handle.db)).total).toBe(0);
  });
});
