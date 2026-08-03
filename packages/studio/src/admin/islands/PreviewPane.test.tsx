// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import PreviewPane from './PreviewPane.js';

/**
 * Hydrated-behaviour tests for the live preview pane.
 *
 * `scripts/a11y-audit.mjs` runs jsdom with `runScripts: 'outside-only'`, so it never hydrates an
 * island — it can see the toggle in the server-rendered HTML and nothing inside the pane, whatever
 * state the cookie is in. Everything below is therefore the only check on this component's
 * accessibility and its keyboard contract.
 *
 * Two things it cannot cover, both needing a real browser: whether the iframe actually frames
 * anything (jsdom fetches no subresources, so `onLoad` never fires — which is why the controls are
 * built to render without waiting on it, asserted below), and screen-reader output.
 */

const PROPS = {
  itemId: 'item-1',
  title: 'Admissions',
  slug: 'admissions',
  data: { body: 'Draft copy' },
  seo: {},
  itemPath: '/admissions',
  siteConfigured: true,
  open: true,
};

function mockMint() {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      return new Response(
        JSON.stringify({
          token: 'tok',
          siteUrl: 'http://localhost:4323',
          itemPath: '/admissions',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

beforeEach(() => {
  vi.stubGlobal('fetch', mockMint());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function renderOpen(overrides: Partial<typeof PROPS> = {}) {
  const view = render(<PreviewPane {...PROPS} {...overrides} />);
  // The mint resolves before the frame can exist; every assertion below depends on it.
  if ((overrides.open ?? PROPS.open) && (overrides.siteConfigured ?? PROPS.siteConfigured)) {
    await screen.findByTitle('Live preview of this content item');
  }
  return view;
}

describe('accessibility', () => {
  it('has no axe violations', async () => {
    const { container } = await renderOpen();

    /**
     * Scoped to the render container rather than `document`: this is not a portalled dialog, so the
     * container holds the whole component, and auditing the body in isolation reports a `region`
     * violation that is an artifact of there being no page around it.
     */
    const results = await axe.run(container, {
      resultTypes: ['violations'],
      /*
       * Not into the frame. axe traverses iframes by default, and the previewed page is a real
       * cross-origin document it could never reach anyway — under jsdom the attempt throws outright.
       * What is being audited here is the CMS's own chrome around the frame; the site's own
       * accessibility is the site's, and `npm run a11y` is the wrong tool for it either way.
       */
      iframes: false,
      // jsdom computes no layout and resolves no custom properties; contrast is checked
      // numerically in a11y-contrast.mjs instead.
      rules: { 'color-contrast': { enabled: false } },
    });

    expect(results.violations.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([]);
  });

  it('has no axe violations while closed', async () => {
    const { container } = await renderOpen({ open: false });

    const results = await axe.run(container, {
      resultTypes: ['violations'],
      iframes: false,
      rules: { 'color-contrast': { enabled: false } },
    });

    expect(results.violations.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([]);
  });

  it('keeps the id its external toggle points at, open or closed', async () => {
    /**
     * The control lives in the page header — server-rendered Astro, outside this island — and aims
     * `aria-controls="editor-preview-pane"` here. A fixed id rather than `useId`, because an Astro
     * component cannot know a generated one, and rendered in both states because a dangling
     * `aria-controls` is an axe violation and a broken promise to a screen reader.
     */
    const { container, rerender } = await renderOpen({ open: false });
    expect(container.querySelector('#editor-preview-pane')).not.toBeNull();

    rerender(<PreviewPane {...PROPS} open />);
    await screen.findByTitle('Live preview of this content item');
    expect(container.querySelector('#editor-preview-pane')).not.toBeNull();
  });

  it('names the frame stably, rather than from the live title', async () => {
    // An accessible name changing on every keystroke is announced churn carrying no information a
    // screen-reader user cannot get by entering the frame.
    const { rerender } = await renderOpen();
    expect(screen.getByTitle('Live preview of this content item')).toBeTruthy();

    rerender(<PreviewPane {...PROPS} title="Something else entirely" />);
    expect(screen.getByTitle('Live preview of this content item')).toBeTruthy();
  });

  it('renders its controls without waiting for the frame to load', async () => {
    // jsdom never fires `onLoad` for the iframe, which is the same position a browser is in while a
    // slow site is still connecting. A toolbar that appeared only after load would be unusable
    // exactly when somebody wants the Refresh button.
    await renderOpen();

    expect(screen.getByLabelText('Preview address')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Phone' })).toBeTruthy();
  });
});

describe('the frame', () => {
  it('cannot navigate the admin away', async () => {
    await renderOpen();
    const sandbox = screen.getByTitle('Live preview of this content item').getAttribute('sandbox')!;

    /**
     * The previewed page is the site's own markup, so a stray `target="_top"` link would otherwise
     * throw an editor out of a form full of unsaved work.
     */
    expect(sandbox).not.toContain('allow-top-navigation');
    expect(sandbox).toContain('allow-scripts');
    expect(sandbox).toContain('allow-same-origin');
  });

  it('carries the token to the item’s own address', async () => {
    await renderOpen();
    const src = screen.getByTitle('Live preview of this content item').getAttribute('src')!;

    expect(src).toContain('http://localhost:4323/admissions');
    expect(src).toContain('taproot_preview=tok');
  });
});

describe('the width presets', () => {
  it('are keyboard-operable buttons with exactly one pressed', async () => {
    // Preset buttons rather than a drag splitter, so keyboard operation is free rather than
    // hand-built. A drag handle added later would need the full separator contract alongside these.
    const user = userEvent.setup();
    await renderOpen();

    const phone = screen.getByRole('button', { name: 'Phone' });
    expect(screen.getByRole('button', { name: 'Full' }).getAttribute('aria-pressed')).toBe('true');

    await user.click(phone);

    expect(phone.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Full' }).getAttribute('aria-pressed')).toBe('false');
  });
});

describe('sending the snapshot', () => {
  it('coalesces a burst of edits into one request', async () => {
    vi.useFakeTimers();
    const calls = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return new Response(
          JSON.stringify({ token: 'tok', siteUrl: 'http://localhost:4323' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', calls);

    const { rerender } = render(<PreviewPane {...PROPS} />);
    await vi.waitFor(() => expect(calls.mock.calls.some(([, i]) => i?.method === 'POST')).toBe(true));

    for (const body of ['a', 'ab', 'abc', 'abcd', 'abcde']) {
      rerender(<PreviewPane {...PROPS} data={{ body }} />);
      await vi.advanceTimersByTimeAsync(100);
    }
    await vi.advanceTimersByTimeAsync(1000);

    // Debounced because it is a network call. The repo's rule is to debounce the network and never
    // the pure recomputation, which is why AccessibilityPanel next door has no timer at all.
    const puts = calls.mock.calls.filter(([, init]) => init?.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(JSON.parse(puts[0]![1]!.body as string).data).toEqual({ body: 'abcde' });
  });

  it('renews the token when the server says it is gone', async () => {
    let mints = 0;
    let puts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          mints += 1;
          return new Response(
            JSON.stringify({ token: `tok-${mints}`, siteUrl: 'http://localhost:4323' }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        puts += 1;
        // A laptop that slept, or a token the sweep collected.
        return new Response(JSON.stringify({ error: 'gone' }), { status: 404 });
      }),
    );

    const { rerender } = render(<PreviewPane {...PROPS} />);
    await screen.findByTitle('Live preview of this content item');

    rerender(<PreviewPane {...PROPS} data={{ body: 'changed' }} />);

    await waitFor(() => expect(puts).toBeGreaterThan(0));
    // Re-minted rather than surfaced as an error: the editor did nothing wrong and there is
    // nothing for them to do about it.
    await waitFor(() => expect(mints).toBe(2));
    await waitFor(() =>
      expect(screen.getByTitle('Live preview of this content item').getAttribute('src')).toContain(
        'taproot_preview=tok-2',
      ),
    );
  });

  it('says it is showing the last valid draft, without claiming a save failed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          return new Response(
            JSON.stringify({ token: 'tok', siteUrl: 'http://localhost:4323' }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        // 200, not 4xx: the previous snapshot still renders, so nothing has failed.
        return new Response(JSON.stringify({ stale: true, fields: { code: ['Too long.'] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );

    const { rerender } = render(<PreviewPane {...PROPS} />);
    await screen.findByTitle('Live preview of this content item');
    rerender(<PreviewPane {...PROPS} data={{ body: 'changed' }} />);

    expect(await screen.findByText(/last valid draft/i)).toBeTruthy();
  });
});

describe('the unreachable-site warning', () => {
  /**
   * This has been wrong in both directions, which is why it is tested rather than eyeballed.
   *
   * First it was an eight-second timer that never learned the frame had loaded, so it accused a
   * healthy site every time. Wiring it to the iframe's `onLoad` then killed it entirely, because
   * Chrome fires `load` for a connection-refused error page too — "loaded" was always true and a
   * genuinely dead site said nothing. A `no-cors` request is the signal neither had: opaque, so
   * nothing about it is readable, which is fine when the only question is whether anything answered.
   */
  function fetchWithProbe(probeFails: boolean) {
    return vi.fn(async (url: string, init?: RequestInit) => {
      // The liveness probe: not our API, and deliberately opaque.
      if (!String(url).startsWith('/api/taproot/preview')) {
        // A refused connection rejects; anything that answered resolves. That distinction is the
        // whole signal.
        if (probeFails) throw new TypeError('Failed to fetch');
        /*
          A real opaque response reports `status: 0`, but `new Response` refuses to construct one —
          the constructor only accepts 200–599, and passing 0 throws a RangeError that lands in the
          probe's own `.catch`, reporting a healthy site as unreachable. The component never reads
          the response, so any resolved value stands in for an opaque one.
        */
        return new Response(null, { status: 200 });
      }
      if (init?.method === 'POST') {
        return new Response(
          JSON.stringify({ token: 'tok', siteUrl: 'http://localhost:4323' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
  }

  /**
   * Queried inside each render's own container rather than through `screen`.
   *
   * `screen` searches the whole document, so an assertion that something is *absent* passes or fails
   * on whatever a previous test left behind — which is exactly the shape of bug this block exists to
   * catch, and it would have been caught by the wrong evidence.
   */
  const warning = (container: HTMLElement) =>
    [...container.querySelectorAll('p')].find((p) => /Could not reach/i.test(p.textContent ?? ''));

  it('says so when the site does not answer', async () => {
    vi.stubGlobal('fetch', fetchWithProbe(true));
    const { container } = render(<PreviewPane {...PROPS} />);

    await waitFor(() => expect(warning(container)).toBeTruthy());
  });

  it('stays quiet when the site answers', async () => {
    // The regression that matters most: a warning nobody can act on, on every healthy preview.
    vi.stubGlobal('fetch', fetchWithProbe(false));
    const { container } = render(<PreviewPane {...PROPS} />);
    await within(container).findByTitle('Live preview of this content item');

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(warning(container)).toBeUndefined();
  });

  it('says nothing at all while the pane is closed', async () => {
    vi.stubGlobal('fetch', fetchWithProbe(true));
    const { container } = render(<PreviewPane {...PROPS} open={false} />);

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(warning(container)).toBeUndefined();
  });
});

describe('when there is nowhere to preview', () => {
  it('explains the missing site URL rather than framing nothing', async () => {
    render(<PreviewPane {...PROPS} siteConfigured={false} />);

    expect(screen.getByText(/TAPROOT_SITE_URL/)).toBeTruthy();
    expect(screen.queryByTitle('Live preview of this content item')).toBeNull();
  });

  it('mints nothing until the pane is opened', async () => {
    const calls = mockMint();
    vi.stubGlobal('fetch', calls);

    render(<PreviewPane {...PROPS} open={false} />);

    // No token is created for a pane nobody asked to see, and none is ever in the HTML the admin
    // serves — it is minted after hydration or not at all.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).not.toHaveBeenCalled();
  });
});
