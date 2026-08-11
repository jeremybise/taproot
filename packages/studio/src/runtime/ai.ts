import { getAiSettings, resolveAssistant, type Assistant } from '@taprootcms/core';

import type { TaprootContext } from './context.js';

/**
 * Pair the environment's keys with the settings row to get a usable assistant.
 *
 * A function rather than a field on `TaprootContext`, because it reads a row: putting it on the
 * context would buy one query on every page view to answer a question that only the SEO panel, the
 * media screens, and Settings ever ask. Same reasoning as `blockTypeRegistry` being gated on placed
 * blocks rather than loaded unconditionally.
 */
export function assistantFor(taproot: TaprootContext): Promise<Assistant> {
  return getAiSettings(taproot.db.db).then((settings) => resolveAssistant(taproot.aiEnv, settings));
}
