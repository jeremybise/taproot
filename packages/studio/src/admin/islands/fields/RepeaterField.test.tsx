// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FieldRow } from '@taprootcms/core';

import { RepeaterField } from './RepeaterField.js';

/**
 * The repeater's editing control, after hydration.
 *
 * Order is usually the point of a repeater — opening hours, a running order — so reordering is what
 * these cover most closely, by the buttons, which are the primary keyboard path rather than a
 * fallback.
 */

function repeater(config: Record<string, unknown>): FieldRow {
  return {
    id: 'f-hours',
    content_type_id: 'ct',
    api_id: 'hours',
    label: 'Opening hours',
    type: 'repeater',
    help_text: null,
    position: 0,
    required: 0,
    localized: 0,
    config: JSON.stringify(config),
    created_at: '',
    updated_at: '',
  } as FieldRow;
}

const shape = {
  fields: [
    { api_id: 'day', label: 'Day', type: 'text', required: true, config: {} },
    { api_id: 'opens', label: 'Opens', type: 'text', required: false, config: {} },
  ],
};

const rows = [
  { id: 'a', data: { day: 'Monday', opens: '09:00' } },
  { id: 'b', data: { day: 'Tuesday', opens: '10:00' } },
];

function setup(props: Partial<Parameters<typeof RepeaterField>[0]> = {}) {
  const onChange = vi.fn();
  const result = render(
    <>
      <span id="label">Opening hours</span>
      <RepeaterField
        field={repeater(shape)}
        value={[]}
        onChange={onChange}
        labelledBy="label"
        {...props}
      />
    </>,
  );
  return { onChange, ...result };
}

afterEach(cleanup);

describe('an undefined shape', () => {
  it('says so rather than offering rows with nowhere to type', () => {
    // The fix is on a different screen, so an "Add entry" button here would read as broken rather
    // than unfinished.
    setup({ field: repeater({}) });

    expect(screen.getByText(/no fields yet/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /add entry/i })).toBeNull();
  });
});

