import { describe, expect, it } from 'vitest';

import { SEO_GUIDANCE, canonicalUrl, resolveSeo, truncateForPreview } from './seo.js';

const item = (title: string, seo: Record<string, unknown> = {}) => ({ title, seo });

describe('resolveSeo', () => {
  it('falls back to the item title when no meta title is set', () => {
    expect(resolveSeo(item('Financial Aid')).title).toBe('Financial Aid');
  });

  it('prefers an explicit meta title', () => {
    expect(resolveSeo(item('Financial Aid', { metaTitle: 'Aid & Scholarships' })).title).toBe(
      'Aid & Scholarships',
    );
  });

  it('treats a whitespace-only override as unset', () => {
    // Stored as written, so "  " reaches here and would otherwise blank out the real title.
    expect(resolveSeo(item('Financial Aid', { metaTitle: '   ' })).title).toBe('Financial Aid');
  });

  it('does not invent a description', () => {
    // Deliberately no excerpt fallback: a truncated first sentence reads like a machine wrote it,
    // and search engines pick a better snippet than a truncation would.
    expect(resolveSeo(item('About')).description).toBeNull();
  });

  it('inherits the content type OG image when the item has none', () => {
    const resolved = resolveSeo(item('Spring Open House'), { default_og_image_id: 'media-type' });

    expect(resolved.ogImageId).toBe('media-type');
    expect(resolved.ogImageSource).toBe('contentType');
  });

  it("prefers the item's own OG image over the type default", () => {
    const resolved = resolveSeo(item('Spring Open House', { ogImageId: 'media-item' }), {
      default_og_image_id: 'media-type',
    });

    expect(resolved.ogImageId).toBe('media-item');
    expect(resolved.ogImageSource).toBe('item');
  });

  it('reports no image rather than an empty string when neither is set', () => {
    const resolved = resolveSeo(item('About'), { default_og_image_id: null });

    expect(resolved.ogImageId).toBeNull();
    expect(resolved.ogImageSource).toBe('none');
  });

  it('tells the caller where an inherited image came from', () => {
    // The editor needs this to say "inherited from the content type" rather than showing a value
    // in a field the editor never filled in.
    expect(resolveSeo(item('X'), { default_og_image_id: 'm' }).ogImageSource).toBe('contentType');
    expect(resolveSeo(item('X', { ogImageId: 'm' })).ogImageSource).toBe('item');
  });

  it('only treats noIndex as true when it is exactly true', () => {
    expect(resolveSeo(item('X')).noIndex).toBe(false);
    expect(resolveSeo(item('X', { noIndex: false })).noIndex).toBe(false);
    expect(resolveSeo(item('X', { noIndex: true })).noIndex).toBe(true);
  });

  it('works with no content type at all', () => {
    // A singleton editor or a preview may not have one to hand.
    expect(resolveSeo(item('X')).ogImageId).toBeNull();
    expect(resolveSeo(item('X'), null).ogImageId).toBeNull();
  });
});

describe('truncateForPreview', () => {
  it('leaves text within the limit untouched', () => {
    expect(truncateForPreview('Short title', 60)).toBe('Short title');
  });

  it('breaks at a word boundary rather than mid-word', () => {
    const result = truncateForPreview('Financial aid and scholarships at Riverbend College', 30);

    expect(result.endsWith('…')).toBe(true);
    expect(result).toBe('Financial aid and scholarships…');
  });

  it('cuts a single over-long word rather than returning the whole thing', () => {
    // No space to break at, and returning it whole would overflow the preview it exists to bound.
    const result = truncateForPreview('a'.repeat(80), 20);

    expect(result).toHaveLength(21);
    expect(result.endsWith('…')).toBe(true);
  });

  it('does not leave a trailing space before the ellipsis', () => {
    expect(truncateForPreview('one two three four five six', 12)).toBe('one two…');
  });

  it('handles the guidance lengths it is actually called with', () => {
    const long = 'word '.repeat(60).trim();

    expect(truncateForPreview(long, SEO_GUIDANCE.titleChars).length).toBeLessThanOrEqual(
      SEO_GUIDANCE.titleChars + 1,
    );
    expect(
      truncateForPreview(long, SEO_GUIDANCE.descriptionChars).length,
    ).toBeLessThanOrEqual(SEO_GUIDANCE.descriptionChars + 1);
  });
});

describe('canonicalUrl', () => {
  it('joins an origin and a path', () => {
    expect(canonicalUrl('https://example.edu', '/admissions/apply')).toBe(
      'https://example.edu/admissions/apply',
    );
  });

  it('does not double the slash when the origin has a trailing one', () => {
    expect(canonicalUrl('https://example.edu/', '/about')).toBe('https://example.edu/about');
  });

  it('keeps the root path', () => {
    expect(canonicalUrl('https://example.edu', '/')).toBe('https://example.edu/');
  });
});
