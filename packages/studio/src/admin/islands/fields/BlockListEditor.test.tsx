// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FieldRow } from '@taprootcms/core';

import { BlockListEditor, type BlockTypeOption } from './BlockListEditor.js';

/**
 * The block list editor's behaviour after hydration.
 *
 * Composition is an ordering task, so reordering is the thing most worth pinning down — and the
 * standing rule here is that dragging is added *to* keyboard control, never substituted for it.
 * The Move up / Move down buttons are the primary path and these tests cover them; pointer dragging
 * needs a layout engine jsdom does not have and remains something a human tries in a browser.
 */

function field(overrides: Partial<FieldRow>): FieldRow {
  return {
    id: 'f1',
    content_type_id: 'hero',
    api_id: 'heading',
    label: 'Heading',
    type: 'text',
    help_text: null,
    position: 0,
    required: 0,
    localized: 0,
    config: '{}',
    created_at: '',
    updated_at: '',
    ...overrides,
  } as FieldRow;
}

function blockType(overrides: Partial<BlockTypeOption> = {}): BlockTypeOption {
  return {
    id: 'bt-hero',
    api_id: 'hero',
    name: 'Hero',
    name_plural: 'Heroes',
    description: null,
    kind: 'block',
    icon: null,
    url_prefix: null,
    title_field: null,
    position: 0,
    default_og_image_id: null,
    created_at: '',
    updated_at: '',
    fields: [field({})],
    ...overrides,
  } as BlockTypeOption;
}

const hero = blockType();
const quote = blockType({
  id: 'bt-quote',
  api_id: 'quote',
  name: 'Quote',
  fields: [field({ id: 'f2', content_type_id: 'quote', api_id: 'quote', label: 'Quote' })],
});

function setup(props: Partial<Parameters<typeof BlockListEditor>[0]> = {}) {
  const onChange = vi.fn();
  const result = render(
    <>
      <span id="label">Sections</span>
      <BlockListEditor
        value={[]}
        onChange={onChange}
        blockTypes={[hero, quote]}
        labelledBy="label"
        {...props}
      />
    </>,
  );
  return { onChange, ...result };
}

const blocks = [
  { id: 'a', type: 'hero', data: { heading: 'First' } },
  { id: 'b', type: 'quote', data: { quote: 'Second' } },
  { id: 'c', type: 'hero', data: { heading: 'Third' } },
];

afterEach(cleanup);

