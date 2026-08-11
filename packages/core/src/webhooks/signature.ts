/**
 * Signing an outbound event, and checking one on the way in.
 *
 * Both halves live here because a receiver and a sender that disagree fail **silently in one
 * direction** — the same shape as `PURGE_PATH` and `searchTokens`, and the reason those are shared
 * rather than copied. A site whose verification is subtly different from Taproot's signing does not
 * see wrong events; it sees *no* events, with a 401 in a log nobody is watching, on the deployment
 * where the CMS reports every delivery as failed.
 *
 * Re-exported from `pure.ts`, so a consumer can verify without pulling Kysely into its bundle.
 * Nothing here touches the database, and nothing here may start to.
 */

/** The signature itself: `t=<unix seconds>,v1=<hex hmac>`. */
export const WEBHOOK_SIGNATURE_HEADER = 'x-taproot-signature';
/** The event name, so a receiver can route without parsing the body. */
export const WEBHOOK_EVENT_HEADER = 'x-taproot-event';
/**
 * The delivery id, which is what makes a retry safe to receive twice.
 *
 * At-least-once is the only delivery guarantee an HTTP retry can offer: a request that times out
 * after the receiver committed is indistinguishable from one that never arrived, so the sweep will
 * send it again. Stable across every attempt of one delivery — it is the row's primary key — so a
 * consumer that records ids it has processed gets exactly-once for the cost of one lookup.
 */
export const WEBHOOK_DELIVERY_HEADER = 'x-taproot-delivery';

/**
 * How far out of date a signature may be, in seconds.
 *
 * A timestamp is what bounds replay: without one, a body-only signature stays valid forever, so an
 * intercepted "published" event can be re-sent at any time to whatever the receiver does with it.
 * Five minutes is the usual figure and is generous enough for clock drift between two deployments
 * that never talk about time.
 *
 * It also settles a thing about retries: the signature is computed **per attempt**, never stored.
 * A delivery queued and retried eight hours later signs with the clock at the moment it is sent, so
 * a long backoff cannot make Taproot's own retry look like an attack.
 */
export const WEBHOOK_TIMESTAMP_TOLERANCE = 300;

const encoder = new TextEncoder();

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));

  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The header value for a body, at a moment.
 *
 * **The timestamp is inside the signed message, not merely beside it.** Signing the body alone and
 * sending `t=` next to it is the version that looks identical and is worthless: an attacker replays
 * the captured body with a fresh `t`, the tolerance check passes because the timestamp is current,
 * and the signature still verifies because nothing about it depended on the timestamp.
 *
 * `timestamp` is injectable for tests only. Callers pass nothing.
 */
export async function signWebhook(
  secret: string,
  body: string,
  timestamp = Math.floor(Date.now() / 1000),
): Promise<string> {
  return `t=${timestamp},v1=${await hmac(secret, `${timestamp}.${body}`)}`;
}

/**
 * Compare two hex digests without leaking where they first differ.
 *
 * `a === b` on strings short-circuits at the first differing character, which over enough requests
 * is a byte-at-a-time oracle for a valid signature. The lengths are compared first and separately —
 * that much is public, since the digest length is fixed by the algorithm.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);

  return diff === 0;
}

export interface VerifyWebhookOptions {
  /** The shared secret, as shown once when the endpoint was created. */
  secret: string;
  /**
   * The **raw** request body.
   *
   * Not a parsed object re-serialised: `JSON.stringify(await request.json())` reorders nothing today
   * and is still not the bytes that were signed the first time a value round-trips differently — a
   * large integer, a lone surrogate, a key order some runtime does not preserve. Read
   * `await request.text()` and parse afterwards.
   */
  body: string;
  /** The `x-taproot-signature` header, verbatim. */
  header: string | null | undefined;
  /** Seconds of clock skew allowed. Defaults to `WEBHOOK_TIMESTAMP_TOLERANCE`. */
  toleranceSeconds?: number;
  /** Injected in tests; the wall clock otherwise. Unix seconds. */
  now?: number;
}

/**
 * Whether a request really came from the Taproot deployment holding this secret.
 *
 * One boolean, and deliberately no reason: "wrong signature", "too old" and "malformed header" are
 * the same answer to whoever is probing, exactly as `resolvePreviewToken` answers `undefined` to
 * absent, unknown and expired alike.
 */
export async function verifyWebhookSignature(options: VerifyWebhookOptions): Promise<boolean> {
  const parts = new Map(
    (options.header ?? '')
      .split(',')
      .map((part) => part.trim().split('='))
      .filter((pair): pair is [string, string] => pair.length === 2),
  );

  const timestamp = Number(parts.get('t'));
  const presented = parts.get('v1');
  if (!presented || !Number.isFinite(timestamp)) return false;

  const now = options.now ?? Math.floor(Date.now() / 1000);
  const tolerance = options.toleranceSeconds ?? WEBHOOK_TIMESTAMP_TOLERANCE;

  /**
   * Bounded in both directions.
   *
   * A future timestamp is the one people forget, and skipping it undoes the check: a signature
   * stamped a year ahead would sit inside "not older than five minutes" forever, which is a replay
   * window with no end.
   */
  if (Math.abs(now - timestamp) > tolerance) return false;

  return timingSafeEqual(presented, await hmac(options.secret, `${timestamp}.${options.body}`));
}
