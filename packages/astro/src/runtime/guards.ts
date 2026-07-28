import type { User } from '@taproot/core';

import type { TaprootContext } from './context.js';

/**
 * Role gates.
 *
 * Phase 0 has a single global role per user; Phase 3 replaces the body of these functions with the
 * scoped model (role assignments narrowed to a content type, a taxonomy branch, or specific items).
 * Keeping every check behind these helpers now means that change lands in one file rather than
 * being spread across every route.
 */

export type Role = User['role'];

const ROLE_RANK: Record<Role, number> = {
  viewer: 0,
  contributor: 1,
  editor: 2,
  admin: 3,
};

export function hasRole(user: User | undefined, minimum: Role): boolean {
  if (!user) return false;
  return ROLE_RANK[user.role] >= ROLE_RANK[minimum];
}

/** Editing content types is schema work — admins only. */
export function canManageSchema(user: User | undefined): boolean {
  return hasRole(user, 'admin');
}

/** Creating and editing content. Publishing is a separate, higher gate. */
export function canEditContent(user: User | undefined): boolean {
  return hasRole(user, 'contributor');
}

export function canPublishContent(user: User | undefined): boolean {
  return hasRole(user, 'editor');
}

export function canManageUsers(user: User | undefined): boolean {
  return hasRole(user, 'admin');
}

export function canUploadMedia(user: User | undefined): boolean {
  return hasRole(user, 'contributor');
}

/**
 * Build the login URL for an unauthenticated request, preserving where they were headed.
 *
 * Only the path and query are carried through — never a full URL — so this cannot be turned into
 * an open redirect.
 */
export function loginRedirect(url: URL): string {
  const next = `${url.pathname}${url.search}`;
  return next === '/admin' ? '/admin/login' : `/admin/login?next=${encodeURIComponent(next)}`;
}

/** Read the context off `Astro.locals`, failing loudly if the middleware did not run. */
export function getTaproot(locals: unknown): TaprootContext {
  const context = (locals as { taproot?: TaprootContext }).taproot;
  if (!context) {
    throw new Error(
      'Taproot context is missing. The @taproot/astro integration registers middleware that ' +
        'creates it — check that `taproot()` is present in the `integrations` array of ' +
        'astro.config.mjs.',
    );
  }
  return context;
}
