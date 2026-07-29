// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';

import HotspotEditor, { type HotspotEditorProps } from './HotspotEditor.js';

/**
 * The hotspot editor's keyboard contract.
 *
 * A focal point is a two-dimensional slider, and the obvious implementation — drag only — is
 * unusable without a pointer. The standing rule in this repo is that drag is always *added to*
 * keyboard control, never substituted for it, so the keyboard path is what these tests pin down.
 *
 * jsdom reports every element as zero-sized, so pointer dragging cannot be exercised here: the
 * drag handler divides by the stage's width. That is the same limitation the field builder's tests
 * record, and dragging remains a thing a human has to try in a browser.
 */

// Typed as the props rather than inferred, so a test can pass `width: null` — which is the whole
// point of the unknown-dimensions case.
const base: HotspotEditorProps = {
  mediaId: 'm1',
  url: '/uploads/x.png',
  altText: 'A green gradient',
  width: 1600,
  height: 900,
  initialHotspot: { x: 0.5, y: 0.5 },
  initialCrop: { top: 0, right: 0, bottom: 0, left: 0 },
  canEdit: true,
};

function setup(props: Partial<HotspotEditorProps> = {}) {
  return render(<HotspotEditor {...base} {...props} />);
}

/** The focal-point stage, which is the element that takes the arrow keys. */
const stage = () => screen.getByRole('group', { name: 'Focal point' });

/** The live region's text is the only readable statement of where the point is. */
const position = () => screen.getByTestId('hotspot-position').textContent ?? '';

afterEach(cleanup);

describe('moving the focal point by keyboard', () => {
  it('moves a percent at a time with the arrow keys', async () => {
    const user = userEvent.setup();
    setup();

    stage().focus();
    await user.keyboard('{ArrowRight}');
    expect(position()).toContain('51% from the left');

    await user.keyboard('{ArrowDown}');
    expect(position()).toContain('51% from the top');
  });

  it('moves faster with Shift held', async () => {
    const user = userEvent.setup();
    setup();

    stage().focus();
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}');
    expect(position()).toContain('60% from the left');
  });

  it('jumps to the edges with Home, End, PageUp and PageDown', async () => {
    const user = userEvent.setup();
    setup();

    stage().focus();
    await user.keyboard('{Home}');
    expect(position()).toContain('0% from the left');

    await user.keyboard('{End}');
    expect(position()).toContain('100% from the left');

    await user.keyboard('{PageUp}');
    expect(position()).toContain('0% from the top');

    await user.keyboard('{PageDown}');
    expect(position()).toContain('100% from the top');
  });

  it('stops at the edges rather than wrapping', async () => {
    // Wrapping would move the focal point to the opposite side of the image, which is never what
    // someone nudging towards an edge means.
    const user = userEvent.setup();
    setup({ initialHotspot: { x: 0.99, y: 0.5 } });

    stage().focus();
    await user.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}');
    expect(position()).toContain('100% from the left');
  });

  it('announces the position in a live region', () => {
    // Without this, arrow presses move a purely visual marker and a screen reader user gets no
    // feedback that anything happened at all.
    setup();
    expect(screen.getByTestId('hotspot-position').getAttribute('aria-live')).toBe('polite');
  });

  it('is reachable by Tab', async () => {
    const user = userEvent.setup();
    setup();

    await user.tab();
    expect(document.activeElement).toBe(stage());
  });

  it('is not focusable for a user who cannot edit', () => {
    setup({ canEdit: false });
    expect(stage().getAttribute('tabindex')).toBe('-1');
  });

  it('ignores arrow keys for a user who cannot edit', async () => {
    const user = userEvent.setup();
    setup({ canEdit: false });

    stage().focus();
    await user.keyboard('{ArrowRight}');
    expect(position()).toContain('50% from the left');
  });
});

describe('the focal point stays inside the crop', () => {
  it('clamps to the cropped region', async () => {
    // A focal point outside the crop points at something the editor has already removed, and every
    // preview would pin to the same edge — which reads as the control having stopped working.
    const user = userEvent.setup();
    setup({
      initialCrop: { top: 0, right: 0.4, bottom: 0, left: 0.2 },
      initialHotspot: { x: 0.5, y: 0.5 },
    });

    stage().focus();
    await user.keyboard('{End}');
    expect(position()).toContain('60% from the left');

    await user.keyboard('{Home}');
    expect(position()).toContain('20% from the left');
  });
});

