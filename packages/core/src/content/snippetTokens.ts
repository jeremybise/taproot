/**
 * The `{{ tuition }}` token grammar, in one place.
 *
 * An importless module, re-exported from `pure.ts`, for the reason `cacheTags.ts` and
 * `PREVIEW_PARAM` are: a consumer that wants to find or highlight tokens has to spell the syntax
 * **identically**, and a second copy is a mismatch that fails silently in one direction — the server
 * substitutes and the site's highlighter marks nothing, or vice versa, on the one page nobody
 * reopened.
 *
 * ## Why a typeable token rather than an opaque marker
 *
 * Rich text stores references as `taproot:item:{uuid}`, and that works because the marker lives in an
 * `href` an editor never sees or types. A snippet has to go **in the middle of a sentence**, and in a
 * plain text input, so it has to be something a person can type and read back. `{{ api_id }}` is
 * that; a uuid is not.
 *
 * It costs one thing, and the cost is why `api_id` is immutable: the token *is* the reference, so a
 * rename would break every stored copy, and rewriting them across `content_items.data` is a second
 * implementation of the problem snippets exist to remove.
 *
 * ## An unknown token is left exactly as written
 *
 * Not blanked. Rendering `{{ tuition }}` as nothing silently deletes content from a live page, and
 * the page still looks plausible — "Tuition is  per year". Leaving it visible is ugly and
 * discoverable, which is the right trade for something that should be rare anyway, since a snippet
 * in use cannot be deleted. It also means ordinary prose containing braces needs no escape syntax:
 * `{{ this }}` is only ever touched when `this` names a real snippet.
 */

/**
 * `{{ name }}`, with optional inner whitespace.
 *
 * The name is restricted to the `api_id` character set rather than being permissive, so a token can
 * never span a line of prose and swallow it — `{{ some text }} and more` matches nothing at all
 * rather than matching greedily up to a later brace.
 */
const TOKEN = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/gi;

/** Every distinct snippet `api_id` a string refers to, in first-seen order. */
export function snippetTokensIn(value: string): string[] {
  const seen = new Set<string>();
  for (const match of value.matchAll(TOKEN)) seen.add(match[1]!.toLowerCase());
  return [...seen];
}

/** Whether a string carries any token at all — the cheap check before doing real work. */
export function hasSnippetToken(value: string): boolean {
  // A fresh regex each call: `TOKEN` is global, so `test` would advance `lastIndex` and answer
  // differently on alternate calls for the same string.
  return /\{\{\s*[a-z][a-z0-9_]*\s*\}\}/i.test(value);
}

/**
 * Replace every token that names a known snippet, leaving the rest untouched.
 *
 * `resolve` returns the text to substitute, or `undefined` for a name it does not know. Returning
 * `undefined` rather than `''` is what keeps "unknown" and "known but empty" apart — an editor may
 * legitimately set a snippet to an empty string, and that should substitute to nothing rather than
 * leaving braces on the page.
 */
export function replaceSnippetTokens(
  value: string,
  resolve: (apiId: string) => string | undefined,
): string {
  return value.replace(TOKEN, (whole, name: string) => {
    const replacement = resolve(name.toLowerCase());
    return replacement === undefined ? whole : replacement;
  });
}
