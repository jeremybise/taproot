import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import { highlightTerms, searchTokens } from './searchTerms.js';
import { toMatchQuery } from './search.js';

/**
 * The tokenizer both sides of the wire share, and the highlighter built on it.
 *
 * Three things are being defended, and the third is the one that needed a database to state.
 *
 * **Segments, never markup.** The search term arrives in `?q=`, so a highlighter returning HTML is
 * a reflected XSS waiting for a template to reach for `set:html`. The tests below assert the
 * function has no way to emit markup at all: a term full of angle brackets comes back as text in a
 * non-matching segment.
 *
 * **The last token is a prefix and no other is.** That is not a stylistic choice about highlighting,
 * it is what `toMatchQuery` sent to FTS5, and a highlight that disagrees marks spans the search did
 * not select.
 *
 * **Folding matches `unicode61`, including where it declines to fold.** `remove_diacritics` strips
 * combining marks and transliterates nothing, so *Peña* answers to `pena` while *Sørensen* does not
 * answer to `sorensen`. Guessing either way produces a highlighter that looks correct on every
 * English page anybody tests it on.
 */

/**
 * The real thing, asked directly.
 *
 * `content_item_fts` is `using fts5(text)` with no tokenizer argument, and this mirrors that
 * declaration exactly. The point is to make the *agreement* the assertion rather than a list of
 * behaviours I believed FTS5 had — the failure this module exists to prevent is precisely a
 * plausible belief about a tokenizer nobody re-checked.
 */
function ftsMatches(text: string, query: string): boolean {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('create virtual table t using fts5(text)');
    db.prepare('insert into t(text) values (?)').run(text);

    const match = toMatchQuery(query);
    if (!match) return false;

    return db.prepare('select 1 from t where t match ?').all(match).length > 0;
  } finally {
    db.close();
  }
}

/** Just the marked runs, which is what a `<mark>` would wrap. */
const marked = (text: string, query: string): string[] =>
  highlightTerms(text, query)
    .filter((segment) => segment.match)
    .map((segment) => segment.text);

/** Segments always reassemble into exactly the input, or the excerpt was corrupted on the way out. */
const rebuilt = (text: string, query: string): string =>
  highlightTerms(text, query)
    .map((segment) => segment.text)
    .join('');

describe('searchTokens', () => {
  it('splits on anything that is not a letter or digit', () => {
    expect(searchTokens('financial-aid, please!')).toEqual(['financial', 'aid', 'please']);
  });

  it('keeps a name with a diacritic whole', () => {
    // `a-z` here would split `Peña` into `Pe` and `a`, and a search for the name would never find it.
    expect(searchTokens('Peña')).toEqual(['Peña']);
  });

  it('keeps digits, so a course code is searchable', () => {
    expect(searchTokens('MATH 163')).toEqual(['MATH', '163']);
  });

  it('answers empty for input with no tokens, rather than throwing', () => {
    // Not the same as "match nothing": `toMatchQuery` returns null and the title/path predicates run.
    expect(searchTokens('!!! ')).toEqual([]);
    expect(toMatchQuery('!!! ')).toBeNull();
  });
});

describe('highlightTerms', () => {
  it('marks the term and leaves the rest of the excerpt alone', () => {
    const segments = highlightTerms('Apply for financial aid today', 'financial');

    expect(segments).toEqual([
      { text: 'Apply for ', match: false },
      { text: 'financial', match: true },
      { text: ' aid today', match: false },
    ]);
  });

  it('never loses or reorders a character of the excerpt', () => {
    const text = 'Apply for financial aid — the deadline is 1 May, and it matters.';
    expect(rebuilt(text, 'financial aid')).toBe(text);
    expect(rebuilt(text, 'nothing here')).toBe(text);
    expect(rebuilt(text, '')).toBe(text);
  });

  it('marks the original spelling, not the folded one', () => {
    // The fold exists to find the span; what gets marked has to be what the visitor is reading.
    expect(marked('Professor Peña teaches biology', 'pena')).toEqual(['Peña']);
  });

  it('emits no markup, whatever the query contains', () => {
    /**
     * The reflected-XSS guard, stated as a property.
     *
     * A query is `?q=` and therefore hostile input. Because this returns data, the worst a hostile
     * term can do is fail to match — there is no string for a template to trust, and the angle
     * brackets below are simply not tokens.
     */
    const query = '<img src=x onerror=alert(1)>';
    const text = 'A perfectly ordinary excerpt about images.';

    expect(rebuilt(text, query)).toBe(text);
    expect(marked(text, query)).toEqual([]);
    // `img` and `src` are tokens of that query, and neither appears in the text as a whole word.
    expect(highlightTerms(text, query).every((segment) => !segment.text.includes('<'))).toBe(true);
  });

  it('marks whole tokens, so a compound word is not marked in pieces', () => {
    /**
     * `full-time` is two tokens to `unicode61` and `fulltime` is one, and the highlighter has to
     * agree with that rather than with intuition. Marking `full` inside `fulltime` would be a
     * `<mark>` on half a word — and FTS5 did not match it either, so the mark would be claiming
     * this result came from a term that had nothing to do with it.
     */
    expect(marked('the full-time programme', 'full time')).toEqual(['full', 'time']);
    expect(marked('fulltime study', 'full time')).toEqual([]);
    expect(ftsMatches('fulltime study', 'full time')).toBe(false);
  });

  it('returns nothing for empty text, and one plain run when there is no term', () => {
    expect(highlightTerms('', 'anything')).toEqual([]);
    expect(highlightTerms('Some text', '   ')).toEqual([{ text: 'Some text', match: false }]);
  });
});

