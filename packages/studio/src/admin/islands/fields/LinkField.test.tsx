// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LinkField, type LinkValue } from './LinkField.js';
import type { MediaOption } from '../../mediaOptions.js';

/**
 * The `link` field's editing control.
 *
 * `scripts/a11y-audit.mjs` cannot see any of this: the dialog only exists after hydration and only
 * once it has been opened, so this file is the whole accessibility check for it as well as the
 * behavioural one.
 *
 * What is actually worth asserting is the *translation*. The control is `LinkDialog`, which rich
 * text already tests; what is new here is turning what the dialog produces — one `href` string, in
 * the `taproot:` reference vocabulary — into the `{ kind, id | href }` a link field stores. Getting
 * that wrong is silent in exactly the way this repo keeps rediscovering: an object is still stored,
 * validation still passes, and the site renders a button that goes nowhere. So every test below
 * performs the act and inspects what came out, rather than asserting a control exists.
 */

const MEDIA: MediaOption[] = [
  {
    id: '33333333-3333-3333-3333-333333333333',
    filename: 'prospectus.pdf',
    url: '/media/prospectus.pdf',
    altText: null,
    mimeType: 'application/pdf',
    width: null,
    height: null,
  },
];

function renderField(overrides: Partial<React.ComponentProps<typeof LinkField>> = {}) {
  const onChange = vi.fn();
  render(
    <>
      <span id="cta-label">Call to action</span>
      <LinkField
        id="cta"
        labelledBy="cta-label"
        value={null}
        onChange={onChange}
        media={MEDIA}
        {...overrides}
      />
    </>,
  );
  return { onChange };
}

