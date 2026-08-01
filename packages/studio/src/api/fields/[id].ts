import { deleteField, updateField } from '@taprootcms/core';
import { z } from 'zod';

import { handle, json, noContent, readJson } from '../_shared.js';

/**
 * Written out explicitly rather than derived from `fieldInputSchema` with `.partial()`.
 *
 * `.partial()` makes keys optional but does **not** strip a `.default()`, so a PATCH that only
 * renamed a field still arrived carrying `config: {}` — silently replacing the field's stored
 * options with nothing. A select field errored loudly; a text field would have quietly lost its
 * length limits and placeholder.
 *
 * Strict rejection then makes `type` and `api_id` an explicit error instead of being silently
 * dropped, since both are immutable after creation and a caller sending them deserves to be told.
 *
 * `z.strictObject` rather than `.strict(message)`: in Zod 4 `.strict()` takes no arguments, so the
 * message passed to it was accepted by the runtime and discarded. The error map below is scoped to
 * `unrecognized_keys` and returns undefined otherwise, leaving Zod's own wording for a malformed
 * body or a bad field value intact.
 */
const patchSchema = z.strictObject(
  {
    label: z.string().min(1).max(120).optional(),
    help_text: z.string().max(500).nullish(),
    required: z.boolean().optional(),
    localized: z.boolean().optional(),
    position: z.number().int().nonnegative().optional(),
    // No `.default()` — absent must stay absent so `updateField` keeps the stored config.
    config: z.record(z.string(), z.unknown()).optional(),
  },
  {
    error: (issue) =>
      issue.code === 'unrecognized_keys'
        ? "Only label, help_text, required, localized, position, and config can be changed. A field's " +
          'type and api_id are fixed after creation.'
        : undefined,
  },
);

export const PATCH = handle(
  async ({ context, taproot }) => {
    const input = await readJson(context.request, patchSchema);
    const field = await updateField(taproot.db.db, context.params.id!, input);
    return json({ field });
  },
  { role: 'admin' },
);

export const DELETE = handle(
  async ({ context, taproot }) => {
    await deleteField(taproot.db.db, context.params.id!);
    return noContent();
  },
  { role: 'admin' },
);
