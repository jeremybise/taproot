import { describe, expect, it } from 'vitest';

import type { ContentStatus } from '../db/schema.js';
import {
  isLegalTransition,
  transitionLabel,
  transitionRole,
  transitionsFrom,
} from './workflow.js';

/**
 * The editorial workflow.
 *
 * `status` used to be a free-form column: any role that could write could set it to anything, and
 * the only rule was that a contributor could not publish. What was missing was the shape — that an
 * archived page comes back as a draft rather than going straight back live, and that "submit for
 * review" is an act with a name rather than a status somebody types.
 */

const ALL: ContentStatus[] = ['draft', 'in_review', 'scheduled', 'published', 'archived'];

describe('the graph', () => {
  it('lets a contributor draft and submit, and nothing further', async () => {
    const fromDraft = transitionsFrom('draft');
    expect(fromDraft.find((t) => t.to === 'in_review')?.role).toBe('contributor');

    for (const to of ['published', 'scheduled', 'archived'] as ContentStatus[]) {
      expect(fromDraft.find((t) => t.to === to)?.role).toBe('editor');
    }
  });

  it('lets a contributor withdraw their own submission', () => {
    // Not a demotion needing an editor: someone who spots their own mistake should be able to pull
    // it back rather than asking another person to un-submit it for them.
    expect(transitionRole('in_review', 'draft')).toBe('contributor');
  });

  it('needs an editor for everything that leaves published', () => {
    /**
     * Every one of these takes a live page down, however harmless the destination sounds. This is
     * the rule that was missing entirely — entering `published` was gated and leaving it was free.
     */
    for (const to of ['draft', 'in_review', 'scheduled', 'archived'] as ContentStatus[]) {
      expect(transitionRole('published', to)).toBe('editor');
    }
  });

  it('brings an archived page back only as a draft', () => {
    /**
     * The one deliberate omission in the graph. A page was archived for a reason, and whatever
     * made it wrong then usually still is — routing it through draft is what puts a person in
     * front of the content before the public is.
     */
    expect(transitionsFrom('archived').map((t) => t.to)).toEqual(['draft']);
    expect(transitionRole('archived', 'published')).toBeNull();
    expect(isLegalTransition('archived', 'published')).toBe(false);
  });

  it('treats staying put as allowed and not as a transition', () => {
    // The editor posts the whole form, so an unchanged status arrives as a value on every save.
    // Reading that as a transition would make every ordinary edit of a live page a publish.
    for (const status of ALL) {
      expect(transitionRole(status, status)).toBe('unchanged');
      expect(isLegalTransition(status, status)).toBe(true);
    }
  });

  it('reaches every status from a draft, so nothing is stranded', () => {
    const reachable = new Set(transitionsFrom('draft').map((t) => t.to));
    for (const status of ALL) {
      if (status !== 'draft') expect(reachable.has(status)).toBe(true);
    }
  });

  it('lets every status get back to draft, so nothing is a dead end', () => {
    for (const status of ALL) {
      if (status !== 'draft') expect(isLegalTransition(status, 'draft')).toBe(true);
    }
  });

  it('never offers a transition to itself', () => {
    for (const status of ALL) {
      expect(transitionsFrom(status).map((t) => t.to)).not.toContain(status);
    }
  });
});

describe('labels', () => {
  it('names the act rather than the destination', () => {
    /**
     * "Submit for review" and "set status to in_review" are the same row and different things to
     * an editor — and the second is how the first was spelled until now, which is why nobody could
     * find it.
     */
    expect(transitionLabel('draft', 'in_review')).toBe('Submit for review');
    expect(transitionLabel('in_review', 'published')).toBe('Approve and publish');
    expect(transitionLabel('in_review', 'draft')).toBe('Withdraw from review');
    expect(transitionLabel('scheduled', 'draft')).toBe('Cancel schedule');
    expect(transitionLabel('archived', 'draft')).toBe('Restore as draft');
  });

  it('has something to say for every legal transition', () => {
    // A blank or `Move to undefined` button is the failure mode of a lookup table with holes.
    for (const from of ALL) {
      for (const { to } of transitionsFrom(from)) {
        const label = transitionLabel(from, to);
        expect(label.length).toBeGreaterThan(0);
        expect(label).not.toMatch(/undefined/);
      }
    }
  });
});
