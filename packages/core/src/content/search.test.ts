import { beforeEach, describe, expect, it } from 'vitest';

import { sql } from 'kysely';

import { createDb, type TaprootDb } from '../db/client.js';
import { migrateToLatest } from '../db/migrations/index.js';
import { createContentType, createField } from './types.js';
import { createItem, deleteItem, listItemSummaries, updateItem } from './items.js';
import { createReusableBlock } from './reusableBlocks.js';
import { reindexDerived } from './derivedIndex.js';
import { buildExcerpt, loadSearchExcerpts, searchIndexStatus, toMatchQuery } from './search.js';
import type { ContentTypeRow, FieldRow } from '../db/schema.js';

/**
 * Search: the derived text index, and the ranked read over it.
 *
 * Three things are being defended.
 *
 * **The walk reaches where prose actually is.** A body inside a repeater row inside a block is as
 * much a part of the page as a top-level field, and a search that stops at the top level would miss
 * most of a composed homepage while looking entirely correct on a simple one.
 *
 * **Markup never matches.** The stored value is HTML, so an index that kept it would answer a
 * search for "title" with every page carrying a `title` attribute, and would miss a phrase with an
 * `<em>` in the middle of it.
 *
 * **The index cannot go stale**, including on the saves that change no content at all — publishing
 * a page rebuilds it from stored data, and that path has its own way of getting the block walk
 * wrong.
 */

let handle: TaprootDb;
let pageType: ContentTypeRow;
let fields: FieldRow[];

async function textFor(itemId: string): Promise<string | undefined> {
  const row = await handle.db
    .selectFrom('content_item_text')
    .select('text')
    .where('content_item_id', '=', itemId)
    .executeTakeFirst();

  return row?.text;
}

async function titlesFor(search: string): Promise<string[]> {
  const { items } = await listItemSummaries(handle.db, { search });
  return items.map((item) => item.title);
}

beforeEach(async () => {
  handle = await createDb({ driver: 'sqlite', location: ':memory:' });
  const migrated = await migrateToLatest(handle.db);
  if (migrated.error) throw migrated.error;

  pageType = await createContentType(handle.db, {
    api_id: 'page',
    name: 'Page',
    name_plural: 'Pages',
    kind: 'page',
    description: null,
    icon: null,
    url_prefix: null,
    summary_template: '{{ title }}',
  });

  fields = [
    await createField(handle.db, pageType.id, {
      api_id: 'summary',
      label: 'Summary',
      type: 'text',
      required: false,
      localized: false,
      position: 0,
      config: {},
      help_text: null,
    }),
    await createField(handle.db, pageType.id, {
      api_id: 'body',
      label: 'Body',
      type: 'richtext',
      required: false,
      localized: false,
      position: 1,
      config: {},
      help_text: null,
    }),
  ];
});

async function makePage(
  title: string,
  data: Record<string, unknown>,
  fieldList: FieldRow[] = fields,
) {
  return createItem(handle, pageType, fieldList, {
    contentTypeId: pageType.id,
    title,
    status: 'published',
    data,
  });
}

