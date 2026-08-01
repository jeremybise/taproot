import { listContentTypes, reorderContentTypes } from '@taprootcms/core';
import { z } from 'zod';

import { apiError, handle, json } from '../_shared.js';

const jsonSchema = z.object({ orderedIds: z.array(z.string()).min(1) });

/**
 * Reorder content types, which is what orders them in the admin sidebar.
 *
 * The form path sends one id and a direction rather than a full order, so the buttons work as
 * plain submits with no JavaScript. The server holds the current order anyway, so asking the
 * browser to send it back would be ceremony — and would go stale the moment two people reordered
 * at once.
 */
export const POST = handle(
  async ({ context, taproot }) => {
    const isForm = !(context.request.headers.get('content-type') ?? '').includes('application/json');
    const back = (params: Record<string, string> = {}) =>
      context.redirect(
        `/admin/settings/types${Object.keys(params).length ? `?${new URLSearchParams(params)}` : ''}`,
        303,
      );

    if (!isForm) {
      const parsed = jsonSchema.safeParse(await context.request.json());
      if (!parsed.success) return apiError(422, 'Send an orderedIds array.');
      await reorderContentTypes(taproot.db, parsed.data.orderedIds);
      return json({ ok: true });
    }

    const form = await context.request.formData();
    const id = String(form.get('id') ?? '');
    const direction = String(form.get('direction') ?? '');

    if (direction !== 'up' && direction !== 'down') {
      return back({ error: 'Unknown direction.' });
    }

    const current = await listContentTypes(taproot.db.db);
    const index = current.findIndex((type) => type.id === id);
    if (index === -1) return back({ error: 'That content type no longer exists.' });

    const target = direction === 'up' ? index - 1 : index + 1;
    // Already at the end: nothing to do, and no error worth showing.
    if (target < 0 || target >= current.length) return back();

    const ordered = current.map((type) => type.id);
    [ordered[index], ordered[target]] = [ordered[target]!, ordered[index]!];

    await reorderContentTypes(taproot.db, ordered);
    return back({ moved: current[index]!.name });
  },
  { role: 'admin' },
);
