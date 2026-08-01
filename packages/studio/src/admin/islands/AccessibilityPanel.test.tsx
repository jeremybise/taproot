// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FieldRow } from '@taproot/core';

import AccessibilityPanel from './AccessibilityPanel.js';
import type { MediaOption } from '../mediaOptions.js';

/**
 * The editor's accessibility panel, hydrated.
 *
 * `scripts/a11y-audit.mjs` cannot see this: it is an island, so the server sends a placeholder and
 * the panel only exists after hydration — the same reason the richtext toolbar and the media picker
 * have tests of this shape. What is asserted here is the panel's own accessibility plus the two
 * behaviours that are its whole reason for existing: that it reports what the *form* currently
 * holds rather than what was saved, and that it resolves alt text for an asset outside the
 * library's first page instead of accusing it.
 */

afterEach(cleanup);

function field(api_id: string, label: string, type: FieldRow['type']): FieldRow {
  return {
    id: `f-${api_id}`,
    content_type_id: 'ct',
    api_id,
    label,
    type,
    help_text: null,
    position: 0,
    required: 0,
    localized: 0,
    config: '{}',
    created_at: '',
    updated_at: '',
  } as FieldRow;
}

const FIELDS = [field('body', 'Body', 'richtext'), field('photo', 'Photo', 'media')];

function asset(id: string, altText: string | null): MediaOption {
  return {
    id,
    filename: `${id}.jpg`,
    url: `/media/${id}.jpg`,
    altText,
    mimeType: 'image/jpeg',
    width: 1600,
    height: 900,
  };
}

describe('what it reports', () => {
  it('says so plainly when there is nothing to report', () => {
    render(<AccessibilityPanel fields={FIELDS} data={{ body: '<h2>Fine</h2>' }} />);

    expect(screen.getByText('No issues found.')).toBeDefined();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('reports a skipped heading against the field it came from', () => {
    render(<AccessibilityPanel fields={FIELDS} data={{ body: '<h2>a</h2><h4>b</h4>' }} />);

    expect(screen.getByText('1 error to look at.')).toBeDefined();
    // Aimed at the label rather than the control: `FieldControl` only renders an element with the
    // control's own id for the labelable types, and the label exists in every branch.
    expect(screen.getByRole('link', { name: 'Body' }).getAttribute('href')).toBe('#field-f-body-label');
  });

  it('counts errors and warnings separately', () => {
    render(
      <AccessibilityPanel
        fields={FIELDS}
        data={{ body: '<h4>a</h4><p><a href="/x">click here</a></p>' }}
      />,
    );

    expect(screen.getByText('1 error and 1 warning to look at.')).toBeDefined();
  });

  it('names the severity in words, not only in colour', () => {
    // A bare colour swatch is a WCAG 1.4.1 failure, which would be a poor thing for this panel of
    // all panels to ship.
    render(<AccessibilityPanel fields={FIELDS} data={{ body: '<h4>a</h4>' }} />);

    expect(screen.getByText('Error')).toBeDefined();
  });

  it('updates as the form does, without a save', () => {
    // The reason this is an island at all: a heading skip is something somebody is typing now.
    const { rerender } = render(
      <AccessibilityPanel fields={FIELDS} data={{ body: '<h2>a</h2>' }} />,
    );
    expect(screen.getByText('No issues found.')).toBeDefined();

    rerender(<AccessibilityPanel fields={FIELDS} data={{ body: '<h2>a</h2><h4>b</h4>' }} />);
    expect(screen.getByText('1 error to look at.')).toBeDefined();
  });

  it('points a library block’s issue at the library', () => {
    const blockTypes = [
      {
        api_id: 'callout',
        name: 'Callout',
        fields: [field('text', 'Text', 'richtext')],
      },
    ] as unknown as Parameters<typeof AccessibilityPanel>[0]['blockTypes'];

    render(
      <AccessibilityPanel
        fields={[field('content', 'Page content', 'block')]}
        data={{ content: [{ id: 'b1', type: 'callout', ref: 'lib1', data: {} }] }}
        blockTypes={blockTypes}
        reusableBlocks={[
          { id: 'lib1', name: 'Admissions callout', block_type: 'callout', data: { text: '<h4>x</h4>' } },
        ]}
      />,
    );

    expect(screen.getByRole('link', { name: 'Admissions callout' }).getAttribute('href')).toBe(
      '/admin/blocks/lib1',
    );
  });
});

describe('alt text', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('reads an asset the picker already has', () => {
    render(
      <AccessibilityPanel fields={FIELDS} data={{ photo: 'm1' }} library={[asset('m1', null)]} />,
    );

    expect(screen.getByText(/m1\.jpg.*has no alt text/)).toBeDefined();
  });

  it('stays quiet for one marked decorative', () => {
    render(<AccessibilityPanel fields={FIELDS} data={{ photo: 'm1' }} library={[asset('m1', '')]} />);

    expect(screen.getByText('No issues found.')).toBeDefined();
  });

  it('fetches an asset neither list covers rather than accusing it', async () => {
    /**
     * The case this panel would otherwise get wrong. `library` is the picker's most recent page, so
     * an image searched for past it — or referenced from years ago — is not in either list, and
     * reading alt text from what is on hand would report a described image as undescribed.
     */
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        media: [{ id: 'old', filename: 'old.jpg', alt_text: 'The quad in 2019', mime_type: 'image/jpeg' }],
      }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    render(<AccessibilityPanel fields={FIELDS} data={{ photo: 'old' }} library={[]} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/taproot/media?ids=old'));
    await waitFor(() => expect(screen.getByText('No issues found.')).toBeDefined());
  });

  it('asks once for an id the server does not return', async () => {
    // A deleted asset comes back from nowhere. Without the attempted-set this would refire on every
    // render — which for a panel recomputed on each keystroke means a request per character.
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ media: [] }) });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { rerender } = render(
      <AccessibilityPanel fields={FIELDS} data={{ photo: 'gone', body: '<p>a</p>' }} />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    rerender(<AccessibilityPanel fields={FIELDS} data={{ photo: 'gone', body: '<p>ab</p>' }} />);
    rerender(<AccessibilityPanel fields={FIELDS} data={{ photo: 'gone', body: '<p>abc</p>' }} />);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // An unresolved id is not reported — the safe direction, since it is a broken reference rather
    // than a description somebody forgot.
    expect(screen.getByText('No issues found.')).toBeDefined();
  });
});

describe('the panel itself', () => {
  it('has no axe violations with issues on show', async () => {
    const { container } = render(
      <AccessibilityPanel
        fields={FIELDS}
        data={{ body: '<h4>a</h4><p><a href="/x">click here</a></p>' }}
      />,
    );

    // Scoped to the container: in isolation there is no landmark around the component, and the
    // `region` violation that produces is an artifact of the test rather than of the panel.
    // `color-contrast` is off because `scripts/a11y-contrast.mjs` is the authority on tokens, which
    // jsdom cannot resolve.
    const results = await axe.run(container, {
      rules: { region: { enabled: false }, 'color-contrast': { enabled: false } },
    });

    expect(results.violations.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([]);
  });

  it('announces its summary politely rather than assertively', async () => {
    // This changes on almost every keystroke. An assertive region would interrupt a screen reader
    // mid-sentence — including the sentence being typed.
    render(<AccessibilityPanel fields={FIELDS} data={{ body: '<h4>a</h4>' }} />);

    const summary = screen.getByText('1 error to look at.');
    expect(summary.getAttribute('aria-live')).toBe('polite');
  });
});