describe('what reaches the text index', () => {
  it('flattens richtext to its words, so markup is never matched', async () => {
    const item = await makePage('Accreditation', {
      body: '<p>Accredited since <strong>1954</strong> by the <em>regional</em> board.</p>',
    });

    const indexed = await textFor(item.id);

    expect(indexed).toContain('Accredited since 1954 by the regional board.');
    // The tag names are gone, which is the point: `<strong>` in the index means a search for
    // "strong" finds every page with bold text in it.
    expect(indexed).not.toContain('<strong>');
    expect(indexed).not.toContain('p>');
  });

  it('reads prose out of a block and a repeater row, not just the top level', async () => {
    const blockType = await createContentType(handle.db, {
      api_id: 'quote',
      name: 'Quote',
      name_plural: 'Quotes',
      kind: 'block',
      description: null,
      icon: null,
      url_prefix: null,
      summary_template: null,
    });

    await createField(handle.db, blockType.id, {
      api_id: 'attribution',
      label: 'Attribution',
      type: 'text',
      required: false,
      localized: false,
      position: 0,
      config: {},
      help_text: null,
    });

    const sections = await createField(handle.db, pageType.id, {
      api_id: 'sections',
      label: 'Sections',
      type: 'block',
      required: false,
      localized: false,
      position: 2,
      config: {},
      help_text: null,
    });

    const staff = await createField(handle.db, pageType.id, {
      api_id: 'staff',
      label: 'Staff',
      type: 'repeater',
      required: false,
      localized: false,
      position: 3,
      config: {
        fields: [{ api_id: 'name', label: 'Name', type: 'text', required: false, config: {} }],
      },
      help_text: null,
    });

    const item = await makePage(
      'Visit',
      {
        sections: [{ id: 'b1', type: 'quote', data: { attribution: 'Nia, second year' } }],
        staff: [{ id: 'r1', data: { name: 'Marguerite Okafor' } }],
      },
      [...fields, sections, staff],
    );

    const indexed = await textFor(item.id);
    expect(indexed).toContain('Nia, second year');
    expect(indexed).toContain('Marguerite Okafor');

    // And both are findable, which is the property the walk exists for rather than the walk itself.
    expect(await titlesFor('marguerite')).toEqual(['Visit']);
    expect(await titlesFor('second year')).toEqual(['Visit']);
  });

  it('leaves a reusable block to the library, which is a stated limit rather than an oversight', async () => {
    const blockType = await createContentType(handle.db, {
      api_id: 'cta',
      name: 'Call to action',
      name_plural: 'Calls to action',
      kind: 'block',
      description: null,
      icon: null,
      url_prefix: null,
      summary_template: null,
    });

    const heading = await createField(handle.db, blockType.id, {
      api_id: 'heading',
      label: 'Heading',
      type: 'text',
      required: false,
      localized: false,
      position: 0,
      config: {},
      help_text: null,
    });

    const entry = await createReusableBlock(handle.db, [heading], {
      name: 'Visit prompt',
      blockType: 'cta',
      data: { heading: 'Come and see us' },
    });

    const sections = await createField(handle.db, pageType.id, {
      api_id: 'sections',
      label: 'Sections',
      type: 'block',
      required: false,
      localized: false,
      position: 2,
      config: {},
      help_text: null,
    });

    const item = await makePage(
      'Visit',
      { sections: [{ id: 'b1', type: 'cta', reusable: true, ref: entry.id }] },
      [...fields, sections],
    );

    /**
     * The page stores `{ id, type, ref }` and no copy, so there is nothing here to flatten. Reaching
     * the entry would need a read inside a planner that is deliberately synchronous, and — the real
     * objection — every referencing page's index would have to be rebuilt whenever the entry was
     * edited, which nothing on that write path can trigger.
     */
    expect(await textFor(item.id)).toBe('');
    expect(await titlesFor('come and see us')).toEqual([]);
  });
});

describe('staying in step with the item', () => {
  it('drops text the item no longer has', async () => {
    const item = await makePage('Notice', { body: '<p>Applications close in March.</p>' });
    expect(await titlesFor('march')).toEqual(['Notice']);

    await updateItem(handle, pageType, fields, item.id, {
      data: { body: '<p>Applications close in June.</p>' },
      userId: null,
    });

    expect(await titlesFor('march')).toEqual([]);
    expect(await titlesFor('june')).toEqual(['Notice']);
  });

  it('keeps a block’s prose indexed through a save that changes no content', async () => {
    /**
     * The trap this is here for: `updateItem` rebuilds the index from stored `data` on *every*
     * save, including one that carries no `data` at all — a publish, a rename, a status change. The
     * block registry is loaded on the branch that validates new content, so a status-only save
     * walked the blocks with no schemas to walk them by and wrote an index with every block's text
     * missing. Nothing errors, the page still renders, and the content simply stops being findable
     * on the most likely last action anybody takes on it.
     *
     * Proven by mutation: dropping the `else` branch in `updateItem` fails exactly this.
     */
    const blockType = await createContentType(handle.db, {
      api_id: 'prose',
      name: 'Prose',
      name_plural: 'Prose blocks',
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
      required: false,
      localized: false,
      position: 0,
      config: {},
      help_text: null,
    });

    const sections = await createField(handle.db, pageType.id, {
      api_id: 'sections',
      label: 'Sections',
      type: 'block',
      required: false,
      localized: false,
      position: 2,
      config: {},
      help_text: null,
    });

    const withBlocks = [...fields, sections];
    const item = await createItem(handle, pageType, withBlocks, {
      contentTypeId: pageType.id,
      title: 'Bursaries',
      status: 'draft',
      data: { sections: [{ id: 'b1', type: 'prose', data: { text: '<p>Hardship fund</p>' } }] },
    });

    expect(await titlesFor('hardship')).toEqual(['Bursaries']);

    // A publish: no `data` on the input at all.
    await updateItem(handle, pageType, withBlocks, item.id, { status: 'published', userId: null });

    expect(await titlesFor('hardship')).toEqual(['Bursaries']);
  });

  it('removes the row when the item is deleted', async () => {
    const item = await makePage('Gone', { summary: 'Ephemeral' });
    await handle.db.deleteFrom('content_items').where('id', '=', item.id).execute();

    expect(await textFor(item.id)).toBeUndefined();
  });

  it('backfills through the same reindex the value index uses', async () => {
    const item = await makePage('Backfill', { body: '<p>Endowment</p>' });
    await handle.db.deleteFrom('content_item_text').execute();

    // What a database looks like between the migration and the reindex — findable by title, and by
    // nothing else.
    expect(await titlesFor('endowment')).toEqual([]);
    expect(await searchIndexStatus(handle.db)).toEqual({ items: 1, unindexed: 1 });

    await reindexDerived(handle);

    expect(await titlesFor('endowment')).toEqual(['Backfill']);
    expect(await searchIndexStatus(handle.db)).toEqual({ items: 1, unindexed: 0 });
    expect(await textFor(item.id)).toBe('Endowment');
  });
});

