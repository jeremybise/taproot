// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ItemPicker } from './ItemPicker.js';

/**
 * The searchable item picker, which replaced two `<select>`s that had outgrown their job.
 *
 * The most important assertion in this file is the *server-render* one. `ItemPicker` is the first
 * control in the admin whose pre-hydration and post-hydration markup deliberately differ, and two
 * things depend on the pre-hydration half being a real, working `<select>`: the menus add-forms work
 * with no JavaScript, and `scripts/a11y-audit.mjs` runs `runScripts: 'outside-only'` — so the server
 * render *is* what axe sees on those routes. A regression there would be invisible: every jsdom test
 * here would still pass, and `npm run a11y` would keep reporting zero while auditing an empty div.
 */

const options = [
  { id: 'c1', title: 'Healthcare', path: '/healthcare', status: 'published' },
  { id: 'c2', title: 'Business', path: '/business', status: 'draft' },
];

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe('ItemPicker before hydration', () => {
  it('server-renders a real select carrying every option', () => {
    const html = renderToStaticMarkup(
      <ItemPicker id="parent" name="contentItemId" value={null} options={options} />,
    );

    expect(html).toContain('<select');
    expect(html).toContain('name="contentItemId"');
    expect(html).toContain('id="parent"');
    // Both candidates reachable without a line of JavaScript.
    expect(html).toContain('value="c1"');
    expect(html).toContain('value="c2"');
    // The path is still there — it is what tells two same-titled pages apart.
    expect(html).toContain('/healthcare');
    // And no search box yet: the enhanced control must not appear until React runs.
    expect(html).not.toContain('type="search"');
  });

  it('keeps the chosen value selected, so an untouched form re-submits it unchanged', () => {
    const html = renderToStaticMarkup(
      <ItemPicker id="parent" name="parentId" value="c2" options={options} />,
    );

    expect(html).toContain('<option value="c2" selected=""');
  });

  it('groups by content type, which is what makes a cross-type parent list readable', () => {
    const html = renderToStaticMarkup(
      <ItemPicker
        id="parent"
        value={null}
        options={[
          { ...options[0]!, groupLabel: 'Program Category' },
          { ...options[1]!, groupLabel: 'Program Group' },
        ]}
      />,
    );

    expect(html).toContain('<optgroup label="Program Category"');
    expect(html).toContain('<optgroup label="Program Group"');
  });
});

describe('ItemPicker after hydration', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          items: [{ id: 'deep', title: 'Nursing', path: '/healthcare/nursing', status: 'published' }],
        }),
      })),
    );
  });

  it('replaces the select with a search box and a list of buttons', async () => {
    render(<ItemPicker id="parent" value={null} options={options} noun="page" />);

    await waitFor(() => expect(screen.getByRole('searchbox')).toBeTruthy());
    expect(document.querySelector('select')).toBeNull();

    // Every candidate is a real button — which is what makes the list keyboard-reachable with no
    // roving tabindex and no `aria-activedescendant`.
    expect(screen.getByRole('button', { name: /Healthcare/ })).toBeTruthy();
  });

  it('shows the title first and the path under it, not "Title (path)" on one line', async () => {
    render(<ItemPicker id="parent" value={null} options={options} />);

    const button = await screen.findByRole('button', { name: /Healthcare/ });
    const lines = within(button)
      .getAllByText(/Healthcare|\/healthcare/)
      .map((node) => node.textContent);

    expect(lines).toContain('Healthcare');
    expect(lines).toContain('/healthcare');
  });

  it('badges a candidate that is not published, because choosing one renders nothing live', async () => {
    render(<ItemPicker id="parent" value={null} options={options} />);

    const draft = await screen.findByRole('button', { name: /Business/ });
    expect(within(draft).getByText('Draft')).toBeTruthy();

    // The published one carries no badge: a pill on every row is noise that hides the two that
    // matter.
    const live = screen.getByRole('button', { name: /Healthcare/ });
    expect(within(live).queryByText('Published')).toBeNull();
  });

  it('reaches an item past the first page by searching', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ItemPicker id="parent" value={null} options={options} onChange={onChange} />);

    const box = await screen.findByRole('searchbox');
    await user.type(box, 'nursing');

    // The whole point of the rewrite: `/healthcare/nursing` is not in `options` and was previously
    // unreachable once a site grew past the cap.
    const found = await screen.findByRole('button', { name: /Nursing/ }, { timeout: 3000 });
    await user.click(found);

    expect(onChange).toHaveBeenCalledWith('deep');
  });

  it('keeps a chosen item out of its own candidate list', async () => {
    const user = userEvent.setup();
    render(<ItemPicker id="parent" value={null} options={options} />);

    await user.click(await screen.findByRole('button', { name: /Healthcare/ }));

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /^Healthcare/ })).toBeNull(),
    );
  });

  it('excludes the item itself and its whole subtree from search results', async () => {
    const user = userEvent.setup();
    render(
      <ItemPicker
        id="parent"
        value={null}
        options={options}
        excludeIds={['self']}
        // `/healthcare/nursing` is beneath this, so the search result above must not be offered.
        excludeSubtreeOf="/healthcare"
      />,
    );

    const box = await screen.findByRole('searchbox');
    await user.type(box, 'nursing');

    await waitFor(() => expect(screen.getByText(/No pages match/)).toBeTruthy());
    expect(screen.queryByRole('button', { name: /Nursing/ })).toBeNull();
  });

  it('keeps the label pointing at a real control once something is chosen', async () => {
    const user = userEvent.setup();
    render(
      <>
        <label htmlFor="parent">Parent page</label>
        <ItemPicker id="parent" value={null} options={options} />
      </>,
    );

    await user.click(await screen.findByRole('button', { name: /Healthcare/ }));

    /*
      The failure this guards against is silent: a `<label for>` pointing at nothing still announces
      correctly through other means, axe still passes, and only click-to-focus is broken. The first
      draft of this control replaced the search box with the chosen item and had exactly that bug.
    */
    const labelled = document.getElementById('parent');
    expect(labelled).not.toBeNull();
    expect(labelled!.tagName).toBe('INPUT');
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <>
        <label htmlFor="parent">Parent page</label>
        <ItemPicker
          id="parent"
          value="c1"
          options={options.map((option) => ({ ...option, groupLabel: 'Program Category' }))}
          total={40}
          emptyLabel="Top level"
        />
      </>,
    );

    await screen.findByRole('searchbox');

    // Scoped to the container: in isolation there is no landmark around the component, and the
    // resulting `region` violation is an artifact of the test rather than of the markup.
    const results = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } },
    });

    expect(results.violations.map((violation) => violation.id)).toEqual([]);
  });
});
