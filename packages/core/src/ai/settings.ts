import type { Kysely } from 'kysely';

import type { Database } from '../db/schema.js';
import { fromBool, now, toBool } from '../db/values.js';
import { isAiProvider, type AiProviderName } from './providers.js';
import type { AiSettings } from './assist.js';

/**
 * The AI half of the one `settings` row.
 *
 * Same row and same `onConflict` shape as `getBranding`/`updateBranding`, which is safe because
 * `doUpdateSet` names only the columns each writer owns — branding cannot clear the provider and
 * this cannot clear the accent. A second table would have been the alternative and buys nothing: the
 * row is deployment-wide configuration either way, and there is exactly one of it.
 *
 * **No key is read or written here.** Keys live in the environment; see `0032_ai_assist`.
 */
const ROW_ID = 'site';

export async function getAiSettings(db: Kysely<Database>): Promise<AiSettings> {
  const row = await db
    .selectFrom('settings')
    .select(['ai_provider', 'ai_model', 'ai_alt_text', 'ai_seo'])
    .where('id', '=', ROW_ID)
    .executeTakeFirst();

  return {
    // An unrecognised stored provider reads as "none chosen" rather than being passed through. The
    // column is text, so a value written before this vocabulary existed — or by hand in a console —
    // must not reach `createAiProvider` and fall past its branches.
    provider: isAiProvider(row?.ai_provider) ? row.ai_provider : null,
    model: row?.ai_model ?? null,
    altText: toBool(row?.ai_alt_text ?? 0),
    seo: toBool(row?.ai_seo ?? 0),
  };
}

export interface AiSettingsInput {
  provider?: AiProviderName | null;
  model?: string | null;
  altText?: boolean;
  seo?: boolean;
}

/**
 * Absent keeps what is stored; the settings form sends all four.
 *
 * The same distinction `updateMenuItem` draws, and it matters for the two booleans for the same
 * reason — a caller patching the model must not silently switch both features off.
 */
export async function updateAiSettings(
  db: Kysely<Database>,
  input: AiSettingsInput,
  actorId: string | null,
): Promise<AiSettings> {
  const current = await getAiSettings(db);

  const next: AiSettings = {
    provider: input.provider === undefined ? current.provider : input.provider,
    // Blank means "use the provider's default", which is what null encodes — the same rule
    // `formValue` applies everywhere else in the admin.
    model: input.model === undefined ? current.model : input.model?.trim() || null,
    altText: input.altText ?? current.altText,
    seo: input.seo ?? current.seo,
  };

  const values = {
    ai_provider: next.provider,
    ai_model: next.model,
    ai_alt_text: fromBool(next.altText),
    ai_seo: fromBool(next.seo),
    updated_at: now(),
    updated_by: actorId,
  };

  await db
    .insertInto('settings')
    .values({ id: ROW_ID, ...values })
    .onConflict((conflict) => conflict.column('id').doUpdateSet(values))
    .execute();

  return next;
}
