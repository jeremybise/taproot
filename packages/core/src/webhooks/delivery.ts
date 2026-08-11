import type { Kysely } from 'kysely';

import type { Database, WebhookDeliveryRow, WebhookDeliveryStatus } from '../db/schema.js';
import { now } from '../db/values.js';
import { newId } from '../ids.js';
import { RETRY_BACKOFF_MINUTES, nextRetryAt } from '../retry.js';
import { activeWebhookEndpoints, matchesEvent, type WebhookEndpoint } from './endpoints.js';
import {
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  signWebhook,
} from './signature.js';
import {
  WEBHOOK_TEST_EVENT,
  type WebhookEvent,
  type WebhookEventInput,
  type WebhookEventPayload,
} from './events.js';

/**
 * Sending an event, and remembering what happened to it.
 *
 * **Enqueue first, then attempt.** This is the one place the webhook queue deliberately differs from
 * the purge queue, which attempts first and records only failures. A purge that vanishes because the
 * isolate was killed between the response and the `fetch` costs staleness the TTL already bounds; an
 * event that vanishes is gone — nothing regenerates it, and the consumer waits forever for a
 * "published" that is never coming. So the row is written before the request leaves, which turns a
 * dead isolate into work the next sweep finds.
 *
 * The cost is one insert per endpoint per event, and it is paid **after the response** — the
 * middleware dispatches from the same place it purges, for the same ordering reason.
 */

/**
 * How many attempts before a delivery is left alone.
 *
 * Same ceiling as the purge queue and for the same reason: past this it is a misconfiguration rather
 * than a blip, and retrying forever turns one broken URL into an unbounded stream of outbound
 * requests. What a `failed` row buys instead is something the screen can *report*.
 */
export const MAX_DELIVERY_ATTEMPTS = RETRY_BACKOFF_MINUTES.length;

/**
 * How long to wait for a receiver, in milliseconds.
 *
 * A receiver that accepts the connection and never answers would otherwise hold the sweep open
 * until the runtime kills it — taking every other due delivery with it, which is how one broken
 * endpoint stops all of them. Ten seconds is long enough for a cold start on the other side and
 * short enough that a full queue still drains inside one five-minute tick.
 */
const REQUEST_TIMEOUT_MS = 10_000;

export interface WebhookDeliveryOptions {
  /** Injected in tests; `globalThis.fetch` otherwise. */
  fetch?: typeof globalThis.fetch;
  /** Injected in tests. Unix seconds. */
  timestamp?: number;
}

/** A delivery row paired with where it is going, which is what a send needs. */
export interface PendingDelivery {
  delivery: WebhookDeliveryRow;
  endpoint: WebhookEndpoint;
}

/**
 * Write one pending row per subscribed endpoint, and return them ready to send.
 *
 * **One endpoint query per request, not per event.** A save that renames a page emits `item.updated`
 * and `item.published` together, and a release publish emits one per item — so asking "who wants
 * this" per event would put a query on a write path in proportion to how much it changed. The
 * endpoints are loaded once and matched in memory, which is also what makes the common case free:
 * with nothing configured this is a single indexed miss and no inserts at all.
 *
 * The rows go out in **one multi-row insert** for the reason `batchWrite` exists — a statement per
 * row is a round trip per row, on the path that runs after every save.
 *
 * **Never throws.** It is called from the same place the purge is, after a write that has already
 * been reported successful to an editor, and failing their save over a webhook they cannot see would
 * be the trade `recordAuditEntry` refuses.
 */