describe('the crop controls', () => {
  it('uses native range inputs, which are keyboard-operable without ARIA', async () => {
    setup();

    for (const side of ['From top', 'From right', 'From bottom', 'From left']) {
      const input = screen.getByLabelText(side) as HTMLInputElement;
      expect(input.type).toBe('range');
    }
  });

  it('gives the range a step fine enough to be useful from the keyboard', () => {
    /**
     * The step, min, and max are asserted rather than the arrow-key behaviour itself.
     *
     * jsdom does not implement native range-input keying, so pressing ArrowRight here changes
     * nothing — a test of it would be testing the browser, and would pass vacuously in a way that
     * hid real regressions. What this repo controls is the attributes that make the native
     * behaviour useful, and those are what is checked.
     */
    setup();
    const top = screen.getByLabelText('From top') as HTMLInputElement;

    expect(top.step).toBe('0.01');
    expect(top.min).toBe('0');
    expect(top.max).toBe('0.9');
  });

  it('refuses a crop that would leave nothing', () => {
    // Everything downstream divides by the cropped region's size. Driven with a change event
    // rather than keystrokes, so it exercises the clamp rather than jsdom's range handling.
    setup({ initialCrop: { top: 0, right: 0.85, bottom: 0, left: 0 } });
    const left = screen.getByLabelText('From left') as HTMLInputElement;

    fireEvent.change(left, { target: { value: '0.5' } });

    expect(Number(left.value)).toBe(0);
  });

  it('accepts a crop that still leaves something', () => {
    setup();
    const left = screen.getByLabelText('From left') as HTMLInputElement;

    fireEvent.change(left, { target: { value: '0.3' } });

    expect(Number(left.value)).toBeCloseTo(0.3, 5);
  });
});

describe('the previews', () => {
  it('shows one frame per shape the site uses', () => {
    setup();

    for (const label of ['Wide', 'Social card', 'Square', 'Portrait']) {
      expect(screen.getByRole('img', { name: `${label} preview` })).toBeTruthy();
    }
  });

  it('says so when the dimensions are unknown rather than showing a wrong crop', () => {
    setup({ width: null, height: null });
    expect(screen.getByText(/dimensions of this file could not be read/i)).toBeTruthy();
  });

  it('moves the previews when the focal point moves', async () => {
    const user = userEvent.setup();
    setup();

    const square = () => screen.getByRole('img', { name: 'Square preview' }).style.backgroundPosition;
    const before = square();

    stage().focus();
    await user.keyboard('{Home}');

    expect(square()).not.toBe(before);
  });
});

describe('saving', () => {
  it('offers no save button to a user who cannot edit', () => {
    setup({ canEdit: false });
    expect(screen.queryByRole('button', { name: /Save focal point/ })).toBeNull();
  });

  it('disables save until something changes', async () => {
    const user = userEvent.setup();
    setup();

    const button = screen.getByRole('button', { name: /Save focal point/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    stage().focus();
    await user.keyboard('{ArrowRight}');
    expect(button.disabled).toBe(false);
  });
});

describe('accessibility of the rendered widget', () => {
  it('has no axe violations', async () => {
    const { container } = setup();

    // Scoped to the container: rendered in isolation there is no landmark around it, and that
    // `region` violation is an artifact of the test rather than of the component.
    const results = await axe.run(container, {
      resultTypes: ['violations'],
      // jsdom computes no layout and resolves no custom properties; contrast is checked
      // numerically in a11y-contrast.mjs.
      rules: { 'color-contrast': { enabled: false } },
    });

    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });

  it('describes the image once, not five times', () => {
    // The stage carries the real alt text; the four shape previews are labelled by shape, because
    // repeating a description four more times is noise rather than information.
    const { container } = setup();
    const described = within(container).getAllByAltText('A green gradient');

    expect(described).toHaveLength(1);
  });
});
