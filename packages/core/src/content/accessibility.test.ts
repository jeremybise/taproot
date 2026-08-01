import { describe, expect, it } from 'vitest';

import type { FieldRow } from '../db/schema.js';
import {
  A11Y_RULES,
  checkItemAccessibility,
  checkRichText,
  countBySeverity,
  isA11yRule,
  referencedMediaIds,
  type A11yContext,
  type A11yMediaInfo,
} from './accessibility.js';

/**
 * The content accessibility checker.
 *
 * Two properties are worth more than the individual rules and are asserted throughout: that the
 * walk reaches everywhere `validateItemData`'s does — blocks, nested blocks, repeater rows — and
 * that a rule stays quiet when it should, since a checker that cries wolf is one nobody reads.
 */

function field(overrides: Partial<FieldRow> & Pick<FieldRow, 'api_id' | 'type'>): FieldRow {
  return {
    id: `f-${overrides.api_id}`,
    content_type_id: 'ct',
    label: overrides.api_id,
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

const body = field({ api_id: 'body', label: 'Body', type: 'richtext' });

function image(id: string, altText: string | null): [string, A11yMediaInfo] {
  return [id, { filename: `${id}.jpg`, mimeType: 'image/jpeg', altText }];
}

describe('heading order', () => {
  it('accepts a run that never skips', () => {
    expect(checkRichText('<h2>One</h2><p>x</p><h3>Two</h3><h4>Three</h4>')).toEqual([]);
  });

  it('accepts going back up more than one level', () => {
    // h2 → h3 → h2 is a new section, not a skip. A naive "levels must differ by one" check calls
    // this an error, which is the most common way this rule is got wrong.
    expect(checkRichText('<h2>One</h2><h3>Under one</h3><h2>Two</h2>')).toEqual([]);
  });

  it('reports a skipped level', () => {
    const findings = checkRichText('<h2>One</h2><h4>Too deep</h4>');

    expect(findings).toHaveLength(1);
    expect(findings[0]!.rule).toBe('heading-order');
    expect(findings[0]!.severity).toBe('error');
    expect(findings[0]!.message).toContain('level 2');
    expect(findings[0]!.message).toContain('level 4');
  });

  it('reports a value that starts deeper than level 2', () => {
    const findings = checkRichText('<h3>Starts too deep</h3>');

    expect(findings).toHaveLength(1);
    expect(findings[0]!.rule).toBe('heading-order');
  });

  it('reports an h1 the sanitiser would never have allowed through', () => {
    // Unreachable through any write path — `h1` is absent from the allowlist. Asserted anyway
    // because content imported straight into the database has not been through it, and a rule that
    // relies on another module's invariant is one that silently stops holding when it changes.
    const findings = checkRichText('<h1>The title, again</h1>');

    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain('level 1');
  });

  it('counts each skip once, not once per following heading', () => {
    expect(checkRichText('<h2>a</h2><h4>b</h4><h4>c</h4>')).toHaveLength(1);
  });
});

describe('link text', () => {
  it('accepts text that names the destination', () => {
    expect(checkRichText('<p><a href="/apply">How to apply</a></p>')).toEqual([]);
  });

  it('reports a link with no text at all', () => {
    const findings = checkRichText('<p><a href="/apply"></a></p>');

    expect(findings).toHaveLength(1);
    expect(findings[0]!.rule).toBe('link-name');
    expect(findings[0]!.severity).toBe('error');
  });

  it('treats whitespace and entities as no text', () => {
    expect(checkRichText('<p><a href="/x">&nbsp; </a></p>')[0]!.rule).toBe('link-name');
  });

  it('warns about generic text, ignoring case and surrounding punctuation', () => {
    for (const html of ['<a href="/x">Click here</a>', '<a href="/x">read more…</a>']) {
      const findings = checkRichText(html);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.rule).toBe('link-text');
      expect(findings[0]!.severity).toBe('warning');
    }
  });

  it('warns about a bare URL as link text', () => {
    expect(checkRichText('<a href="/x">https://example.edu/apply</a>')[0]!.rule).toBe('link-text');
  });

  it('reads text through nested formatting', () => {
    expect(checkRichText('<a href="/x"><strong>Apply</strong> now</a>')).toEqual([]);
  });

  it('checks a link the markup never closed', () => {
    // Sanitised values are always balanced, so this is the same defensiveness as the h1 case: the
    // text was still going to be visible, so it is still worth an answer.
    expect(checkRichText('<p><a href="/x">click here')[0]!.rule).toBe('link-text');
  });
});

describe('missing alt text', () => {
  const media = field({ api_id: 'photo', label: 'Photo', type: 'media' });

  function contextWith(...entries: [string, A11yMediaInfo][]): A11yContext {
    return { altById: new Map(entries) };
  }

  it('reports an image nobody has described', () => {
    const issues = checkItemAccessibility([media], { photo: 'm1' }, contextWith(image('m1', null)));

    expect(issues).toHaveLength(1);
    expect(issues[0]!.rule).toBe('image-alt');
    expect(issues[0]!.severity).toBe('error');
    expect(issues[0]!.fieldApiId).toBe('photo');
    expect(issues[0]!.location).toBe('Photo');
  });

  it('stays quiet for an image marked decorative', () => {
    // `''` is somebody saying "this needs no description"; `null` is nobody having said. Collapsing
    // the two is what makes this rule unusable — every divider and icon becomes a permanent
    // complaint, and a panel that is always red is one nobody reads.
    const issues = checkItemAccessibility([media], { photo: 'm1' }, contextWith(image('m1', '')));

    expect(issues).toEqual([]);
  });

  it('stays quiet for a described image', () => {
    const issues = checkItemAccessibility(
      [media],
      { photo: 'm1' },
      contextWith(image('m1', 'The quad in autumn')),
    );

    expect(issues).toEqual([]);
  });

  it('ignores a non-image asset', () => {
    const issues = checkItemAccessibility(
      [media],
      { photo: 'm1' },
      { altById: new Map([['m1', { filename: 'form.pdf', mimeType: 'application/pdf', altText: null }]]) },
    );

    expect(issues).toEqual([]);
  });

  it('says nothing about an id it was not given', () => {
    // An unresolvable id is a broken reference, which is a different problem on a different screen.
    // Reporting "no alt text" would send somebody to fix an asset that no longer exists.
    expect(checkItemAccessibility([media], { photo: 'gone' }, contextWith())).toEqual([]);
  });

  it('reads every id of a multi-value media field', () => {
    const issues = checkItemAccessibility(
      [media],
      { photo: ['m1', 'm2', 'm3'] },
      contextWith(image('m1', null), image('m2', 'described'), image('m3', null)),
    );

    expect(issues).toHaveLength(2);
  });
});

describe('the walk', () => {
  const hero = {
    name: 'Hero',
    fields: [
      field({ api_id: 'intro', label: 'Intro', type: 'richtext' }),
      field({ api_id: 'image', label: 'Image', type: 'media' }),
    ],
  };

  const section = {
    name: 'Section',
    fields: [field({ api_id: 'inner', label: 'Inner blocks', type: 'block' })],
  };

  const blocks = field({ api_id: 'content', label: 'Page content', type: 'block' });

  const blockTypes = new Map([
    ['hero', hero],
    ['section', section],
  ]);

  it('reaches inside a block and names where it was', () => {
    const issues = checkItemAccessibility(
      [blocks],
      { content: [{ id: 'b1', type: 'hero', data: { intro: '<h4>Too deep</h4>' } }] },
      { blockTypes },
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]!.location).toBe('Page content → Block 1 (Hero) → Intro');
    // The top-level field, not the leaf: a block three levels down has no control of its own on
    // the page, but the block field holding it does, and that is what the editor can scroll to.
    expect(issues[0]!.fieldApiId).toBe('content');
  });

  it('reaches through nested blocks', () => {
    const issues = checkItemAccessibility(
      [blocks],
      {
        content: [
          {
            id: 'b1',
            type: 'section',
            data: {
              inner: [{ id: 'b2', type: 'hero', data: { intro: '<a href="/x">click here</a>' } }],
            },
          },
        ],
      },
      { blockTypes },
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]!.location).toBe(
      'Page content → Block 1 (Section) → Inner blocks → Block 1 (Hero) → Intro',
    );
  });

  it('stops at the same depth validation does', () => {
    // Six levels of Section, one level past MAX_BLOCK_DEPTH. Nothing throws and nothing recurses
    // without a bound; the deepest block is simply not reached, which matches the boundary that
    // would have refused to store it.
    let data: unknown = [{ id: 'deep', type: 'hero', data: { intro: '<h4>x</h4>' } }];
    for (let i = 0; i < 6; i++) {
      data = [{ id: `s${i}`, type: 'section', data: { inner: data } }];
    }

    expect(checkItemAccessibility([blocks], { content: data }, { blockTypes })).toEqual([]);
  });

  it('reaches into repeater rows and numbers them', () => {
    const hours = field({
      api_id: 'hours',
      label: 'Opening hours',
      type: 'repeater',
      config: JSON.stringify({
        fields: [{ api_id: 'note', label: 'Note', type: 'richtext', required: false, config: {} }],
      }),
    });

    const issues = checkItemAccessibility(
      [hours],
      {
        hours: [
          { id: 'r1', data: { note: '<p>Fine</p>' } },
          { id: 'r2', data: { note: '<a href="/x">read more</a>' } },
        ],
      },
      {},
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]!.location).toBe('Opening hours → Entry 2 → Note');
  });

  it('skips a block whose type it was not given', () => {
    // Deleting a block type is refused while blocks reference it, so this means something unusual
    // happened — and guessing at an unknown schema would invent findings.
    expect(
      checkItemAccessibility([blocks], { content: [{ id: 'b1', type: 'ghost', data: {} }] }, { blockTypes }),
    ).toEqual([]);
  });

  it('tolerates a value of the wrong shape', () => {
    expect(checkItemAccessibility([blocks], { content: 'not an array' }, { blockTypes })).toEqual([]);
    expect(checkItemAccessibility([body], { body: 42 }, {})).toEqual([]);
  });
});