export async function enqueueWebhookEvents(
  db: Kysely<Database>,
  inputs: WebhookEventInput[],
): Promise<PendingDelivery[]> {
  if (inputs.length === 0) return [];

  try {
    const endpoints = await activeWebhookEndpoints(db);
    if (endpoints.length === 0) return [];

    const pending: PendingDelivery[] = [];

    for (const input of inputs) {
      const createdAt = input.createdAt ?? now();

      for (const endpoint of endpoints) {
        if (!matchesEvent(endpoint, input.event)) continue;

        const id = newId();

        /**
         * The id is minted before the payload, because the payload carries it.
         *
         * That is what makes a retry recognisable as the same event rather than a second one — see
         * `WEBHOOK_DELIVERY_HEADER`. Building the body first and stamping an id onto the row
         * afterwards would leave a receiver no way to deduplicate from the body alone.
         */
        const payload: WebhookEventPayload = {
          id,
          event: input.event,
          createdAt,
          subject: input.subject,
        };

        pending.push({
          delivery: {
            id,
            endpoint_id: endpoint.id,
            event: input.event,
            payload: JSON.stringify(payload),
            status: 'pending',
            attempts: 0,
            response_status: null,
            last_error: null,
            next_attempt_at: nextRetryAt(0),
            delivered_at: null,
            created_at: createdAt,
          },
          endpoint,
        });
      }
    }

    if (pending.length === 0) return [];

    await db
      .insertInto('webhook_deliveries')
      .values(pending.map((entry) => entry.delivery))
      .execute();

    return pending;
  } catch (error) {
    console.error('[taproot] could not queue webhook events', error);
    return [];
  }
}

/** One event, for the callers that only ever have one. */
export async function enqueueWebhookEvent(
  db: Kysely<Database>,
  input: WebhookEventInput,
): Promise<PendingDelivery[]> {
  return enqueueWebhookEvents(db, [input]);
}

/**
 * A test send, which is not a subscription and does not go through the queue's matching.
 *
 * It writes a row like any other so the delivery log shows the attempt — the whole point is to find
 * out what a real send would do — and it goes to the endpoint whether or not it is paused, because
 * "pause it, then work out why it was failing" is the order somebody does those in.
 */
export async function enqueueWebhookTest(
  db: Kysely<Database>,
  endpoint: WebhookEndpoint,
): Promise<PendingDelivery> {
  const id = newId();
  const createdAt = now();

  const payload: WebhookEventPayload = {
    id,
    event: WEBHOOK_TEST_EVENT,
    createdAt,
    subject: { kind: 'test' },
  };

  const row: WebhookDeliveryRow = {
    id,
    endpoint_id: endpoint.id,
    event: WEBHOOK_TEST_EVENT,
    payload: JSON.stringify(payload),
    status: 'pending',
    attempts: 0,
    response_status: null,
    last_error: null,
    next_attempt_at: nextRetryAt(0),
    delivered_at: null,
    created_at: createdAt,
  };

  await db.insertInto('webhook_deliveries').values(row).execute();

  return { delivery: row, endpoint };
}

export interface DeliveryOutcome {
  ok: boolean;
  status?: number;
  error?: string;
}

/**
 * Make the request. No database access, so the outcome can be recorded by the caller that owns it.
 *
 * **Never throws**, for the reason the whole path never does.
 */
export async function sendWebhook(
  pending: PendingDelivery,
  options: WebhookDeliveryOptions = {},
): Promise<DeliveryOutcome> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const { delivery, endpoint } = pending;

  try {
    const signature = await signWebhook(endpoint.secret, delivery.payload, options.timestamp);

    const response = await doFetch(endpoint.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [WEBHOOK_SIGNATURE_HEADER]: signature,
        [WEBHOOK_EVENT_HEADER]: delivery.event,
        [WEBHOOK_DELIVERY_HEADER]: delivery.id,
      },
      body: delivery.payload,
      /**
       * Redirects are a failure, not something to follow.
       *
       * Following one re-sends a signed body to wherever the receiver's redirect points, which turns
       * an open redirect on their side into a way to aim Taproot's authenticated events at a third
       * party. It also hides the common case worth fixing once — an apex domain bouncing to `www`,
       * which would otherwise double every delivery forever and look like it was working.
       */
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    /**
     * The response body is never read.
     *
     * A receiver is an arbitrary host, and reading an unbounded body into a Worker to store an
     * error message is a memory limit somebody else controls. The status is what a retry decision
     * and the screen are made of; anything more is the receiver's own logs to answer.
     */
    if (response.status >= 200 && response.status < 300) {
      return { ok: true, status: response.status };
    }

    if (response.status >= 300 && response.status < 400) {
      return {
        ok: false,
        status: response.status,
        error: `Endpoint redirected (${response.status}). Point the URL at the final address.`,
      };
    }

    return { ok: false, status: response.status, error: `Endpoint answered ${response.status}.` };
  } catch (error) {
    /**
     * Every failure is retried, including a 4xx.
     *
     * Treating "the receiver understood and refused" as permanent was considered and rejected: a
     * 403 from a proxy mid-deploy and a 401 from a secret that has genuinely drifted are the same
     * status, and a rule that is wrong sometimes is worse here than a few wasted requests. The
     * ceiling plus the screen is the surfacing mechanism, exactly as it is for a purge.
     */
    const message =
      error instanceof Error
        ? error.name === 'TimeoutError'
          ? `No answer within ${REQUEST_TIMEOUT_MS / 1000}s.`
          : error.message
        : String(error);

    return { ok: false, error: message };
  }
}