describe('adding and removing', () => {
  it('adds an entry with a generated id', async () => {
    const user = userEvent.setup();
    const { onChange } = setup();

    await user.click(screen.getByRole('button', { name: /add entry/i }));

    const added = onChange.mock.calls[0]![0];
    expect(added).toHaveLength(1);
    // The id keeps a row's inputs mounted across a reorder; without one React remounts every row
    // and focus is lost mid-edit.
    expect(added[0].id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('seeds a new entry with its sub-fields’ defaults', async () => {
    // A row added as `{}` fails validation the moment a sub-field is required, so the editor would
    // show an error for something nobody has touched.
    const user = userEvent.setup();
    const { onChange } = setup({
      field: repeater({
        fields: [{ api_id: 'open', label: 'Open', type: 'boolean', config: { defaultValue: true } }],
      }),
    });

    await user.click(screen.getByRole('button', { name: /add entry/i }));
    expect(onChange.mock.calls[0]![0][0].data).toEqual({ open: true });
  });

  it('removes only the entry asked for', async () => {
    const user = userEvent.setup();
    const { onChange } = setup({ value: rows });

    await user.click(screen.getByRole('button', { name: 'Remove entry 1' }));
    expect(onChange.mock.calls[0]![0].map((row: { id: string }) => row.id)).toEqual(['b']);
  });

  it('stops offering more at maxItems', () => {
    setup({ value: rows, maxItems: 2 });

    expect(screen.queryByRole('button', { name: /add entry/i })).toBeNull();
    expect(screen.getByText(/at most 2 entries/i)).toBeTruthy();
  });

  it('says how many are required when empty', () => {
    setup({ minItems: 2 });
    expect(screen.getByText(/at least 2 are required/i)).toBeTruthy();
  });
});

describe('reordering', () => {
  it('moves an entry up and down', async () => {
    const user = userEvent.setup();
    const { onChange } = setup({ value: rows });

    await user.click(screen.getByRole('button', { name: 'Move entry 2 up' }));
    expect(onChange.mock.calls[0]![0].map((row: { id: string }) => row.id)).toEqual(['b', 'a']);
  });

  it('disables the buttons at the ends', () => {
    setup({ value: rows });

    expect(screen.getByRole('button', { name: 'Move entry 1 up' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Move entry 2 down' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('announces the move, since the list is otherwise only visible', async () => {
    const user = userEvent.setup();
    const { container } = setup({ value: rows });

    await user.click(screen.getByRole('button', { name: 'Move entry 2 up' }));

    expect(container.querySelector('[aria-live="polite"]')?.textContent).toMatch(
      /moved to position 1 of 2/i,
    );
  });
});

describe('editing a row', () => {
  it('renders each sub-field per entry', () => {
    // Matched loosely: `FieldControl` appends a required marker and an "(required)" span to the
    // accessible name, so an exact string would miss exactly the required fields.
    setup({ value: rows });

    expect(screen.getAllByLabelText(/^Day/)).toHaveLength(2);
    expect(screen.getAllByLabelText(/^Opens/)).toHaveLength(2);
  });

  it('writes a change back into that row only', async () => {
    const user = userEvent.setup();
    const { onChange } = setup({ value: rows });

    await user.type(screen.getAllByLabelText(/^Day/)[0]!, '!');

    const next = onChange.mock.calls.at(-1)![0];
    expect(next[0].data.day).toBe('Monday!');
    expect(next[1].data.day).toBe('Tuesday');
  });

  it('gives each row its own DOM ids', async () => {
    /**
     * Every row renders the same sub-field definitions, so without an `idPrefix` per row they
     * would share an id and a label would focus the row above. The same fix two blocks of one type
     * needed.
     */
    const user = userEvent.setup();
    setup({ value: rows });

    const [first, second] = screen.getAllByLabelText(/^Opens/) as HTMLInputElement[];
    expect(first!.id).not.toBe(second!.id);

    // And the labels genuinely point at their own input — which is the part that breaks when two
    // rows share an id, since clicking the second label focuses the first row's box.
    await user.click(screen.getAllByText('Opens')[1]!);
    expect(document.activeElement).toBe(second);
  });

  it('names each row by its position, so controls are distinguishable', () => {
    // Without it a screen reader's list of form fields is the same two labels repeated.
    setup({ value: rows });
    expect(screen.getByText('Entry 1 of 2')).toBeTruthy();
    expect(screen.getByText('Entry 2 of 2')).toBeTruthy();
  });

  it('offers no editing controls in preview mode', () => {
    setup({ value: rows, disabled: true });

    expect(screen.queryByRole('button', { name: /add entry/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Move entry/ })).toBeNull();
  });
});

describe('collapsing', () => {
  /**
   * Rows had no collapse at all until Phase 5A, while blocks had it from the start — so a staff
   * list of thirty rows buried every field below it and the two composition editors behaved
   * differently for no reason anyone could state.
   */
  it('collapses and expands a row', async () => {
    const user = userEvent.setup();
    const { container } = setup({ value: rows });

    const toggle = screen.getByRole('button', { name: 'Entry 2 of 2' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    await user.click(toggle);

    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    // The panel, not just the label — a disclosure that only relabels itself is inert.
    expect(container.querySelector('#repeater-panel-b')?.hasAttribute('hidden')).toBe(true);
    expect(container.querySelector('#repeater-panel-a')?.hasAttribute('hidden')).toBe(false);
  });

  it('collapses and expands every row at once', async () => {
    const user = userEvent.setup();
    const { container } = setup({ value: rows });

    await user.click(screen.getByRole('button', { name: 'Collapse all entries' }));
    for (const id of ['a', 'b']) {
      expect(container.querySelector(`#repeater-panel-${id}`)?.hasAttribute('hidden')).toBe(true);
    }

    await user.click(screen.getByRole('button', { name: 'Expand all entries' }));
    for (const id of ['a', 'b']) {
      expect(container.querySelector(`#repeater-panel-${id}`)?.hasAttribute('hidden')).toBe(false);
    }
  });

  it('announces a bulk collapse, since both controls are idempotent', async () => {
    const user = userEvent.setup();
    const { container } = setup({ value: rows });

    await user.click(screen.getByRole('button', { name: 'Collapse all entries' }));

    expect(container.querySelector('[aria-live="polite"]')?.textContent).toMatch(
      /all 2 entries collapsed/i,
    );
  });

  it('still collapses in preview mode, because reading is not editing', () => {
    // The move and remove buttons go when `disabled`; the disclosure stays, since a long read-only
    // repeater is exactly where collapsing helps most.
    setup({ value: rows, disabled: true });
    expect(screen.getByRole('button', { name: 'Entry 1 of 2' })).toBeTruthy();
  });
});

describe('accessibility', () => {
  it('has no violations', async () => {
    const { container } = setup({ value: rows });

    // Scoped to the container: in isolation there is no landmark around the component, and the
    // resulting `region` violation would be an artifact of the test.
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });

  it('names the group by the field label', () => {
    const { container } = setup({ value: rows });
    expect(container.querySelector('[role="group"]')?.getAttribute('aria-labelledby')).toBe('label');
  });

  it('uses an ordered list, because the order is the content', () => {
    const { container } = setup({ value: rows });
    expect(container.querySelector('ol')).toBeTruthy();
  });
});
