import { beforeEach, describe, expect, it } from 'vitest';

import { createDb, type TaprootDb } from '../db/client.js';
import { migrateToLatest } from '../db/migrations/index.js';
import { createContentType, createField } from './types.js';
import { createItem } from './items.js';
import { resolveDelivery } from './delivery.js';
import { createSnippet, deleteSnippet, countSnippetUsage, renderSnippet } from './snippets.js';
import { createReusableBlock } from './reusableBlocks.js';
import type { ContentTypeRow, StorageAdapter } from '../db/schema.js';

/**
 * Snippets, end to end through delivery.
 *
 * The property worth the most here is the **walk**: substitution has to reach a token wherever prose
 * can live, and the place it would silently miss is inside a block or a repeater row — where the
 * field definitions are not in scope and the descent is structural. A top-level-only implementation
 * looks completely correct on a simple page and fails on every composed one.
 */

let handle: TaprootDb;
let pageType: ContentTypeRow;

const storage = {
  name: 'local',
  publicUrl: (key: string) => `/uploads/${key}`,
} as unknown as StorageAdapter;

const options = { origin: 'https://example.edu', storage };

beforeEach(async () => {
  handle = await createDb({ driver: 'sqlite', location: ':memory:' });
  const result = await migrateToLatest(handle.db);
  if (result.error) throw result.error;

  pageType = await createContentType(handle.db, {
    api_id: 'page',
    name: 'Page',
    name_plural: 'Pages',
    kind: 'page',
    description: null,
    icon: null,
    url_prefix: null,
    summary_template: null,
  });

  await createField(handle.db, pageType.id, {
    api_id: 'headline',
    label: 'Headline',
    type: 'text',
    required: 0,
    config: {},
  });
  await createField(handle.db, pageType.id, {
    api_id: 'body',
    label: 'Body',
    type: 'richtext',
    required: 0,
    config: {},
  });

  await createSnippet(handle.db, {
    api_id: 'tuition',
    name: 'Current tuition',
    kind: 'number',
    value: '4500',
    display: '$4,500',
  });
});

async function deliver(path: string) {
  const result = await resolveDelivery(handle.db, path, options);
  if (result.kind !== 'item') throw new Error(`expected an item, got ${result.kind}`);
  return result;
}

describe('snippets in delivery', () => {
  it('substitutes into a text field and into rich text', async () => {
    await createItem(handle, pageType, await fieldsOf(), {
      contentTypeId: pageType.id,
      title: 'Costs',
      status: 'published',
      data: {
        headline: 'Tuition is {{ tuition }}',
        body: '<p>You pay <strong>{{ tuition }}</strong> a year.</p>',
      },
    });

    const { item } = await deliver('/costs');

    expect(item.data.headline).toBe('Tuition is $4,500');
    expect(item.data.body).toBe('<p>You pay <strong>$4,500</strong> a year.</p>');
  });

  it('sends the canonical value alongside, which is what a chart plots', async () => {
    await createItem(handle, pageType, await fieldsOf(), {
      contentTypeId: pageType.id,
      title: 'Costs',
      status: 'published',
      data: { headline: 'Tuition is {{ tuition }}' },
    });

    const { snippets } = await deliver('/costs');

    // Prose got "$4,500"; a block component gets 4500 without parsing currency back out of a
    // sentence, which is the whole reason `value` and `display` are separate columns.
    expect(snippets.tuition).toEqual({ kind: 'number', value: '4500', display: '$4,500' });
  });

  it('carries only the snippets the page refers to', async () => {
    await createSnippet(handle.db, {
      api_id: 'deadline',
      name: 'Application deadline',
      kind: 'date',
      value: '2026-08-15',
      display: null,
    });

    await createItem(handle, pageType, await fieldsOf(), {
      contentTypeId: pageType.id,
      title: 'Costs',
      status: 'published',
      data: { headline: 'Tuition is {{ tuition }}' },
    });

    const { snippets } = await deliver('/costs');
    expect(Object.keys(snippets)).toEqual(['tuition']);
  });

  it('leaves an unknown token written out, rather than blanking the sentence', async () => {
    await createItem(handle, pageType, await fieldsOf(), {
      contentTypeId: pageType.id,
      title: 'Costs',
      status: 'published',
      data: { headline: 'Fees are {{ nosuch }} this year' },
    });

    const { item } = await deliver('/costs');
    expect(item.data.headline).toBe('Fees are {{ nosuch }} this year');
  });

  it('does not touch a field type that is not prose', async () => {
    // `slug` is not a field, but the rule it stands for is: substitution is scoped to text and
    // richtext, so a token cannot appear somewhere nobody expects it to be expanded.
    await createItem(handle, pageType, await fieldsOf(), {
      contentTypeId: pageType.id,
      title: 'Tuition is {{ tuition }}',
      status: 'published',
      data: {},
    });

    const { item } = await deliver('/tuition-is-tuition');
    expect(item.title).toBe('Tuition is {{ tuition }}');
  });
});

