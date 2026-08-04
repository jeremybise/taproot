// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { VisibilityEditor, type SiblingOption } from './VisibilityEditor.js';

/**
 * The condition builder, after hydration.
 *
 * `npm run a11y` cannot reach most of this: the operator and value controls only exist once a field
 * has been chosen, which is client state, and the audit runs the island's server-rendered markup
 * with no scripts. So the axe run lives here, on the expanded tree — the same bargain
 * `RichTextEditor.test.tsx` and `MediaPicker.test.tsx` make.
 *
 * The rest is the rule that the link search had to learn: asserting a control exists is not
 * asserting it works. Every case below makes the component emit a condition and inspects it.
 */

const siblings: SiblingOption[] = [
  { api_id: 'enabled', label: 'Show the banner', type: 'boolean' },
  { api_id: 'severity', label: 'Severity', type: 'select' },
];

function setup(props: Partial<Parameters<typeof VisibilityEditor>[0]> = {}) {
  const onChange = vi.fn();
  const result = render(
    <VisibilityEditor idPrefix="t" value={null} siblings={siblings} onChange={onChange} {...props} />,
  );
  return { onChange, ...result };
}

afterEach(cleanup);

describe('choosing what to depend on', () => {
  it('starts unconditional and offers every sibling', () => {
    setup();

    const select = screen.getByLabelText('Show this field when') as HTMLSelectElement;
    expect(select.value).toBe('');
    expect([...select.options].map((option) => option.textContent)).toEqual([
      'Always shown',
      'Show the banner',
      'Severity',
    ]);
  });

  it('emits a condition with a sensible operator for a checkbox', async () => {
    const user = userEvent.setup();
    const { onChange } = setup();

    await user.selectOptions(screen.getByLabelText('Show this field when'), 'enabled');

    // `is_checked` rather than `equals`: a checkbox has two states and both are already spelled, so
    // making somebody type "true" into a value box is a way to get "false" and a truthy string.
    expect(onChange).toHaveBeenCalledWith({ field: 'enabled', operator: 'is_checked' });
  });

  it('clears the condition when set back to "Always shown"', async () => {
    // Null is the only thing that removes a condition — `updateField` reads an absent key as "keep
    // what is stored", so an omitted value here would make a condition impossible to undo.
    const user = userEvent.setup();
    const { onChange } = setup({ value: { field: 'enabled', operator: 'is_checked' } });

    await user.selectOptions(screen.getByLabelText('Show this field when'), '');

    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('offers only checkbox operators for a boolean, and only the others otherwise', () => {
    const { unmount } = setup({ value: { field: 'enabled', operator: 'is_checked' } });
    expect(
      [...(screen.getByLabelText('Condition') as HTMLSelectElement).options].map((o) => o.value),
    ).toEqual(['is_checked', 'is_not_checked']);
    unmount();

    // A text or select field has no useful "is checked"; offering all six means five are wrong on
    // any given field, and the one picked by accident yields a field that never appears.
    setup({ value: { field: 'severity', operator: 'equals', value: 'closure' } });
    expect(
      [...(screen.getByLabelText('Condition') as HTMLSelectElement).options].map((o) => o.value),
    ).toEqual(['equals', 'not_equals', 'is_set', 'is_empty']);
  });

  it('re-derives the operator when the chosen field changes type', async () => {
    /**
     * Carrying the operator over would leave `is_checked` selected against a select field, where it
     * can never be true — the control would look settled and the field would simply never appear.
     */
    const user = userEvent.setup();
    const { onChange } = setup({ value: { field: 'enabled', operator: 'is_checked' } });

    await user.selectOptions(screen.getByLabelText('Show this field when'), 'severity');

    expect(onChange).toHaveBeenCalledWith({ field: 'severity', operator: 'equals' });
  });
});

describe('the comparison value', () => {
  it('is offered for "is" and collected', async () => {
    const user = userEvent.setup();
    const { onChange } = setup({ value: { field: 'severity', operator: 'equals', value: '' } });

    await user.type(screen.getByLabelText('Value'), 'c');

    expect(onChange).toHaveBeenCalledWith({ field: 'severity', operator: 'equals', value: 'c' });
  });

  it('is not offered for an operator that does not read it', () => {
    setup({ value: { field: 'severity', operator: 'is_set' } });
    expect(screen.queryByLabelText('Value')).toBeNull();
  });

  it('is dropped when switching to an operator that ignores it', async () => {
    // A stale comparison value left in the stored condition does nothing and reads as though it
    // still applies, which is worse than absent.
    const user = userEvent.setup();
    const { onChange } = setup({
      value: { field: 'severity', operator: 'equals', value: 'closure' },
    });

    await user.selectOptions(screen.getByLabelText('Condition'), 'is_set');

    expect(onChange).toHaveBeenCalledWith({ field: 'severity', operator: 'is_set' });
  });
});

describe('nothing to depend on', () => {
  it('says why rather than rendering an empty picker', () => {
    // The advice has to be actionable: an empty `<select>` reads as broken, where "add a second
    // field" names the thing that makes this available.
    setup({ siblings: [] });

    expect(screen.getByText(/only one so far/i)).toBeTruthy();
    expect(screen.queryByLabelText('Show this field when')).toBeNull();
  });
});

describe('accessibility', () => {
  it('has no violations with every control showing', async () => {
    // Scoped to the container: in isolation there is no landmark around the component, and the
    // `region` violation that follows would be an artifact of the test.
    const { container } = setup({
      value: { field: 'severity', operator: 'equals', value: 'closure' },
    });

    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });

  it('labels each control, so the row is not three unnamed selects', () => {
    setup({ value: { field: 'severity', operator: 'equals', value: 'closure' } });

    expect(screen.getByLabelText('Show this field when')).toBeTruthy();
    expect(screen.getByLabelText('Condition')).toBeTruthy();
    expect(screen.getByLabelText('Value')).toBeTruthy();
  });
});