describe('reusable blocks', () => {
  const blockTypes = new Map([
    ['callout', { name: 'Callout', fields: [field({ api_id: 'text', label: 'Text', type: 'richtext' })] }],
  ]);

  const reusableBlocks = new Map([
    [
      'lib1',
      { id: 'lib1', name: 'Admissions callout', type: 'callout', data: { text: '<a href="/x">click here</a>' } },
    ],
  ]);

  const blocks = field({ api_id: 'content', label: 'Page content', type: 'block' });

  it('checks the library entry’s content and attributes it there', () => {
    const issues = checkItemAccessibility(
      [blocks],
      { content: [{ id: 'b1', type: 'callout', ref: 'lib1', data: {} }] },
      { blockTypes, reusableBlocks },
    );

    expect(issues).toHaveLength(1);
    // The page's author cannot fix this here — the library row owns the content, which is the same
    // reason a referenced block skips field validation on the page.
    expect(issues[0]!.inheritedFrom).toEqual({ id: 'lib1', name: 'Admissions callout' });
    expect(issues[0]!.location).toBe('Page content → Block 1 (Admissions callout) → Text');
  });

  it('says nothing when the entry was not resolved', () => {
    const issues = checkItemAccessibility(
      [blocks],
      { content: [{ id: 'b1', type: 'callout', ref: 'missing', data: {} }] },
      { blockTypes, reusableBlocks },
    );

    expect(issues).toEqual([]);
  });
});