describe('snippets inside composed content', () => {
  it('substitutes inside a block, where the walk is structural', async () => {
    const blockType = await createContentType(handle.db, {
      api_id: 'callout',
      name: 'Callout',
      name_plural: 'Callouts',
      kind: 'block',
      description: null,
      icon: null,
      url_prefix: null,
      summary_template: null,
    });
    await createField(handle.db, blockType.id, {
      api_id: 'text',
      label: 'Text',
      type: 'richtext',
      required: 0,
      config: {},
    });

    const blocksField = await createField(handle.db, pageType.id, {
      api_id: 'sections',
      label: 'Sections',
      type: 'block',
      required: 0,
      config: { allowedBlocks: ['callout'] },
    });

    await createItem(handle, pageType, [...(await fieldsOf()), blocksField], {
      contentTypeId: pageType.id,
      title: 'Costs',
      status: 'published',
      data: {
        sections: [
          { id: 'b1', type: 'callout', data: { text: '<p>Only {{ tuition }} a year.</p>' } },
        ],
      },
    });

    const { item, snippets } = await deliver('/costs');
    const sections = item.data.sections as { data: { text: string } }[];

    expect(sections[0]!.data.text).toBe('<p>Only $4,500 a year.</p>');
    // Collected as well as substituted — the two walks have to agree, or a token is expanded from a
    // map that never loaded it, or loaded and never expanded.
    expect(snippets.tuition).toBeDefined();
  });
});

describe('deleting a snippet', () => {
  it('is refused while an item still uses it', async () => {
    await createItem(handle, pageType, await fieldsOf(), {
      contentTypeId: pageType.id,
      title: 'Costs',
      status: 'published',
      data: { headline: 'Tuition is {{ tuition }}' },
    });

    const snippet = (await handle.db.selectFrom('snippets').selectAll().execute())[0]!;
    const result = await deleteSnippet(handle.db, snippet.id);

    expect(result.deleted).toBe(false);
    expect(result.blocker).toMatch(/still use/);
  });

  it('counts a use inside a reusable block entry', async () => {
    const blockType = await createContentType(handle.db, {
      api_id: 'callout',
      name: 'Callout',
      name_plural: 'Callouts',
      kind: 'block',
      description: null,
      icon: null,
      url_prefix: null,
      summary_template: null,
    });
    const textField = await createField(handle.db, blockType.id, {
      api_id: 'text',
      label: 'Text',
      type: 'richtext',
      required: 0,
      config: {},
    });

    await createReusableBlock(handle.db, [textField], {
      name: 'Fees note',
      blockType: 'callout',
      data: { text: '<p>Tuition is {{ tuition }}.</p>' },
    });

    /*
     * A snippet used *only* inside a library entry would look unused if the count read
     * `content_items` alone — and that is precisely the delete that leaves visible braces on every
     * page sharing that block.
     */
    expect(await countSnippetUsage(handle.db, 'tuition')).toBe(1);
  });

  it('is allowed when nothing refers to it', async () => {
    const snippet = (await handle.db.selectFrom('snippets').selectAll().execute())[0]!;
    expect((await deleteSnippet(handle.db, snippet.id)).deleted).toBe(true);
  });
});

describe('renderSnippet', () => {
  it('prefers an explicit display over the derived one', () => {
    expect(renderSnippet({ kind: 'number', value: '4500', display: '$4,500' })).toBe('$4,500');
  });

  it('derives a readable number when none is set', () => {
    expect(renderSnippet({ kind: 'number', value: '4500', display: null })).toBe('4,500');
  });

  it('derives a readable date when none is set', () => {
    expect(renderSnippet({ kind: 'date', value: '2026-08-15', display: null })).toBe(
      'August 15, 2026',
    );
  });

  it('falls back to the raw value rather than rendering NaN', () => {
    // A stored value that will not parse degrades to something readable rather than putting "NaN"
    // in a sentence — the `parseJson` precedent.
    expect(renderSnippet({ kind: 'number', value: 'about 4500', display: null })).toBe('about 4500');
  });
});

/** The page type's fields, reloaded so newly added ones are included. */
async function fieldsOf() {
  return handle.db
    .selectFrom('fields')
    .selectAll()
    .where('content_type_id', '=', pageType.id)
    .orderBy('position')
    .execute();
}
