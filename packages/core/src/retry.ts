/**
 * When a failed piece of deferred work may be tried again.
 *
 * Shared by the cache-purge queue and the webhook queue because both answer the *same* question —
 * "the five-minute sweep is the only thing that will pick this up, so how many sweeps should it
 * skip" — and an answer tuned against that interval is not a property of either kind of work. Two
 * copies would be two things to change and one to forget.
 *
 * That is the only thing they share. The queues themselves stay separate for the reasons
 * `0033_webhooks` sets out: they differ on durability, on their columns, and on whether a screen
 * reads them.
 */

/** Backoff in minutes, indexed by attempts already made. The last entry repeats. */
export const RETRY_BACKOFF_MINUTES = [0, 5, 15, 30, 60, 120, 240, 480];

/**
 * The moment a row with this many failures behind it becomes due.
 *
 * Zero for the first entry: something queued because an attempt just failed should be eligible on
 * the next sweep rather than waiting out a delay it has already served.
 */
export function nextRetryAt(attempts: number, from = Date.now()): string {
  const minutes = RETRY_BACKOFF_MINUTES[Math.min(attempts, RETRY_BACKOFF_MINUTES.length - 1)]!;
  return new Date(from + minutes * 60_000).toISOString();
}
