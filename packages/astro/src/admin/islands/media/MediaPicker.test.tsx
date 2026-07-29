// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MediaOption } from '../../mediaOptions.js';
import { MediaField } from './MediaField.js';
import { MediaPicker } from './MediaPicker.js';

/**
 * Hydrated-behaviour tests for the media picker.
 *
 * `scripts/a11y-audit.mjs` cannot see any of this: the dialog only exists after hydration and
 * only once opened, so the server-rendered HTML the audit fetches contains a button and nothing
 * else. The grid is a hand-built listbox — a custom widget implementing an ARIA pattern by hand,
 * which is exactly where WCAG failures creep in — so without these tests it would be unverified.
 *
 * Still needing a human with a real browser: screen-reader output, and the two-dimensional arrow
 * navigation, which depends on layout jsdom does not compute. That degradation is deliberate and
 * covered below.
 */

const ASSETS: MediaOption[] = [
  img('a', 'quad-autumn.jpg', 'Students crossing the quad'),
  img('b', 'library-reading-room.jpg', null),
  img('c', 'convocation-2026.jpg', 'The convocation procession'),
  {
    id: 'd',
    filename: 'course-catalogue.pdf',
    url: '/media/course-catalogue.pdf',
    altText: null,
    mimeType: 'application/pdf',
    width: null,
    height: null,
  },
];

function img(id: string, filename: string, altText: string | null): MediaOption {
  return {
    id,
    filename,
    url: `/media/${filename}`,
    altText,
    mimeType: 'image/jpeg',
    width: 1600,
    height: 900,
  };
}

function renderPicker(props: Partial<Parameters<typeof MediaPicker>[0]> = {}) {
  const onConfirm = vi.fn();
  const onOpenChange = vi.fn();
  const result = render(
    <MediaPicker
      open
      onOpenChange={onOpenChange}
      library={ASSETS}
      selected={[]}
      onConfirm={onConfirm}
      {...props}
    />,
  );
  return { onConfirm, onOpenChange, ...result };
}

const options = () => screen.getAllByRole('option');

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the grid follows the ARIA listbox pattern', () => {
  it('is a single tab stop rather than one per asset', () => {
    // The reason it is a listbox and not a grid of checkboxes: a library of forty images would
    // otherwise cost forty Tab presses to walk past.
    renderPicker();

    const cards = options();
    expect(cards).toHaveLength(4);
    expect(cards.filter((card) => card.getAttribute('tabindex') === '0')).toHaveLength(1);
    expect(cards[0]!.getAttribute('tabindex')).toBe('0');
  });

  it('moves focus with the arrow keys and Home/End', async () => {
    const user = userEvent.setup();
    renderPicker();

    options()[0]!.focus();

    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(options()[1]);

    await user.keyboard('{ArrowRight}{ArrowLeft}');
    expect(document.activeElement).toBe(options()[1]);

    await user.keyboard('{End}');
    expect(document.activeElement).toBe(options()[3]);

    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(options()[0]);
  });

  it('clamps at both ends rather than wrapping', async () => {
    const user = userEvent.setup();
    renderPicker();

    options()[0]!.focus();
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(options()[0]);

    await user.keyboard('{End}{ArrowRight}');
    expect(document.activeElement).toBe(options()[3]);
  });

  it('walks linearly when the row width cannot be measured', async () => {
    /**
     * jsdom reports every offsetTop as 0, so the column count degrades to 1 and ArrowDown moves
     * by one card. The point of asserting it is that the degradation is *reachability preserved*:
     * a key that cannot be measured must still move, not do nothing.
     */
    const user = userEvent.setup();
    renderPicker();

    options()[0]!.focus();
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(options()[1]);

    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(options()[0]);
  });

  it('marks selection with aria-selected, not colour alone', async () => {
    const user = userEvent.setup();
    renderPicker();

    expect(options()[0]!.getAttribute('aria-selected')).toBe('false');
    // The tick is what carries selection for anyone who cannot see the ring's colour, so it has
    // to appear with the selection rather than merely accompany it.
    expect(options()[0]!.querySelector('svg')).toBeNull();

    await user.click(options()[0]!);
    expect(options()[0]!.getAttribute('aria-selected')).toBe('true');
    expect(options()[0]!.querySelector('svg')).not.toBeNull();
  });

  it('names each option by its filename', () => {
    renderPicker();
    // The thumbnail is alt="" on purpose: naming the option twice is worse than not at all.
    expect(screen.getByRole('option', { name: /quad-autumn\.jpg/ })).toBeDefined();
  });
});

