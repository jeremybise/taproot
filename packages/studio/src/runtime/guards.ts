import {
  apiKeyHasScope,
  transitionRole,
  type ApiKey,
  type ApiKeyScope,
  type ContentStatus,
  type User,
} from '@taprootcms/core';

import type { TaprootContext } from './context.js';

/**
 * Role gates.
 *
 * Roles are flat and site-wide — `viewer < contributor < editor < admin` — and that is the settled
 * model, not a placeholder. An earlier draft of SCOPE.md scoped role assignments to departments
 * that owned content; departments turned out to be classification, which the taxonomy already
 * does, so there is no ownership dimension to narrow a role against. See SCOPE.md.
 *
 * Every check stays behind these helpers anyway: a per-content-type permission matrix is the one
 * extension still plausible, and it would land in the bodies here rather than across every route.
 */

export type Role = User['role'];

/**
 * Who is asking.
 *
 * Until the delivery API there was one answer — a `users` row — and every guard took one. SCOPE
 * recorded taking a principal instead as a Phase 3 constraint, on the grounds that it is nearly
 * free while the role model is being designed and expensive afterwards. It was not done then, so
 * this is that debt being paid; the shape is unchanged from what was described.
 *
 * The two kinds are genuinely different and must not be collapsed. A user has a role and can be
 * asked "are you at least an editor"; a key has scopes and cannot be asked that at all. Modelling a
 * key as a user with a role would make every `hasRole` check in the codebase silently answer for it.
 */
export type Principal =
  | { kind: 'user'; user: User }
  | { kind: 'api_key'; key: ApiKey };

export function userPrincipal(user: User): Principal {
  return { kind: 'user', user };
}

export function apiKeyPrincipal(key: ApiKey): Principal {
  return { kind: 'api_key', key };
}

/** The user behind a principal, or `undefined` for a key. */
export function principalUser(principal: Principal | undefined): User | undefined {
  return principal?.kind === 'user' ? principal.user : undefined;
}

/**
 * Whether a principal carries a scope.
 *
 * A **user principal is deliberately never granted one.** It is tempting to say an admin implicitly
 * holds every scope, and it would be wrong: scopes exist to narrow what a machine credential may
 * do, and a route gated on a scope is one meant for machines. A signed-in admin reaching such a
 * route should be refused and sent to a route built for people, rather than quietly succeeding
 * through a path nobody tested.
 */
export function hasScope(principal: Principal | undefined, scope: ApiKeyScope): boolean {
  return principal?.kind === 'api_key' ? apiKeyHasScope(principal.key, scope) : false;
}

/**
 * The role guards below still take `User | undefined`, and that is the design rather than the debt.
 *
 * The obvious reading of "guards take a principal" is that every one of them changes signature. It
 * was tried and it is worse: `canPublishContent(principal)` has to answer for a key, and the only
 * correct answer is false — so every guard grows a branch that exists solely to say "not this kind
 * of thing", and forty call sites across the admin screens change to carry a wrapper they never
 * inspect.
 *
 * Converting at the boundary gets the same guarantee from the type system instead. `principalUser`
 * returns `undefined` for a key, `hasRole(undefined, …)` is already false, and there is no value of
 * type `User` that a key can produce — so a key cannot satisfy a role check, and the compiler
 * enforces it rather than a branch inside each guard.
 *
 * What genuinely had to change is the *auth layer*: the context carries a principal, and `handle()`
 * decides which kinds a route accepts. That is where the Phase 3 constraint actually bit.
 */

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

/**
 * The statuses a contributor may put an item into.
 *
 * Written as the short allowlist rather than the list of statuses that need the editor role, so an
 * unrecognised status fails closed: a row written by a newer build than this one is not something
 * to hand a contributor by default.
 *
 * `scheduled` is deliberately *not* here, even though nothing yet flips a scheduled item live. The
 * moment a scheduler exists an ungated `scheduled` becomes a way to publish without approval, and
 * a permission that has to be remembered while building an unrelated feature is one that will not
 * be. `archived` is not here either — archiving takes a page off the site, which is a publishing
 * decision wearing a different name.
 */
