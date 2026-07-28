import type { Kysely } from 'kysely';

import type { Database, User } from '../db/schema.js';
import { now } from '../db/values.js';

/**
 * Opaque session tokens, hashed at rest.
 *
 * The raw token exists only in the user's cookie. The database stores its SHA-256, so a leaked
 * database dump cannot be replayed as a set of live sessions. This is the Lucia session model,
 * implemented directly rather than pulled in as a dependency — it is about sixty lines and avoids
 * a framework that has to be tracked across breaking changes.
 */

/** Sessions last 30 days. */
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
/** Refreshed when less than half the lifetime remains, so active users are never logged out. */
const REFRESH_THRESHOLD_MS = SESSION_TTL_MS / 2;

export const SESSION_COOKIE_NAME = 'taproot_session';

export interface SessionValidation {
  user: User;
  sessionId: string;
  /** True when the caller should re-issue the cookie because the expiry was extended. */
  refreshed: boolean;
  expiresAt: Date;
}

/** Generate a new session token. 32 bytes of CSPRNG output, hex-encoded. */
export function generateSessionToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Derive the storage key for a token. Never store the token itself. */
export async function hashSessionToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function createSession(
  db: Kysely<Database>,
  userId: string,
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateSessionToken();
  const id = await hashSessionToken(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await db
    .insertInto('sessions')
    .values({
      id,
      user_id: userId,
      expires_at: expiresAt.toISOString(),
      created_at: now(),
    })
    .execute();

  return { token, expiresAt };
}

/**
 * Validate a session token and return the user behind it.
 *
 * Expired sessions are deleted as they are encountered, which keeps the table tidy without
 * needing a scheduled cleanup job for the common case.
 */
export async function validateSession(
  db: Kysely<Database>,
  token: string,
): Promise<SessionValidation | null> {
  const id = await hashSessionToken(token);

  const row = await db
    .selectFrom('sessions')
    .innerJoin('users', 'users.id', 'sessions.user_id')
    .select([
      'sessions.id as session_id',
      'sessions.expires_at as expires_at',
      'users.id as id',
      'users.email as email',
      'users.name as name',
      'users.avatar_url as avatar_url',
      'users.role as role',
      'users.is_active as is_active',
      'users.created_at as created_at',
      'users.updated_at as updated_at',
    ])
    .where('sessions.id', '=', id)
    .executeTakeFirst();

  if (!row) return null;

  const expiresAt = new Date(row.expires_at);
  if (Date.now() >= expiresAt.getTime()) {
    await db.deleteFrom('sessions').where('id', '=', id).execute();
    return null;
  }

  // A deactivated user's existing sessions must stop working immediately, not at expiry.
  if (!row.is_active) {
    await db.deleteFrom('sessions').where('id', '=', id).execute();
    return null;
  }

  let refreshed = false;
  let effectiveExpiry = expiresAt;
  if (expiresAt.getTime() - Date.now() < REFRESH_THRESHOLD_MS) {
    effectiveExpiry = new Date(Date.now() + SESSION_TTL_MS);
    await db
      .updateTable('sessions')
      .set({ expires_at: effectiveExpiry.toISOString() })
      .where('id', '=', id)
      .execute();
    refreshed = true;
  }

  const user: User = {
    id: row.id,
    email: row.email,
    name: row.name,
    avatar_url: row.avatar_url,
    role: row.role,
    is_active: row.is_active,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };

  return { user, sessionId: row.session_id, refreshed, expiresAt: effectiveExpiry };
}

export async function invalidateSession(db: Kysely<Database>, token: string): Promise<void> {
  const id = await hashSessionToken(token);
  await db.deleteFrom('sessions').where('id', '=', id).execute();
}

/** Drop every session for a user — used on password change and on deactivation. */
export async function invalidateUserSessions(db: Kysely<Database>, userId: string): Promise<void> {
  await db.deleteFrom('sessions').where('user_id', '=', userId).execute();
}

/** Delete sessions that have already expired. Safe to call on a schedule. */
export async function purgeExpiredSessions(db: Kysely<Database>): Promise<number> {
  const result = await db.deleteFrom('sessions').where('expires_at', '<', now()).executeTakeFirst();
  return Number(result.numDeletedRows ?? 0);
}

export interface SessionCookieOptions {
  /** Omit `Secure` in local HTTP development, where the browser would otherwise drop the cookie. */
  secure: boolean;
  path?: string;
}

export function buildSessionCookie(
  token: string,
  expiresAt: Date,
  options: SessionCookieOptions,
): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${token}`,
    `Path=${options.path ?? '/'}`,
    `Expires=${expiresAt.toUTCString()}`,
    'HttpOnly',
    // Lax rather than Strict so returning from an OAuth provider's redirect carries the cookie.
    'SameSite=Lax',
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

export function buildSessionClearCookie(options: SessionCookieOptions): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    `Path=${options.path ?? '/'}`,
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}