describe('ranking', () => {
  it('puts a title match above a body match, and an exact title above both', async () => {
    await makePage('Aid', { body: '<p>Nothing else here.</p>' });
    await makePage('Aid for transfer students', { body: '<p>Nothing else here.</p>' });
    await makePage('Costs', { body: '<p>Every kind of aid we offer.</p>' });
    await makePage('Bursaries and aid', { body: '<p>Nothing else here.</p>' });

    /**
     * Bands rather than a score: exact title, title prefix, title anywhere, path, body. What they
     * encode is the one thing a `LIKE` genuinely knows — a term in the title is what a page is
     * *about*, a term in the body is what it *mentions*.
     */
    expect(await titlesFor('aid')).toEqual([
      'Aid',
      'Aid for transfer students',
      'Bursaries and aid',
      'Costs',
    ]);
  });

  it('ranks without being asked, and defers the moment a caller names an order', async () => {
    await makePage('Aid', {});
    await makePage('Costs', { body: '<p>aid</p>' });

    // No sort: relevance, so the title match leads.
    expect(await titlesFor('aid')).toEqual(['Aid', 'Costs']);

    // A named order wins, because a search page offering "newest first" has to get it.
    const { items } = await listItemSummaries(handle.db, { search: 'aid', sort: 'title' });
    expect(items.map((item) => item.title)).toEqual(['Aid', 'Costs']);

    const oldest = await listItemSummaries(handle.db, { search: 'aid', sort: 'path' });
    expect(oldest.items.map((item) => item.title)).toEqual(['Aid', 'Costs']);
  });

  it('counts what it lists, so a facet cannot disagree with the rows', async () => {
    await makePage('Aid', {});
    await makePage('Costs', { body: '<p>aid</p>' });
    await makePage('Term dates', {});

    const { items, total } = await listItemSummaries(handle.db, { search: 'aid' });

    // The count comes from the same predicate the page does — the body match is in both or neither.
    expect(items).toHaveLength(2);
    expect(total).toBe(2);
  });
});