describe('referencedMediaIds', () => {
  const blockTypes = new Map([
    ['hero', { name: 'Hero', fields: [field({ api_id: 'image', label: 'Image', type: 'media' })] }],
  ]);

  it('finds ids the checker would read, including inside blocks and repeaters', () => {
    const fields = [
      field({ api_id: 'photo', label: 'Photo', type: 'media' }),
      field({ api_id: 'content', label: 'Page content', type: 'block' }),
      field({
        api_id: 'gallery',
        label: 'Gallery',
        type: 'repeater',
        config: JSON.stringify({
          fields: [{ api_id: 'shot', label: 'Shot', type: 'media', required: false, config: {} }],
        }),
      }),
    ];

    const ids = referencedMediaIds(
      fields,
      {
        photo: ['m1', 'm2'],
        content: [{ id: 'b1', type: 'hero', data: { image: 'm3' } }],
        gallery: [{ id: 'r1', data: { shot: 'm4' } }],
      },
      { blockTypes },
    );

    // Order is not part of the contract; membership is — a media field this misses is one whose
    // images all report as undescribed.
    expect(new Set(ids)).toEqual(new Set(['m1', 'm2', 'm3', 'm4']));
  });

  it('deduplicates an asset used twice', () => {
    const fields = [field({ api_id: 'photo', label: 'Photo', type: 'media' })];
    expect(referencedMediaIds(fields, { photo: ['m1', 'm1'] })).toEqual(['m1']);
  });
});

describe('rule metadata', () => {
  it('describes every rule the checker can emit', () => {
    const emitted = new Set(
      [
        ...checkRichText('<h4>a</h4><a href="/x"></a><a href="/y">click here</a>'),
        ...checkItemAccessibility(
          [field({ api_id: 'photo', label: 'Photo', type: 'media' })],
          { photo: 'm1' },
          { altById: new Map([image('m1', null)]) },
        ),
      ].map((issue) => issue.rule),
    );

    expect([...emitted].every(isA11yRule)).toBe(true);
    expect(new Set(A11Y_RULES)).toEqual(emitted);
  });

  it('rejects an inherited key as a rule name', () => {
    // The same trap the status filter fell into: testing membership with `in` rather than against
    // the list lets every inherited key through.
    expect(isA11yRule('toString')).toBe(false);
    expect(isA11yRule('constructor')).toBe(false);
  });
});

describe('countBySeverity', () => {
  it('splits errors from warnings', () => {
    const issues = checkRichText('<h4>a</h4><a href="/x">click here</a>').map((finding) => ({
      ...finding,
      fieldApiId: 'body',
      location: 'Body',
    }));

    expect(countBySeverity(issues)).toEqual({ errors: 1, warnings: 1 });
  });
});