describe('choosing', () => {
  it('confirms one asset and closes', async () => {
    const user = userEvent.setup();
    const { onConfirm, onOpenChange } = renderPicker();

    await user.click(screen.getByRole('option', { name: /convocation/ }));
    await user.click(screen.getByRole('button', { name: 'Choose' }));

    expect(onConfirm).toHaveBeenCalledWith([expect.objectContaining({ id: 'c' })]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('replaces rather than accumulates when only one is allowed', async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderPicker();

    await user.click(options()[0]!);
    await user.click(options()[1]!);
    await user.click(screen.getByRole('button', { name: 'Choose' }));

    expect(onConfirm).toHaveBeenCalledWith([expect.objectContaining({ id: 'b' })]);
  });

  it('keeps the order they were selected in', async () => {
    // Order is the whole reason a gallery field stores an array rather than a set: it is the
    // order the images render in on the page.
    const user = userEvent.setup();
    const { onConfirm } = renderPicker({ multiple: true });

    await user.click(screen.getByRole('option', { name: /convocation/ }));
    await user.click(screen.getByRole('option', { name: /quad-autumn/ }));
    await user.click(screen.getByRole('button', { name: 'Choose 2' }));

    expect(onConfirm.mock.calls[0]![0].map((asset: MediaOption) => asset.id)).toEqual(['c', 'a']);
  });

  it('shows the selection order on each card', async () => {
    const user = userEvent.setup();
    renderPicker({ multiple: true });

    await user.click(options()[2]!);
    await user.click(options()[0]!);

    expect(within(options()[2]!).getByText('1')).toBeDefined();
    expect(within(options()[0]!).getByText('2')).toBeDefined();
  });

  it('finishes on Enter when only one asset is wanted', async () => {
    const user = userEvent.setup();
    const { onConfirm, onOpenChange } = renderPicker();

    options()[1]!.focus();
    await user.keyboard('{Enter}');

    expect(onConfirm).toHaveBeenCalledWith([expect.objectContaining({ id: 'b' })]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('toggles on Enter when several are wanted, since one press cannot be the end of it', async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderPicker({ multiple: true });

    options()[1]!.focus();
    await user.keyboard('{Enter}');

    expect(onConfirm).not.toHaveBeenCalled();
    expect(options()[1]!.getAttribute('aria-selected')).toBe('true');
  });

  it('toggles on Space in either mode', async () => {
    const user = userEvent.setup();
    renderPicker();

    options()[0]!.focus();
    await user.keyboard(' ');
    expect(options()[0]!.getAttribute('aria-selected')).toBe('true');

    await user.keyboard(' ');
    expect(options()[0]!.getAttribute('aria-selected')).toBe('false');
  });

  it('opens showing what is already stored', () => {
    renderPicker({ selected: ['b'] });
    expect(screen.getByRole('option', { name: /library-reading-room/ }).getAttribute('aria-selected')).toBe('true');
  });
});

describe('the accept list', () => {
  it('hides what the field cannot store', () => {
    // The field builder offers "Images"/"Documents" per field. Before the picker, every call site
    // was handed an images-only list regardless, so a document field could not reach a PDF at all.
    renderPicker({ accept: ['image/'] });

    expect(options()).toHaveLength(3);
    expect(screen.queryByRole('option', { name: /course-catalogue\.pdf/ })).toBeNull();
  });

  it('accepts everything when the list is empty', () => {
    renderPicker({ accept: [] });
    expect(options()).toHaveLength(4);
  });

  it('lets a document field reach a document', () => {
    renderPicker({ accept: ['application/'] });
    expect(options()).toHaveLength(1);
    expect(screen.getByRole('option', { name: /course-catalogue\.pdf/ })).toBeDefined();
  });
});

describe('search', () => {
  it('queries the server and reports the count in a live region', async () => {
    const user = userEvent.setup();
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          media: [{ id: 'z', filename: 'quad-spring.jpg', url: '/media/quad-spring.jpg', alt_text: 'The quad in spring', mime_type: 'image/jpeg', width: 1600, height: 900 }],
          total: 1,
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    );

    renderPicker();
    await user.type(screen.getByLabelText('Search the library'), 'quad');

    await waitFor(() => expect(screen.getByRole('option', { name: /quad-spring/ })).toBeDefined());
    expect(screen.getByRole('status').textContent).toContain('1 asset matches');

    // Searching past the loaded page is the point of the picker; the accept list travels with it
    // so results cannot include something the grid would then hide.
    const url = vi.mocked(fetch).mock.calls.at(-1)![0] as string;
    expect(url).toContain('q=quad');
  });

  it('passes the accept list to the server so results match the grid', async () => {
    const user = userEvent.setup();
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ media: [], total: 0 }), {
        headers: { 'content-type': 'application/json' },
      }),
    );

    renderPicker({ accept: ['image/'] });
    await user.type(screen.getByLabelText('Search the library'), 'quad');

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(vi.mocked(fetch).mock.calls.at(-1)![0]).toContain('accept=image%2F');
  });

  it('does not drop a selection the search results no longer contain', async () => {
    /**
     * The failure this guards against: select an image, search for a second one, and the first is
     * silently missing from what gets saved — the footer still counts it, so the only evidence is
     * the page afterwards. Selection has to be resolved against every asset seen, not the page
     * currently on screen.
     */
    const user = userEvent.setup();
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          media: [{ id: 'z', filename: 'quad-spring.jpg', url: '/media/quad-spring.jpg', alt_text: 'Spring', mime_type: 'image/jpeg', width: 1600, height: 900 }],
          total: 1,
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    );

    const { onConfirm } = renderPicker({ multiple: true });

    await user.click(screen.getByRole('option', { name: /convocation/ }));
    await user.type(screen.getByLabelText('Search the library'), 'quad');
    await waitFor(() => expect(screen.getByRole('option', { name: /quad-spring/ })).toBeDefined());

    await user.click(screen.getByRole('option', { name: /quad-spring/ }));
    await user.click(screen.getByRole('button', { name: 'Choose 2' }));

    expect(onConfirm.mock.calls[0]![0].map((asset: MediaOption) => asset.id)).toEqual(['c', 'z']);
  });

  it('keeps the loaded assets usable when the search fails', async () => {
    const user = userEvent.setup();
    vi.mocked(fetch).mockRejectedValue(new Error('offline'));

    renderPicker();
    await user.type(screen.getByLabelText('Search the library'), 'quad');

    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined());
    expect(screen.getByRole('alert').textContent).toContain('still selectable');
  });
});

