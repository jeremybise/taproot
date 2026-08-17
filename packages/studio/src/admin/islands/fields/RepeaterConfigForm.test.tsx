// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';

import { validateItemData, type FieldRow } from '@taprootcms/core';

import { fieldConfigForms } from './FieldConfigForm.js';

/**
 * The `repeater` field's config form, and specifically its sort control.
 *
 * Rendered and driven rather than asserted against a hand-written literal, and then **fed through
 * `validateItemData`** — because the failure this class of test exists to catch is a form that emits
 * a shape core does not read. A config storing `sortField` where core looks for `sortBy` would look
 * completely correct on this screen and do nothing at all on save.
 *
 * It is also the only accessibility check this form gets: it is a React island, so
 * `scripts/a11y-audit.mjs` sees the server-rendered placeholder and never these controls.
 */

const Repeater = fieldConfigForms.repeater;

const subFields = [
  { api_id: 'code', label: 'Course code', type: 'text', required: false, config: {} },
  { api_id: 'description', label: 'Description', type: 'richtext', required: false, config: {} },
  { api_id: 'credits', label: 'Credits', type: 'number', required: false, config: {} },
];

function Harness({ fields = subFields }: { fields?: Record<string, unknown>[] } = {}) {
  const [config, setConfig] = useState<Record<string, unknown>>({ fields });
  return (
    <>
      <Repeater
        config={config}
        onChange={setConfig}
        contentTypes={[]}
        taxonomies={[]}
        currentContentTypeId="ct"
      />
      <output data-testid="config">{JSON.stringify(config)}</output>
    </>
  );
}

const stored = () => JSON.parse(screen.getByTestId('config').textContent || '{}');

afterEach(cleanup);

describe('keeping entries in order', () => {
  it('defaults to the order they are entered in', () => {
    render(<Harness />);

    const select = screen.getByLabelText(/Keep entries in order of/i) as HTMLSelectElement;
    expect(select.value).toBe('');
    expect(stored().sortBy).toBeUndefined();
    // No direction until there is something to direct — a lone "A to Z" beside "the order they are
    // entered in" would be a control with nothing to act on.
    expect(screen.queryByLabelText('Direction')).toBeNull();
  });

  /**
   * A richtext body sorts by its markup, which is nonsense dressed as a feature; `media`, `relation`
   * and `taxonomy` store ids that sort by nothing an author can see.
   */
  it('offers only sub-fields worth ordering by', () => {
    render(<Harness />);

    const options = [...(screen.getByLabelText(/Keep entries in order of/i) as HTMLSelectElement).options].map(
      (option) => option.textContent,
    );

    expect(options).toContain('Course code');
    expect(options).toContain('Credits');
    expect(options).not.toContain('Description');
  });

  it('renders nothing at all when no sub-field could be sorted by', () => {
    render(
      <Harness
        fields={[{ api_id: 'body', label: 'Body', type: 'richtext', required: false, config: {} }]}
      />,
    );

    expect(screen.queryByLabelText(/Keep entries in order of/i)).toBeNull();
  });

  /**
   * The half this test file exists for: what the form emits has to be what `validateItemData` reads.
   * A stored `sortField` would render identically here and sort nothing on save.
   */
  it('emits a config that core actually sorts by', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.selectOptions(screen.getByLabelText(/Keep entries in order of/i), 'code');

    expect(stored().sortBy).toBe('code');

    const field = {
      id: 'f1',
      content_type_id: 'ct',
      api_id: 'courses',
      label: 'Courses',
      type: 'repeater',
      help_text: null,
      position: 0,
      required: 0,
      localized: 0,
      visible_when: null,
      config: JSON.stringify(stored()),
      created_at: '',
      updated_at: '',
    } as FieldRow;

    const result = validateItemData([field], {
      courses: [
        { id: 'a', data: { code: 'RAD 196' } },
        { id: 'b', data: { code: 'ART 101' } },
      ],
    });

    expect((result.data!.courses as { data: { code: string } }[]).map((r) => r.data.code)).toEqual([
      'ART 101',
      'RAD 196',
    ]);
  });

  it('offers a direction once a field is chosen, and stores it', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.selectOptions(screen.getByLabelText(/Keep entries in order of/i), 'code');
    await user.selectOptions(screen.getByLabelText('Direction'), 'desc');

    expect(stored()).toMatchObject({ sortBy: 'code', sortDirection: 'desc' });
  });

  /** Going back to manual clears both keys rather than leaving a direction with nothing to direct. */
  it('clears the direction when the sort is turned off', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.selectOptions(screen.getByLabelText(/Keep entries in order of/i), 'code');
    await user.selectOptions(screen.getByLabelText('Direction'), 'desc');
    await user.selectOptions(screen.getByLabelText(/Keep entries in order of/i), '');

    expect(stored().sortBy).toBeUndefined();
    expect(stored().sortDirection).toBeUndefined();
  });

  it('has no axe violations', async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness />);

    await user.selectOptions(screen.getByLabelText(/Keep entries in order of/i), 'code');

    // Scoped to the container: in isolation there is no landmark around the component, so `region`
    // would fire on an artifact of the test.
    const results = await axe.run(container, {
      rules: { region: { enabled: false }, 'color-contrast': { enabled: false } },
    });
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});
