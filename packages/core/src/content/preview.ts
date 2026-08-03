import type { Kysely } from 'kysely';

import type { Database } from '../db/schema.js';
import { now, parseJson, stringifyJson } from '../db/values.js';
import { hashSessionToken } from '../auth/session.js';
import { validateItemData } from '../validation/fields.js';
import { getItem, type ContentItem, type SeoData } from './items.js';
import { getContentType, blockTypeRegistry } from './types.js';
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
export { PREVIEW_PARAM, PREVIEW_MESSAGE } from '../pure.js';

/**
 * Where the site that reads this content lives, or the reason nobody knows.
 *
 * One function rather than a `process.env` read at each call site, because there are now three —
 * the redirect that mints a link, the JSON mint the split-view pane uses, and the pane's own empty
 * state — and an operator who has not set this should not be told three different things about it.
 *
 * Unset is a configuration gap with no sensible guess: redirecting to a 404 on the CMS's own origin
 * would be the same failure, spelled confusingly.
 */
export const NO_SITE_URL =
  'No site URL is configured, so Taproot does not know where to send a preview. Set ' +
  'TAPROOT_SITE_URL to the origin of the site that reads this content.';

export function previewSiteUrl(env: { TAPROOT_SITE_URL?: string }): string | undefined {
  return env.TAPROOT_SITE_URL || undefined;
}

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
   *
   * With a draft snapshot present, the editor's unsaved state is merged over that in turn.
   */
  item: ContentItem;
  releaseId: string | null;
  /**
   * Whether unsaved editor state was merged in.
   *
   * Not on the wire — `buildItemPayload` never sees it. It exists so tests can assert the merge
   * happened rather than inferring it from a value that might have matched by chance.
   */
  draft: boolean;
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

  const live = await getItem(db, row.content_item_id);
  if (!live) return undefined;

  /**
   * Three layers, applied in the order an editor experiences them.
   *
   * The live row is the base. A release's staged version goes over it, because that is the version
   * this token names. The editor's unsaved form state goes over *that*, because somebody in split
   * view on a staged version is editing the staged version — resolving the draft against the live
   * row instead would show them a page that is neither what they are editing nor what will ship.
   *
   * `path`, `status`, and `parent_id` survive every layer untouched, matching what `release_items`
   * deliberately does not stage. A preview that invented a path would be a preview of a URL nobody
   * will ever request.
   */
  let item = live;
  let releaseId: string | null = null;

  if (row.release_id) {
    const staged = await getStagedItem(db, row.release_id, row.content_item_id);
    // A staged version removed since the link was made falls back to the live item rather than
    // failing: the page still exists, and showing it is more useful than an error about a release.
    if (staged) {
      item = { ...item, title: staged.title, slug: staged.slug, data: staged.data, seo: staged.seo };
      releaseId = row.release_id;
    }
  }

  /**
   * `draft_updated_at` is the flag, not `data !== null`.
   *
   * "A snapshot has been written" is one fact, and deriving it from four nullable columns is four
   * chances to disagree — a snapshot whose `data` happened to be cleared would read as no snapshot.
   */
  if (row.draft_updated_at === null) return { item, releaseId, draft: false };

  return {
    item: {
      ...item,
      // Column by column, so a snapshot carrying only a title is a title override rather than a
      // silent wipe of everything else. The one writer always sends all four; the merge does not
      // depend on that staying true.
      title: row.title ?? item.title,
      slug: row.slug ?? item.slug,
      data: parseJson<Record<string, unknown>>(row.data, item.data),
      seo: parseJson<SeoData>(row.seo, item.seo),
    },
    releaseId,
    draft: true,
  };
}

/** The editor's unsaved form state, as the pane sends it. */
export interface PreviewDraft {
  title: string;
  slug: string;
  data: Record<string, unknown>;
  seo: SeoData;
}

