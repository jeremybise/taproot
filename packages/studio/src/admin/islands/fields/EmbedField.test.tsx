// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EmbedValue } from '@taprootcms/core';

import { EmbedField } from './EmbedField.js';

/**
 * The `embed` field's editing control.
 *
 * Every test here performs the act and inspects what came out, rather than asserting an input
 * exists — the rule this repo arrived at after the link search shipped with tests for its label, its
 * placeholder and its tab order, and no ability to create a link.
 *
 * The host feedback is worth testing for a second reason: it is deliberately *not* the boundary
 * (`validateItemData` is), so it can only be wrong in the direction of confusing an editor. A hint
 * that fires on a half-typed address is the version that gets ignored, which is why the "says
 * nothing yet" cases below matter as much as the refusals.
 */

const ALLOWED = ['youtube.com'];

function renderField(overrides: Partial<React.ComponentProps<typeof EmbedField>> = {}) {
  const onChange = vi.fn();
  const { container } = render(
    <>
      <span id="video-label">Video</span>
      <EmbedField
        id="video"
        labelledBy="video-label"
        value={null}
        onChange={onChange}
        allowedHosts={ALLOWED}
        {...overrides}
      />
    </>,
  );
  return { onChange, container };
}

afterEach(cleanup);

/**
 * A parent that actually holds the value, which is the only way typing proves anything.
 *
 * Rendered without one, `EmbedField` is controlled by a `value` that never changes, so every
 * keystroke reports a one-character string and the test passes while accumulating nothing. That is
 * the same class of blind spot as rendering the richtext editor outside a `<form>`: the component
 * was never in the tree it has to work in.
 */
function Harness({ allowedHosts = ALLOWED }: { allowedHosts?: string[] }) {
  const [value, setValue] = useState<EmbedValue | null>(null);
  return (
    <>
      <span id="video-label">Video</span>
      <EmbedField
        id="video"
        labelledBy="video-label"
        value={value}
        onChange={setValue}
        allowedHosts={allowedHosts}
      />
      <output data-testid="stored">{JSON.stringify(value)}</output>
    </>
  );
}

describe('writing a value', () => {
  it('an address and a title typed in actually become the stored value', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.type(screen.getByLabelText('Address'), 'https://youtube.com/embed/abc');
    await user.type(screen.getByLabelText('Title'), 'Campus tour');

    expect(JSON.parse(screen.getByTestId('stored').textContent!)).toEqual({
      url: 'https://youtube.com/embed/abc',
      title: 'Campus tour',
    });
  });

  it('clears back to null when both boxes are emptied', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.type(screen.getByLabelText('Address'), 'https://youtube.com/e');
    await user.clear(screen.getByLabelText('Address'));

    expect(screen.getByTestId('stored').textContent).toBe('null');
  });

  it('clears rather than storing an empty pair', async () => {
    /**
     * `{ url: '', title: '' }` is a *present* value that validation then refuses for a missing
     * address — so an optional embed nobody filled in would block the save. Null is what "not filled
     * in" means for every other field here.
     */
    const user = userEvent.setup();
    const { onChange } = renderField({ value: { url: 'https://youtube.com/e', title: '' } });

    await user.clear(screen.getByLabelText('Address'));

    expect(onChange).toHaveBeenLastCalledWith(null);
  });
});

describe('host feedback', () => {
  it('names the approved sites before anything is typed', () => {
    renderField();
    expect(screen.getByText(/Approved sites: youtube\.com/)).toBeTruthy();
  });

  it('says nothing accusing about a half-typed address', () => {
    // Two keystrokes in, `https://ww` is neither valid nor approved. Shouting here is how a hint
    // teaches somebody to stop reading it.
    renderField({ value: { url: 'https://ww', title: '' } });
    expect(screen.queryByText(/is not approved/)).toBeNull();
  });

  it('reports a host that is not approved', () => {
    renderField({ value: { url: 'https://evil.example/x', title: '' } });
    expect(screen.getByText(/evil\.example is not approved/)).toBeTruthy();
  });

  it('reports a lookalike host', () => {
    // The control calls core's `embedHostAllowed`, so this is really asserting it did not grow its
    // own opinion about what `youtube.com` covers.
    renderField({ value: { url: 'https://evil-youtube.com/x', title: '' } });
    expect(screen.getByText(/evil-youtube\.com is not approved/)).toBeTruthy();
  });

  it('accepts a subdomain of an approved host', () => {
    renderField({ value: { url: 'https://www.youtube.com/embed/a', title: '' } });
    expect(screen.queryByText(/is not approved/)).toBeNull();
  });

  it('stays quiet on a scheme that is still being typed', () => {
    // `new URL('http:')` parses, so a protocol check placed before the plausible-host check would
    // flash a red warning at somebody on their way to typing `https://`.
    renderField({ value: { url: 'http:', title: '' } });
    expect(screen.queryByText(/must use https/i)).toBeNull();
  });

  it('reports an http address', () => {
    renderField({ value: { url: 'http://youtube.com/embed/a', title: '' } });
    expect(screen.getByText(/must use https/i)).toBeTruthy();
  });

  it('says so when no site has been approved at all', () => {
    renderField({ allowedHosts: [] });
    expect(screen.getByText(/no approved sites yet/)).toBeTruthy();
  });

  it('offers a way out to the real thing only once the address is usable', async () => {
    const { rerender } = render(
      <EmbedField
        value={{ url: 'https://evil.example/x', title: 'T' }}
        onChange={vi.fn()}
        allowedHosts={ALLOWED}
      />,
    );
    expect(screen.queryByRole('link')).toBeNull();

    rerender(
      <EmbedField
        value={{ url: 'https://youtube.com/embed/a', title: 'T' }}
        onChange={vi.fn()}
        allowedHosts={ALLOWED}
      />,
    );
    expect(screen.getByRole('link').getAttribute('href')).toBe('https://youtube.com/embed/a');
  });
});

describe('accessibility', () => {
  it('names the group from the field label and both inputs from their own', () => {
    renderField();

    // The group is not labelable, so it is named through `aria-labelledby` — the rule
    // `scripts/a11y-audit.mjs` enforces. The two inputs inside it *are* labelable and carry real
    // `<label for>`s, which is a separate question and the reason `labelsAControl` returns false.
    expect(screen.getByRole('group').getAttribute('aria-labelledby')).toBe('video-label');
    expect(screen.getByLabelText('Address').tagName).toBe('INPUT');
    expect(screen.getByLabelText('Title').tagName).toBe('INPUT');
  });

  it('ties the host hint to the address box', () => {
    renderField();
    const address = screen.getByLabelText('Address');
    const describedBy = address.getAttribute('aria-describedby');

    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toContain('Approved sites');
  });

  it('has no axe violations', async () => {
    const { container } = renderField({ value: { url: 'https://evil.example/x', title: 'T' } });

    const results = await axe.run(container, {
      resultTypes: ['violations'],
      // jsdom computes no layout and resolves no custom properties; contrast is measured
      // numerically in `a11y-contrast.mjs` instead.
      rules: { 'color-contrast': { enabled: false } },
    });

    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});
