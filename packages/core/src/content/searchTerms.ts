/**
 * The search vocabulary both sides of the wire spell, and the only module that knows how FTS5
 * decides two words are the same word.
 *
 * Importless, so `pure.ts` can re-export it to a consumer that must never see Kysely — the same
 * arrangement `cacheTags` and `imageVariants` have, and for the same reason. Two things read this
 * and they are on opposite sides of an HTTP boundary:
 *
 *  - **The server** builds the `MATCH` expression from `searchTokens` (`toMatchQuery` in
 *    `search.ts`), which is what actually selects rows.
 *  - **A consumer** highlights the excerpt it is handed, because `buildExcerpt` returns plain text
 *    by design and a site that wants a `<mark>` has to find the term itself.
 *
 * A second copy of the tokenizer on the consumer's side is the failure this module exists to
 * prevent, and it fails *silently*: the highlight marks the wrong span, or none, on a page whose
 * results are perfectly correct. Nothing errors, so nobody looks. Same class as a `cache-tag`
 * spelled two ways — the purge succeeds, reports success, and clears nothing.
 *
 * **Everything here was measured against FTS5 rather than reasoned about**, because the tokenizer's
 * behaviour is not guessable from its name. `content_item_fts` is declared `using fts5(text)` with
 * no tokenizer argument, so it gets `unicode61` with `remove_diacritics 1`, and that turns out to
 * mean:
 *
 *  - `"pena"` matches *Peña* and `"resume"*` matches *résumé* — combining marks are folded away.
 *  - `ø` and `ß` are folded by **neither**, so `"sorensen"` does not match *Sørensen* and
 *    `"strasse"` does not match *Straße*. `remove_diacritics` strips combining marks; it does not
 *    transliterate, and a highlighter that "helpfully" did would mark words the search never found.
 *  - `Å` and `Ö` fold, and case folds, in both directions.
 *
 * A highlighter agreeing on the first three and not the fourth is worse than one that agrees on
 * none, because it looks right on every page anybody tests it on.
 */

/**
 * The tokens a search string contributes, Unicode-aware.
 *
 * Runs of letters and digits, matching how `unicode61` splits text: anything else is a separator.
 * `\p{L}\p{N}` rather than `a-z0-9`, or a search for `Peña` splits in the middle of the name and a
 * course code like `163` disappears.
 *
 * Returns an empty array for input with no tokens at all (`!!!`, or whitespace). Callers must treat
 * that as "nothing to match on" rather than as "match nothing" — `toMatchQuery` still lets the title
 * and path predicates run, so searching `?` finds a page called `?` rather than erroring.
 */
export function searchTokens(input: string): string[] {
  return input.match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** One run of the excerpt, and whether the search matched it. */
export interface SearchSegment {
  text: string;
  /** True when this run is what the search found, and therefore what a `<mark>` goes around. */
  match: boolean;
}

/**
 * Case- and diacritic-folded, **without changing the string's length**.
 *
 * The length is the whole trick. Folding is only useful here if a match position in the folded
 * string is also a match position in the original — a consumer marks a span of the *real* excerpt,
 * accents and capitals intact, and the offsets have to survive the round trip. The obvious
 * implementation, `text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()`, is length-*changing*
 * in both halves: NFD splits `é` into two code units, and `İ`.toLowerCase() is two.
 *
 * So the fold is per code point and only applied when the result is the same width, which leaves a
 * character that cannot be folded that way exactly as it was. That is not a compromise — it is the
 * behaviour that matches FTS5, which also leaves `ø` and `ß` alone.
 */
function foldForSearch(text: string): string {
  // ASCII cannot carry a combining mark and lowercases one-for-one, which is nearly every excerpt a
  // site will ever render. Worth a branch: the general path calls `normalize` per character.
  if (!/[^\x20-\x7E]/.test(text)) return text.toLowerCase();

  return Array.from(text, (character) => {
    const lowered = character.toLowerCase();
    const stripped = lowered.normalize('NFD').replace(/\p{M}/gu, '');

    // Prefer the fully folded form, fall back to merely lowercased, and keep the original rather
    // than shift every offset after it. `İ` needs the fallback chain: lowercasing widens it to two
    // units and stripping the combining dot brings it back to one.
    if (stripped.length === character.length) return stripped;
    if (lowered.length === character.length) return lowered;
    return character;
  }).join('');
}

/** Tokens contain no regex metacharacters by construction; escaped anyway, so that stays true. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** What `unicode61` treats as part of a word, and therefore what a token boundary is not. */
const WORD = '[\\p{L}\\p{N}]';

/**
 * Split text into runs, marking the ones the search matched.
 *
 * Pure, and exported for its own tests: string arithmetic that only ever runs inside a template is
 * reachable by no suite in this repo, which is the lesson `scaleSizes` cost a release to learn.
 *
 * **Segments rather than markup, and that is the security property.** The obvious shape for this
 * function is one returning `<mark>`-wrapped HTML, which a template then renders with `set:html` —
 * and the search term arrives in `?q=`, so that is a reflected XSS on the one page most likely to
 * be handed a hostile URL. Returning data means the template emits text nodes and elements, there
 * is no string to trust, and the unsafe version is not merely discouraged but unavailable.
 * `<TaprootExcerpt>` in `@taprootcms/astro` is the renderer.
 *
 * **The last token is a prefix and the others are not**, mirroring `toMatchQuery` exactly, because
 * that is what the server matched on. Measured: `"college"` does not match *colleges* in FTS5,
 * while `"college"*` does — so highlighting every token as a prefix would mark spans no query
 * selected, and highlighting none of them as a prefix would leave the word an editor is still
 * typing unmarked.
 *
 * Nothing merges adjacent matches, because the boundary lookarounds make adjacency impossible: a
 * match ends on a word character and the next one may not begin after one. That was written as a
 * merge step first, on the theory that two tokens meeting across a hyphen would emit two `<mark>`s
 * and seam one word — the branch turned out to be unreachable, and a defensive copy of it would be
 * untestable code carrying a rationale that is not true.
 */
export function highlightTerms(text: string, query: string): SearchSegment[] {
  if (!text) return [];

  const tokens = searchTokens(query);
  if (tokens.length === 0) return [{ text, match: false }];

  const pattern = tokens
    .map((token, index) => {
      const folded = escapeRegExp(foldForSearch(token));
      const opening = `(?<!${WORD})${folded}`;

      // The final token carries FTS5's `*`, so it runs on to the end of whatever word it started.
      return index === tokens.length - 1 ? `${opening}${WORD}*` : `${opening}(?!${WORD})`;
    })
    .join('|');

  const segments: SearchSegment[] = [];
  let cursor = 0;

  // An empty run is dropped rather than emitted, or a match at position zero leads with a blank
  // segment and every consumer has to filter it before rendering.
  const push = (slice: string, match: boolean): void => {
    if (slice) segments.push({ text: slice, match });
  };

  // The fold is length-preserving, so an index found here is the same index in `text` — which is
  // what lets the marked span keep its own capitals and accents.
  for (const found of foldForSearch(text).matchAll(new RegExp(pattern, 'gu'))) {
    const start = found.index;
    push(text.slice(cursor, start), false);
    push(text.slice(start, start + found[0].length), true);
    cursor = start + found[0].length;
  }

  push(text.slice(cursor), false);
  return segments;
}
