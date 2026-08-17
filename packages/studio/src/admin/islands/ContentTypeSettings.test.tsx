// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContentTypeRow } from '@taprootcms/core';

import ContentTypeSettings from './ContentTypeSettings.js';

/**
 * The sidebar-visibility checkbox on a content type's own screen.
 *
 * `isNavigable` is tested in core against the column; what needs pinning here is the *form*, because
 * a checkbox that renders correctly and sends nothing looks identical to one that works. It is sent
 * unconditionally rather than inside one of the kind-gated groups, which is the part a refactor is
 * most likely to break — every kind can clutter a sidebar, so this is the one visibility setting with
 * no kind check in front of it.
 */

const contentType = {
  id: 'ct-person',
  api_id: 'person',
  name: 'Person',
  name_plural: 'People',
  description: null,
  kind: 'collection',
  icon: null,
  url_prefix: 'people',
  preview_path: null,
  item_pages: 1,
  hide_from_nav: 0,
  summary_template: null,
  list_columns: null,
  list_sort: null,
  list_sort_field: null,
  position: 0,
  default_og_image_id: null,
  created_at: '',
  updated_at: '',
} as ContentTypeRow;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const view = (overrides: Partial<ContentTypeRow> = {}) =>
  render(<ContentTypeSettings contentType={{ ...contentType, ...overrides }} fields={[]} />);

const patchBody = () =>
  JSON.parse((fetchMock.mock.calls.at(-1)![1] as { body: string }).body) as Record<string, unknown>;

const checkbox = () => screen.getByLabelText(/Hide from the sidebar/i) as HTMLInputElement;

describe('hiding a content type from the sidebar', () => {
  it('reflects the stored value', () => {
    view();
    expect(checkbox().checked).toBe(false);

    cleanup();
    view({ hide_from_nav: 1 });
    expect(checkbox().checked).toBe(true);
  });

  it('sends the change on save', async () => {
    const user = userEvent.setup();
    view();

    await user.click(checkbox());
    await user.click(screen.getByRole('button', { name: /Save/i }));

    expect(patchBody().hide_from_nav).toBe(true);
  });

  /**
   * Sent on every kind, which is what distinguishes it from `url_prefix` and `preview_path`. A
   * singleton is exactly as clutterable as a collection, so a kind check here would be a control
   * that renders and does nothing on two of the three kinds that have a sidebar entry.
   */
  it('sends it for a page and a singleton too', async () => {
    for (const kind of ['page', 'singleton'] as const) {
      const user = userEvent.setup();
      view({ kind, url_prefix: null });

      await user.click(checkbox());
      await user.click(screen.getByRole('button', { name: /Save/i }));

      expect(patchBody().hide_from_nav).toBe(true);
      cleanup();
    }
  });

  /** A block type has no list screen to link to, so there is nothing to hide it from. */
  it('is absent for a block type', () => {
    view({ kind: 'block', url_prefix: null });

    expect(screen.queryByLabelText(/Hide from the sidebar/i)).toBeNull();
  });
});
