// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { QueryField } from './QueryField.js';

/**
 * The query field's control, after hydration.
 *
 * The live preview is the part worth pinning down: it is the only thing telling an editor what a
 * rule they cannot otherwise see actually returns, and it is a `fetch` — so it is exactly the shape
 * of feature that ships looking complete and doing nothing. Every case here makes the component
 * issue a request and inspects what it asked for.
 *
 * `npm run a11y` sees the server-rendered markup only, which is the controls in their loading state.
 * The axe run below covers the state with results in it.
 */

const terms = [
  { id: 't-academics', name: 'Academics', depth: 0 },
  { id: 't-sciences', name: 'Sciences', depth: 1 },
];

const value = { termIds: [], sort: 'path' as const, limit: 6, dateFilter: 'any' as const };

function mockFetch(body: unknown = { items: [{ id: 'e1', title: 'Jazz Night', path: '/e/jazz' }], total: 1 }) {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => body });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** The URL of the most recent preview request, parsed. */
function lastQuery(fetchMock: ReturnType<typeof vi.fn>) {
  const url = String(fetchMock.mock.calls.at(-1)![0]);
  return new URL(url, 'http://localhost').searchParams;
}

function setup(props: Partial<Parameters<typeof QueryField>[0]> = {}) {
  const onChange = vi.fn();
  const result = render(
    <QueryField
      id="q"
      value={value}
      onChange={onChange}
      targetContentTypeId="ct-event"
      terms={terms}
      maxResults={12}
      {...props}
    />,
  );
  return { onChange, ...result };
}

