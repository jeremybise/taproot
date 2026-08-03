import { tokenize } from './sanitizeHtml.js';

/**
 * Internal references inside rich text: finding them, and turning them into real URLs.
 *
 * A rich-text value is an HTML string, so a link stored in it cannot be a row in a join table the
 * way a `relation` field's value is. What it stores instead is `taproot:item:{id}` in the `href` —
 * a reference, never a path, for the same reason a menu item stores its target: a page that moves
 * keeps every link pointing at it, and nobody edits the prose.
 *
 * The resolution happens at delivery rather than being left to the consumer. That is a deliberate
 * exception to "references are lookup maps, never inlined into `data`", and the reason is the
 * failure mode: a marker left in place ships `taproot:item:…` to a visitor the moment a site forgets
 * to call a helper, which is a broken link on a live page. Delivery is read-only — `content:read` —
 * so nothing round-trips this back into a write, which is the concern that rule exists to protect.
 * The ids stay in the payload's `references` and `media` maps for anyone who wants them.
 *
 * **Parsed with `tokenize`, never with a regex over the markup.** `sanitizeHtml` says why: a second
 * regex-shaped answer to "what does this markup say" is how the two disagree, and `accessibility.ts`
 * already reuses the same tokenizer for the same reason.
 */

const REF = /^taproot:(item|media):([0-9a-f-]{36})$/i;

export interface RichTextRefs {
  itemIds: Set<string>;
  mediaIds: Set<string>;
}

/**
 * Every internal reference a rich-text value points at.
 *
 * Collected so `buildItemPayload` can look them all up in one query each, rather than one per link.
 */
export function collectRichTextRefs(
  html: string,
  into: RichTextRefs = { itemIds: new Set(), mediaIds: new Set() },
): RichTextRefs {
  if (!html || !html.includes('taproot:')) return into;

  for (const token of tokenize(html)) {
    if (token.kind !== 'open' || token.name !== 'a') continue;

    const href = hrefOf(token.attributes);
    const match = href ? REF.exec(href) : null;
    if (!match) continue;

    if (match[1]!.toLowerCase() === 'item') into.itemIds.add(match[2]!);
    else into.mediaIds.add(match[2]!);
  }

  return into;
}

export interface RichTextTargets {
  /** Item id → the path to link to. Absent means "do not link": missing, or not visible. */
  items: Map<string, string>;
  /** Media id → absolute asset URL. */
  media: Map<string, string>;
}

/**
 * Rewrite internal references into the URLs they currently resolve to.
 *
 * A reference with no target — deleted, or unpublished and this is not a preview — **unwraps**: the
 * `<a>` goes and its text stays. That mirrors what a menu does with a target it cannot show, and it
 * is the better of the two failures. The alternative, linking anyway, sends a reader to a 404 that
 * the page itself claimed was there.
 *
 * Rebuilt from the token stream rather than string-replaced, so the output is the tokenizer's idea
 * of the markup rather than the input with holes cut in it.
 */
export function resolveRichTextRefs(html: string, targets: RichTextTargets): string {
  if (!html || !html.includes('taproot:')) return html;

  const out: string[] = [];
  /** Depth of anchors whose opening tag was dropped, so the matching `</a>` is dropped too. */
  let unwrapping = 0;

  for (const token of tokenize(html)) {
    if (token.kind === 'text') {
      out.push(token.value);
      continue;
    }
    if (token.kind === 'other') continue;

    if (token.kind === 'close') {
      if (token.name === 'a' && unwrapping > 0) {
        unwrapping -= 1;
        continue;
      }
      out.push(`</${token.name}>`);
      continue;
    }

    if (token.name !== 'a') {
      out.push(renderOpen(token.name, token.attributes));
      continue;
    }

    const href = hrefOf(token.attributes);
    const match = href ? REF.exec(href) : null;

    if (!match) {
      out.push(renderOpen('a', token.attributes));
      continue;
    }

    const resolved =
      match[1]!.toLowerCase() === 'item'
        ? targets.items.get(match[2]!)
        : targets.media.get(match[2]!);

    if (!resolved) {
      unwrapping += 1;
      continue;
    }

    out.push(renderOpen('a', replaceHref(token.attributes, resolved)));
  }

  return out.join('');
}

/**
 * The `href` value, decoded enough to compare.
 *
 * Deliberately small: this only ever runs over markup `sanitizeHtml` has already produced, where
 * attributes are double-quoted and entity-escaped by one known serialiser.
 */
function hrefOf(attributes: string): string | null {
  const match = /\bhref\s*=\s*"([^"]*)"/i.exec(attributes);
  return match ? match[1]!.replace(/&amp;/g, '&') : null;
}

function replaceHref(attributes: string, href: string): string {
  return attributes.replace(/\bhref\s*=\s*"[^"]*"/i, `href="${escapeAttribute(href)}"`);
}

function renderOpen(name: string, attributes: string): string {
  const trimmed = attributes.trim();
  return trimmed ? `<${name} ${trimmed}>` : `<${name}>`;
}

/** Matches `sanitizeHtml`'s own escaping, so a resolved path cannot break out of the attribute. */
function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