describe('excerpts', () => {
  const passage =
    'Riverbend was founded in 1897 on a bend in the river, and has taught continuously since. ' +
    'The accreditation review of 2019 confirmed its standing across every faculty, and the college ' +
    'has grown steadily in the years since without losing the scale that makes it what it is.';

  it('opens a window around the match, marked as a window on both sides', () => {
    const excerpt = buildExcerpt(passage, 'accreditation');

    expect(excerpt).toContain('accreditation review of 2019');
    expect(excerpt.startsWith('…')).toBe(true);
    expect(excerpt.endsWith('…')).toBe(true);
    // Bounded, or ten results are a page nobody can scan.
    expect(excerpt.length).toBeLessThanOrEqual(210);
  });

  it('opens from the beginning when the term is not in the body at all', () => {
    /**
     * The normal case for a title hit, and not a failure: the item matched on its title, and the
     * opening of its text is still the best summary available.
     */
    const excerpt = buildExcerpt(passage, 'riverbend college prospectus');

    expect(excerpt.startsWith('Riverbend was founded')).toBe(true);
    expect(excerpt.startsWith('…')).toBe(false);
  });

  it('marks no ellipsis when the whole text fits', () => {
    expect(buildExcerpt('Short and complete.', 'complete')).toBe('Short and complete.');
  });

  it('is empty for an item with no prose, rather than absent', () => {
    expect(buildExcerpt('', 'anything')).toBe('');
    expect(buildExcerpt('   ', 'anything')).toBe('');
  });

  it('loads a page of them in one query, and skips an unindexed item', async () => {
    const a = await makePage('A', { body: `<p>${passage}</p>` });
    const b = await makePage('B', { body: '<p>Nothing relevant.</p>' });

    await handle.db.deleteFrom('content_item_text').where('content_item_id', '=', b.id).execute();

    const excerpts = await loadSearchExcerpts(handle.db, [a.id, b.id], 'accreditation');

    expect(excerpts.get(a.id)).toContain('accreditation review');
    // Absent rather than empty: "never indexed" and "indexed, holds nothing" have to stay
    // distinguishable, or a database nobody reindexed is undiagnosable.
    expect(excerpts.has(b.id)).toBe(false);
  });

  it('answers an empty page of results without asking the database for `in ()`', async () => {
    expect(await loadSearchExcerpts(handle.db, [], 'anything')).toEqual(new Map());
  });
});

/**
 * The full-text index, and specifically the ways it can go wrong without anything erroring.
 *
 * `content_item_fts` is an external-content FTS5 table with no triggers — `0025_item_text_fts` says
 * why, and the consequence is that its consistency rests entirely on two statements `planTextIndex`
 * emits in the right order. Every failure mode here is silent: a search that keeps returning a page
 * whose word was deleted, or a query that errors only on punctuation nobody tested with.
 */
