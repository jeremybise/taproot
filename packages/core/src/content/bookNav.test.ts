import { describe, expect, it } from 'vitest';

import { bookNavigation, type BookNavEntry } from './bookNav.js';

/**
 * Previous/next/up over an outline.
 *
 * The arithmetic is small; what is worth pinning is that filtering happens **before** the walk, so a
 * branch the site does not render is stepped over rather than stepped into — and that `up` is
 * derived from depth rather than from the real parent, because with a branch hidden the navigable
 * parent and the actual one are different rows.
 */

function entry(path: string, depth: number, typeApiId = 'section'): BookNavEntry {
  return { title: path, path, depth, typeApiId };
}

/**
 * A catalog in miniature: chapters, one of them with sections, and a branch of programs the site
 * keeps out of its navigation.
 */
const outline: BookNavEntry[] = [
  entry('/c/about', 0),
  entry('/c/admissions', 0),
  entry('/c/admissions/apply', 1),
  entry('/c/admissions/apply/deadlines', 2),
  entry('/c/admissions/costs', 1),
  entry('/c/programs', 0),
  entry('/c/programs/nursing', 1, 'program'),
  entry('/c/programs/welding', 1, 'program'),
  entry('/c/policies', 0),
];

describe('bookNavigation', () => {
  it('reads straight through in outline order, across depth changes', () => {
    const at = bookNavigation(outline, '/c/admissions/apply');
    expect(at.previous?.path).toBe('/c/admissions');
    expect(at.next?.path).toBe('/c/admissions/apply/deadlines');

    // Descending and ascending are both just the next element — the outline is already depth-first.
    const deep = bookNavigation(outline, '/c/admissions/apply/deadlines');
    expect(deep.next?.path).toBe('/c/admissions/costs');
  });

  it('has no previous at the start and no next at the end', () => {
    expect(bookNavigation(outline, '/c/about').previous).toBeNull();
    expect(bookNavigation(outline, '/c/policies').next).toBeNull();
  });

  it('answers all-null for a path that is not a section, rather than throwing', () => {
    // The book root itself is the ordinary case: it is not one of its own sections.
    const none = bookNavigation(outline, '/c');
    expect(none).toEqual({ current: null, previous: null, next: null, up: null, ancestors: [] });
  });

  it('builds ancestors from the top down', () => {
    const at = bookNavigation(outline, '/c/admissions/apply/deadlines');
    expect(at.ancestors.map((a) => a.path)).toEqual(['/c/admissions', '/c/admissions/apply']);
    expect(at.up?.path).toBe('/c/admissions/apply');
  });

  it('has no up at the top level', () => {
    expect(bookNavigation(outline, '/c/about').up).toBeNull();
  });

  /**
   * The reason the filter is the consumer's, and the reason it runs first.
   *
   * With programs excluded, the chapter before `/c/policies` is `/c/programs` — not
   * `/c/programs/welding`, which is what a filter applied *after* the walk would give: previous
   * would step into a branch the site does not render, and the reader would land on a 404 or a page
   * with no navigation out.
   */
  it('steps over an excluded branch rather than into it', () => {
    const at = bookNavigation(outline, '/c/policies', { exclude: ['program'] });
    expect(at.previous?.path).toBe('/c/programs');

    const from = bookNavigation(outline, '/c/programs', { exclude: ['program'] });
    expect(from.next?.path).toBe('/c/policies');
  });

  it('answers nothing for a page that was filtered out', () => {
    expect(bookNavigation(outline, '/c/programs/nursing', { exclude: ['program'] }).current).toBeNull();
  });

  it('takes only as the same decision from the other side', () => {
    const at = bookNavigation(outline, '/c/policies', { only: ['section'] });
    expect(at.previous?.path).toBe('/c/programs');
  });

  /**
   * `up` must point at something the reader can reach.
   *
   * With the intermediate level hidden, the real parent is gone from the navigable list — deriving
   * `up` from `parentId` would return a page the site does not render. Walking back by depth finds
   * the nearest ancestor that survived the filter instead.
   */
  it('points up at the nearest surviving ancestor, not the real parent', () => {
    const mixed: BookNavEntry[] = [
      entry('/c/admissions', 0),
      entry('/c/admissions/apply', 1, 'hidden'),
      entry('/c/admissions/apply/deadlines', 2),
    ];

    const at = bookNavigation(mixed, '/c/admissions/apply/deadlines', { exclude: ['hidden'] });
    expect(at.up?.path).toBe('/c/admissions');
    expect(at.ancestors.map((a) => a.path)).toEqual(['/c/admissions']);
  });

  it('is quiet on an empty outline', () => {
    expect(bookNavigation([], '/c/anything').current).toBeNull();
  });
});
