// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContentTypeRow, FieldRow } from '@taproot/core';

import FieldBuilder from './FieldBuilder.js';

/**
 * Interaction tests for the content-type builder.
 *
 * The axe run in `scripts/a11y-audit.mjs` only sees server-rendered HTML, so the builder's
 * hydrated state — config forms, the field editor, the reorder controls — would otherwise go
 * unaudited. These tests cover that, and the behaviours most likely to regress silently.
 *
 * Not covered here: pointer dragging, which needs real pointer events and a layout engine. The
 * keyboard reorder buttons are the accessibility-critical path and they *are* covered; dragging is
 * dnd-kit's own well-tested behaviour layered on top after hydration.
 */

function field(overrides: Partial<FieldRow> = {}): FieldRow {
  return {
    id: 'f1',
    content_type_id: 'ct1',
    api_id: 'summary',
    label: 'Summary',
    type: 'text',
    help_text: null,
    position: 0,
    required: 0,
    localized: 0,
    config: '{}',
    created_at: '',
    updated_at: '',
    ...overrides,
  } as FieldRow;
}

const contentType: ContentTypeRow = {
  id: 'ct1',
  api_id: 'page',
  name: 'Page',
  name_plural: 'Pages',
  description: null,
  kind: 'page',
  icon: null,
  url_prefix: null,
  title_field: null,
  created_at: '',
  updated_at: '',
} as ContentTypeRow;

function renderBuilder(fields: FieldRow[] = [], itemCount = 0) {
  return render(
    <FieldBuilder
      contentTypeId="ct1"
      initialFields={fields}
      contentTypes={[contentType]}
      taxonomies={[]}
      itemCount={itemCount}
    />,
  );
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ field: field() }), { status: 200 })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('field type picker', () => {
  it('offers every type as a radio with a description', async () => {
    renderBuilder();
    const group = screen.getByRole('group', { name: /field type/i });

    // Radios, not a dropdown: the descriptions are what tell a non-technical editor which to pick.
    expect(within(group).getByRole('radio', { name: /Text/ })).toBeTruthy();
    expect(within(group).getByRole('radio', { name: /Rich text/ })).toBeTruthy();
    expect(within(group).getByRole('radio', { name: /Relation/ })).toBeTruthy();
  });

  it('marks types whose editor is not built yet', () => {
    renderBuilder();
    const blocks = screen.getByRole('radio', { name: /Blocks/ });
    expect(blocks.closest('div')?.textContent).toMatch(/Phase 2/);
  });
});

describe('config forms', () => {
  it('shows the options editor only for select', async () => {
    const user = userEvent.setup();
    renderBuilder();

    expect(screen.queryByRole('button', { name: /add option/i })).toBeNull();

    await user.click(screen.getByRole('radio', { name: /Select/ }));
    expect(screen.getByRole('button', { name: /add option/i })).toBeTruthy();
  });

  it('swaps options when the type changes', async () => {
    const user = userEvent.setup();
    renderBuilder();

    // Text has a multiline toggle; number does not.
    expect(screen.getByLabelText(/multiline/i)).toBeTruthy();

    await user.click(screen.getByRole('radio', { name: /^Number/ }));
    expect(screen.queryByLabelText(/multiline/i)).toBeNull();
    expect(screen.getByLabelText(/whole numbers only/i)).toBeTruthy();
  });

  it('adds and removes select options', async () => {
    const user = userEvent.setup();
    renderBuilder();

    await user.click(screen.getByRole('radio', { name: /Select/ }));
    await user.click(screen.getByRole('button', { name: /add option/i }));

    const labelInput = screen.getByLabelText(/option label/i);
    await user.type(labelInput, 'Alpha');
    expect((labelInput as HTMLInputElement).value).toBe('Alpha');

    await user.click(screen.getByRole('button', { name: /remove/i }));
    expect(screen.queryByLabelText(/option label/i)).toBeNull();
  });
});

