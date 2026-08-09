import { describe, expect, it } from 'vitest';

import {
  hasSnippetToken,
  replaceSnippetTokens,
  snippetTokensIn,
} from './snippetTokens.js';

/**
 * The token grammar, which both the server and a consumer have to spell identically.
 *
 * It is re-exported from `pure.ts` for that reason, and the failure mode if the two drift is silent:
 * delivery substitutes before a site ever sees a token, so a consumer's near-miss regex marks
 * nothing and errors nowhere. These tests are what the shared copy is measured against.
 */

const known: Record<string, string> = { tuition: '$4,500', deadline: 'August 15' };
const resolve = (apiId: string) => known[apiId];

describe('snippetTokensIn', () => {
  it('finds a token', () => {
    expect(snippetTokensIn('Tuition is {{ tuition }} per year')).toEqual(['tuition']);
  });

  it('accepts a token written without inner spaces', () => {
    expect(snippetTokensIn('{{tuition}}')).toEqual(['tuition']);
  });

  it('reports each name once, in first-seen order', () => {
    expect(snippetTokensIn('{{ deadline }} … {{ tuition }} … {{ deadline }}')).toEqual([
      'deadline',
      'tuition',
    ]);
  });

  it('ignores braces that are not a token', () => {
    // Ordinary prose containing braces needs no escape syntax, which is only true because the name
    // is restricted to the api_id character set rather than matched greedily.
    expect(snippetTokensIn('Use {{ two words }} or {{ }} or { tuition }')).toEqual([]);
  });

  it('does not let a token span prose and swallow it', () => {
    // A greedy pattern would match from the first `{{` to the last `}}` and take the sentence with
    // it. The character class is what stops that.
    expect(snippetTokensIn('{{ start }} some words {{ end }}')).toEqual(['start', 'end']);
  });
});

describe('hasSnippetToken', () => {
  it('answers the same for the same string twice', () => {
    /*
     * The regression this guards: `TOKEN` is a global regex, and calling `.test` on a shared global
     * advances `lastIndex`, so the second call on an identical string answers false. It is the
     * classic JavaScript footgun and it would show up as "substitution works on some pages".
     */
    const value = 'Tuition is {{ tuition }}';
    expect(hasSnippetToken(value)).toBe(true);
    expect(hasSnippetToken(value)).toBe(true);
  });

  it('is false for prose with no token', () => {
    expect(hasSnippetToken('Tuition is four thousand')).toBe(false);
  });
});

describe('replaceSnippetTokens', () => {
  it('substitutes a known token', () => {
    expect(replaceSnippetTokens('Tuition is {{ tuition }} per year', resolve)).toBe(
      'Tuition is $4,500 per year',
    );
  });

  it('leaves an unknown token exactly as written', () => {
    /*
     * Not blanked. Rendering it as nothing deletes content from a live page while leaving it looking
     * plausible — "Tuition is  per year" — where visible braces are ugly, discoverable and
     * searchable. Deleting a snippet that is in use is refused, so this should be rare anyway.
     */
    expect(replaceSnippetTokens('Tuition is {{ nope }} per year', resolve)).toBe(
      'Tuition is {{ nope }} per year',
    );
  });

  it('substitutes an empty value rather than treating it as unknown', () => {
    // `resolve` returning '' is "known, and empty"; returning undefined is "no such snippet". A
    // resolver that collapsed the two would leave braces on screen for a legitimately empty value.
    expect(replaceSnippetTokens('a{{ blank }}b', () => '')).toBe('ab');
  });

  it('substitutes every occurrence, not just the first', () => {
    expect(replaceSnippetTokens('{{ tuition }} and {{ tuition }}', resolve)).toBe(
      '$4,500 and $4,500',
    );
  });

  it('leaves surrounding markup alone', () => {
    // Rich text is stored as HTML and a token is ordinary text inside it, so substitution must not
    // need to understand the markup around it.
    expect(replaceSnippetTokens('<p>Tuition is <strong>{{ tuition }}</strong></p>', resolve)).toBe(
      '<p>Tuition is <strong>$4,500</strong></p>',
    );
  });
});
