// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OverflowMenu } from './OverflowMenu.js';

/**
 * The `⋯` menu's half of the disclosure contract.
 *
 * `useDismissable.ts` states that contract as four points and says a change to one implementation is
 * a change to the other. It is a doc comment, and a doc comment is not a test — the Astro side has
 * `UserMenu.astro` exercised through the audit, and this is the React side's equivalent.
 *
 * Focus return is the point most easily lost: the hook reports the *intent* to close and cannot know
 * which element opened the panel, so the component has to move focus itself. A menu that closes
 * leaving focus on `<body>` drops a keyboard user to the top of the page, which nothing visual shows.
 */

const items = [
  { label: 'Save to the library', onSelect: vi.fn() },
  { label: 'Remove', onSelect: vi.fn(), danger: true },
];

afterEach(cleanup);

describe('OverflowMenu', () => {
  it('is closed until asked, and says so on the trigger', () => {
    render(<OverflowMenu label="More actions for Quote" items={items} />);

    const trigger = screen.getByRole('button', { name: 'More actions for Quote' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
  });

  it('opens, and the trigger names what it acts on', async () => {
    const user = userEvent.setup();
    render(<OverflowMenu label="More actions for Quote" items={items} />);

    const trigger = screen.getByRole('button', { name: 'More actions for Quote' });
    await user.click(trigger);

    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    // `aria-controls` has to name a node that exists, or it is a promise to a screen reader that
    // the page does not keep.
    const controlled = trigger.getAttribute('aria-controls')!;
    expect(document.getElementById(controlled)).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy();
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    render(<OverflowMenu label="More actions for Quote" items={items} />);

    const trigger = screen.getByRole('button', { name: 'More actions for Quote' });
    await user.click(trigger);
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('closes on a click outside', async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">Elsewhere</button>
        <OverflowMenu label="More actions for Quote" items={items} />
      </>,
    );

    await user.click(screen.getByRole('button', { name: 'More actions for Quote' }));
    await user.click(screen.getByRole('button', { name: 'Elsewhere' }));

    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
  });

  it('runs the action and closes', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <OverflowMenu label="More actions for Quote" items={[{ label: 'Remove', onSelect }]} />,
    );

    await user.click(screen.getByRole('button', { name: 'More actions for Quote' }));
    await user.click(screen.getByRole('button', { name: 'Remove' }));

    expect(onSelect).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
  });

  it('renders nothing at all when it would hold no actions', () => {
    // A contributor sees neither promote nor detach on an ordinary block, which would otherwise
    // leave a trigger that opens an empty panel.
    const { container } = render(<OverflowMenu label="More actions" items={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('has no axe violations when open', async () => {
    const user = userEvent.setup();
    const { container } = render(<OverflowMenu label="More actions for Quote" items={items} />);
    await user.click(screen.getByRole('button', { name: 'More actions for Quote' }));

    // Scoped to the container: in isolation there is no landmark around the component, and the
    // resulting `region` violation is an artifact of the test rather than of the markup.
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});
