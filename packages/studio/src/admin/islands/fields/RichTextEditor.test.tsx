// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RichTextEditor } from './RichTextEditor.js';

/**
 * Hydrated-behaviour tests for the richtext toolbar.
 *
 * These exist because the axe run in `scripts/a11y-audit.mjs` cannot reach this component at all:
 * ProseMirror needs a real DOM, so the editor is created after hydration and the server-rendered
 * markup is an empty placeholder. Without these tests the toolbar — a custom widget implementing
 * the ARIA toolbar pattern by hand, which is exactly where WCAG failures creep in — would be
 * entirely unverified.
 *
 * Still not covered, and still needing a human with a real browser: screen-reader output, and text
 * selection behaviour, which jsdom does not model.
 */

function setup(props: Partial<Parameters<typeof RichTextEditor>[0]> = {}) {
  const onChange = vi.fn();
  const result = render(
    <>
      <span id="label">Body</span>
      <RichTextEditor
        id="editor"
        value="<p>Hello</p>"
        onChange={onChange}
        labelledBy="label"
        {...props}
      />
    </>,
  );
  return { onChange, ...result };
}

/**
 * Render and wait for the editor.
 *
 * ProseMirror is created in an effect, so the toolbar does not exist on the first render. Bundling
 * the wait into the render keeps that from being something each test has to remember.
 */
async function setupWithToolbar(props: Partial<Parameters<typeof RichTextEditor>[0]> = {}) {
  const rendered = setup(props);
  const bar = await waitFor(() => screen.getByRole('toolbar', { name: 'Text formatting' }));
  return { ...rendered, bar };
}

afterEach(cleanup);

describe('the toolbar follows the ARIA toolbar pattern', () => {
  it('is a single tab stop rather than one per button', async () => {
    // The reason the pattern exists: fifteen tabbable buttons in front of every richtext field
    // would mean fifteen Tab presses to reach the text a keyboard user came to write.
    const { bar } = await setupWithToolbar();

    const buttons = within(bar).getAllByRole('button');
    expect(buttons.length).toBeGreaterThan(5);
    expect(buttons.filter((b) => b.getAttribute('tabindex') === '0')).toHaveLength(1);
    expect(buttons[0]!.getAttribute('tabindex')).toBe('0');
  });

  it('moves focus with the arrow keys', async () => {
    const user = userEvent.setup();
    const { bar } = await setupWithToolbar();
    const buttons = within(bar).getAllByRole('button');

    buttons[0]!.focus();
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(buttons[1]);

    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(buttons[0]);
  });

  it('wraps around at both ends', async () => {
    const user = userEvent.setup();
    const { bar } = await setupWithToolbar();
    const buttons = within(bar).getAllByRole('button');

    buttons[0]!.focus();
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(buttons[buttons.length - 1]);
  });

  it('jumps to the ends with Home and End', async () => {
    const user = userEvent.setup();
    const { bar } = await setupWithToolbar();
    const buttons = within(bar).getAllByRole('button');

    buttons[2]!.focus();
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(buttons[0]);

    await user.keyboard('{End}');
    expect(document.activeElement).toBe(buttons[buttons.length - 1]);
  });

  it('gives every button a name, since they are icon-only', async () => {
    const { bar } = await setupWithToolbar();

    for (const button of within(bar).getAllByRole('button')) {
      expect(button.getAttribute('aria-label')?.trim()).toBeTruthy();
    }
  });

  it('exposes toggle state through aria-pressed', async () => {
    // A visual highlight alone leaves a screen reader with no way to answer "is this bold?".
    const { bar } = await setupWithToolbar();

    expect(
      within(bar).getByRole('button', { name: /^Bold/ }).getAttribute('aria-pressed'),
    ).toBe('false');
  });

  it('points at the region it controls', async () => {
    const { bar } = await setupWithToolbar();
    expect(bar.getAttribute('aria-controls')).toBe('editor');
  });
});

describe('the editable region', () => {
  it('takes its accessible name from the field label', async () => {
    await setupWithToolbar();

    const region = document.getElementById('editor');
    expect(region).not.toBeNull();
    expect(region!.getAttribute('aria-labelledby')).toBe('label');
  });

  it('carries the described-by and invalid state it is given', async () => {
    await setupWithToolbar({ describedBy: 'hint', invalid: true });

    const region = document.getElementById('editor')!;
    expect(region.getAttribute('aria-describedby')).toBe('hint');
    expect(region.getAttribute('aria-invalid')).toBe('true');
  });
});

