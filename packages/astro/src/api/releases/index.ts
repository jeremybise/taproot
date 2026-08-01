import { createRelease, listReleases, recordAuditEntry } from '@taproot/core';
import { z } from 'zod';

import { handle, json, readJson } from '../_shared.js';

export const GET = handle(async ({ context, taproot }) => {
  const params = new URL(context.request.url).searchParams;
  const status = params.get('status');

  return json(
    await listReleases(taproot.db.db, {
      status:
        status === 'open' || status === 'scheduled' || status === 'published' || status === 'blocked'
          ? status
          : undefined,
      limit: Number(params.get('limit') ?? 50),
      offset: Number(params.get('offset') ?? 0),
    }),
  );
});

const createSchema = z.strictObject(
  {
    name: z.string().min(1).max(200),
    description: z.string().max(2000).nullish(),
  },
  {
    error: (issue) =>
      issue.code === 'unrecognized_keys'
        ? { message: `Unknown field(s): ${issue.keys.join(', ')}.` }
        : undefined,
  },
);

/**
 * Create a release, from JSON or from the releases screen's form.
 *
 * Editor rather than contributor: a release is a publishing artefact, and the person who decides
 * that a launch exists is the person who will publish it. Adding *content* to one is a contributor's
 * to do — see `canStageToRelease` — because that reaches nobody until this same role publishes.
 */
export const POST = handle(
  async ({ context, taproot, user }) => {
    const isForm = (context.request.headers.get('content-type') ?? '').includes('form');

    let input: z.infer<typeof createSchema>;
    if (isForm) {
      const form = await context.request.formData();
      const name = String(form.get('name') ?? '').trim();
      if (!name) {
        return context.redirect(
          `/admin/releases?${new URLSearchParams({ error: 'A release needs a name.' })}`,
          303,
        );
      }
      input = { name, description: String(form.get('description') ?? '') || null };
    } else {
      input = await readJson(context.request, createSchema);
    }

    const release = await createRelease(taproot.db.db, {
      name: input.name,
      description: input.description,
      userId: user.id,
    });

    await recordAuditEntry(taproot.db.db, {
      action: 'release.created',
      subjectType: 'release',
      subjectId: release.id,
      subjectLabel: release.name,
      actor: user,
    });

    // Straight into the new release rather than back to the list: a release with nothing in it is
    // not a thing anybody wanted, so the next step is always adding content to it.
    return isForm
      ? context.redirect(`/admin/releases/${release.id}`, 303)
      : json({ release }, { status: 201 });
  },
  { role: 'editor' },
);
