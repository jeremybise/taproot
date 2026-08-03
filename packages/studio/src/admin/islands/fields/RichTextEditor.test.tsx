// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

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

/**
 * jsdom has no layout, and ProseMirror asks for one.
 *
 * Every command that moves the selection ends in `scrollIntoView`, which calls `getClientRects` on
 * a Range and throws asynchronously — several stack traces per run, none of them a failure and none
 * of them about anything under test. Unhandled errors that are always there are unhandled errors
 * nobody reads, so the two methods it reaches for return empty rather than nothing. Scroll position
 * is not something this suite can assert on either way.
 */
beforeAll(() => {
  const empty = Object.assign([], { item: () => null }) as unknown as DOMRectList;
  Range.prototype.getClientRects = () => empty;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
afterEach(cleanup);

// This repo does not install jest-dom, so state is read off the element itself.
const checked = (element: HTMLElement) => (element as HTMLInputElement).checked;

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

const PAGE = { id: '019fbe8e-ba01-7c65-a08f-e49bc783e1e3', title: 'About', path: '/about' };
const ASSET = {
  id: '019fbe8e-b69b-71e4-a9de-8a895e8bd7e2',
  filename: 'prospectus.pdf',
  url: '/media/prospectus.pdf',
  altText: null,
  mimeType: 'application/pdf',
  width: null,
  height: null,
};

/**
 * One stub for every endpoint the dialog reaches, routed by URL.
 *
 * The dialog asks three different questions — search for pages, resolve one item, resolve one media
 * row — and a stub that answers them all the same way is how a test passes while the resolution it
 * is meant to be checking returns the wrong shape.
 */
function stubApi() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes('/items?')
        ? { items: [PAGE] }
        : url.includes(`/items/${PAGE.id}`)
          ? { item: PAGE }
          : url.includes('/media?ids=')
            ? { media: [{ ...ASSET, mime_type: ASSET.mimeType, alt_text: null }] }
            : {};
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

/** Open the link dialog from the toolbar and hand back its element. */
async function openLinkDialog(
  user: ReturnType<typeof userEvent.setup>,
  bar: HTMLElement,
  name: RegExp = /Add or edit link/,
) {
  await user.click(within(bar).getByRole('button', { name }));
  return screen.findByRole('dialog', { name: /link/i });
}

describe('the link dialog', () => {
  it('opens with a labelled address box rather than a window prompt', async () => {
    const user = userEvent.setup();
    const { bar } = await setupWithToolbar();

    const dialog = await openLinkDialog(user, bar);

    const input = within(dialog).getByLabelText('Link address');
    // Focus lands in the panel, not on the close button Radix would otherwise pick — a dialog
    // opened to type an address should not open with focus on the way out of it.
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  it('closes on Escape without applying', async () => {
    const user = userEvent.setup();
    const { onChange, bar } = await setupWithToolbar();

    await openLinkDialog(user, bar);
    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(onChange).not.toHaveBeenCalled();
  });

  it('opens on Ctrl+K, which the handbook has always claimed', async () => {
    /**
     * The shortcut was documented and did not exist: TipTap's Link extension ships no keyboard
     * shortcut of its own, and nothing here added one. A handbook that promises a key is a
     * contract, so the key now does something.
     */
    const user = userEvent.setup();
    await setupWithToolbar();

    document.getElementById('editor')!.focus();
    await user.keyboard('{Control>}k{/Control}');

    expect(await screen.findByRole('dialog', { name: /link/i })).toBeTruthy();
  });

  it('offers the three kinds of link as one radio group', async () => {
    /**
     * Drawn as tabs, built as radios. Hand-rolled tabs mean writing a roving tabindex and the
     * tab/panel wiring by hand and keeping them written; a radio group is the same interaction from
     * the platform. What matters for the contract is that all three are reachable and exclusive.
     */
    const user = userEvent.setup();
    const { bar } = await setupWithToolbar({ media: [ASSET] });

    const dialog = await openLinkDialog(user, bar);
    const group = within(dialog).getByRole('group', { name: 'What should this link to?' });

    expect(within(group).getAllByRole('radio').map((radio) => radio.getAttribute('value'))).toEqual(
      ['page', 'file', 'url'],
    );
    expect(checked(within(group).getByRole('radio', { name: /Web address/ }))).toBe(true);
  });

  it('hides the file panel when the library is empty', async () => {
    // Nothing to choose. The same rule as the toolbar's paperclip, which is also absent.
    const user = userEvent.setup();
    const { bar } = await setupWithToolbar();

    const dialog = await openLinkDialog(user, bar);
    expect(within(dialog).queryByRole('radio', { name: /File/ })).toBeNull();
  });

  it('says why Apply is unavailable instead of only disabling it', async () => {
    const user = userEvent.setup();
    const { bar } = await setupWithToolbar();

    const dialog = await openLinkDialog(user, bar);
    expect((within(dialog).getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(dialog).getByText('Type an address to link to.')).toBeTruthy();
  });
});

describe('the dialog lives inside the item editor’s form', () => {
  /**
   * Every one of the tests above renders this component on its own, and that is exactly why they
   * all passed while Apply saved the whole content item and navigated away.
   *
   * Radix portals the dialog to `document.body`, so in the DOM it is nowhere near the editor's
   * form — but React propagates events through the **React** tree, and that tree still has
   * `<form onSubmit={save}>` above it. The link never landed; what an author saw was the page
   * reloading with their link missing. Found in a browser, not here, so the shape of the test is
   * the point: render it where it actually lives.
   */
  function setupInAForm(props: Partial<Parameters<typeof RichTextEditor>[0]> = {}) {
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
    const onChange = vi.fn();
    render(
      <form onSubmit={onSubmit}>
        <span id="label">Body</span>
        <RichTextEditor
          id="editor"
          value="<p>Hello</p>"
          onChange={onChange}
          labelledBy="label"
          {...props}
        />
      </form>,
    );
    return { onSubmit, onChange };
  }

  it('does not submit the surrounding form when a link is applied', async () => {
    const user = userEvent.setup();
    const { onSubmit, onChange } = setupInAForm();
    const bar = await screen.findByRole('toolbar', { name: 'Text formatting' });

    const dialog = await openLinkDialog(user, bar);
    await user.type(within(dialog).getByLabelText('Link address'), 'https://example.edu');
    await user.click(within(dialog).getByRole('button', { name: 'Apply' }));

    expect(onSubmit).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(onChange.mock.calls.at(-1)?.[0] ?? '').toContain('href="https://example.edu"'),
    );
  });

  it('does not submit it when Enter is pressed in the address box either', async () => {
    // The same event by the other route. A fix that only covered the button would leave the
    // keyboard path saving the page.
    const user = userEvent.setup();
    const { onSubmit } = setupInAForm();
    const bar = await screen.findByRole('toolbar', { name: 'Text formatting' });

    const dialog = await openLinkDialog(user, bar);
    await user.type(within(dialog).getByLabelText('Link address'), 'https://example.edu{Enter}');

    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('editing a link that already exists', () => {
  /**
   * The complaint this answers: opening the form on an existing link showed an empty box and a
   * placeholder saying *a* page was linked, never which one. A reference is correct and unreadable,
   * so the id has to be exchanged for a title before anyone can tell what they are about to replace.
   */
  async function editorOnALink(html: string, props = {}) {
    stubApi();
    const user = userEvent.setup();
    const rendered = await setupWithToolbar({ value: html, ...props });
    /*
      No click to place the caret, deliberately.

      ProseMirror starts a fresh document with the selection at the start of the first text
      block, which is inside the link when the link is the first thing in it — so the toolbar
      already reads the mark there. Clicking the anchor instead goes through `posAtCoords`, which
      needs `document.elementFromPoint`; jsdom has neither that nor a layout to answer it with, so
      the click would be exercising a shim rather than the component.
    */
    return { ...rendered, user, bar: rendered.bar };
  }

  it('names the page a reference points at', async () => {
    const { user, bar } = await editorOnALink(
      `<p><a href="taproot:item:${PAGE.id}">read more</a></p>`,
    );

    const dialog = await openLinkDialog(user, bar);

    expect(await within(dialog).findByText('About')).toBeTruthy();
    expect(within(dialog).getByText('/about')).toBeTruthy();
    // And a way to go and look at it, rather than a title with nothing behind it.
    expect(
      within(dialog).getByRole('link', { name: /Open in the editor/ }).getAttribute('href'),
    ).toBe(`/admin/content/${PAGE.id}`);
  });

  it('names the file a reference points at', async () => {
    const { user, bar } = await editorOnALink(
      `<p><a href="taproot:media:${ASSET.id}">the prospectus</a></p>`,
      { media: [ASSET] },
    );

    const dialog = await openLinkDialog(user, bar);
    expect((await within(dialog).findAllByText('prospectus.pdf')).length).toBe(2);
  });

  it('opens on the panel matching the kind of link it is', async () => {
    // A link to a page opening on the address box is how the old form managed to look identical
    // whether you were adding a link or editing one.
    const { user, bar } = await editorOnALink(
      `<p><a href="taproot:item:${PAGE.id}">read more</a></p>`,
    );

    const dialog = await openLinkDialog(user, bar);
    expect(checked(within(dialog).getByRole('radio', { name: /Page/ }))).toBe(true);
  });

  it('shows a plain address in the box it was typed into', async () => {
    const { user, bar } = await editorOnALink('<p><a href="https://example.edu">read more</a></p>');

    const dialog = await openLinkDialog(user, bar);
    expect((within(dialog).getByLabelText('Link address') as HTMLInputElement).value).toBe('https://example.edu');
  });

  it('says so when the reference points at nothing', async () => {
    /**
     * Delivery unwraps an unresolvable link — the text stays, the `<a>` goes — so an author who is
     * never told sees a link in the editor and no link on the site, with nothing connecting the two.
     */
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    const user = userEvent.setup();
    const { bar } = await setupWithToolbar({
      value: `<p><a href="taproot:item:${PAGE.id}">read more</a></p>`,
    });

    const dialog = await openLinkDialog(user, bar);
    expect(await within(dialog).findByText('This page no longer exists')).toBeTruthy();
  });

  it('carries the current options into the checkboxes', async () => {
    const { user, bar } = await editorOnALink(
      '<p><a href="https://example.edu" target="_blank" rel="nofollow noopener">read more</a></p>',
    );

    const dialog = await openLinkDialog(user, bar);
    expect(checked(within(dialog).getByLabelText('Open in a new tab'))).toBe(true);
    expect(checked(within(dialog).getByLabelText('Tell search engines not to follow'))).toBe(true);
  });

  it('removes the link from the dialog', async () => {
    const { user, bar, onChange } = await editorOnALink(
      '<p><a href="https://example.edu">read more</a></p>',
    );

    const dialog = await openLinkDialog(user, bar);
    await user.click(within(dialog).getByRole('button', { name: 'Remove link' }));

    await waitFor(() => {
      const html = onChange.mock.calls.at(-1)?.[0] ?? '';
      expect(html).not.toContain('<a');
      // The text it was wrapped around stays; only the link goes.
      expect(html).toContain('read more');
    });
  });
});

describe('the toolbar reaches the dialog', () => {
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

  it('opens the same dialog on the file panel from the paperclip', async () => {
    // One dialog entered at the point the button names, rather than a second control doing nearly
    // the same thing as the chain icon.
    const user = userEvent.setup();
    const { bar } = await setupWithToolbar({ media: [ASSET] });

    const dialog = await openLinkDialog(user, bar, /Link to a file/);
    expect(checked(within(dialog).getByRole('radio', { name: /File/ }))).toBe(true);
  });
});

describe('a chosen link actually becomes a link', () => {
  /**
   * The tests above check that controls exist and that the toolbar can reach them. None of them
   * notices that picking a result produces **nothing**, which is exactly what shipped: TipTap's Link
   * extension validates hrefs against its `protocols` list, `taproot` was not on it, and every
   * internal link was silently discarded between the click and the document. A control that is
   * present and inert passes every test about its presence.
   *
   * Selecting text inside ProseMirror is not something jsdom can be trusted to do — it has no real
   * selection model — so the branch that wraps an existing selection is verified in a browser
   * instead. What these prove is the part that was actually broken: that a `taproot:` href survives
   * TipTap's own validation and reaches the document at all.
   */
  it('inserts the page title as the text when nothing is selected', async () => {
    stubApi();
    const user = userEvent.setup();
    const { onChange, bar } = await setupWithToolbar();

    const dialog = await openLinkDialog(user, bar);
    await user.click(within(dialog).getByRole('radio', { name: /Page/ }));
    await user.type(within(dialog).getByLabelText('Search pages by title'), 'about');
    await user.click(await within(dialog).findByRole('button', { name: /About/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Apply' }));

    await waitFor(() => {
      const html = onChange.mock.calls.at(-1)?.[0] ?? '';
      expect(html).toContain(`href="taproot:item:${PAGE.id}"`);
      // The title, not an empty anchor — the bug that a stale state read would produce.
      expect(html).toContain('>About<');
    });
  });

  it('links to a file chosen from the library', async () => {
    stubApi();
    const user = userEvent.setup();
    const { onChange, bar } = await setupWithToolbar({ media: [ASSET] });

    const dialog = await openLinkDialog(user, bar, /Link to a file/);
    await user.click(within(dialog).getByRole('button', { name: /Choose a file/ }));

    // The picker is a second dialog stacked on this one. It has to stay reachable: a nested modal
    // hidden from the accessibility tree by the one underneath it is unusable, not merely awkward.
    const picker = await screen.findByRole('dialog', { name: /Choose a file/i });
    await user.click(within(picker).getByRole('option', { name: /prospectus/i }));
    await user.click(within(picker).getByRole('button', { name: /^Choose$/ }));

    await user.click(within(dialog).getByRole('button', { name: 'Apply' }));

    await waitFor(() => {
      const html = onChange.mock.calls.at(-1)?.[0] ?? '';
      expect(html).toContain(`href="taproot:media:${ASSET.id}"`);
    });
  });
});

describe('link options', () => {
  it('offers new-tab and nofollow, worded for a person', async () => {
    const user = userEvent.setup();
    const { bar } = await setupWithToolbar();
    const dialog = await openLinkDialog(user, bar);

    expect(within(dialog).getByLabelText('Open in a new tab')).toBeTruthy();
    // Not "nofollow": the people writing here are not SEO consultants.
    expect(within(dialog).getByLabelText('Tell search engines not to follow')).toBeTruthy();
  });

  it('applies a typed address with the options ticked', async () => {
    const user = userEvent.setup();
    const { onChange, bar } = await setupWithToolbar();
    const dialog = await openLinkDialog(user, bar);

    await user.type(within(dialog).getByLabelText('Link address'), 'https://example.edu');
    await user.click(within(dialog).getByLabelText('Open in a new tab'));
    await user.click(within(dialog).getByLabelText('Tell search engines not to follow'));
    await user.click(within(dialog).getByRole('button', { name: 'Apply' }));

    await waitFor(() => {
      const html = onChange.mock.calls.at(-1)?.[0] ?? '';
      expect(html).toContain('href="https://example.edu"');
      expect(html).toContain('target="_blank"');
      expect(html).toContain('nofollow');
    });
  });

  it('leaves target off when the box is not ticked', async () => {
    /**
     * The default has to be "same tab". TipTap ships `target: '_blank'` in the Link extension's own
     * defaults and `HTMLAttributes` merges rather than replaces, so overriding only `rel` left every
     * link opening in a new tab — including internal ones, where nobody would ever want it.
     */
    const user = userEvent.setup();
    const { onChange, bar } = await setupWithToolbar();
    const dialog = await openLinkDialog(user, bar);

    await user.type(within(dialog).getByLabelText('Link address'), 'https://example.edu');
    await user.click(within(dialog).getByRole('button', { name: 'Apply' }));

    await waitFor(() => {
      const html = onChange.mock.calls.at(-1)?.[0] ?? '';
      expect(html).toContain('href="https://example.edu"');
      expect(html).not.toContain('target=');
    });
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

  it('has no axe violations with the link dialog open', async () => {
    const user = userEvent.setup();
    const { bar } = await setupWithToolbar({ media: [ASSET] });

    const dialog = await openLinkDialog(user, bar);

    /**
     * Scoped to the dialog element, not to the render container.
     *
     * Radix portals its content to `document.body`, so the container the component rendered into is
     * empty of everything being checked here — an axe run against it would report zero violations
     * for a dialog it never looked at. The same reason the media picker's own test does this.
     */
    const results = await axe.run(dialog, {
      resultTypes: ['violations'],
      rules: { 'color-contrast': { enabled: false } },
    });

    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });

  it('has no axe violations on the panel showing an existing target', async () => {
    // The half that only exists while editing a link: the resolved card, its open link, and the
    // remove button. It is a different tree from the one above and would otherwise be unchecked.
    stubApi();
    const user = userEvent.setup();
    const { bar } = await setupWithToolbar({
      value: `<p><a href="taproot:item:${PAGE.id}">read more</a></p>`,
    });

    const dialog = await openLinkDialog(user, bar);
    await within(dialog).findByText('About');

    const results = await axe.run(dialog, {
      resultTypes: ['violations'],
      rules: { 'color-contrast': { enabled: false } },
    });

    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});