describe('full-text index', () => {
  async function ftsIntegrityOk(): Promise<boolean> {
    try {
      await sql`insert into content_item_fts(content_item_fts) values ('integrity-check')`.execute(
        handle.db,
      );
      return true;
    } catch {
      return false;
    }
  }

  it('forgets the old prose when an item is edited', async () => {
    // The single most important property, and the one an index without triggers has to earn: FTS5
    // stores an inverted index and no copy, so a save that indexes the new text without retracting
    // the old leaves both searchable. Nothing errors — the page simply keeps answering a search for
    // a word it no longer contains, forever.
    const item = await makePage('Programme', { body: '<p>Endowment and bursaries.</p>' });
    expect(await titlesFor('endowment')).toEqual(['Programme']);

    await updateItem(handle, pageType, fields, item.id, {
      data: { body: '<p>Scholarships and grants.</p>' },
    });

    expect(await titlesFor('endowment')).toEqual([]);
    expect(await titlesFor('scholarships')).toEqual(['Programme']);
    expect(await ftsIntegrityOk()).toBe(true);
  });

  it('retracts a deleted item from the index', async () => {
    // `content_item_text` cascades, but an external-content index has no foreign key to cascade
    // along. Reads join back through the text table so an orphan cannot surface as a result — what it
    // does is accumulate and skew bm25, which `integrity-check` is the only thing that notices.
    const item = await makePage('Doomed', { body: '<p>Convocation.</p>' });
    expect(await titlesFor('convocation')).toEqual(['Doomed']);

    await deleteItem(handle, item.id);

    expect(await titlesFor('convocation')).toEqual([]);
    expect(await ftsIntegrityOk()).toBe(true);
  });

  it('repairs a drifted index on the next save rather than failing it', async () => {
    /**
     * The reason `0025_item_text_fts` stores the text instead of using `content='content_item_text'`.
     *
     * An external-content index can only retract a row by being given the text it indexed, so once
     * the index and the text disagree, the *next save* of that item throws `database disk image is
     * malformed` — an editor pressing save on an ordinary page and being told the database is
     * corrupt, with no action available to them. This is the case that found it.
     */
    const item = await makePage('Prospectus', { body: '<p>Matriculation.</p>' });

    await sql`delete from content_item_fts`.execute(handle.db);

    await expect(
      updateItem(handle, pageType, fields, item.id, { data: { body: '<p>Graduation.</p>' } }),
    ).resolves.toBeDefined();

    expect(await titlesFor('graduation')).toEqual(['Prospectus']);
    expect(await ftsIntegrityOk()).toBe(true);
  });

  it('matches a prefix, so a half-typed word still finds the page', async () => {
    await makePage('Aid', { body: '<p>Scholarship deadlines.</p>' });
    expect(await titlesFor('schol')).toEqual(['Aid']);
  });

  it('ands its terms rather than oring them', async () => {
    await makePage('Both', { body: '<p>Autumn convocation ceremony.</p>' });
    await makePage('One', { body: '<p>Autumn leaves.</p>' });

    expect(await titlesFor('autumn convocation')).toEqual(['Both']);
  });

  it('survives punctuation that is FTS5 syntax', async () => {
    // Every one of these is meaningful in an FTS5 MATCH expression, so passing a search box through
    // unfiltered turns an ordinary query into a SQL error. `toMatchQuery` re-quotes tokens rather
    // than escaping in place, which is the same argument `sanitizeHtml` makes one layer up.
    await makePage('Languages', { body: '<p>We teach C++ and Python.</p>' });

    for (const query of ['C++', '"open', 'AND', 'NEAR(', 'a OR b', '*', 'x:y', '^caret', '-dash']) {
      await expect(titlesFor(query)).resolves.toBeInstanceOf(Array);
    }

    // And a query made only of punctuation still finds a page by *title*, rather than matching
    // nothing — `toMatchQuery` returns null and the prose term drops out of the OR.
    await makePage('!!!', {});
    expect(await titlesFor('!!!')).toEqual(['!!!']);
  });

  it('ranks by bm25 inside a band rather than alphabetically', async () => {
    // The gain over the CASE bands this replaced. All three match only in the body, so all three sit
    // in the old fifth band, which was ordered by `path` — alphabetical, i.e. no ranking at all on
    // the largest band there is. Zed says it most and must lead despite sorting last by title.
    await makePage('Alpha', { body: '<p>Bursary. Then a great deal of unrelated filler prose.</p>' });
    await makePage('Mid', { body: '<p>Bursary bursary. Plus unrelated filler prose here.</p>' });
    await makePage('Zed', { body: '<p>Bursary bursary bursary.</p>' });

    expect(await titlesFor('bursary')).toEqual(['Zed', 'Mid', 'Alpha']);
  });

  it('keeps a title match above a body match that scores higher', async () => {
    // The regression the pre-existing ranking test caught while this was being written: bm25 is
    // computed over `content_item_text`, which carries prose and not the title, so ranking by score
    // alone puts a page merely mentioning the word above the page named after it.
    await makePage('Bursary', { body: '<p>Nothing else here.</p>' });
    await makePage('Costs', { body: '<p>Bursary bursary bursary bursary.</p>' });

    expect(await titlesFor('bursary')).toEqual(['Bursary', 'Costs']);
  });

  it('is rebuilt wholesale by the reindex, including from an index that drifted', async () => {
    // What makes `db:reindex` a repair rather than a replay — and the recovery path for a database
    // restored from an export, which cannot carry a virtual table at all.
    await makePage('Restored', { body: '<p>Matriculation.</p>' });

    // Exactly what a restored export looks like: the text survives, the virtual table does not.
    await sql`delete from content_item_fts`.execute(handle.db);
    expect(await titlesFor('matriculation')).toEqual([]);

    await reindexDerived(handle);

    expect(await titlesFor('matriculation')).toEqual(['Restored']);
    expect(await ftsIntegrityOk()).toBe(true);
  });
});

describe('toMatchQuery', () => {
  it('quotes each token and prefixes only the last', () => {
    expect(toMatchQuery('financial aid')).toBe('"financial" "aid"*');
  });

  it('keeps letters and digits across scripts, and drops everything else', () => {
    expect(toMatchQuery('Peña 2026!')).toBe('"Peña" "2026"*');
    expect(toMatchQuery('C++')).toBe('"C"*');
  });

  it('neutralises FTS5 operators by quoting them as words', () => {
    expect(toMatchQuery('cats AND dogs')).toBe('"cats" "AND" "dogs"*');
  });

  it('is null when there is nothing to match on', () => {
    // Not "match nothing" — the caller drops the prose term and still searches title and path.
    expect(toMatchQuery('!!!')).toBeNull();
    expect(toMatchQuery('   ')).toBeNull();
    expect(toMatchQuery('')).toBeNull();
  });
});