export type PreviewDraftOutcome =
  /** Written. `expiresAt` is the slid expiry the client should trust from here. */
  | { ok: true; expiresAt: Date }
  /**
   * Unknown, expired, or not this person's.
   *
   * One outcome for all three, following `resolvePreviewToken` — telling them apart tells whoever
   * is guessing which guess was once real.
   */
  | { ok: false; reason: 'unknown' }
  /**
   * The draft breaks a rule that is not about being unfinished — a value past a `maxLength`, most
   * likely, which the editor warns about but does not block.
   *
   * The caller keeps the previous snapshot rather than clearing it, so the pane goes on showing the
   * last good state instead of going blank while somebody is briefly over a limit.
   */
  | { ok: false; reason: 'invalid'; errors: Record<string, string[]> };

/**
 * Store an unsaved editor snapshot against a preview token.
 *
 * The ownership rule lives here rather than in the route, for the same reason `deleteItem` enforces
 * its own blockers: the REST API must not be able to do what the admin declines.
 *
 * **The client never names the item.** `content_item_id` is on the row, so there is no request that
 * can aim a snapshot at a different content item — which is what makes a plain role check at the
 * boundary sufficient, with no per-item permission to invent.
 *
 * Sanitising is not this function's own idea: the draft goes through `validateItemData`, which is
 * where richtext sanitising lives for every write path in the system. `requireComplete: false`
 * relaxes three completeness rules and nothing else — see that option for which three and why
 * sanitising is not among them.
 *
 * The write slides `expires_at` by a full TTL. The thirty minutes exist so a *shared link* goes
 * stale, and somebody with the editor open and typing is not a stale link; without this the pane
 * dies mid-sentence on any page worth spending half an hour on. It costs one column in an `UPDATE`
 * that is happening anyway, and it makes the bound an idle timeout, which is the honest reading.
 */
export async function writePreviewDraft(
  db: Kysely<Database>,
  input: { token: string; userId: string; draft: PreviewDraft },
): Promise<PreviewDraftOutcome> {
  const id = await hashSessionToken(input.token);

  const row = await db
    .selectFrom('preview_tokens')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();

  if (!row) return { ok: false, reason: 'unknown' };
  if (Date.now() >= new Date(row.expires_at).getTime()) return { ok: false, reason: 'unknown' };
  /**
   * A session may only write to a snapshot it minted.
   *
   * Not a security boundary — a contributor may already edit this item through the REST API — but a
   * real property worth having: two people with the same page open in two tabs cannot scribble over
   * each other's preview. A null `created_by` fails, because a token nobody owns is one nobody may
   * write to.
   */
  if (!row.created_by || row.created_by !== input.userId) return { ok: false, reason: 'unknown' };

  const item = await getItem(db, row.content_item_id);
  if (!item) return { ok: false, reason: 'unknown' };

  const contentType = await getContentType(db, item.content_type_id);
  if (!contentType) return { ok: false, reason: 'unknown' };

  const validation = validateItemData(contentType.fields, input.draft.data, {
    blockTypes: await blockTypeRegistry(db),
    requireComplete: false,
  });
  if (!validation.success) return { ok: false, reason: 'invalid', errors: validation.errors };

  const expiresAt = new Date(Date.now() + PREVIEW_TOKEN_TTL_MS);

  await db
    .updateTable('preview_tokens')
    .set({
      title: input.draft.title,
      slug: input.draft.slug,
      // The *validated* data, not the input: that is the copy the richtext transform ran over.
      data: stringifyJson(validation.data ?? {}),
      seo: stringifyJson(input.draft.seo),
      draft_updated_at: now(),
      expires_at: expiresAt.toISOString(),
    })
    .where('id', '=', id)
    .execute();

  return { ok: true, expiresAt };
}

/** Drop expired tokens. Safe to call on a schedule. */
export async function purgeExpiredPreviewTokens(db: Kysely<Database>): Promise<number> {
  const result = await db
    .deleteFrom('preview_tokens')
    .where('expires_at', '<', now())
    .executeTakeFirst();
  return Number(result.numDeletedRows ?? 0);
}
