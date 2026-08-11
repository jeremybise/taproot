/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AiButton } from './AiButton.js';

/**
 * What must stay true of the AI marker.
 *
 * The colour is checked by `a11y-contrast.mjs` and the generated mark by the icon build, so what is
 * left here is the property neither can see: that the button still reads correctly with the colour
 * and the icon taken away. That is WCAG 1.4.1, and it is the rule the status badges keep by
 * construction — strip the hue and a text label is still there.
 */
// Vitest registers no global RTL cleanup here, so renders accumulate across tests in one file and a
// query written for this test matches a button the previous one left behind. Explicit, as the other
// island suites do it.
afterEach(cleanup);

describe('AiButton', () => {
  it('carries its meaning in text, not in the mark', () => {
    render(<AiButton onClick={() => {}}>Generate from page content</AiButton>);

    // The accessible name is the label. If this ever became icon-only, this fails.
    expect(screen.getByRole('button', { name: /generate from page content/i })).toBeTruthy();
  });

  it('hides the mark from assistive technology', () => {
    const { container } = render(<AiButton onClick={() => {}}>Suggest</AiButton>);

    // Decoration beside a real label, not a second thing to announce.
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute('aria-hidden')).toBe('true');
  });

  it('reports a request in flight in words, not by opacity alone', async () => {
    render(
      <AiButton onClick={() => {}} busy busyLabel="Generating…">
        Suggest
      </AiButton>,
    );

    // Opacity is not a status. The label is what changes.
    const button = screen.getByRole('button', { name: /generating/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.queryByRole('button', { name: /^suggest$/i })).toBeNull();
  });

  it('distinguishes rows that would otherwise share one label', () => {
    render(
      <>
        <AiButton onClick={() => {}} srSuffix="a description for quad.png">
          Suggest
        </AiButton>
        <AiButton onClick={() => {}} srSuffix="a description for library.png">
          Suggest
        </AiButton>
      </>,
    );

    // Every row's button reads "Suggest"; without the suffix a screen-reader user gets a list of
    // identical controls with no way to tell which image one belongs to.
    expect(screen.getByRole('button', { name: /quad\.png/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /library\.png/ })).toBeTruthy();
  });

  it('does not fire while busy', async () => {
    const onClick = vi.fn();
    render(
      <AiButton onClick={onClick} busy>
        Suggest
      </AiButton>,
    );

    await userEvent.click(screen.getByRole('button')).catch(() => {});
    // A second press mid-request would spend credit twice for one answer.
    expect(onClick).not.toHaveBeenCalled();
  });

  it('fires once when idle', async () => {
    const onClick = vi.fn();
    render(<AiButton onClick={onClick}>Suggest</AiButton>);

    await userEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