beforeEach(() => {
  // `useResolvedTarget` looks an id up to show a title rather than a uuid. Nothing here asserts on
  // the resolved name, but an unstubbed fetch would leave the component in "Looking it up…".
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify({ item: { id: 'x', title: 'Apply', path: '/apply' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('what the control produces', () => {
  it('turns a typed address into a url link', async () => {
    const user = userEvent.setup();
    const { onChange } = renderField();

    await user.click(screen.getByRole('button', { name: /choose a link/i }));
    // The dialog opens on the page panel, so the address box does not exist until this switch.
    await user.click(await screen.findByRole('radio', { name: 'Web address' }));
    await user.type(await screen.findByLabelText('Link address'), 'https://example.edu/apply');
    await user.click(screen.getByRole('button', { name: /^apply$/i }));

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange.mock.calls[0]![0]).toMatchObject({
      kind: 'url',
      href: 'https://example.edu/apply',
      newTab: false,
    });
  });

  /**
   * The half a relation field could never do, and the reason the options are stored per link rather
   * than configured per field: the same button is internal on one page and external on another.
   */
  it('carries the new-tab choice onto the stored value', async () => {
    const user = userEvent.setup();
    const { onChange } = renderField();

    await user.click(screen.getByRole('button', { name: /choose a link/i }));
    await user.click(await screen.findByRole('radio', { name: 'Web address' }));
    await user.type(await screen.findByLabelText('Link address'), 'https://example.edu');
    await user.click(screen.getByLabelText(/new tab/i));
    await user.click(screen.getByRole('button', { name: /^apply$/i }));

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange.mock.calls[0]![0]).toMatchObject({ kind: 'url', newTab: true });
  });

  /**
   * The gap this field shipped with.
   *
   * `LinkDialog` had no label input at all — it derived one from the target, which is right for rich
   * text (the label is the selection) and wrong here, where the label *is* the button. Every button
   * came out named after the page it pointed at, with no way to say "Explore academics" instead of
   * "Academics". The earlier test asserted a label arrived, and one always did; asserting it came
   * from the author is what was missing.
   */
  it('lets the author write the label, rather than only deriving it', async () => {
    const user = userEvent.setup();
    const { onChange } = renderField();

    await user.click(screen.getByRole('button', { name: /choose a link/i }));
    await user.click(await screen.findByRole('radio', { name: 'Web address' }));
    await user.type(await screen.findByLabelText('Link address'), 'https://example.edu/book');
    await user.type(screen.getByLabelText(/link text/i), 'Reserve your place');
    await user.click(screen.getByRole('button', { name: /^apply$/i }));

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange.mock.calls[0]![0]).toMatchObject({
      kind: 'url',
      href: 'https://example.edu/book',
      label: 'Reserve your place',
    });
  });

  /** Blank still means "use the target's own name", which is what the placeholder promises. */
  it('falls back to the derived label when the box is left empty', async () => {
    const user = userEvent.setup();
    const { onChange } = renderField();

    await user.click(screen.getByRole('button', { name: /choose a link/i }));
    await user.click(await screen.findByRole('radio', { name: 'Web address' }));
    await user.type(await screen.findByLabelText('Link address'), 'https://example.edu');
    await user.click(screen.getByRole('button', { name: /^apply$/i }));

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange.mock.calls[0]![0]).toMatchObject({ label: 'https://example.edu' });
  });

  /** Editing opens on the words already stored, not on an empty box. */
  it('opens on the existing label', async () => {
    const user = userEvent.setup();
    renderField({
      value: { kind: 'url', href: 'https://example.edu', label: 'Book a visit', newTab: false, noFollow: false },
    });

    await user.click(screen.getByRole('button', { name: /edit/i }));

    expect((await screen.findByLabelText(/link text/i)).getAttribute('value') ?? (screen.getByLabelText(/link text/i) as HTMLInputElement).value).toBe('Book a visit');
  });

  /** Removing clears the field. There is no surrounding text to keep, unlike unlinking in prose. */
  it('clears the value rather than storing an empty link', async () => {
    const user = userEvent.setup();
    const value: LinkValue = { kind: 'url', href: 'https://example.edu', newTab: false, noFollow: false };
    const { onChange } = renderField({ value });

    await user.click(screen.getByRole('button', { name: /edit/i }));
    await user.click(await screen.findByRole('button', { name: /remove link/i }));

    expect(onChange).toHaveBeenCalledWith(null);
  });
});

describe('what the control shows', () => {
  it('shows the author’s own label rather than a raw reference', () => {
    renderField({
      value: {
        kind: 'item',
        id: '11111111-1111-1111-1111-111111111111',
        label: 'Reserve your place',
        newTab: false,
        noFollow: false,
      },
    });

    expect(screen.getByText('Reserve your place')).toBeDefined();
    // The uuid is correct and unreadable — the whole reason `LinkDialog` resolves targets at all.
    expect(screen.queryByText(/taproot:item:/)).toBeNull();
  });

  it('offers no file panel when the field does not allow one', async () => {
    const user = userEvent.setup();
    renderField({ allowedKinds: ['item', 'url'] });

    await user.click(screen.getByRole('button', { name: /choose a link/i }));
    await screen.findByRole('dialog');

    expect(screen.queryByRole('radio', { name: 'File' })).toBeNull();
  });
});

describe('accessibility', () => {
  /**
   * The field is named through `aria-labelledby`, not `<label for>` — `id` sits on a `role="group"`,
   * which is not a labelable element, so a label pointing at it would be silently inert. That is the
   * rule `a11y-audit.mjs` checks directly, and `FieldControl.labelsAControl()` has to agree.
   */
  it('names the group without a label pointing at a non-labelable element', () => {
    renderField();

    expect(screen.getByRole('group', { name: 'Call to action' })).toBeDefined();
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <>
        <span id="l">Call to action</span>
        <LinkField id="cta" labelledBy="l" value={null} onChange={() => {}} media={MEDIA} />
      </>,
    );

    const results = await axe.run(container, {
      resultTypes: ['violations'],
      // jsdom computes no layout and resolves no custom properties; contrast is measured
      // numerically in `a11y-contrast.mjs` instead.
      rules: { 'color-contrast': { enabled: false } },
    });

    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });

  it('has no axe violations with the dialog open', async () => {
    const user = userEvent.setup();
    renderField();

    await user.click(screen.getByRole('button', { name: /choose a link/i }));

    /**
     * Scoped to the dialog: Radix portals it to `document.body`, so the render container is empty
     * and auditing the body in isolation reports a `region` violation that is an artifact of there
     * being no page around it.
     */
    const results = await axe.run(await screen.findByRole('dialog'), {
      resultTypes: ['violations'],
      rules: { 'color-contrast': { enabled: false } },
    });

    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});