describe('the field config shapes the toolbar', () => {
  it('hides controls the field does not allow', async () => {
    // Offering a heading button on an inline-only field would produce markup the server then
    // silently unwraps — the editor would watch their formatting vanish on save.
    const { bar } = await setupWithToolbar({ allowedTags: ['strong', 'em'] });

    expect(within(bar).queryByRole('button', { name: /^Bold/ })).not.toBeNull();
    expect(within(bar).queryByRole('button', { name: /Heading 2/ })).toBeNull();
    expect(within(bar).queryByRole('button', { name: /link/i })).toBeNull();
  });

  it('offers the full toolbar when nothing is restricted', async () => {
    const { bar } = await setupWithToolbar();

    for (const name of [/^Bold/, /^Italic/, /Heading 2/, /Bulleted list/, /Quote/, /link/i]) {
      expect(within(bar).queryByRole('button', { name })).not.toBeNull();
    }
  });

  it('never offers a Heading 1 button', async () => {
    // The page's h1 is its title. A second one breaks the document outline — WCAG 1.3.1, and
    // exactly what the accessibility checker flags if one reaches the database another way.
    const { bar } = await setupWithToolbar();
    expect(within(bar).queryByRole('button', { name: /Heading 1/ })).toBeNull();
  });
});

describe('the link form', () => {
  it('opens with a labelled input rather than a window prompt', async () => {
    const user = userEvent.setup();
    const { bar } = await setupWithToolbar();

    await user.click(within(bar).getByRole('button', { name: /Add or edit link/ }));

    const input = await screen.findByLabelText('Link address');
    expect(document.activeElement).toBe(input);
  });

  it('closes on Escape without applying', async () => {
    const user = userEvent.setup();
    const { bar } = await setupWithToolbar();

    await user.click(within(bar).getByRole('button', { name: /Add or edit link/ }));
    await screen.findByLabelText('Link address');

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByLabelText('Link address')).toBeNull());
  });
});

describe('linking to content and files', () => {
  const ASSET = {
    id: '019fbe8e-b69b-71e4-a9de-8a895e8bd7e2',
    filename: 'prospectus.pdf',
    url: '/media/prospectus.pdf',
    altText: null,
    mimeType: 'application/pdf',
    width: null,
    height: null,
  };

  it('offers a page search in the link form', async () => {
    const user = userEvent.setup();
    const { bar } = await setupWithToolbar();

    await user.click(within(bar).getByRole('button', { name: /link/i }));

    // Typing a path from memory is what breaks when a page moves; this is the alternative.
    expect(screen.getByLabelText('Or link to a page')).toBeTruthy();
  });

  it('adds the file button to the roving tabindex rather than stranding it', async () => {
    /**
     * The toolbar's promise is that one tab stop reaches every control. A button rendered without
     * being counted is reachable by mouse and by nothing else — and the count has to be derived,
     * because the unlink button comes and goes and everything after it shifts.
     */
    const { bar } = await setupWithToolbar({ media: [ASSET] });

    const buttons = within(bar).getAllByRole('button');
    const file = within(bar).getByRole('button', { name: 'Link to a file' });

    expect(buttons.at(-1)).toBe(file);
    // Exactly one tab stop, and End must be able to land on the last button.
    expect(buttons.filter((b) => b.getAttribute('tabindex') === '0')).toHaveLength(1);

    await userEvent.setup().tab();
    await userEvent.setup().keyboard('{End}');
    await waitFor(() => expect(document.activeElement).toBe(file));
  });

  it('hides the file button when links are not an allowed format', async () => {
    // A file link is a link. If `a` is disallowed there is nothing this button could produce.
    const { bar } = await setupWithToolbar({ media: [ASSET], allowedTags: ['strong', 'em'] });

    expect(within(bar).queryByRole('button', { name: 'Link to a file' })).toBeNull();
  });

  it('has no file button with an empty library', async () => {
    const { bar } = await setupWithToolbar();

    expect(within(bar).queryByRole('button', { name: 'Link to a file' })).toBeNull();
  });
});

describe('accessibility of the rendered widget', () => {
  it('has no axe violations once hydrated', async () => {
    const { container } = await setupWithToolbar();

    // Scoped to the container rather than the document: rendered in isolation there is no
    // landmark around it, which is an artifact of the test rather than of the component.
    const results = await axe.run(container, {
      resultTypes: ['violations'],
      // jsdom computes no layout and resolves no custom properties, so contrast is measured
      // numerically in a11y-contrast.mjs instead.
      rules: { 'color-contrast': { enabled: false } },
    });

    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });

  it('has no axe violations with the link form open', async () => {
    const user = userEvent.setup();
    const { bar, container } = await setupWithToolbar();

    await user.click(within(bar).getByRole('button', { name: /Add or edit link/ }));
    await screen.findByLabelText('Link address');

    const results = await axe.run(container, {
      resultTypes: ['violations'],
      rules: { 'color-contrast': { enabled: false } },
    });

    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});