describe('editing an existing field', () => {
  const existing = field({ id: 'f1', label: 'Summary', api_id: 'summary' });

  it('loads the field into the editor when selected', async () => {
    const user = userEvent.setup();
    renderBuilder([existing]);

    await user.click(screen.getByRole('button', { name: /^Summary/ }));

    expect(screen.getByRole('heading', { name: /Edit .Summary./ })).toBeTruthy();
    expect((screen.getByLabelText(/^label$/i) as HTMLInputElement).value).toBe('Summary');
  });

  it('locks type and api_id, which are immutable after creation', async () => {
    const user = userEvent.setup();
    renderBuilder([existing]);
    await user.click(screen.getByRole('button', { name: /^Summary/ }));

    expect(screen.getByLabelText(/api id/i)).toHaveProperty('readOnly', true);

    // The type picker is disabled via its <fieldset>, which disables descendants per spec but
    // does not set each input's own `disabled` property — so assert the guarantee that actually
    // matters: clicking a different type cannot change it.
    expect(screen.getByRole('group', { name: /field type/i })).toHaveProperty('disabled', true);

    await user.click(screen.getByRole('radio', { name: /^Number/ }));
    expect(screen.getByText(/Text options/i)).toBeTruthy();
    expect(screen.queryByLabelText(/whole numbers only/i)).toBeNull();
  });

  it('moves focus to the editor heading so the pane swap is announced', async () => {
    const user = userEvent.setup();
    renderBuilder([existing]);

    await user.click(screen.getByRole('button', { name: /^Summary/ }));
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: /Edit/ }));
  });
});

describe('required warning', () => {
  it('warns with the affected item count when marking a field required', async () => {
    const user = userEvent.setup();
    renderBuilder([], 7);

    await user.click(screen.getByLabelText(/^required$/i));

    const warning = screen.getByText(/already has 7 items/i);
    expect(warning).toBeTruthy();
    // Wired to the checkbox, so a screen reader hears it on the control rather than by chance.
    expect(screen.getByLabelText(/^required$/i).getAttribute('aria-describedby')).toBe(
      warning.getAttribute('id'),
    );
  });

  it('stays quiet when the type has no content yet', async () => {
    const user = userEvent.setup();
    renderBuilder([], 0);
    await user.click(screen.getByLabelText(/^required$/i));
    expect(screen.queryByText(/will fail validation/i)).toBeNull();
  });
});

describe('reordering', () => {
  const fields = [
    field({ id: 'a', label: 'First', api_id: 'first' }),
    field({ id: 'b', label: 'Second', api_id: 'second' }),
    field({ id: 'c', label: 'Third', api_id: 'third' }),
  ];

  it('exposes buttons as the discoverable keyboard path', () => {
    renderBuilder(fields);

    // Names include the position, so a screen reader user knows where they are in the list.
    expect(screen.getByRole('button', { name: /Move Second up, currently 2 of 3/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Move Second down, currently 2 of 3/ })).toBeTruthy();
  });

  it('disables the boundary controls', () => {
    renderBuilder(fields);
    expect(screen.getByRole('button', { name: /Move First up/ })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: /Move Third down/ })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('persists a new order through the API', async () => {
    const user = userEvent.setup();
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init.body ?? '{}')) });
        return new Response(null, { status: 204 });
      }),
    );

    renderBuilder(fields);
    await user.click(screen.getByRole('button', { name: /Move Second up/ }));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toMatch(/content-types\/ct1\/fields$/);
    expect((calls[0]!.body as { fieldIds: string[] }).fieldIds).toEqual(['b', 'a', 'c']);
  });

  it('puts the order back if the save fails', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'nope' }), { status: 500 })),
    );

    renderBuilder(fields);
    await user.click(screen.getByRole('button', { name: /Move Second up/ }));

    // Reverted, so the list never disagrees with what the server actually stored.
    expect(screen.getByRole('button', { name: /Move Second up, currently 2 of 3/ })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/could not save/i);
  });
});

describe('accessibility of the hydrated builder', () => {
  it('has no axe violations with a field selected', async () => {
    const user = userEvent.setup();
    const { container } = renderBuilder([field({ id: 'a', label: 'First', api_id: 'first' })], 3);

    await user.click(screen.getByRole('button', { name: /^First/ }));

    const results = await axe.run(container, {
      // jsdom computes no colour; tokens are checked by scripts/a11y-contrast.mjs instead.
      rules: { 'color-contrast': { enabled: false } },
    });

    const messages = results.violations.map((v) => `${v.id}: ${v.help}`);
    expect(messages).toEqual([]);
  });

  it('has no axe violations on the select options editor', async () => {
    const user = userEvent.setup();
    const { container } = renderBuilder();

    await user.click(screen.getByRole('radio', { name: /Select/ }));
    await user.click(screen.getByRole('button', { name: /add option/i }));

    const results = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});
