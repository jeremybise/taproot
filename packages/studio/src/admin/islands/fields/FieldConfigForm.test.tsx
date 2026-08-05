// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';

import { parseFieldConfig } from '@taprootcms/core';

import { fieldConfigForms } from './FieldConfigForm.js';

/**
 * The `embed` field's config form.
 *
 * `fieldConfigForms.test.ts` beside this checks that every field type *has* a form and that a
 * hand-written literal round-trips through core — which is the shape of test that passes while the
 * form emits something else entirely. This renders the real thing, drives it, and feeds what it
 * actually produced back through `parseFieldConfig`.
 *
 * It is also the only accessibility check this form gets: it is a React island, so
 * `scripts/a11y-audit.mjs` sees the server-rendered placeholder and never the controls.
 */

const Embed = fieldConfigForms.embed;

function Harness() {
  const [config, setConfig] = useState<Record<string, unknown>>({});
  return (
    <>
      <Embed
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

describe('approved hosts', () => {
  it('a preset writes hosts core then accepts', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole('button', { name: 'YouTube' }));

    expect(stored().allowedHosts).toEqual(['youtube.com', 'youtube-nocookie.com']);

    const parsed = parseFieldConfig('embed', stored());
    expect(parsed.success, !parsed.success ? parsed.issues.join('; ') : '').toBe(true);
  });

  it('splits a comma-separated paste rather than storing one impossible host', async () => {
    // What somebody who has written a CSP header will type. Storing `a.com, b.com` as a single
    // entry would match nothing and look correct in the box.
    const user = userEvent.setup();
    render(<Harness />);

    await user.type(screen.getByLabelText('Approved sites'), 'youtube.com, player.vimeo.com');

    expect(stored().allowedHosts).toEqual(['youtube.com', 'player.vimeo.com']);
  });

  it('does not offer a preset that is already listed', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const youtube = screen.getByRole('button', { name: 'YouTube' });
    await user.click(youtube);

    expect(youtube.hasAttribute('disabled')).toBe(true);
  });
});

describe('frame height', () => {
  it('switching to auto stores the mode and offers a minimum, not a ratio', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole('radio', { name: /report its height/i }));

    expect(stored().sizing).toEqual({ mode: 'auto', minHeight: 400 });
    expect(screen.getByLabelText(/Minimum height/)).toBeTruthy();
    expect(screen.queryByLabelText(/Ratio/)).toBeNull();

    const parsed = parseFieldConfig('embed', stored());
    expect(parsed.success, !parsed.success ? parsed.issues.join('; ') : '').toBe(true);
  });

  it('each mode emits a shape core accepts', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    for (const name of [/aspect ratio/i, /fixed height/i, /report its height/i]) {
      await user.click(screen.getByRole('radio', { name }));

      const parsed = parseFieldConfig('embed', stored());
      expect(parsed.success, !parsed.success ? parsed.issues.join('; ') : '').toBe(true);
    }
  });
});

describe('accessibility', () => {
  it('has no axe violations in any mode', async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness />);

    for (const name of [/aspect ratio/i, /fixed height/i, /report its height/i]) {
      await user.click(screen.getByRole('radio', { name }));

      const results = await axe.run(container, {
        resultTypes: ['violations'],
        // jsdom computes no layout and resolves no custom properties; contrast is measured
        // numerically in `a11y-contrast.mjs` instead.
        rules: { 'color-contrast': { enabled: false } },
      });

      expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
    }
  });

  it('names every control from a real label', () => {
    render(<Harness />);

    // The mode selector is a radio group rather than hand-built tabs, so the roving tabindex and
    // the tab/panel wiring come from the platform — the house rule about custom widgets.
    expect(screen.getAllByRole('radio')).toHaveLength(3);
    expect(screen.getByLabelText('Approved sites').tagName).toBe('TEXTAREA');
  });
});