const CONTRIBUTOR_STATUSES: readonly string[] = ['draft', 'in_review'];

export function statusRequiresPublish(status: string): boolean {
  return !CONTRIBUTOR_STATUSES.includes(status);
}

/**
 * Whether this user may move an item from one status to another.
 *
 * Two questions, asked in order, and they are genuinely different:
 *
 *  1. **Is this move legal at all?** The workflow table in core owns that, and the answer does not
 *     depend on who is asking — `archived → published` is refused for an admin too, because it is
 *     an arrow that does not exist rather than a permission they lack.
 *  2. **May *you* make it?** Only then, and only for a move that exists.
 *
 * Both halves matter. Entering a status that reaches visitors needs the editor role, which is the
 * obvious one; *leaving* `published` needs it too, which is the one that was missing — publishing
 * was gated and unpublishing was free, so a contributor could take a live page to draft and it
 * would simply vanish from the site.
 *
 * `to` being undefined means the write does not touch status, which is the common case for an
 * ordinary edit and is nobody's business but `canEditContent`'s.
 */
export function canChangeStatus(
  user: User | undefined,
  from: ContentStatus | undefined,
  to: ContentStatus | undefined,
): boolean {
  if (to === undefined || to === from) return true;

  /**
   * A create has no previous status, so there is no transition to look up — only "may you put
   * something straight into this status", which is the same question `statusRequiresPublish`
   * answers.
   */
  if (from === undefined) {
    return statusRequiresPublish(to) ? canPublishContent(user) : canEditContent(user);
  }

  /**
   * Everything else goes through the workflow table, which is the single place the graph lives.
   *
   * An illegal move is refused for everyone including admins — `archived → published` is not a
   * permission an admin lacks, it is an arrow that does not exist, and a page coming back from
   * the archive goes through draft so somebody reads it first.
   */
  const role = transitionRole(from, to);
  if (role === null) return false;
  if (role === 'unchanged') return true;
  return hasRole(user, role);
}

/**
 * The same rule with the user taken out of it.
 *
 * The item editor is a React island that receives `canPublish` as a boolean prop rather than a
 * user row, and it has to disable exactly the options this route would refuse — a select that
 * offers a status the API then rejects is a 403 the editor could not have predicted. Splitting the
 * predicate out is what lets both sides ask the same question.
 */
export function statusChangeNeedsPublish(
  from: ContentStatus | undefined,
  to: ContentStatus | undefined,
): boolean {
  if (to === undefined || to === from) return false;
  if (from === undefined) return statusRequiresPublish(to);

  const role = transitionRole(from, to);
  // An illegal move is not "needs publish" — it is not on offer at all, and the editor filters it
  // out by legality before it ever asks about the role.
  return role === 'editor';
}

/**
 * Putting content into a release, and editing the version waiting there.
 *
 * Contributor, and the reason is that staging is not publishing. A staged version reaches nobody:
 * it sits in `release_items` until an editor publishes the release, which is the same shape as a
 * contributor moving an item to `in_review` and an editor approving it. Requiring the editor role
 * to stage would mean the people who write the content could not assemble the launch it is for.
 *
 * This is the permission question SCOPE.md left open, and the flat role model makes it a smaller
 * one than it was drafted as: with no departments to scope against, "can a Contributor add their
 * department's item to someone else's Release" is just "can a Contributor stage".
 */
export function canStageToRelease(user: User | undefined): boolean {
  return hasRole(user, 'contributor');
}

/**
 * Creating, scheduling, publishing, and deleting a release.
 *
 * Editor, and this one is not a new rule so much as the existing one arriving by a different route:
 * publishing a release performs a transition into `published` for every item in it, and the workflow
 * graph already prices that at editor. A release must not become a way to make a change that
 * `canChangeStatus` would refuse one item at a time.
 */
export function canManageRelease(user: User | undefined): boolean {
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
      'Taproot context is missing. The @taprootcms/studio integration registers middleware that ' +
        'creates it — check that `taproot()` is present in the `integrations` array of ' +
        'astro.config.mjs.',
    );
  }
  return context;
}
