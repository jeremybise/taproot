import type { WebhookEvent } from '@taprootcms/core';

/**
 * What each event means, in words an operator can choose between.
 *
 * A `.ts` beside the screens rather than inline in one of them, for the reason `status.ts` and
 * `parentOptions.ts` are extracted: both screens offer the same checkboxes, and copy duplicated
 * across two files is copy that drifts — the create form would end up describing an event
 * differently from the edit form on the next screen along.
 *
 * Deliberately **not** in core. The event names are the contract and belong there; how the admin
 * explains them to somebody choosing is presentation, and putting English in `events.ts` would put
 * it in a consumer's bundle through `pure.ts`.
 *
 * `Record<WebhookEvent, string>` rather than a partial map, so adding an event to `WEBHOOK_EVENTS`
 * fails the typecheck here until somebody says what it is for — a checkbox with no explanation is
 * how a subscription list becomes guesswork.
 */
export const EVENT_DESCRIPTIONS: Record<WebhookEvent, string> = {
  'item.created': 'A new item exists, whatever its status.',
  'item.updated': 'An item was saved. Fires on every edit, including drafts.',
  'item.published': 'An item became visible to the public.',
  'item.unpublished': 'An item stopped being visible — moved to draft, review, or archived.',
  'item.deleted': 'An item was removed. Carries what it was, because it is gone.',
  'release.published': 'A whole release went live. Sent alongside the per-item events.',
};