/**
 * Write the outcome onto the row.
 *
 * A success is an **update, not a delete**, which is the other half of this table being a log:
 * `pending_purges` deletes a row that landed because nothing ever asks about a purge that worked,
 * and the first question anyone asks about a webhook is whether it arrived.
 */
export async function recordDeliveryOutcome(
  db: Kysely<Database>,
  delivery: WebhookDeliveryRow,
  outcome: DeliveryOutcome,
): Promise<void> {
  const attempts = delivery.attempts + 1;
  const timestamp = now();

  if (outcome.ok) {
    await db
      .updateTable('webhook_deliveries')
      .set({
        status: 'delivered',
        attempts,
        response_status: outcome.status ?? null,
        last_error: null,
        // Cleared so a settled row cannot be picked up again, without the due query needing to know
        // about `status` as well.
        next_attempt_at: null,
        delivered_at: timestamp,
      })
      .where('id', '=', delivery.id)
      .execute();
    return;
  }

  const exhausted = attempts >= MAX_DELIVERY_ATTEMPTS;

  await db
    .updateTable('webhook_deliveries')
    .set({
      status: exhausted ? 'failed' : 'pending',
      attempts,
      response_status: outcome.status ?? null,
      last_error: outcome.error ?? 'Delivery failed.',
      next_attempt_at: exhausted ? null : nextRetryAt(attempts),
    })
    .where('id', '=', delivery.id)
    .execute();
}

/**
 * Send one delivery and record what happened, which is what both callers want.
 *
 * Never throws: `sendWebhook` does not, and the outcome is *read* rather than caught — the same
 * shape `drainPurgeQueue` uses, and for the same reason. A `try`/`catch` around a function that
 * cannot reject is dead code that would mark every row delivered whether or not it arrived.
 */
export async function attemptWebhookDelivery(
  db: Kysely<Database>,
  pending: PendingDelivery,
  options: WebhookDeliveryOptions = {},
): Promise<DeliveryOutcome> {
  const outcome = await sendWebhook(pending, options);
  await recordDeliveryOutcome(db, pending.delivery, outcome);
  return outcome;
}

/**
 * How many queued deliveries one request tries to send before leaving the rest to the sweep.
 *
 * A bound on how long an isolate is kept alive after the response, not a correctness measure —
 * which is the payoff of writing the rows first. Whatever this cap leaves behind, and anything the
 * runtime kills halfway through, is a `pending` row the next tick finds. A release publishing fifty
 * items is the case that reaches it.
 */
const INLINE_DISPATCH_LIMIT = 20;

/**
 * Queue a request's events and send what can be sent now.
 *
 * The one entry point for a write path. Sequential rather than parallel, following
 * `drainPurgeQueue`: this runs on a production deployment after every save, and finishing a tick
 * later is a better trade than saturating the outbound request budget — or than aiming twenty
 * concurrent requests at one receiver that has just told us it is struggling.
 *
 * **Never throws**, and the outcome of each send is *read* rather than caught, because
 * `attemptWebhookDelivery` cannot reject.
 */
