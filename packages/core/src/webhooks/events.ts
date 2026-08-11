/**
 * What Taproot sends, and the shape it arrives in.
 *
 * Re-exported from `pure.ts` so a consumer can type its handler against the same declarations the
 * CMS builds from. No database access here, and none may be added: this file is on the consumer's
 * side of the bundle boundary.
 */

import type { ContentStatus } from '../db/schema.js';

/**
 * Every event an endpoint may subscribe to.
 *
 * Small on purpose, and cheap to extend — a new entry is one string plus the call site that emits
 * it. That is the argument for shipping the ones a site can act on rather than a complete mirror of
 * the audit log: an event nobody consumes still costs an outbound request, a queue row and a line in
 * a delivery log, on every save, forever.
 *
 * `item.updated` and `item.published` both firing for one save is **not** two spellings of one fact.
 * They answer different questions — "the content changed" and "the content became public" — and an
 * endpoint subscribes to whichever it is for. A search index wants the first; a site rebuild wants
 * the second and must not fire on every draft keystroke.
 *
 * Note what is absent. There is no `item.saved` distinct from `item.updated`, no per-status event
 * beyond the two publication ones, and no user or API-key event: administering the CMS is what the
 * audit log is for, and a webhook carrying "this person's role changed" is an access-control fact
 * leaving the deployment over HTTP to somewhere nobody audited.
 */
export const WEBHOOK_EVENTS = [
  'item.created',
  'item.updated',
  'item.published',
  'item.unpublished',
  'item.deleted',
  'release.published',
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/**
 * The name a test send carries, and deliberately **not** in `WEBHOOK_EVENTS`.
 *
 * A subscription list is what an endpoint asked for, and nobody asks for pings — so a test that
 * required subscribing to it would fail on exactly the endpoint being diagnosed, which is the one
 * whose configuration is in doubt. It is sent to one endpoint on request and is never produced by a
 * content write, so a receiver switching on the event name has one obvious case to ignore.
 */
export const WEBHOOK_TEST_EVENT = 'ping';

export interface WebhookItemSubject {
  kind: 'item';
  id: string;
  title: string;
  /**
   * The public URL path, or **null when the item has no page of its own**.
   *
   * Null rather than the stored path, because `content_types.item_pages` can be off — a staff
   * directory's people are real content and none of them is a URL. A consumer given the stored path
   * would rebuild or purge an address that answers 404, which is the CMS asserting a route the site
   * does not serve.
   */
  path: string | null;
  slug: string;
  status: ContentStatus;
  /** The content type's `api_id`, which is what a consumer's own code is written against. */
  contentType: string;
  /** Present on the events that are a transition, absent on the rest. */
  previousStatus?: ContentStatus;
}

export interface WebhookReleaseSubject {
  kind: 'release';
  id: string;
  name: string;
  itemCount: number;
}

export type WebhookSubject = WebhookItemSubject | WebhookReleaseSubject;

/**
 * The body of one delivery.
 *
 * **It says what happened; it does not carry the content.** The delivery API is the read contract,
 * and a webhook that inlined an item's fields would be a second one — with no key, no scope check,
 * and no visibility rules, arriving at whatever URL an admin typed. Three things follow from
 * keeping it a notification: a receiver reads through `/delivery`, so it gets published content by
 * construction; the payload does not have to track the content model; and an endpoint cannot be
 * used to exfiltrate drafts.
 *
 * What it does carry is everything needed to decide *whether to bother* — the path, the type and
 * the status — so a rebuild can skip an event about a page it does not render.
 */
/**
 * What a call site hands to the dispatcher: the fact, not the delivery.
 *
 * Declared beside the payload rather than in `delivery.ts` because an emit site should not have to
 * import the queue to describe an event — and because the two shapes have to stay in step, since
 * one is built from the other.
 */
export interface WebhookEventInput {
  event: WebhookEvent;
  subject: WebhookSubject;
  /** When it happened. Defaults to now; passed explicitly by the sweep, which acts in arrears. */
  createdAt?: string;
}

export interface WebhookEventPayload {
  /**
   * The delivery id, repeated in `x-taproot-delivery`.
   *
   * In the body as well as the header because a receiver that queues the body for later processing
   * would otherwise have to carry the header alongside it to stay idempotent.
   */
  id: string;
  event: WebhookEvent | typeof WEBHOOK_TEST_EVENT;
  /** When the event happened, not when this attempt was sent. ISO 8601. */
  createdAt: string;
  subject: WebhookSubject | { kind: 'test' };
}