describe('accessibility', () => {
  it('has no axe violations', async () => {
    renderPicker({ multiple: true });

    /**
     * Scoped to the dialog rather than the container: Radix portals the dialog to `document.body`,
     * so the render container is empty, and auditing the whole body in isolation reports a
     * `region` violation that is an artifact of there being no page around it.
     */
    const results = await axe.run(screen.getByRole('dialog'), {
      resultTypes: ['violations'],
      // jsdom computes no layout and resolves no custom properties, so contrast is measured
      // numerically in a11y-contrast.mjs instead.
      rules: { 'color-contrast': { enabled: false } },
    });

    expect(results.violations.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([]);
  });

  it('has no axe violations with the upload panel open', async () => {
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByRole('button', { name: 'Upload a file' }));
    await screen.findByLabelText('Alt text');

    const results = await axe.run(screen.getByRole('dialog'), {
      resultTypes: ['violations'],
      rules: { 'color-contrast': { enabled: false } },
    });

    expect(results.violations.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([]);
  });

  it('asks for alt text where the upload happens', async () => {
    // An upload path that never asks is how a library fills with images nobody can describe.
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByRole('button', { name: 'Upload a file' }));
    expect(screen.getByLabelText('Alt text')).toBeDefined();
  });

  it('flags an image with no alt text', () => {
    renderPicker();
    expect(within(screen.getByRole('option', { name: /library-reading-room/ })).getByText('Missing alt text')).toBeDefined();
  });
});

describe('MediaField', () => {
  function renderField(props: Partial<Parameters<typeof MediaField>[0]> = {}) {
    const onChange = vi.fn();
    const result = render(
      <>
        <span id="label">Photo</span>
        <MediaField
          labelledBy="label"
          value={[]}
          onChange={onChange}
          library={ASSETS}
          {...props}
        />
      </>,
    );
    return { onChange, ...result };
  }

  it('is a named group so the field label still applies', () => {
    renderField();
    expect(screen.getByRole('group', { name: 'Photo' })).toBeDefined();
  });

  it('reorders with buttons, not only by dragging', async () => {
    // The house rule: drag-and-drop is added alongside keyboard controls, never instead of them.
    const user = userEvent.setup();
    const { onChange } = renderField({ multiple: true, value: ['a', 'b', 'c'] });

    await user.click(screen.getByRole('button', { name: 'Move library-reading-room.jpg up' }));
    expect(onChange).toHaveBeenCalledWith(['b', 'a', 'c']);
  });

  it('disables the move buttons at the ends rather than hiding them', () => {
    renderField({ multiple: true, value: ['a', 'b'] });

    expect(screen.getByRole('button', { name: 'Move quad-autumn.jpg up' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Move library-reading-room.jpg down' }).hasAttribute('disabled')).toBe(true);
  });

  it('removes one without disturbing the rest', async () => {
    const user = userEvent.setup();
    const { onChange } = renderField({ multiple: true, value: ['a', 'b', 'c'] });

    await user.click(screen.getByRole('button', { name: 'Remove library-reading-room.jpg' }));
    expect(onChange).toHaveBeenCalledWith(['a', 'c']);
  });

  it('shows an inherited value rather than an empty box', () => {
    // An editor who cannot see what leaving a field alone gives them sets it unnecessarily.
    renderField({ inherited: { asset: ASSETS[0]!, note: 'Inherited from the content type.' } });
    expect(screen.getByText(/Inherited from the content type/)).toBeDefined();
  });

  it('keeps a reference whose asset no longer resolves visible', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ media: [] }), {
        headers: { 'content-type': 'application/json' },
      }),
    );

    // The menus rule applied to media: a broken reference stays visible in the admin rather than
    // silently disappearing, because disappearing is indistinguishable from never having been set.
    renderField({ value: ['deleted-id'] });

    await waitFor(() => expect(screen.getByText('Asset no longer in the library')).toBeDefined());
  });

  it('looks an unresolved id up once, not on every render', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ media: [] }), {
        headers: { 'content-type': 'application/json' },
      }),
    );

    const { rerender } = renderField({ value: ['deleted-id'] });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    rerender(
      <>
        <span id="label">Photo</span>
        <MediaField labelledBy="label" value={['deleted-id']} onChange={vi.fn()} library={ASSETS} />
      </>,
    );

    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
