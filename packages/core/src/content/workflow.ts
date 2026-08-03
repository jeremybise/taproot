import type { ContentStatus } from '../db/schema.js';

/**
 * The editorial workflow, as a transition model rather than a free-form status field.
 *
 * Until now `status` was a column anyone with the right role could set to anything: a contributor
 * could not publish, and that was the whole of it. Nothing said an archived page should come back
 * as a draft rather than reappearing live, or that "submit for review" is a different act from
 * "set the status to in_review" — even though the second is how the first was spelled.
 *
 * Modelled here in core and not in a screen, because the API is the boundary. A rule the editor
 * enforces and the REST API does not is not a rule.
 *
 * The graph is deliberately small. Every arrow is one somebody asked for; there is no
 * `archived → published`, because bringing an old page back is a decision that deserves a look at
 * its content first, and landing in `draft` is what forces that look.
 */

/** The lowest role that may make a transition. `null` means nobody: the move is not offered. */
export type TransitionRole = 'contributor' | 'editor' | null;

/**
 * From → to → who.
 *
 * Read it as a table rather than a set of rules: every cell is either a role or explicitly absent,
 * which is what makes "is this move allowed" a lookup instead of a series of conditions that
 * accumulate exceptions.
 */
const TRANSITIONS: Record<ContentStatus, Partial<Record<ContentStatus, TransitionRole>>> = {
  draft: {
    // A contributor's whole job: write, then hand it on.
    in_review: 'contributor',
    published: 'editor',
    scheduled: 'editor',
    archived: 'editor',
  },
  in_review: {
    // Sending it back is not a demotion that needs an editor — a contributor who spots a mistake
    // in their own submission should be able to pull it back rather than asking someone to.
    draft: 'contributor',
    published: 'editor',
    scheduled: 'editor',
    archived: 'editor',
  },
  scheduled: {
    // Cancelling a scheduled publish is an editor's call: it is a change to what the public will
    // see, made ahead of time, and undoing it silently is how a launch gets missed.
    draft: 'editor',
    in_review: 'editor',
    published: 'editor',
    archived: 'editor',
  },
  published: {
    // Everything off `published` takes a live page down, which is why none of these is lower than
    // editor no matter how harmless the destination sounds.
    draft: 'editor',
    in_review: 'editor',
    scheduled: 'editor',
    archived: 'editor',
  },
  archived: {
    /**
     * Back to draft only.
     *
     * There is deliberately no `archived → published`. A page was archived for a reason, and
     * whatever made it wrong then is usually still wrong; routing it through draft is what puts a
     * human in front of the content before the public is.
     */
    draft: 'editor',
  },
};

export interface Transition {
  to: ContentStatus;
  role: Exclude<TransitionRole, null>;
}

/** Every move out of a status, with the role each needs. */
export function transitionsFrom(status: ContentStatus): Transition[] {
  const row = TRANSITIONS[status] ?? {};
  return Object.entries(row)
    .filter((entry): entry is [ContentStatus, Exclude<TransitionRole, null>] => entry[1] !== null)
    .map(([to, role]) => ({ to, role }));
}

/**
 * Which move out of a status deserves to be the visible button, if any.
 *
 * The editor renders one named button plus a "More" disclosure, because four full-width buttons is
 * most of the sidebar and three of them are rare on any given edit. Which one is promoted is an
 * editorial judgement, so it is a table here rather than "whichever the loop reaches first" — that
 * would promote `in_review` on a draft for an editor who is about to publish, purely because of key
 * order in the object above.
 *
 * `published` deliberately has **no primary**. Everything reachable from it — back to draft, back to
 * review, schedule, archive — is an unusual thing to do to a live page, and the usual reason to open
 * one is to edit its content and press Save. Promoting any of them would be putting a button nobody
 * wants next to the one they do.
 *
 * `archived` needs no entry either: it has exactly one move, so there is nothing to hide behind a
 * disclosure and `transitionsFrom` already returns a list of one.
 */
export function primaryTransition(
  from: ContentStatus,
  canPublish: boolean,
): ContentStatus | undefined {
  const allowed = (to: ContentStatus) => {
    const role = TRANSITIONS[from]?.[to];
    if (!role) return false;
    return role === 'contributor' || canPublish;
  };

  switch (from) {
    // The forward move, for whoever is asking: publish it, or hand it on to somebody who can.
    case 'draft':
      return allowed('published') ? 'published' : allowed('in_review') ? 'in_review' : undefined;
    // Approve, or — for a contributor, who cannot — take it back.
    case 'in_review':
      return allowed('published') ? 'published' : allowed('draft') ? 'draft' : undefined;
    // Going live now is the forward move; cancelling is the second thought.
    case 'scheduled':
      return allowed('published') ? 'published' : undefined;
    case 'archived':
      return allowed('draft') ? 'draft' : undefined;
    default:
      return undefined;
  }
}

/**
 * The role a transition needs, or `null` if it is not a legal move at all.
 *
 * Staying put is always allowed and needs nothing: the editor posts the whole form, so an
 * unchanged status arrives as a value on every save and must not be read as a transition.
 */
export function transitionRole(
  from: ContentStatus,
  to: ContentStatus,
): TransitionRole | 'unchanged' {
  if (from === to) return 'unchanged';
  return TRANSITIONS[from]?.[to] ?? null;
}

export function isLegalTransition(from: ContentStatus, to: ContentStatus): boolean {
  const role = transitionRole(from, to);
  return role === 'unchanged' || role !== null;
}

/**
 * How to describe a transition to the person making it.
 *
 * The label is the *act*, not the destination. "Submit for review" and "set status to in_review"
 * are the same row in the table and different things to an editor — and the second is how the
 * first has been spelled until now, which is why nobody could find it.
 */
export function transitionLabel(from: ContentStatus, to: ContentStatus): string {
  if (from === 'draft' && to === 'in_review') return 'Submit for review';
  if (from === 'in_review' && to === 'draft') return 'Withdraw from review';
  if (from === 'in_review' && to === 'published') return 'Approve and publish';
  if (from === 'scheduled' && to === 'draft') return 'Cancel schedule';
  if (to === 'published') return from === 'published' ? 'Republish' : 'Publish';
  if (to === 'archived') return 'Archive';
  if (from === 'archived' && to === 'draft') return 'Restore as draft';
  if (to === 'scheduled') return 'Schedule';
  if (to === 'draft') return 'Return to draft';
  return `Move to ${to.replace(/_/g, ' ')}`;
}
