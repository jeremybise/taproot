/**
 * The embed vocabulary both sides of the wire spell.
 *
 * Its own importless module for the reason `cacheTags.ts` and `queryKeys.ts` are: the validation
 * beside it needs Zod, and `pure.ts` re-exports this so `<TaprootEmbed>` can clamp a height and read
 * a sizing mode without a consumer's bundle growing a schema library it cannot use.
 *
 * Nothing here imports anything, which is the property that makes it safe to publish.
 */

/** One embed's stored value. An address and the frame's accessible name — never markup. */
export interface EmbedValue {
  url: string;
  title: string;
}

/**
 * How an embed's frame gets its height.
 *
 * Three modes rather than one aspect ratio, because a ratio describes exactly one of the three
 * things people embed. A video is 16:9 forever and a map is whatever box you give it; a **form** is
 * 400px until somebody trips validation and then it is 900px, and no ratio says that.
 */
export const EMBED_SIZING_MODES = ['ratio', 'fixed', 'auto'] as const;
export type EmbedSizingMode = (typeof EMBED_SIZING_MODES)[number];

export type EmbedSizing =
  /** An `aspect-ratio` box. The default, and the only mode needing no JavaScript at all. */
  | { mode: 'ratio'; ratio: number }
  /** A stated pixel height. Covers more forms than it looks like it would. */
  | { mode: 'fixed'; height: number }
  /**
   * The frame reports its own height by `postMessage`; `minHeight` is what it stands at until one
   * arrives, and what it keeps if none ever does. Not zero — an invisible form is the failure
   * everybody ships.
   */
  | { mode: 'auto'; minHeight: number };

/** 16:9. Every video platform's default, and why `ratio` is the default mode. */
export const DEFAULT_EMBED_RATIO = 16 / 9;

/**
 * A ceiling on any height, stated or reported, in CSS pixels.
 *
 * Not a design opinion — a bound on what the system will carry, in the sense `requireComplete`
 * leaves alone. It stops a typo producing a frame taller than any device, and gives the message
 * handler a number to clamp against: a height arrives from another origin, so it is input.
 */
export const MAX_EMBED_HEIGHT = 5000;

/**
 * Whether a host is covered by a field's allowlist.
 *
 * An entry covers itself and everything under it, so `youtube.com` admits `www.youtube.com` — which
 * is what an admin typing a domain into a box means, and it avoids teaching a wildcard syntax for
 * the only case anybody needs. Three details are load-bearing:
 *
 * - The suffix test is `.${allowed}` **with the dot**. `endsWith(allowed)` would admit
 *   `evil-youtube.com`, which is the entire attack this list exists to stop.
 * - A trailing dot is stripped. `youtube.com.` is the same host to a browser and would otherwise
 *   match no entry, so an allowlist could be walked past by typing one character.
 * - A leading `*.` is stripped rather than rejected, because an admin who writes `*.youtube.com`
 *   out of habit has said exactly what this already does and should not be answered with nothing.
 */
export function embedHostAllowed(host: string, allowedHosts: readonly string[]): boolean {
  const candidate = host.trim().toLowerCase().replace(/\.$/, '');
  if (candidate === '') return false;

  return allowedHosts.some((entry) => {
    const allowed = entry.trim().toLowerCase().replace(/^\*\./, '').replace(/\.$/, '');
    if (allowed === '') return false;
    return candidate === allowed || candidate.endsWith(`.${allowed}`);
  });
}

/**
 * Read a height out of a `postMessage` payload, for `sizing.mode === 'auto'`.
 *
 * **There is no standard here, and this function is a convenience rather than a contract.**
 * iframe-resizer posts a colon-delimited string, several vendors post `{ height }`, some post a bare
 * number, and whoever built a given form posted whatever they felt like. Taproot cannot know which,
 * so `<TaprootEmbed>` takes a `parseHeight` prop and this is only what it falls back to — the same
 * split as `resolveMenu`'s `termHref` callback, and for the same reason: the CMS supplies what it
 * can know and the site supplies what only it knows.
 *
 * Returns `null` for anything it cannot read, and **null must leave the frame at its current
 * height**. Guessing zero would collapse a working embed the first time a page posted an unrelated
 * message, and pages post unrelated messages constantly.
 */
export function parseEmbedHeight(payload: unknown): number | null {
  if (typeof payload === 'number') return finiteHeight(payload);

  if (typeof payload === 'string') {
    /**
     * iframe-resizer: `[iFrameSizer]iFrameResizer0:1234:0:init`. Matched by prefix and read
     * positionally, because the id in the second segment is the library's own and carries no
     * information this needs.
     */
    if (payload.startsWith('[iFrameSizer]')) {
      const parts = payload.split(':');
      return parts.length > 1 ? finiteHeight(Number(parts[1])) : null;
    }

    /**
     * A JSON string, which is what a vendor posting through a `postMessage` wrapper usually sends.
     * Parsed rather than matched with a regex, and a failure is `null` rather than a throw — this
     * runs on every message the page receives, including every one meant for somebody else.
     */
    if (payload.startsWith('{')) {
      try {
        return parseEmbedHeight(JSON.parse(payload));
      } catch {
        return null;
      }
    }

    return finiteHeight(Number(payload));
  }

  if (typeof payload === 'object' && payload !== null) {
    const { height } = payload as { height?: unknown };
    if (typeof height === 'number') return finiteHeight(height);
    if (typeof height === 'string') return finiteHeight(Number(height));
  }

  return null;
}

/**
 * A reported height is input from another origin, so it is bounded on both ends before it reaches a
 * style attribute. `Number('')` is 0 and `Number('abc')` is NaN, which is why this rejects rather
 * than clamps at the bottom: a zero-height frame and an unreadable message are the same mistake.
 */
function finiteHeight(value: number): number | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.min(Math.round(value), MAX_EMBED_HEIGHT);
}
