/**
 * The endpoint a site mounts to receive content events.
 *
 * The sibling of `createTaprootPurgeHandler`, and mounted the same way — a handler the site owns
 * rather than a route an integration injects, so the path, the runtime and the secret's provenance
 * all belong to the site:
 *
 * ```ts
 * // src/pages/taproot/events.ts
 * import { createTaprootWebhookHandler } from '@taprootcms/astro';
 * import { env } from 'cloudflare:workers';
 *
 * export const prerender = false;
 * export const POST = createTaprootWebhookHandler({
 *   secret: env.TAPROOT_WEBHOOK_SECRET,
 *   async onEvent(event) {
 *     if (event.event === 'item.published') await rebuild(event.subject);
 *   },
 * });
 * ```
 *
 * **Why this exists at all, when verifying a signature is four lines.** Those four lines are the
 * ones people get wrong, and every way of getting them wrong is silent: reading the body with
 * `request.json()` and re-serialising it verifies a different string than the one that was signed;
 * comparing digests with `===` leaks where they differ; skipping the timestamp leaves a captured
 * request replayable forever; answering 200 before the work is done turns a retry queue into a
 * single attempt. The same argument as `menuRel` — two consumers independently wrote
 * `rel="noopener"` without `noreferrer`, and neither was a wrong answer so much as a nearly-right
 * one that looked deliberate.
 */

import {
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  verifyWebhookSignature,
  type WebhookEventPayload,
} from '@taprootcms/core/pure';

export interface TaprootWebhookHandlerOptions {
  /**
   * The signing secret, as shown once when the endpoint was created in the CMS.
   *
   * Undefined disables the endpoint — 404 rather than 401, exactly as the purge handler does and
   * for the same reason: an unconfigured site should look like a site with no such route rather
   * than like one guarding something worth guessing at.
   */
  secret?: string;
  /**
   * What to do with an event.
   *
   * **Awaited before the response**, which is the whole shape of the contract. Taproot treats a 2xx
   * as "this landed" and stops retrying, so answering before the work is done converts an
   * at-least-once delivery into a best-effort one, silently. If the work is long, hand it to
   * `waitUntil` yourself and accept what that means — do not make this function return early on
   * Taproot's behalf.
   *
   * A throw becomes a 500, which Taproot retries on a widening schedule and eventually reports on
   * the endpoint's own screen. That is the right way to say "I could not handle this".
   */
  onEvent: (event: WebhookEventPayload, request: Request) => void | Promise<void>;
  /**
   * Seconds of clock skew allowed before a signature is considered stale. Defaults to five minutes.
   *
   * Raise it only for a receiver whose clock you do not control. It is what bounds replay of a
   * captured request, so a large value is a long window in which one can be sent again.
   */
  toleranceSeconds?: number;
}

/**
 * A handler that verifies, parses, and hands over one event.
 *
 * Answers 401 to a bad signature, 400 to a body that is not a Taproot event, and 500 to a handler
 * that threw. Nothing here is cached or stored: this is an authenticated write surface.
 */
export function createTaprootWebhookHandler(options: TaprootWebhookHandlerOptions) {
  return async function POST(context: { request: Request }): Promise<Response> {
    const secret = options.secret?.trim();
    const headers = { 'cache-control': 'no-store' };

    if (!secret) return new Response(null, { status: 404, headers });

    /**
     * The **raw** body, read once, before anything parses it.
     *
     * `JSON.stringify(await request.json())` is the version that looks identical and is not: it
     * reorders nothing today and still is not the bytes that were signed the first time a value
     * round-trips differently. It also cannot be undone — a `Request` body is a stream, so a
     * handler that parsed first has no raw text left to verify against.
     */
    const body = await context.request.text();

    const verified = await verifyWebhookSignature({
      secret,
      body,
      header: context.request.headers.get(WEBHOOK_SIGNATURE_HEADER),
      toleranceSeconds: options.toleranceSeconds,
    });

    if (!verified) return new Response(null, { status: 401, headers });

    let event: WebhookEventPayload;
    try {
      event = JSON.parse(body) as WebhookEventPayload;
    } catch {
      /**
       * 400, and reached only by something holding the secret.
       *
       * Which makes it a signal worth having rather than noise: a signed request whose body is not
       * JSON means the two sides disagree about the protocol, not that somebody is probing.
       */
      return new Response(null, { status: 400, headers });
    }

    try {
      await options.onEvent(event, context.request);

      /**
       * 204, and the delivery id echoed back.
       *
       * Not required by anything — Taproot reads only the status — and it costs one header to make
       * a receiver's own logs correlate with the delivery table on the CMS, which is the first
       * thing anybody wants when the two disagree about whether something arrived.
       */
      return new Response(null, {
        status: 204,
        headers: { ...headers, [WEBHOOK_DELIVERY_HEADER]: event.id ?? '' },
      });
    } catch (error) {
      /**
       * Reported as a failure, deliberately unlike every outbound path inside the CMS.
       *
       * There "never throw" is right because the write being described has already committed. Here
       * nothing has committed and the caller is a retry queue whose only way to replay is a
       * response saying this did not work — the same reasoning the purge handler sets out.
       */
      console.error('[taproot] webhook handler failed', event.event, error);
      return new Response(null, { status: 500, headers });
    }
  };
}

/**
 * Whether a request really came from your Taproot deployment.
 *
 * For a receiver that wants the check without the handler — a framework route, a queue producer, an
 * existing endpoint that already does its own parsing. Read the body as **text** and pass that
 * exact string; see the note on `onEvent` about what re-serialising costs.
 */
export { verifyWebhookSignature } from '@taprootcms/core/pure';
