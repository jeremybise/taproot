/**
 * The `rel` vocabulary, and the one rule that is not the author's to break.
 *
 * An importless module for the reason `itemSort.ts` and `contentTypeKind.ts` are: the sanitiser
 * needs the allowlist, menus need it, and `sanitizeHtml.ts` is not somewhere `menus.ts` should have
 * to import from — it is a serialiser for a different feature, and reaching into it for a constant
 * is how the two grow a dependency neither wants.
 *
 * ## Two features had two opinions about `rel`, and one of them was wrong
 *
 * Rich text has always composed `rel` correctly: `serializeAnchor` filters an author's tokens
 * against the allowlist and then **adds `noopener noreferrer` last** whenever it emits
 * `target="_blank"`, so an author can add `nofollow` on top and cannot take the protective pair
 * away. A menu item carried `open_in_new_tab` as a bare boolean and left the markup to the
 * consumer, which is a different thing entirely — it makes the protection a rule every site has to
 * know rather than one Taproot keeps. The first real consumer duly rendered
 * `rel="noopener"` and no `noreferrer`, which is exactly the failure a shared vocabulary prevents:
 * not a wrong `rel`, a *nearly* right one that looks deliberate.
 *
 * So `menuRel` composes the string here and it travels in the delivery payload beside the flags.
 * Same split as `<TaprootEmbed>` owning `sandbox` and `referrerpolicy` rather than trusting an
 * author to remember them: where a value protects the visitor, Taproot emits it and the site
 * renders what it is given.
 */

/**
 * Relationship tokens an author is allowed to set.
 *
 * A short list rather than free text: `rel` is a security-relevant attribute, and the useful
 * editorial ones are few. Anything outside this set is discarded rather than passed through, so a
 * pasted `rel` cannot carry something nobody vetted.
 */
export const ALLOWED_REL = new Set(['nofollow', 'noopener', 'noreferrer', 'sponsored', 'ugc']);

/**
 * The pair a new-tab link always carries.
 *
 * A link opening in a new tab without `rel="noopener"` hands the opened page a reference back
 * through `window.opener`. Current browsers imply it for `target="_blank"`, older ones do not, and
 * being explicit costs nothing.
 */
export const NEW_TAB_REL = ['noopener', 'noreferrer'] as const;

/**
 * Compose a menu item's `rel`, or `null` when it needs none.
 *
 * Null rather than an empty string, so a consumer can spread the attribute conditionally without
 * emitting `rel=""` — which is not harmful and is noise on every internal link on the site.
 *
 * The protective pair is added **last** and unconditionally, exactly as `serializeAnchor` adds it,
 * so the two paths cannot disagree about the one token that matters. `nofollow` is genuinely the
 * editor's choice; `noopener noreferrer` is not.
 */
export function menuRel(flags: { openInNewTab?: boolean; noFollow?: boolean }): string | null {
  const rel = new Set<string>();
  if (flags.noFollow) rel.add('nofollow');
  if (flags.openInNewTab) for (const token of NEW_TAB_REL) rel.add(token);
  return rel.size > 0 ? [...rel].join(' ') : null;
}
