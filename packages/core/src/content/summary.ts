import type { FieldRow } from '../db/schema.js';
import { htmlToText } from './sanitizeHtml.js';

/**
 * Render a content type's summary template against one item's or block's stored `data`.
 *
 * **In core, not in the island that shows it**, for the reason `resolveSeo` lives here: two places
 * need the same answer — the block editor's collapsed row and the admin's content lists — and two
 * implementations of "what does this thing say it is" drift into an item labelled one way in a list
 * and another way inside the page that holds it.
 *
 * ## What it replaced
 *
 * `content_types.title_field` named a single field and was written by the content-type settings
 * screen under the label *"Which field labels an item in admin lists"*. **No admin list ever read
 * it.** That is the same shape as `reverseLabel` and the old `needsPublish` flag: a setting that
 * looks configured, is stored correctly, and is enforced by nothing.
 *
 * A template rather than a second column beside it, because `title_field: 'headline'` *is*
 * `{{ headline }}` — a near-twin column is the "two spellings of one fact" this codebase keeps
 * avoiding, and migrating the old values costs one statement. What the template buys is the case a
 * single field cannot express: a card that reads "Apply now · /admissions", or a person row that
 * reads "Ada Lovelace — Mathematics".
 *
 * ## Rules, each preventing a specific way this goes wrong
 *
 * - **The output is always text and never markup.** Callers render it as a string; nothing here may
 *   reach `set:html`. A richtext value is flattened with `htmlToText` — the same function the search
 *   index uses — so a summary of a prose field is words rather than tags.
 * - **A token that resolves to nothing takes its separators with it.** `{{ headline }} · {{ link }}`
 *   with no link must read `Apply now`, not `Apply now ·`. Dangling punctuation on half the rows of
 *   a list looks like breakage, and it is the common case rather than the rare one — optional fields
 *   are optional.
 * - **A `media`, `relation`, `link` or `block` field contributes nothing**, because what it stores is
 *   an id or an envelope. A uuid in a summary is worse than a blank: it is noise that looks like
 *   data, and resolving it would need a database handle on a function the editor runs per keystroke.
 * - **An unknown field name resolves to nothing rather than erroring.** A template outlives the
 *   field it names — somebody renames an `api_id` on another screen weeks later — and the same
 *   reasoning applies as a query field whose `dateFieldApiId` no longer names a date field: a live
 *   screen must not break for a configuration mistake made elsewhere.
 */

/** How long a rendered summary may be before it is cut. Long enough to be useful in a table cell. */
const MAX_SUMMARY = 120;

/** Field types whose stored value is an id or an envelope rather than something readable. */
const UNREADABLE = new Set(['media', 'relation', 'link', 'block', 'query', 'repeater']);

const TOKEN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/**
 * One field's value as a plain string, or `''` when it has nothing to show.
 *
 * Exported because the admin's list columns will want exactly this, and a second copy of "how does a
 * date field read" is how two screens start disagreeing about the same row.
 */
export function fieldValueText(field: FieldRow | undefined, value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  if (field && UNREADABLE.has(field.type)) return '';

  if (Array.isArray(value)) {
    // A multi-value `select` or `taxonomy`. Joined rather than truncated to the first, since "Staff,
    // Students" and "Staff" are different answers.
    return value.map((entry) => fieldValueText(field, entry)).filter(Boolean).join(', ');
  }

  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return String(value);
  if (typeof value !== 'string') return '';

  // Richtext is stored as HTML; flattening is what stops a summary reading "<p>Apply".
  if (field?.type === 'richtext') return htmlToText(value);

  /*
   * A date is stored as an ISO string, and `2026-03-03T23:00:00.000Z` is not something to put in a
   * sentence or a table cell. Formatted here rather than at each call site so a summary line and a
   * list column cannot disagree about how the same field reads.
   *
   * The time is shown only when the stored value carries one, which is what the field's own
   * `includeTime` option produces — so an all-day date does not gain a misleading midnight. `en-US`
   * matches `renderSnippet`, and moves with it if a locale setting ever exists.
   */
  if (field?.type === 'date') {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return value;
    const hasTime = value.includes('T');
    return new Intl.DateTimeFormat('en-US', {
      dateStyle: 'medium',
      ...(hasTime ? { timeStyle: 'short' } : { timeZone: 'UTC' }),
    }).format(parsed);
  }

  return value;
}