describe('adding blocks', () => {
  it('offers one button per allowed block type', async () => {
    setup();

    expect(screen.getByRole('button', { name: '+ Hero' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '+ Quote' })).toBeTruthy();
  });

  it('appends the chosen type with a generated id', async () => {
    const user = userEvent.setup();
    const { onChange } = setup();

    await user.click(screen.getByRole('button', { name: '+ Quote' }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const added = onChange.mock.calls[0]![0];
    expect(added).toHaveLength(1);
    expect(added[0].type).toBe('quote');
    // The id is what keeps a block's inputs mounted across a reorder; without it React would
    // remount every row and drop focus mid-edit.
    expect(added[0].id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('stops offering more once maxBlocks is reached', () => {
    setup({ value: blocks, maxBlocks: 3 });

    expect(screen.queryByRole('button', { name: '+ Hero' })).toBeNull();
    expect(screen.getByText(/holds at most 3 blocks/)).toBeTruthy();
  });

  it('says so when a field permits no block types', () => {
    setup({ blockTypes: [] });
    expect(screen.getByText(/No block types are available/)).toBeTruthy();
  });
});

describe('reordering by keyboard', () => {
  it('gives every move button a name that says which block it moves', () => {
    // A column of identical "Move up" buttons is unusable in a screen reader's control list.
    setup({ value: blocks });

    expect(screen.getAllByRole('button', { name: /Move .* up/ })).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Move Quote up' })).toBeTruthy();
  });

  it('moves a block up', async () => {
    const user = userEvent.setup();
    const { onChange } = setup({ value: blocks });

    await user.click(screen.getByRole('button', { name: 'Move Quote up' }));

    expect(onChange.mock.calls[0]![0].map((b: { id: string }) => b.id)).toEqual(['b', 'a', 'c']);
  });

  it('moves a block down', async () => {
    const user = userEvent.setup();
    const { onChange } = setup({ value: blocks });

    await user.click(screen.getByRole('button', { name: 'Move Quote down' }));

    expect(onChange.mock.calls[0]![0].map((b: { id: string }) => b.id)).toEqual(['a', 'c', 'b']);
  });

  it('disables the moves that would fall off the ends', () => {
    setup({ value: blocks });

    const ups = screen.getAllByRole('button', { name: /Move .* up/ }) as HTMLButtonElement[];
    const downs = screen.getAllByRole('button', { name: /Move .* down/ }) as HTMLButtonElement[];

    expect(ups[0]!.disabled).toBe(true);
    expect(downs[downs.length - 1]!.disabled).toBe(true);
    expect(ups[1]!.disabled).toBe(false);
  });

  it('announces the move, since the list is otherwise only visible', async () => {
    const user = userEvent.setup();
    setup({ value: blocks });

    await user.click(screen.getByRole('button', { name: 'Move Quote up' }));

    const live = document.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toContain('Quote moved to position 1 of 3');
  });
});

describe('removing blocks', () => {
  /**
   * Remove now lives in the row's `⋯` menu rather than beside the reorder buttons.
   *
   * These tests open it, which is the point: the interaction genuinely changed, so a test that
   * still found a bare "Remove Quote" button would be asserting a control nobody can reach.
   */
  it('names the block in the menu that holds its actions', () => {
    setup({ value: blocks });
    expect(screen.getByRole('button', { name: 'More actions for Quote' })).toBeTruthy();
  });

  it('removes only that block', async () => {
    const user = userEvent.setup();
    const { onChange } = setup({ value: blocks });

    await user.click(screen.getByRole('button', { name: 'More actions for Quote' }));
    await user.click(screen.getByRole('button', { name: 'Remove' }));

    expect(onChange.mock.calls[0]![0].map((b: { id: string }) => b.id)).toEqual(['a', 'c']);
  });

  it('keeps reordering on the row, where it is used repeatedly', () => {
    setup({ value: blocks });

    // The split is by frequency: a click to reach ordering is a click paid every time a region is
    // composed, so these must not follow Remove into the menu.
    expect(screen.getByRole('button', { name: 'Move Quote up' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Move Quote down' })).toBeTruthy();
  });
});

describe('editing a block', () => {
  it('renders each block type its own fields', () => {
    setup({ value: blocks });

    // Two heroes and one quote, so two Heading inputs and one Quote input.
    expect(screen.getAllByLabelText('Heading')).toHaveLength(2);
    expect(screen.getAllByLabelText('Quote')).toHaveLength(1);
  });

  it('writes a change back into that block only', async () => {
    const user = userEvent.setup();
    const { onChange } = setup({ value: blocks });

    await user.type(screen.getAllByLabelText('Heading')[0]!, '!');

    const next = onChange.mock.calls.at(-1)![0];
    expect(next[0].data.heading).toBe('First!');
    expect(next[2].data.heading).toBe('Third');
  });

  it('collapses and expands a block', async () => {
    const user = userEvent.setup();
    setup({ value: blocks });

    const toggle = screen.getByRole('button', { name: /Quote 2 of 3/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    await user.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('hides a collapsed block’s fields rather than only relabelling its toggle', async () => {
    // `aria-expanded` is what the button *says*; `hidden` on the panel is what makes it true.
    // Asserting only the first is asserting the label, which is how a disclosure ships inert.
    const user = userEvent.setup();
    const { container } = setup({ value: blocks });

    await user.click(screen.getByRole('button', { name: /Quote 2 of 3/ }));

    expect(container.querySelector('#block-panel-b')?.hasAttribute('hidden')).toBe(true);
    expect(container.querySelector('#block-panel-a')?.hasAttribute('hidden')).toBe(false);
  });

  it('collapses and expands every block at once', async () => {
    const user = userEvent.setup();
    const { container } = setup({ value: blocks });

    await user.click(screen.getByRole('button', { name: 'Collapse all blocks' }));
    for (const id of ['a', 'b', 'c']) {
      expect(container.querySelector(`#block-panel-${id}`)?.hasAttribute('hidden')).toBe(true);
    }

    await user.click(screen.getByRole('button', { name: 'Expand all blocks' }));
    for (const id of ['a', 'b', 'c']) {
      expect(container.querySelector(`#block-panel-${id}`)?.hasAttribute('hidden')).toBe(false);
    }
  });

  it('announces a bulk collapse, since both controls are idempotent', async () => {
    // Pressing "Collapse all" twice does nothing the second time, so silence would be
    // indistinguishable from a broken button.
    const user = userEvent.setup();
    const { container } = setup({ value: blocks });

    await user.click(screen.getByRole('button', { name: 'Collapse all blocks' }));

    expect(container.querySelector('[aria-live="polite"]')?.textContent).toMatch(
      /all 3 blocks collapsed/i,
    );
  });

  it('offers no bulk controls for a single block', () => {
    // One block already has its own disclosure; a pair of buttons above it is two more controls
    // for something one already does.
    setup({ value: [blocks[0]!] });
    expect(screen.queryByRole('button', { name: /^Collapse all/ })).toBeNull();
  });

  it('uses headings so the block list reads as the page structure it is', () => {
    setup({ value: blocks });
    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(3);
  });
});

describe('a block field inside a block', () => {
  /**
   * A `section` block whose own `blocks` field holds more blocks.
   *
   * Nothing prevented an author defining this — the field builder renders every field type for a
   * block type — but the editor never passed the block catalogue into a nested field, so it
   * rendered "No block types are available for this field. Create some under Settings → Block
   * types" and no amount of creating block types helped. There was no test, which is why.
   */
  const section = blockType({
    id: 'bt-section',
    api_id: 'section',
    name: 'Section',
    fields: [
      field({
        id: 'f3',
        content_type_id: 'section',
        api_id: 'blocks',
        label: 'Blocks',
        type: 'block',
      }),
    ],
  });

  const nested = [{ id: 's', type: 'section', data: { blocks: [] } }];

  it('offers block types inside the nested field', () => {
    setup({ value: nested, blockTypes: [section, hero, quote] });

    // The outer field's own add buttons, plus the nested field's.
    expect(screen.getAllByRole('button', { name: '+ Hero' })).toHaveLength(2);
    expect(screen.queryByText(/No block types are available/)).toBeNull();
  });

  it('does not offer a block type inside itself', () => {
    setup({ value: nested, blockTypes: [section, hero, quote] });

    // "+ Section" exists once, at the top level. Offering it again inside a Section is the one
    // arrangement that lets an editor descend forever.
    expect(screen.getAllByRole('button', { name: '+ Section' })).toHaveLength(1);
  });

  it('says why the nested list is empty when every type is an ancestor', () => {
    // The old copy sent the editor to Settings → Block types, which could not have helped: the
    // list is empty because of where they are, not because of what exists.
    setup({ value: nested, blockTypes: [section] });

    expect(screen.getByText(/already open further up/)).toBeTruthy();
    expect(screen.queryByText(/Create some under Settings/)).toBeNull();
  });

  it('does not apply the outer field allowedBlocks to the nested one', () => {
    // FieldControl narrows `blockTypes` by this field's `allowedBlocks` before handing it over, so
    // the catalogue has to travel separately or a Section allowing only Sections would leave its
    // own block field able to hold nothing.
    setup({
      value: nested,
      blockTypes: [section],
      allBlockTypes: [section, hero, quote],
    });

    expect(screen.getByRole('button', { name: '+ Hero' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '+ Quote' })).toBeTruthy();
  });

  it('writes a nested block back through the outer block data', async () => {
    const user = userEvent.setup();
    const { onChange } = setup({ value: nested, blockTypes: [section, hero, quote] });

    // Scoped to the Section's row rather than picked out of the flat list by index: the outer
    // field's add buttons render after the list, so an index here would silently mean the other
    // one and the test would pass against the wrong control.
    const row = screen.getByRole('listitem');
    await user.click(within(row).getByRole('button', { name: '+ Quote' }));

    const next = onChange.mock.calls.at(-1)![0];
    expect(next[0].data.blocks).toHaveLength(1);
    expect((next[0].data.blocks as { type: string }[])[0]!.type).toBe('quote');
  });
});

describe('a block whose type no longer exists', () => {
  it('shows an error rather than rendering nothing', () => {
    // Deleting a block type in use is refused, so this is unusual — but silently dropping the
    // block would delete an editor's content on the next save.
    setup({ value: [{ id: 'x', type: 'gone', data: { heading: 'kept' } }] });

    expect(screen.getByText(/Unknown block/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Remove block 1/ })).toBeTruthy();
  });
});

describe('accessibility', () => {
  it('has no axe violations', async () => {
    const { container } = setup({ value: blocks });

    // Scoped to the container: in isolation there is no landmark around it, and that `region`
    // violation is an artifact of the test rather than the component.
    const results = await axe.run(container, {
      resultTypes: ['violations'],
      rules: { 'color-contrast': { enabled: false } },
    });

    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });

  it('offers no editing controls in preview mode', () => {
    const { container } = setup({ value: blocks, disabled: true });

    expect(within(container).queryByRole('button', { name: /Move/ })).toBeNull();
    expect(within(container).queryByRole('button', { name: /Remove/ })).toBeNull();
    expect(within(container).queryByRole('button', { name: /^\+ / })).toBeNull();
  });
});