export async function dispatchWebhookEvents(
  db: Kysely<Database>,
  inputs: WebhookEventInput[],
  options: WebhookDeliveryOptions = {},
): Promise<void> {
  const pending = await enqueueWebhookEvents(db, inputs);

  for (const entry of pending.slice(0, INLINE_DISPATCH_LIMIT)) {
    await attemptWebhookDelivery(db, entry, options);
  }
}

/**
 * Deliveries whose backoff has elapsed, oldest first, bounded so one sweep cannot run long.
 *
 * Joined to the endpoint rather than loaded per row: a send needs the URL and the secret, and N+1
 * lookups on the one path that runs unattended is the cost `npm run query-count` exists to notice.
 * An endpoint deleted since the row was written takes its deliveries with it (`on delete cascade`),
 * so the join can be inner without dropping work silently.
 */
export async function dueWebhookDeliveries(
  db: Kysely<Database>,
  limit = 50,
): Promise<PendingDelivery[]> {
  const rows = await db
    .selectFrom('webhook_deliveries')
    .innerJoin('webhook_endpoints', 'webhook_endpoints.id', 'webhook_deliveries.endpoint_id')
    .selectAll('webhook_deliveries')
    .select([
      'webhook_endpoints.url as endpoint_url',
      'webhook_endpoints.secret as endpoint_secret',
      'webhook_endpoints.label as endpoint_label',
      'webhook_endpoints.events as endpoint_events',
      'webhook_endpoints.active as endpoint_active',
      'webhook_endpoints.created_by as endpoint_created_by',
      'webhook_endpoints.created_at as endpoint_created_at',
      'webhook_endpoints.updated_at as endpoint_updated_at',
    ])
    .where('webhook_deliveries.status', '=', 'pending')
    .where('webhook_deliveries.next_attempt_at', '<=', now())
    .orderBy('webhook_deliveries.next_attempt_at')
    .limit(limit)
    .execute();

  return rows.map((row) => ({
    delivery: {
      id: row.id,
      endpoint_id: row.endpoint_id,
      event: row.event,
      payload: row.payload,
      status: row.status,
      attempts: row.attempts,
      response_status: row.response_status,
      last_error: row.last_error,
      next_attempt_at: row.next_attempt_at,
      delivered_at: row.delivered_at,
      created_at: row.created_at,
    },
    endpoint: {
      id: row.endpoint_id,
      label: row.endpoint_label,
      url: row.endpoint_url,
      secret: row.endpoint_secret,
      /**
       * Parsed here rather than through `hydrate`, which this module cannot reach without importing
       * the whole endpoint layer for one line. The events on a due row are never matched against
       * anything — the subscription question was answered when the row was written — so the value
       * is carried only so the shape is a real `WebhookEndpoint`.
       */
      events: row.endpoint_events.split(',').filter(Boolean) as WebhookEvent[],
      active: row.endpoint_active,
      created_by: row.endpoint_created_by,
      created_at: row.endpoint_created_at,
      updated_at: row.endpoint_updated_at,
    },
  }));
}

export interface WebhookQueueStatus {
  /** Waiting, and still being retried. A few is a sweep that has not run yet, which is normal. */
  pending: number;
  /** Given up on — the number somebody has to do something about. */
  failed: number;
  /** The most recent failure, so the screen can say why and not only how many. */
  lastError: string | null;
}

/**
 * What Settings → System reports.
 *
 * `failed` is separate from `pending` for the reason `purgeQueueStatus` splits them: one total lets
 * the ordinary case hide the actionable one.
 */
export async function webhookQueueStatus(db: Kysely<Database>): Promise<WebhookQueueStatus> {
  const rows = await db
    .selectFrom('webhook_deliveries')
    .select(['status', 'last_error'])
    .where('status', '!=', 'delivered')
    .execute();

  const failed = rows.filter((row) => row.status === 'failed');

  return {
    pending: rows.length - failed.length,
    failed: failed.length,
    lastError: failed.at(-1)?.last_error ?? null,
  };
}

export interface WebhookEndpointStats {
  pending: number;
  delivered: number;
  failed: number;
  /** The most recent attempt of any outcome, or null for an endpoint nothing has been sent to. */
  lastAt: string | null;
}

