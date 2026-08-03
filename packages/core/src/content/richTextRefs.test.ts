import { describe, expect, it } from 'vitest';

import { collectRichTextRefs, resolveRichTextRefs } from './richTextRefs.js';
import { sanitizeHtml } from './sanitizeHtml.js';

/**
 * Internal links in rich text: found on the way in, resolved on the way out.
 *
 * The point of the whole mechanism is that a page can move and the prose pointing at it does not
 * have to be edited — so the test that matters most is the one where the path changes and the stored
 * HTML does not.
 */

const ITEM = '019fbe8e-b9ed-7235-8ed1-353226dddf87';
const OTHER = '019fbe8e-ba0f-7035-9fe6-d141d3bce731';
const FILE = '019fbe8e-b69b-71e4-a9de-8a895e8bd7e2';

const link = (id: string, text = 'Apply') => `<p><a href="taproot:item:${id}">${text}</a></p>`;

describe('finding references', () => {
  it('sees an item link', () => {
    const refs = collectRichTextRefs(link(ITEM));

    expect([...refs.itemIds]).toEqual([ITEM]);
    expect([...refs.mediaIds]).toEqual([]);
  });

  it('sees a media link', () => {
    const refs = collectRichTextRefs(`<p><a href="taproot:media:${FILE}">Prospectus</a></p>`);

    expect([...refs.mediaIds]).toEqual([FILE]);
  });

  it('ignores ordinary links', () => {
    const refs = collectRichTextRefs(
      '<p><a href="/admissions">a</a><a href="https://example.edu">b</a></p>',
    );

    expect([...refs.itemIds, ...refs.mediaIds]).toEqual([]);
  });

  it('does not mistake prose for a reference', () => {
    // The id test elsewhere is anchored precisely so a paragraph is never offered as a lookup key.
    // This walk is parsed rather than matched, so the same has to be true here.
    const refs = collectRichTextRefs(`<p>The id is ${ITEM} and taproot:item: is a scheme.</p>`);

    expect([...refs.itemIds, ...refs.mediaIds]).toEqual([]);
  });
});

describe('resolving them', () => {
  const targets = {
    items: new Map([[ITEM, '/admissions/apply']]),
    media: new Map([[FILE, 'https://cms.example.edu/api/taproot/media/file/prospectus.pdf']]),
  };

  it('rewrites an item link to its current path', () => {
    expect(resolveRichTextRefs(link(ITEM), targets)).toBe(
      '<p><a href="/admissions/apply">Apply</a></p>',
    );
  });

  /** The whole reason the reference is stored instead of the path. */
  it('follows the target when it moves, with the stored value untouched', () => {
    const stored = link(ITEM);

    const before = resolveRichTextRefs(stored, targets);
    const after = resolveRichTextRefs(stored, {
      ...targets,
      items: new Map([[ITEM, '/admissions/how-to-apply']]),
    });

    expect(before).toContain('href="/admissions/apply"');
    expect(after).toContain('href="/admissions/how-to-apply"');
    // Nothing rewrote the content itself — the same string produced both.
    expect(stored).toBe(link(ITEM));
  });

  it('rewrites a media link to the asset URL', () => {
    const out = resolveRichTextRefs(`<p><a href="taproot:media:${FILE}">Prospectus</a></p>`, targets);

    expect(out).toContain('href="https://cms.example.edu/api/taproot/media/file/prospectus.pdf"');
  });

  /**
   * A target that cannot be shown loses its link and keeps its words.
   *
   * Mirrors what a menu does with an entry it cannot resolve. Linking anyway would send a reader to
   * a 404 the page itself claimed was there.
   */
  it('unwraps a link whose target is missing', () => {
    expect(resolveRichTextRefs(link(OTHER, 'Somewhere'), targets)).toBe('<p>Somewhere</p>');
  });

  it('unwraps only the dead link, leaving live ones alone', () => {
    const html = `<p>${link(ITEM, 'Live').slice(3, -4)}${link(OTHER, 'Dead').slice(3, -4)}</p>`;
    const out = resolveRichTextRefs(html, targets);

    expect(out).toBe('<p><a href="/admissions/apply">Live</a>Dead</p>');
  });

  it('keeps other attributes on a link it rewrites', () => {
    const html = `<p><a href="taproot:item:${ITEM}" title="Apply now">x</a></p>`;

    expect(resolveRichTextRefs(html, targets)).toBe(
      '<p><a href="/admissions/apply" title="Apply now">x</a></p>',
    );
  });

  it('leaves ordinary markup exactly as it found it', () => {
    const html = '<p>Plain <strong>bold</strong> and <a href="/x">a link</a>.</p>';

    expect(resolveRichTextRefs(html, targets)).toBe(html);
  });

  it('does nothing to text that merely mentions the scheme', () => {
    const html = '<p>Write taproot:item: in prose and nothing happens.</p>';

    expect(resolveRichTextRefs(html, targets)).toBe(html);
  });
});

describe('what the sanitiser lets through', () => {
  /**
   * The two halves have to agree: a reference the sanitiser would drop must never be one the
   * resolver is asked to look up, or an author would see a link vanish with no explanation.
   */
  it('keeps a well-formed reference and drops a malformed one', () => {
    expect(sanitizeHtml(link(ITEM))).toContain(`href="taproot:item:${ITEM}"`);
    expect(sanitizeHtml('<p><a href="taproot:item:nope">x</a></p>')).toBe('<p><a>x</a></p>');
    expect(sanitizeHtml('<p><a href="taproot:arbitrary">x</a></p>')).toBe('<p><a>x</a></p>');
  });

  it('still refuses an image', () => {
    // Reconsidered and refused: a picture in prose is a block's job, because `set:html` cannot
    // produce a `TaprootImage` and it would be the one image on the site ignoring its focal point.
    expect(sanitizeHtml(`<p>a<img data-taproot-media="${FILE}">b</p>`)).toBe('<p>ab</p>');
  });

  it('survives a round trip through the sanitiser', () => {
    // What is stored is what the sanitiser emitted, so that is what the resolver actually sees.
    const stored = sanitizeHtml(link(ITEM));
    const out = resolveRichTextRefs(stored, {
      items: new Map([[ITEM, '/admissions/apply']]),
      media: new Map(),
    });

    expect(out).toBe('<p><a href="/admissions/apply">Apply</a></p>');
  });
});
