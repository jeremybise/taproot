// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { primaryTransition, transitionsFrom, type ContentStatus, type FieldRow } from '@taprootcms/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ItemEditor from './ItemEditor.js';

/**
 * The status controls: one promoted action, the rest behind a disclosure.
 *
 * Four full-width transition buttons were most of the editor's sidebar, and on any given edit three
 * of them are rare. What must survive the change is the thing the original comment defended — the
 * control says "Submit for review", not "in_review" — and what must not regress is the keyboard
 * contract, which `scripts/a11y-audit.mjs` cannot check because the menu only exists after
 * hydration.
 */

const FIELDS: FieldRow[] = [
  {
    id: 'f-body',
    content_type_id: 'ct',
    api_id: 'body',
    label: 'Body',
    type: 'text',
    help_text: null,
    position: 0,
    required: 0,
    localized: 0,
    config: '{}',
    created_at: '',
    updated_at: '',
  } as FieldRow,
];

function renderEditor(status: ContentStatus, canPublish = true) {
  return render(
    <ItemEditor
      itemId="item-1"
      contentTypeId="ct"
      contentTypeName="Page"
      fields={FIELDS}
      initial={{
        title: 'Admissions',
        slug: 'admissions',
        status,
        publishAt: null,
        parentId: null,
        data: { body: 'x' },
        seo: {},
      }}
      parents={[]}
      canPublish={canPublish}
      isHierarchical={false}
      path="/admissions"
    />,
  );
}

/** The disclosure trigger, whichever of its two labels applies. */
const moreTrigger = () => screen.getByRole('button', { name: /More…|Change status…/ });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('what gets promoted', () => {
  it('offers the forward move as a named button on a draft', async () => {
    renderEditor('draft');

    // The label is the act, not the status code. That is the whole of the original argument.
    expect(screen.getByRole('button', { name: 'Publish' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^in_review$/ })).toBeNull();
  });

  it('promotes handing on rather than publishing when the role cannot publish', async () => {
    renderEditor('draft', false);

    expect(screen.getByRole('button', { name: 'Submit for review' })).toBeTruthy();
  });

  it('promotes nothing on a published page', async () => {
    /**
     * Everything reachable from `published` is unusual — back to draft, back to review, schedule,
     * archive — and the usual reason to open a live page is to edit it and press Save. So the
     * trigger changes wording rather than promoting a button nobody wants.
     */
    renderEditor('published');

    expect(screen.getByRole('button', { name: 'Change status…' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^More…$/ })).toBeNull();
  });

  it('shows no disclosure at all when there is only one move', async () => {
    // `archived` has exactly one transition, so there is nothing to hide behind a menu.
    renderEditor('archived');

    expect(screen.getByRole('button', { name: 'Restore as draft' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /More…|Change status…/ })).toBeNull();
  });

  it('offers every legal transition between the button and the menu, and no more', async () => {
    // The screen must not offer something the API would refuse, and must not hide something it
    // would allow — so the two halves have to add up to exactly the table in core.
    const user = userEvent.setup();
    renderEditor('draft');
    await user.click(moreTrigger());

    const menu = screen.getByRole('list');
    const inMenu = within(menu).getAllByRole('button').length;
    const promoted = primaryTransition('draft', true) ? 1 : 0;

    expect(inMenu + promoted).toBe(transitionsFrom('draft').length);
  });
});

describe('the disclosure', () => {
  it('has no axe violations open or closed', async () => {
    const user = userEvent.setup();
    const { container } = renderEditor('draft');

    const closed = await axe.run(container, {
      resultTypes: ['violations'],
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(closed.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

    await user.click(moreTrigger());

    const open = await axe.run(container, {
      resultTypes: ['violations'],
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(open.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });

  it('reports its state and points at its panel', async () => {
    const user = userEvent.setup();
    const { container } = renderEditor('draft');
    const trigger = moreTrigger();

    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await user.click(trigger);

    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const id = trigger.getAttribute('aria-controls')!;
    expect(container.querySelector(`#${CSS.escape(id)}`)).not.toBeNull();
  });

  it('closes on Escape and returns nothing to the void', async () => {
    const user = userEvent.setup();
    renderEditor('draft');
    await user.click(moreTrigger());

    await user.keyboard('{Escape}');

    await waitFor(() => expect(moreTrigger().getAttribute('aria-expanded')).toBe('false'));
  });

  it('closes when a click lands outside it', async () => {
    const user = userEvent.setup();
    renderEditor('draft');
    await user.click(moreTrigger());

    await user.click(screen.getByLabelText('Title'));

    await waitFor(() => expect(moreTrigger().getAttribute('aria-expanded')).toBe('false'));
  });

  it('applies the chosen transition and closes', async () => {
    const user = userEvent.setup();
    renderEditor('draft');
    await user.click(moreTrigger());

    await user.click(screen.getByRole('button', { name: 'Archive' }));

    // Staged, not performed — nothing moves until Save, which is what the revert below proves.
    await waitFor(() => expect(moreTrigger().getAttribute('aria-expanded')).toBe('false'));
    expect(screen.getByRole('button', { name: /Keep as draft/i })).toBeTruthy();
  });
});
