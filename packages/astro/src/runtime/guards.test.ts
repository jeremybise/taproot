import { describe, expect, it } from 'vitest';
import type { ContentStatus, User } from '@taproot/core';

import {
  canChangeStatus,
  canEditContent,
  canManageSchema,
  canManageUsers,
  canPublishContent,
  canUploadMedia,
  hasRole,
  loginRedirect,
  statusRequiresPublish,
} from './guards.js';

/**
 * The guards had no tests at all until this file.
 *
 * They were left alone on the assumption that the roles phase would rewrite their bodies with a
 * scoped model. It will not — flat site-wide roles are the settled answer — so these are permanent,
 * security-relevant, and every admin screen and API route is behind them.
 */

const user = (role: User['role']): User => ({
  id: `user-${role}`,
  email: `${role}@example.com`,
  name: role,
  avatar_url: null,
  role,
  is_active: 1 as User['is_active'],
  created_at: '2026-01-01T00:00:00.000Z' as User['created_at'],
  updated_at: '2026-01-01T00:00:00.000Z' as User['updated_at'],
});

const admin = user('admin');
const editor = user('editor');
const contributor = user('contributor');
const viewer = user('viewer');

describe('hasRole', () => {
  it('ranks roles so a higher one satisfies a lower requirement', () => {
    expect(hasRole(admin, 'contributor')).toBe(true);
    expect(hasRole(editor, 'contributor')).toBe(true);
    expect(hasRole(contributor, 'contributor')).toBe(true);
    expect(hasRole(viewer, 'contributor')).toBe(false);
  });

  it('refuses an absent user rather than throwing', () => {
    // Every guard takes `User | undefined` because a signed-out request reaches them the same way
    // a signed-in one does. Throwing here would turn a 403 into a 500.
    expect(hasRole(undefined, 'viewer')).toBe(false);
  });
});

describe('capability gates', () => {
  it('puts schema and user management behind admin', () => {
    expect(canManageSchema(editor)).toBe(false);
    expect(canManageSchema(admin)).toBe(true);
    expect(canManageUsers(editor)).toBe(false);
    expect(canManageUsers(admin)).toBe(true);
  });

  it('lets a contributor write content and upload, but not publish', () => {
    expect(canEditContent(contributor)).toBe(true);
    expect(canUploadMedia(contributor)).toBe(true);
    expect(canPublishContent(contributor)).toBe(false);
    expect(canPublishContent(editor)).toBe(true);
  });

  it('gives a viewer nothing', () => {
    for (const gate of [canEditContent, canUploadMedia, canPublishContent, canManageSchema]) {
      expect(gate(viewer)).toBe(false);
    }
  });
});

describe('statusRequiresPublish', () => {
  it('lets a contributor reach only draft and in_review', () => {
    expect(statusRequiresPublish('draft')).toBe(false);
    expect(statusRequiresPublish('in_review')).toBe(false);
  });

  it('covers scheduled and archived, not just published', () => {
    // `scheduled` becomes a publish-without-approval path the day a scheduler exists, and
    // `archived` takes a live page off the site. Both were ungated because the routes tested for
    // the literal string 'published'.
    expect(statusRequiresPublish('published')).toBe(true);
    expect(statusRequiresPublish('scheduled')).toBe(true);
    expect(statusRequiresPublish('archived')).toBe(true);
  });

  it('fails closed on a status this build does not know', () => {
    expect(statusRequiresPublish('pending_legal_review')).toBe(true);
  });
});

describe('canChangeStatus', () => {
  it('allows a write that does not touch status', () => {
    // The common case: a contributor editing the body of a page, published or not. Returning false
    // here would make every ordinary edit of a live page an editor-only action.
    expect(canChangeStatus(contributor, 'published', undefined)).toBe(true);
  });

  it('allows a no-op status write', () => {
    // The editor posts the whole form, so an unchanged select still arrives as a value.
    expect(canChangeStatus(contributor, 'published', 'published')).toBe(true);
  });

  it('lets a contributor move between draft and review', () => {
    expect(canChangeStatus(contributor, 'draft', 'in_review')).toBe(true);
    expect(canChangeStatus(contributor, 'in_review', 'draft')).toBe(true);
  });

  it('refuses a contributor publishing, scheduling, or archiving', () => {
    expect(canChangeStatus(contributor, 'draft', 'published')).toBe(false);
    expect(canChangeStatus(contributor, 'draft', 'scheduled')).toBe(false);
    expect(canChangeStatus(contributor, 'draft', 'archived')).toBe(false);
  });

  it('refuses a contributor UNpublishing', () => {
    // The hole this function exists to close. Entering `published` was gated and leaving it was
    // free, so a contributor could take a live page to `draft` and it would vanish from the site
    // without anyone with publish rights being involved.
    expect(canChangeStatus(contributor, 'published', 'draft')).toBe(false);
    expect(canChangeStatus(contributor, 'published', 'in_review')).toBe(false);
  });

  it('lets an editor move in either direction', () => {
    expect(canChangeStatus(editor, 'published', 'draft')).toBe(true);
    expect(canChangeStatus(editor, 'draft', 'published')).toBe(true);
    expect(canChangeStatus(editor, undefined, 'scheduled')).toBe(true);
  });

  it('treats creation as having no previous status', () => {
    expect(canChangeStatus(contributor, undefined, 'draft')).toBe(true);
    expect(canChangeStatus(contributor, undefined, 'published')).toBe(false);
  });

  it('refuses an anonymous requester any status change', () => {
    expect(canChangeStatus(undefined, 'draft', 'published')).toBe(false);
    expect(canChangeStatus(undefined, 'published', 'draft')).toBe(false);
  });

  it('covers every status pair without throwing', () => {
    const statuses: ContentStatus[] = [
      'draft',
      'in_review',
      'scheduled',
      'published',
      'archived',
    ];
    for (const from of statuses) {
      for (const to of statuses) {
        expect(typeof canChangeStatus(contributor, from, to)).toBe('boolean');
        // An admin outranks an editor, so nothing an editor may do is closed to them.
        expect(canChangeStatus(admin, from, to)).toBe(true);
      }
    }
  });
});

describe('loginRedirect', () => {
  it('carries only a path and query, never a full URL', () => {
    // Anything that reflected the origin back would be an open redirect.
    const next = loginRedirect(new URL('https://example.com/admin/content?q=fees'));
    expect(next).toBe(`/admin/login?next=${encodeURIComponent('/admin/content?q=fees')}`);
    expect(next).not.toContain('example.com');
  });

  it('does not add a redundant next for the admin root', () => {
    expect(loginRedirect(new URL('https://example.com/admin'))).toBe('/admin/login');
  });
});