beforeEach(() => {
  mockFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('with no target chosen', () => {
  it('says so, and asks for nothing', () => {
    // A field pointed at nothing is an unfinished *definition*, and the fix is on another screen —
    // so the message names it rather than rendering filters that could not work.
    const fetchMock = mockFetch();
    setup({ targetContentTypeId: null });

    expect(screen.getByText(/not been pointed at a content type/i)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the live preview', () => {
  it('asks for exactly what the rule says', async () => {
    const fetchMock = mockFetch();
    setup({ value: { termIds: ['t-sciences'], sort: 'newest', limit: 4, dateFilter: 'any' } });

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const params = lastQuery(fetchMock);
    expect(params.get('contentTypeId')).toBe('ct-event');
    expect(params.get('termIds')).toBe('t-sciences');
    expect(params.get('sort')).toBe('newest');
    expect(params.get('limit')).toBe('4');
    /**
     * The preview has to answer the question *delivery* will answer, and delivery never lists a
     * draft. Without this an editor tunes a listing to six results and watches four vanish the
     * moment the page goes live.
     */
    expect(params.get('visibleOnly')).toBe('1');
  });

  it('reports the total, not the number shown', async () => {
    // The count is what tells an editor their filter is too narrow, so it counts matches rather
    // than the page of them coming back.
    mockFetch({ items: [{ id: 'e1', title: 'Jazz Night', path: '/e/jazz' }], total: 37 });
    setup();

    expect(await screen.findByText(/37 matches/)).toBeTruthy();
    expect(screen.getByText(/showing the first 1/)).toBeTruthy();
  });

  it('names what matched, so the rule is checkable at a glance', async () => {
    setup();
    expect(await screen.findByText('Jazz Night')).toBeTruthy();
  });

  it('says nothing matches without implying something is broken', async () => {
    mockFetch({ items: [], total: 0 });
    setup();

    // An empty listing is a normal state for a rule that will fill itself in later, and the wording
    // has to distinguish that from a misconfigured field.
    expect(await screen.findByText(/Nothing matches this yet/i)).toBeTruthy();
  });

  it('survives the server being unreachable, and says the rule is still saved', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    setup();

    expect(await screen.findByText(/Could not reach the server/i)).toBeTruthy();
  });

  it('re-asks when the rule changes', async () => {
    const fetchMock = mockFetch();
    const { rerender } = setup();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    rerender(
      <QueryField
        id="q"
        value={{ termIds: [], sort: 'title', limit: 6, dateFilter: 'any' }}
        onChange={vi.fn()}
        targetContentTypeId="ct-event"
        terms={terms}
        maxResults={12}
      />,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(lastQuery(fetchMock).get('sort')).toBe('title');
  });
});

describe('editing the rule', () => {
  it('adds and removes a term', async () => {
    const user = userEvent.setup();
    const { onChange } = setup();

    await user.click(screen.getByLabelText('Sciences'));
    expect(onChange).toHaveBeenCalledWith({ ...value, termIds: ['t-sciences'] });

    cleanup();
    const second = setup({ value: { ...value, termIds: ['t-sciences'] } });
    await user.click(screen.getByLabelText('Sciences'));
    expect(second.onChange).toHaveBeenCalledWith({ ...value, termIds: [] });
  });

  it('clamps a limit typed above the field’s ceiling', async () => {
    // `maxResults` is the admin's bound on what the site will carry. Refusing the keystroke would
    // block an editor on a number whose ceiling is not visible to them.
    const user = userEvent.setup();
    const { onChange } = setup();

    const input = screen.getByLabelText('How many');
    await user.clear(input);
    await user.type(input, '99');

    expect(onChange.mock.calls.at(-1)![0].limit).toBe(12);
  });

  it('hides the field orders when there is no field to order by', () => {
    /**
     * "Soonest first" with no date field nominated falls back to site order in `listItems` — which
     * is the right failure for a query saved before somebody deleted the field, and the wrong thing
     * to *offer*. An option that appears to work and does nothing is worse than an absent one.
     */
    setup();
    const options = [...(screen.getByLabelText('Order') as HTMLSelectElement).options].map(
      (option) => option.value,
    );
    expect(options).toEqual(['path', 'title', 'newest', 'oldest', 'recently_updated']);
    expect(screen.queryByLabelText('Date')).toBeNull();
  });

  it('offers the date window and the field orders once a date field is configured', () => {
    setup({ dateFieldApiId: 'starts_at' });

    const options = [...(screen.getByLabelText('Order') as HTMLSelectElement).options].map(
      (option) => option.value,
    );
    expect(options).toContain('field_asc');
    expect(options).toContain('field_desc');

    const dates = [...(screen.getByLabelText('Date') as HTMLSelectElement).options].map(
      (option) => option.value,
    );
    expect(dates).toEqual(['any', 'upcoming', 'past']);
  });

  it('asks the preview for the same date window the page will use', async () => {
    /**
     * The preview and delivery have to answer the same question, or an editor tunes "still to come"
     * against a list that includes last year's events. Note the *filter* travels, never a resolved
     * timestamp — "now" is worked out per request at both ends.
     */
    const fetchMock = mockFetch();
    setup({
      dateFieldApiId: 'starts_at',
      value: { termIds: [], sort: 'field_asc', limit: 6, dateFilter: 'upcoming' },
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const params = lastQuery(fetchMock);
    expect(params.get('dateField')).toBe('starts_at');
    expect(params.get('dateFilter')).toBe('upcoming');
    expect(params.get('sort')).toBe('field_asc');
  });

  it('offers no term filter when the field allows none', () => {
    // `taxonomyId` is optional on the config — a listing that is simply "the six newest" needs no
    // filter, and an empty fieldset would read as a taxonomy with no terms.
    setup({ terms: [] });
    expect(screen.queryByText('Filter by term')).toBeNull();
  });
});

describe('accessibility', () => {
  it('has no violations with results showing', async () => {
    const { container } = setup();
    await screen.findByText('Jazz Night');

    // Scoped to the container: in isolation there is no landmark around the component, and the
    // `region` violation that follows would be an artifact of the test.
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });

  it('announces the preview, which changes with no focus moving', async () => {
    const { container } = setup();
    await screen.findByText('Jazz Night');

    // Same reason the block and repeater editors announce a reorder: the thing that changed is
    // somewhere else on the screen from the control that changed it.
    expect(container.querySelector('[aria-live="polite"]')).toBeTruthy();
  });
});