/**
 * Per-endpoint delivery counts for the list screen, in one grouped query.
 *
 * Not a lookup per endpoint. The list is single digits, so N+1 would be survivable and it is still
 * the habit that produced the two real costs `npm run query-count` was written to catch — and this
 * is a screen an admin reloads while diagnosing something, which is exactly when the queries are
 * being watched.
 *
 * Counts rather than "the last outcome", which is what a `row_number()` window would be needed for
 * and is the less useful answer: "eleven delivered, one failed" tells somebody whether an endpoint
 * is working, where one green row above ten red ones does not.
 */
export async function webhookEndpointStats(
  db: Kysely<Database>,
): Promise<Map<string, WebhookEndpointStats>> {
  const rows = await db
    .selectFrom('webhook_deliveries')
    .select((eb) => [
      'endpoint_id',
      'status',
      eb.fn.countAll<number>().as('n'),
      eb.fn.max('created_at').as('last_at'),
    ])
    .groupBy(['endpoint_id', 'status'])
    .execute();

  const stats = new Map<string, WebhookEndpointStats>();

  for (const row of rows) {
    const entry = stats.get(row.endpoint_id) ?? {
      pending: 0,
      delivered: 0,
      failed: 0,
      lastAt: null,
    };

    entry[row.status as WebhookDeliveryStatus] = Number(row.n);
    if (!entry.lastAt || (row.last_at && row.last_at > entry.lastAt)) {
      entry.lastAt = row.last_at ?? null;
    }

    stats.set(row.endpoint_id, entry);
  }

  return stats;
}

export interface ListDeliveriesOptions {
  endpointId?: string;
  limit?: number;
  offset?: number;
}

/**
 * The delivery log, newest first, with a total counted before the limit.
 *
 * The total is what lets the screen page rather than truncate silently — the rule the content lists
 * learned: a count above a capped list is a number that is right, rows that are right, and the two
 * together saying something false.
 */
export async function listWebhookDeliveries(
  db: Kysely<Database>,
  options: ListDeliveriesOptions = {},
): Promise<{ deliveries: WebhookDeliveryRow[]; total: number }> {
  let query = db.selectFrom('webhook_deliveries');
  if (options.endpointId) query = query.where('endpoint_id', '=', options.endpointId);

  const totalRow = await query
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .executeTakeFirst();

  const deliveries = await query
    .selectAll()
    // By id as well as time: a save fanning out to several endpoints writes rows in the same
    // millisecond, and an unstable order would show one twice across a page boundary.
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(options.limit ?? 50)
    .offset(options.offset ?? 0)
    .execute();

  return { deliveries, total: Number(totalRow?.count ?? 0) };
}

/**
 * Drop delivery rows older than a cutoff.
 *
 * Retention rather than a delete-on-success, and unlike the two logs it is **not** opt-in: a
 * delivery row is operational rather than historical — it exists to be retried and to answer "did
 * last night's publish arrive" — so keeping one forever is hoarding rather than history.
 * `TAPROOT_AUDIT_LOG_RETENTION_DAYS` covers the question a webhook row cannot answer anyway, which
 * is who did the thing that caused it.
 *
 * Bounded and batched for `purgeAuditLogBefore`'s reason: the first sweep after an upgrade can face
 * a table that has grown since, and `delete … limit` needs a SQLite build flag D1 cannot be asked
 * about — so the ids are selected first and deleted by key.
 */
export async function purgeExpiredWebhookDeliveries(
  db: Kysely<Database>,
  days = 30,
  limit = 500,
): Promise<number> {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();

  const result = await db
    .deleteFrom('webhook_deliveries')
    .where('id', 'in', (eb) =>
      eb
        .selectFrom('webhook_deliveries')
        .select('id')
        .where('created_at', '<', cutoff)
        /**
         * A pending row is never swept, however old.
         *
         * Age is not the same question as settledness: a delivery still inside its backoff is work,
         * and deleting it would drop the event silently — which is the one failure this whole
         * module exists to prevent. A `failed` row is settled and goes.
         */
        .where('status', '!=', 'pending')
        .limit(limit),
    )
    .executeTakeFirst();

  return Number(result.numDeletedRows ?? 0);
}
