import type { Kysely } from 'kysely';

import type { Database } from '../db/schema.js';
import { now } from '../db/values.js';
import { hashSessionToken } from '../auth/session.js';
import { getItem, type ContentItem } from './items.js';
import { getStagedItem } from './releases.js';

/**
 * Preview links that survive a cross-origin split.
 *
 * `?preview=1` used to work because the site and the CMS shared an origin, so an editor's session
 * cookie was sent with the request and the route checked the *session*, never the parameter. That
 * distinction was the whole security property, and it stops being available the moment the site is
 * a separate deployment: the cookie is not sent, and there is nothing left to check.
 *
 * So the capability moves into a token. A row rather than a signed value, following
 * `login_challenges`: it must be short-lived and revocable, and a self-contained signed token stays
 * valid however the account changes underneath it. It also avoids inventing a signing secret, which
 * would need a working default for `npm run dev` — and a default signing secret is not a secret.
 *
 * **One mechanism covers a draft and a release's staged version.** Phase 3.5 added a second thing
 * worth previewing, and giving it its own token is how two nearly-identical paths drift until one
 * of them stops checking something.
 */

/** Long enough to open the link and read the page; short enough that a shared URL goes stale. */
export const PREVIEW_TOKEN_TTL_MS = 30 * 60 * 1000;

/**
 * Re-exported from `pure.ts`, which is where it is declared.
 *
 * That file is the only entry a consumer can import — this one needs Kysely — so the constant lives
 * there and is surfaced here so `@taprootcms/core` still exposes it to the server. One string, two
 * doors.
 */
export { PREVIEW_PARAM } from '../pure.js';

export interface GeneratedPreviewToken {
  /** The raw token. Exists here and in the link, never stored. */
  token: string;
  expiresAt: Date;
}

export async function createPreviewToken(
  db: Kysely<Database>,
  input: { contentItemId: string; releaseId?: string | null; userId?: string | null },
): Promise<GeneratedPreviewToken> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  const expiresAt = new Date(Date.now() + PREVIEW_TOKEN_TTL_MS);

  await db
    .insertInto('preview_tokens')
    .values({
      id: await hashSessionToken(token),
      content_item_id: input.contentItemId,
      release_id: input.releaseId ?? null,
      created_by: input.userId ?? null,
      expires_at: expiresAt.toISOString(),
      created_at: now(),
    })
    .execute();

  return { token, expiresAt };
}

export interface ResolvedPreview {
  /**
   * The item as the preview should show it.
   *
   * For a release preview this is the live row with the staged title, slug, data, and SEO merged
   * over it — which is what the page will look like *after* the release publishes, and therefore
   * the only useful thing to preview. Merged rather than fabricated so everything not staged
   * (status, path, parent) stays true.
   */
  item: ContentItem;
  releaseId: string | null;
}

/**
 * The content a preview token names, if the token is still good.
 *
 * Returns `undefined` for absent, malformed, unknown, and expired alike — the caller must answer
 * identically to all four, because distinguishing them tells whoever is guessing which guess was
 * once real.
 *
 * Deliberately **not** single-use. A preview link is opened, and then the page is reloaded, and
 * links inside it are followed back — burning the token on first read would make the feature work
 * exactly once per click, which is how a security measure becomes something people route around.
 * The short expiry is what bounds it instead.
 */
export async function resolvePreviewToken(
  db: Kysely<Database>,
  token: string | null | undefined,
): Promise<ResolvedPreview | undefined> {
  if (!token) return undefined;

  const row = await db
    .selectFrom('preview_tokens')
    .selectAll()
    .where('id', '=', await hashSessionToken(token))
    .executeTakeFirst();

  if (!row) return undefined;
  if (Date.now() >= new Date(row.expires_at).getTime()) return undefined;

  const item = await getItem(db, row.content_item_id);
  if (!item) return undefined;

  if (!row.release_id) return { item, releaseId: null };

  const staged = await getStagedItem(db, row.release_id, row.content_item_id);
  // A staged version removed since the link was made falls back to the live item rather than
  // failing: the page still exists, and showing it is more useful than an error about a release.
  if (!staged) return { item, releaseId: null };

  return {
    item: { ...item, title: staged.title, slug: staged.slug, data: staged.data, seo: staged.seo },
    releaseId: row.release_id,
  };
}

/** Drop expired tokens. Safe to call on a schedule. */
export async function purgeExpiredPreviewTokens(db: Kysely<Database>): Promise<number> {
  const result = await db
    .deleteFrom('preview_tokens')
    .where('expires_at', '<', now())
    .executeTakeFirst();
  return Number(result.numDeletedRows ?? 0);
}