/**
 * Fill a template, dropping empty tokens along with the punctuation that separated them.
 *
 * The separator rule is why this is not a `String.replace` one-liner: replacing a token with `''`
 * leaves whatever sat between it and its neighbour, which is the dangling-bullet bug.
 */
export function renderSummary(
  template: string | null | undefined,
  fields: FieldRow[],
  data: Record<string, unknown>,
): string {
  if (!template) return '';

  const byApiId = new Map(fields.map((field) => [field.api_id, field]));

  /*
   * Split into alternating literal and token parts, so a literal can be dropped when the token
   * beside it resolved to nothing. Walking the string this way is what makes "separator goes with
   * its token" expressible at all.
   */
  const parts: { literal: string; token?: string }[] = [];
  let cursor = 0;
  for (const match of template.matchAll(TOKEN)) {
    parts.push({ literal: template.slice(cursor, match.index), token: match[1] });
    cursor = match.index + match[0].length;
  }
  parts.push({ literal: template.slice(cursor) });

  let out = '';
  for (const part of parts) {
    if (part.token === undefined) {
      out += out === '' ? withoutLeadingSeparator(part.literal) : part.literal;
      continue;
    }
    const text = fieldValueText(byApiId.get(part.token), data[part.token]).trim();
    // The literal *before* an empty token is dropped with it — that literal is the separator the
    // author wrote to join this token to the previous one.
    if (!text) continue;
    /*
     * And a separator before the *first surviving* token goes too. `{{ subtitle }} — {{ headline }}`
     * with no subtitle would otherwise render "— Apply now": the em dash was written to join two
     * values and there is only one left. Dropping it needs the emptiness of the output so far, not
     * of the previous token, because several tokens may have collapsed in a row.
     */
    out += (out === '' ? withoutLeadingSeparator(part.literal) : part.literal) + text;
  }

  const collapsed = out.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_SUMMARY ? `${collapsed.slice(0, MAX_SUMMARY - 1).trimEnd()}…` : collapsed;
}

/**
 * Strip punctuation an author wrote to *join* two values, when there is nothing to its left.
 *
 * Deliberately only punctuation and whitespace. A literal that begins with a word is a label rather
 * than a separator — `Event: {{ title }}` should keep its "Event:" — and the distinction is exactly
 * "did somebody write this to sit between two things, or in front of one".
 */
function withoutLeadingSeparator(literal: string): string {
  return literal.replace(/^[\s·•\-–—|,;:/]+/, '');
}

/**
 * What to call this thing, with the fallback chain applied.
 *
 * The template is an override, not a requirement: most content types never set one and their items
 * are known by their title. A block has no title of its own, so its type's name is the floor —
 * "Hero" beats an empty disclosure that says nothing about what it holds.
 */
export function summaryLabel(
  template: string | null | undefined,
  fields: FieldRow[],
  data: Record<string, unknown>,
  fallback: string,
): string {
  return renderSummary(template, fields, data) || fallback;
}

/**
 * Load stored `data` for a page of items, keyed by id.
 *
 * `ContentItemSummary` is `Omit<ContentItemRow, 'data' | 'seo'>` on purpose — a menu picker asking
 * for two hundred candidates by title must not start paying for two hundred page bodies, and that
 * default is what keeps every other caller cheap. A list rendering a summary template does need the
 * values, so it opts in here.
 *
 * **One query for the whole page, never one per row.** Same rule `resolveDelivery` follows for its
 * media and term lookups: the cost is per page, not per item. An empty `ids` short-circuits rather
 * than sending `in ()`, which is a syntax error — the same trap `listMedia` documents.
 */
export async function loadItemData(
  db: { selectFrom: (table: 'content_items') => any },
  ids: string[],
): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  if (ids.length === 0) return out;

  const rows: { id: string; data: string }[] = await db
    .selectFrom('content_items')
    .select(['id', 'data'])
    .where('id', 'in', ids)
    .execute();

  for (const row of rows) {
    try {
      out.set(row.id, JSON.parse(row.data || '{}') as Record<string, unknown>);
    } catch {
      // A row whose JSON will not parse gets an empty object rather than taking the list down —
      // the `parseJson` precedent, and a list screen is the wrong place to discover a bad write.
      out.set(row.id, {});
    }
  }
  return out;
}
