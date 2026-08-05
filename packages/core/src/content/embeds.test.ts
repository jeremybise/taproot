import { describe, expect, it } from 'vitest';

import { MAX_EMBED_HEIGHT, embedHostAllowed, parseEmbedHeight } from './embeds.js';

/**
 * The two functions an embed's safety rests on.
 *
 * `embedHostAllowed` is the boundary between "an editor pastes an address" and "a page frames an
 * arbitrary origin", so the cases below are mostly about the ways a near-miss could sneak past it.
 * `parseEmbedHeight` reads input from another origin, and its failure mode has to be inert.
 */

describe('embedHostAllowed', () => {
  it('matches a host exactly', () => {
    expect(embedHostAllowed('youtube.com', ['youtube.com'])).toBe(true);
  });

  it('covers everything under an approved domain', () => {
    // What an admin typing a domain into a box means. Without it, every list needs `www.` spelled
    // out beside it and somebody eventually forgets.
    expect(embedHostAllowed('www.youtube.com', ['youtube.com'])).toBe(true);
    expect(embedHostAllowed('a.b.youtube.com', ['youtube.com'])).toBe(true);
  });

  it('refuses a host that merely ends with the approved one', () => {
    /**
     * The whole attack this list exists to stop, and the one-character bug that would allow it:
     * `endsWith(allowed)` instead of `endsWith('.' + allowed)`. Anyone can register these.
     */
    expect(embedHostAllowed('evil-youtube.com', ['youtube.com'])).toBe(false);
    expect(embedHostAllowed('notyoutube.com', ['youtube.com'])).toBe(false);
  });

  it('refuses an approved domain used as a prefix of another', () => {
    // `youtube.com.evil.com` is a host `evil.com` controls, and reads as approved at a glance.
    expect(embedHostAllowed('youtube.com.evil.com', ['youtube.com'])).toBe(false);
  });

  it('is not fooled by a trailing dot', () => {
    // A fully-qualified name resolves to the same server, so treating it as a different host would
    // let one character walk straight past the list.
    expect(embedHostAllowed('youtube.com.', ['youtube.com'])).toBe(true);
    expect(embedHostAllowed('www.youtube.com.', ['youtube.com'])).toBe(true);
  });

  it('ignores case on both sides', () => {
    expect(embedHostAllowed('WWW.YouTube.COM', ['youtube.com'])).toBe(true);
    expect(embedHostAllowed('www.youtube.com', ['YouTube.com'])).toBe(true);
  });

  it('accepts a wildcard spelling of what it already does', () => {
    expect(embedHostAllowed('www.youtube.com', ['*.youtube.com'])).toBe(true);
    expect(embedHostAllowed('youtube.com', ['*.youtube.com'])).toBe(true);
  });

  it('admits nothing when the list is empty', () => {
    /**
     * The inversion of `media.accept` and `link.allowedKinds`, where empty means anything. Here the
     * tempting fallthrough is the dangerous one — an unconfigured field would frame any origin on
     * the internet.
     */
    expect(embedHostAllowed('youtube.com', [])).toBe(false);
  });

  it('ignores blank entries rather than matching everything on them', () => {
    // `''.endsWith('.')` reasoning goes wrong quickly; a stray blank line in the config textarea
    // must not become a wildcard.
    expect(embedHostAllowed('anything.example', ['', '  '])).toBe(false);
  });

  it('refuses an empty host', () => {
    expect(embedHostAllowed('', ['youtube.com'])).toBe(false);
  });
});

describe('parseEmbedHeight', () => {
  it('reads the shapes vendors actually post', () => {
    expect(parseEmbedHeight(640)).toBe(640);
    expect(parseEmbedHeight('640')).toBe(640);
    expect(parseEmbedHeight({ height: 640 })).toBe(640);
    expect(parseEmbedHeight({ height: '640' })).toBe(640);
    expect(parseEmbedHeight({ type: 'resize', height: 640 })).toBe(640);
    expect(parseEmbedHeight('{"height":640}')).toBe(640);
  });

  it('reads iframe-resizer’s positional string', () => {
    expect(parseEmbedHeight('[iFrameSizer]iFrameResizer0:640:0:init')).toBe(640);
  });

  it('rounds a fractional height', () => {
    expect(parseEmbedHeight(640.4)).toBe(640);
  });

  it('clamps above the ceiling', () => {
    // A height is input from another origin. Nothing about it may reach a style attribute unbounded.
    expect(parseEmbedHeight(9_999_999)).toBe(MAX_EMBED_HEIGHT);
  });

  it('returns null for anything it cannot read', () => {
    /**
     * Null is what leaves the frame alone, and every one of these arrives on an ordinary page: an
     * analytics script, a chat widget, a payment provider. Guessing a number for any of them would
     * collapse a working embed.
     */
    for (const payload of [
      undefined,
      null,
      '',
      'hello',
      {},
      { height: 'tall' },
      { height: null },
      [],
      '{not json',
      '[iFrameSizer]',
      0,
      -100,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(parseEmbedHeight(payload), `expected null for ${JSON.stringify(payload)}`).toBeNull();
    }
  });
});
