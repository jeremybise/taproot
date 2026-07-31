// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RelationField } from './RelationField.js';
import type { RelationTarget } from '../../relationOptions.js';

/**
 * The relation control's behaviour after hydration.
 *
 * This field type shipped with a config form, server-side validation, and no editing control at
 * all — an author could define a relation and the editor could not fill it in. These tests are as
 * much about that not recurring as about the behaviour itself.
 */

const items = [
  { id: 'e1', title: 'Spring Open House', path: '/events/spring-open-house', status: 'published' },
  { id: 'e2', title: 'Autumn Tour', path: '/events/autumn-tour', status: 'draft' },
  { id: 'e3', title: 'Winter Concert', path: '/events/winter-concert', status: 'published' },
];

const target: RelationTarget = {
  contentTypeId: 'ct-event',
  name: 'Event',
  namePlural: 'Events',
  items,
  total: 3,
};

function setup(props: Partial<Parameters<typeof RelationField>[0]> = {}) {
  const onChange = vi.fn();
  const result = render(
    <>
      <span id="label">Related event</span>
      <RelationField value={[]} onChange={onChange} target={target} labelledBy="label" {...props} />
    </>,
  );
  return { onChange, ...result };
}

afterEach(cleanup);

describe('choosing', () => {
  it('lists the candidates', () => {
    setup();
    expect(screen.getByRole('button', { name: /Spring Open House/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Winter Concert/ })).toBeTruthy();
  });

  it('stores the chosen id', async () => {
    const user = userEvent.setup();
    const { onChange } = setup();

    await user.click(screen.getByRole('button', { name: /Spring Open House/ }));

    expect(onChange).toHaveBeenCalledWith(['e1']);
  });

  it('replaces rather than accumulating for a single-value field', async () => {
    const user = userEvent.setup();
    const { onChange } = setup({ value: ['e1'] });

    // A single-value field offers no "add" list once something is chosen, so the way to change it
    // is to remove and choose again. What must never happen is a second id joining the first.
    await user.click(screen.getByRole('button', { name: /Remove Spring Open House/ }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('appends for a multi-value field', async () => {
    const user = userEvent.setup();
    const { onChange } = setup({ value: ['e1'], multiple: true });

    await user.click(screen.getByRole('button', { name: /Winter Concert/ }));

    expect(onChange).toHaveBeenCalledWith(['e1', 'e3']);
  });

  it('does not offer an item already chosen', () => {
    setup({ value: ['e1'], multiple: true });
    expect(screen.queryByRole('button', { name: /Spring Open House.*\/events/s })).toBeNull();
  });
});

describe('what is chosen', () => {
  it('shows the title and path rather than the raw id', () => {
    setup({ value: ['e1'] });
    expect(screen.getByText('Spring Open House')).toBeTruthy();
    expect(screen.getByText('/events/spring-open-house')).toBeTruthy();
  });

  it('flags a reference to unpublished content', () => {
    // A relation to a draft renders as nothing for a visitor, and the editor choosing it is the
    // one person positioned to notice before it ships.
    setup({ value: ['e2'] });
    expect(screen.getByText('Draft')).toBeTruthy();
  });

  it('keeps an id whose item no longer exists rather than dropping it', () => {
    // Silently discarding would delete a reference on the next save, and the id is the only
    // evidence left of what was intended.
    setup({ value: ['gone'] });
    expect(screen.getByText('Item no longer exists')).toBeTruthy();
    expect(screen.getByText('gone')).toBeTruthy();
  });

  it('reorders a multi-value field by button', async () => {
    const user = userEvent.setup();
    const { onChange } = setup({ value: ['e1', 'e3'], multiple: true });

    await user.click(screen.getByRole('button', { name: 'Move Winter Concert up' }));

    expect(onChange).toHaveBeenCalledWith(['e3', 'e1']);
  });
});

describe('searching', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          items: [
            { id: 'e9', title: 'Deep Archive Event', path: '/events/deep', status: 'published' },
          ],
        }),
      })),
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it('says the first page is not the whole set', () => {
    // Without this an editor who cannot find an item they know exists concludes it is gone rather
    // than that they need to type.
    setup({ target: { ...target, total: 214 } });
    expect(screen.getByText(/Showing 3 of 214/)).toBeTruthy();
  });

  it('reaches items beyond the first page', async () => {
    const user = userEvent.setup();
    setup({ target: { ...target, total: 214 } });

    await user.type(screen.getByRole('searchbox'), 'deep');

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Deep Archive Event/ })).toBeTruthy(),
    );
  });

  it('keeps a chosen item resolvable after a search that excludes it', async () => {
    const user = userEvent.setup();
    setup({ value: ['e1'], multiple: true, target: { ...target, total: 214 } });

    await user.type(screen.getByRole('searchbox'), 'deep');
    await waitFor(() => expect(screen.getByRole('button', { name: /Deep Archive/ })).toBeTruthy());

    // The chosen row still names the item. Resolving from the visible results instead would have
    // dropped its title the moment the search stopped returning it.
    expect(screen.getByText('Spring Open House')).toBeTruthy();
  });
});

describe('an unconfigured field', () => {
  it('says the target is missing, and how to set it', () => {
    setup({ target: null, hasTarget: false });
    expect(screen.getByText(/no target content type yet/)).toBeTruthy();
  });

  it('does not claim a configured field is unconfigured', () => {
    // The content-type builder's preview resolves no candidates because it has no database. Saying
    // "no target content type yet" there contradicts the setting the author just chose.
    setup({ target: null, hasTarget: true });
    expect(screen.queryByText(/no target content type yet/)).toBeNull();
  });
});

describe('accessibility', () => {
  it('has no violations', async () => {
    const { container } = setup({ value: ['e1', 'e2'], multiple: true });

    // Scoped to the container: in isolation there is no landmark around the component, and the
    // resulting `region` violation would be an artifact of the test rather than the control.
    const results = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } },
    });

    expect(results.violations).toEqual([]);
  });

  it('names the group by the field label', () => {
    const { container } = setup();
    const group = container.querySelector('[role="group"]');
    expect(group?.getAttribute('aria-labelledby')).toBe('label');
  });

  it('announces a change to the chosen list', async () => {
    const user = userEvent.setup();
    const { container } = setup({ multiple: true });

    await user.click(screen.getByRole('button', { name: /Autumn Tour/ }));

    const live = container.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toContain('Autumn Tour added');
  });
});