/**
 * The agreement itself.
 *
 * Each case asserts the same claim twice — that FTS5 matched, and that something was marked — so a
 * change to either side that breaks the pairing fails here rather than shipping a highlight nobody
 * checks against a search nobody re-measures.
 */
describe('highlightTerms agrees with the FTS5 tokenizer', () => {
  const cases: Array<{ text: string; query: string; expected: string[] }> = [
    // Only the final token is a prefix, which is why one word grows and an earlier one does not.
    { text: 'The colleges of the district', query: 'college', expected: ['colleges'] },
    // Marked spans keep the excerpt's own capitals — the fold finds the span, it does not replace it.
    { text: 'Financial aid and scholarships', query: 'financial schol', expected: ['Financial', 'scholarships'] },
    /**
     * `college` is not last here, so it is exact: the standalone word is marked and `colleges` is
     * not. Both words are in the text precisely so the two treatments sit side by side — with only
     * `colleges` present the document would not match at all, which is the next case down.
     */
    { text: 'The colleges and the college offer aid', query: 'college aid', expected: ['college', 'aid'] },
    // Combining marks fold, in both directions.
    { text: 'Meet Professor Peña', query: 'pena', expected: ['Peña'] },
    { text: 'Submit your résumé', query: 'resume', expected: ['résumé'] },
    { text: 'ÅNGSTRÖM lab', query: 'angstrom', expected: ['ÅNGSTRÖM'] },
    { text: 'Course MATH 163 meets Tuesdays', query: '163', expected: ['163'] },
  ];

  for (const { text, query, expected } of cases) {
    it(`${JSON.stringify(query)} in ${JSON.stringify(text)}`, () => {
      expect(ftsMatches(text, query)).toBe(true);
      expect(marked(text, query)).toEqual(expected);
    });
  }

  /**
   * The half that is easy to get wrong in the generous direction.
   *
   * `remove_diacritics` strips combining marks; `ø` and `ß` carry none, so FTS5 leaves them and a
   * highlighter that transliterated would mark a word the search did not find — a `<mark>` on a
   * result that is only there because of some *other* token.
   */
  const declines: Array<{ text: string; query: string }> = [
    { text: 'Sørensen Hall', query: 'sorensen' },
    { text: 'Straße information', query: 'strasse' },
  ];

  for (const { text, query } of declines) {
    it(`declines ${JSON.stringify(query)} for ${JSON.stringify(text)}, as FTS5 does`, () => {
      expect(ftsMatches(text, query)).toBe(false);
      expect(marked(text, query)).toEqual([]);
    });
  }

  it('records that a non-final token is exact, and what that costs', () => {
    /**
     * Pinning a real consequence of `toMatchQuery`'s rule, so that changing the rule has to change
     * a test that says what the change is for.
     *
     * Terms are ANDed and only the last carries `*`, so a page saying *colleges offer aid* is not
     * returned for `college aid`: the exact token `college` is absent, and there is no stemming
     * anywhere in the pipeline. Searching `colleges aid` finds it, and so does `aid college`.
     *
     * This is matching behaviour rather than highlighting behaviour, and the highlighter is never
     * asked about a document search did not return — which is why this asserts on `ftsMatches`
     * alone. It is here because this file is where the tokenizer's contract is written down.
     */
    expect(ftsMatches('The colleges offer aid', 'college aid')).toBe(false);
    expect(ftsMatches('The colleges offer aid', 'colleges aid')).toBe(true);
    expect(ftsMatches('The colleges offer aid', 'aid college')).toBe(true);
  });
});
