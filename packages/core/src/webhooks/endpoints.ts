import type { Kysely } from 'kysely';

import type { Database, WebhookEndpointRow } from '../db/schema.js';
import { now } from '../db/values.js';
import { newId } from '../ids.js';
import { WEBHOOK_EVENTS, type WebhookEvent } from './events.js';

/**
 * Where events go.
 *
 * Modelled on `apiKeys.ts` — a labelled row, a secret shown once, an inventory an admin reads before
 * turning something off — and it differs in the one place that matters: the secret is **stored**,
 * because signing needs it. `0033_webhooks` holds the argument for why that is admissible here and
 * not for a provider key.
 */

/**
 * How the secret is spelled.
 *
 * A recognisable prefix for the reason `tpr_` has one: a leaked value should be identifiable as what
 * it is by a secret scanner, a log filter, or a person reading a paste. `whsec_` is the convention
 * receivers already recognise from other senders, which costs nothing to match.
 */
const SECRET_PREFIX = 'whsec_';

export class WebhookEndpointError extends Error {
  override name = 'WebhookEndpointError';
  constructor(
    message: string,
    readonly code: 'not_found' | 'invalid_url' | 'invalid_events' = 'not_found',
  ) {
    super(message);
  }
}

export interface WebhookEndpoint extends Omit<WebhookEndpointRow, 'events'> {
  events: WebhookEvent[];
}

function hydrate(row: WebhookEndpointRow): WebhookEndpoint {
  return {
    ...row,
    /**
     * Unknown names are dropped rather than surfaced.
     *
     * A row can outlive an event this version knows about — an endpoint configured on a newer
     * deployment, or a name removed later — and the only sane reading of a subscription to an event
     * that does not exist is that nothing matches it. Keeping it would put a string through
     * `matchesEvent` that can never be true while making the screen offer a checkbox for it.
     */
    events: row.events
      .split(',')
      .map((event) => event.trim())
      .filter((event): event is WebhookEvent => (WEBHOOK_EVENTS as readonly string[]).includes(event)),
  };
}

/**
 * Where a delivery may be sent.
 *
 * `https` or a loopback `http`, and nothing else. The payload names unpublished items by title and
 * path, so plain `http` to a public host puts an editorial calendar on the wire in clear — nearly
 * always a typo rather than a decision, and the kind that looks like it is working. Loopback stays
 * open because `npm run dev` and a receiver on the same machine are real, and neither leaves the
 * host.
 *
 * Only an admin can reach this, which is what settles the SSRF question rather than a host allowlist:
 * anyone who can create an endpoint can already read every draft through the admin, so a URL aimed
 * at internal infrastructure tells them nothing they could not already see.
 */
export function validateWebhookUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new WebhookEndpointError('That is not a URL Taproot can send to.', 'invalid_url');
  }

  const loopback =
    url.hostname === 'localhost' ||
    url.hostname.endsWith('.localhost') ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '[::1]';

  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && loopback) return url;

  throw new WebhookEndpointError(
    'A webhook URL must use https, unless it points at localhost. Events name unpublished ' +
      'items by title and path.',
    'invalid_url',
  );
}

function serializeEvents(events: readonly string[]): string {
  const unknown = events.filter((event) => !(WEBHOOK_EVENTS as readonly string[]).includes(event));
  if (unknown.length > 0) {
    throw new WebhookEndpointError(`Unknown event(s): ${unknown.join(', ')}.`, 'invalid_events');
  }

  /**
   * An endpoint with no events is refused rather than treated as "everything".
   *
   * Empty meaning all is the tempting fallthrough and the dangerous one — the same call
   * `embed.allowedHosts` and `ItemFilters.termIds` make. It would also sit in the list looking like
   * a configured integration while being the only one that fires on every save.
   */
  if (events.length === 0) {
    throw new WebhookEndpointError('Choose at least one event to send.', 'invalid_events');
  }

  return [...new Set(events)].join(',');
}

function mintSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `${SECRET_PREFIX}${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export interface CreatedWebhookEndpoint {
  endpoint: WebhookEndpointSummary;
  /**
   * The signing secret, for the one screen that shows it.
   *
   * Unlike an API key this *is* readable from the row afterwards, and the admin still shows it once
   * and then offers rotation instead. Holding it does not mean displaying it: a reveal control is a
   * live credential on screen behind an unattended session, and the recovery — rotate, paste the new
   * one — is the same two minutes as looking it up would have been.
   */
  secret: string;
}

export async function createWebhookEndpoint(
  db: Kysely<Database>,
  input: {
    label: string;
    url: string;
    events: string[];
    userId?: string | null;
  },
): Promise<CreatedWebhookEndpoint> {
  const url = validateWebhookUrl(input.url);
  const events = serializeEvents(input.events);
  const secret = mintSecret();
  const timestamp = now();

  const row: WebhookEndpointRow = {
    id: newId(),
    label: input.label.trim(),
    url: url.toString(),
    secret,
    events,
    active: 1,
    created_by: input.userId ?? null,
    created_at: timestamp,
    updated_at: timestamp,
  };

  await db.insertInto('webhook_endpoints').values(row).execute();

  return { endpoint: redactWebhookEndpoint(hydrate(row)), secret };
}

/**
 * An endpoint with the secret taken out — what a screen renders and what a route serialises.
 *
 * A type rather than a convention, because the failure is silent and total: `selectAll()` on this
 * table returns a live signing secret, and a route that hands it back puts one in browser history,
 * in `Referer`, and in every access log between here and the admin's laptop. The same reasoning
 * that keeps a minted API key out of a query string, one step earlier — and unlike a key, this value
 * cannot be revoked by looking at it, only rotated.
 */
export type WebhookEndpointSummary = Omit<WebhookEndpoint, 'secret'>;

export function redactWebhookEndpoint(endpoint: WebhookEndpoint): WebhookEndpointSummary {
  const { secret: _secret, ...rest } = endpoint;
  return rest;
}

/**
 * Every endpoint, without secrets.
 *
 * Redacted **by construction** rather than by each caller remembering: this is the function the
 * screens and the REST route use, and the only ones that need the secret are the dispatcher and the
 * test send, which reach for it explicitly.
 */
export async function listWebhookEndpoints(
  db: Kysely<Database>,
): Promise<WebhookEndpointSummary[]> {
  const rows = await db
    .selectFrom('webhook_endpoints')
    .selectAll()
    // Active first: the list is a worklist before it is a record, exactly as `listApiKeys` is.
    .orderBy('active', 'desc')
    .orderBy('created_at', 'desc')
    .execute();

  return rows.map((row) => redactWebhookEndpoint(hydrate(row)));
}

export async function getWebhookEndpoint(
  db: Kysely<Database>,
  id: string,
): Promise<WebhookEndpoint | undefined> {
  const row = await db
    .selectFrom('webhook_endpoints')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();

  return row ? hydrate(row) : undefined;
}

export async function updateWebhookEndpoint(
  db: Kysely<Database>,
  id: string,
  input: { label?: string; url?: string; events?: string[]; active?: boolean },
): Promise<WebhookEndpointSummary> {
  const existing = await getWebhookEndpoint(db, id);
  if (!existing) throw new WebhookEndpointError(`Webhook endpoint ${id} not found.`);

  const patch: Partial<WebhookEndpointRow> = { updated_at: now() };

  if (input.label !== undefined) patch.label = input.label.trim();
  if (input.url !== undefined) patch.url = validateWebhookUrl(input.url).toString();
  if (input.events !== undefined) patch.events = serializeEvents(input.events);
  if (input.active !== undefined) patch.active = input.active ? 1 : 0;

  await db.updateTable('webhook_endpoints').set(patch).where('id', '=', id).execute();

  return redactWebhookEndpoint((await getWebhookEndpoint(db, id))!);
}

/**
 * Mint a new secret and forget the old one.
 *
 * The only recovery from a lost or leaked secret, and it is immediate by design: a grace period
 * where both verify would mean a leaked secret staying valid for exactly as long as the convenience
 * is worth, which is the wrong side of that trade for a value one paste replaces.
 */
export async function rotateWebhookSecret(db: Kysely<Database>, id: string): Promise<string> {
  const existing = await getWebhookEndpoint(db, id);
  if (!existing) throw new WebhookEndpointError(`Webhook endpoint ${id} not found.`);

  const secret = mintSecret();

  await db
    .updateTable('webhook_endpoints')
    .set({ secret, updated_at: now() })
    .where('id', '=', id)
    .execute();

  return secret;
}

/**
 * Delete an endpoint, taking its deliveries with it.
 *
 * A real delete, where an API key is only ever revoked, and the difference is what the row is
 * evidence of. A key names a principal that acted, so audit entries point at it and it has to stay
 * resolvable; an endpoint is a destination, and an audit entry about one carries its label already.
 * Pausing covers the case revocation covers — see `active`.
 */
export async function deleteWebhookEndpoint(db: Kysely<Database>, id: string): Promise<void> {
  const existing = await getWebhookEndpoint(db, id);
  if (!existing) throw new WebhookEndpointError(`Webhook endpoint ${id} not found.`);

  await db.deleteFrom('webhook_endpoints').where('id', '=', id).execute();
}

/** Whether this endpoint asked for this event. */
export function matchesEvent(endpoint: WebhookEndpoint, event: WebhookEvent): boolean {
  return endpoint.active === 1 && endpoint.events.includes(event);
}

/**
 * Every endpoint that is switched on.
 *
 * The subscription narrowing happens in JS rather than as a `like '%…%'` over `events`, and not for
 * tidiness: a substring match reads `item.publish` as a prefix of `item.published` and would fire
 * the wrong subscription. The set is single digits on any real deployment, so the filter is free.
 *
 * `active` *is* in SQL, because that one is exact and is what makes the common case — nothing
 * configured, which is every deployment until somebody sets one up — a single indexed miss.
 */
export async function activeWebhookEndpoints(db: Kysely<Database>): Promise<WebhookEndpoint[]> {
  const rows = await db
    .selectFrom('webhook_endpoints')
    .selectAll()
    .where('active', '=', 1)
    .execute();

  return rows.map(hydrate);
}

/** The endpoints one event has to reach. */
export async function endpointsForEvent(
  db: Kysely<Database>,
  event: WebhookEvent,
): Promise<WebhookEndpoint[]> {
  return (await activeWebhookEndpoints(db)).filter((endpoint) => matchesEvent(endpoint, event));
}
