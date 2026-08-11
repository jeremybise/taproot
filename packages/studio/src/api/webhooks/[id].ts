import {
  WEBHOOK_EVENTS,
  WebhookEndpointError,
  attemptWebhookDelivery,
  deleteWebhookEndpoint,
  enqueueWebhookTest,
  getWebhookEndpoint,
  recordAuditEntry,
  redactWebhookEndpoint,
  rotateWebhookSecret,
  updateWebhookEndpoint,
  type WebhookEvent,
} from '@taprootcms/core';
import { z } from 'zod';

import { apiError, handle, json, noContent, readJson } from '../_shared.js';
import { revealCookie } from './revealCookie.js';

/**
 * One endpoint: edit it, pause it, rotate its secret, send it a test, delete it.
 *
 * More verbs than `api-keys/[id]`, which offers only revocation, and the difference is what the row
 * is. A key's label and scopes describe a credential already sitting in somebody else's deployment,
 * so editing them changes what that credential can do without telling its holder. An endpoint is a
 * *destination this deployment sends to* — changing which events it wants is the ordinary way to use
 * it, and the receiver finds out because the events stop or start arriving.
 */
const patchSchema = z.strictObject(
  {
    label: z.string().min(1).max(200).optional(),
    url: z.string().min(1).optional(),
    events: z
      .array(z.enum(WEBHOOK_EVENTS as unknown as [WebhookEvent, ...WebhookEvent[]]))
      .min(1)
      .optional(),
    active: z.boolean().optional(),
  },
  {
    error: (issue) =>
      issue.code === 'unrecognized_keys'
        ? { message: `Unknown field(s): ${issue.keys.join(', ')}.` }
        : undefined,
  },
);

export const GET = handle(
  async ({ context, taproot }) => {
    const endpoint = await getWebhookEndpoint(taproot.db.db, context.params.id!);
    if (!endpoint) return apiError(404, 'Webhook endpoint not found.');

    // Redacted on the way out. `getWebhookEndpoint` carries the secret because the dispatcher and
    // the test send need it; nothing that answers a request may pass it on.
    return json({ endpoint: redactWebhookEndpoint(endpoint) });
  },
  { role: 'admin' },
);

export const PATCH = handle(
  async ({ context, taproot, user }) => {
    const id = context.params.id!;
    const existing = await getWebhookEndpoint(taproot.db.db, id);
    if (!existing) return apiError(404, 'Webhook endpoint not found.');

    const input = await readJson(context.request, patchSchema);

    try {
      const endpoint = await updateWebhookEndpoint(taproot.db.db, id, input);

      await recordAuditEntry(taproot.db.db, {
        action: 'webhook.updated',
        subjectType: 'webhook',
        subjectId: id,
        subjectLabel: endpoint.label,
        actor: user,
        detail: { url: endpoint.url, events: endpoint.events, active: endpoint.active === 1 },
      });

      return json({ endpoint });
    } catch (error) {
      if (error instanceof WebhookEndpointError) return apiError(400, error.message);
      throw error;
    }
  },
  { role: 'admin' },
);

export const DELETE = handle(
  async ({ context, taproot, user }) => {
    const endpoint = await getWebhookEndpoint(taproot.db.db, context.params.id!);
    if (!endpoint) return apiError(404, 'Webhook endpoint not found.');

    await deleteWebhookEndpoint(taproot.db.db, endpoint.id);

    await recordAuditEntry(taproot.db.db, {
      action: 'webhook.deleted',
      subjectType: 'webhook',
      subjectId: endpoint.id,
      subjectLabel: endpoint.label,
      actor: user,
      detail: { url: endpoint.url },
    });

    return noContent();
  },
  { role: 'admin' },
);

/**
 * The form half: everything an HTML form can reach, keyed on `_method`.
 *
 * A form can only GET or POST, which is why the admin screen's edit, pause, rotate, test and delete
 * controls all arrive here — the same arrangement `items/[id]` and `api-keys/[id]` already use.
 */
export const POST = handle(
  async ({ context, taproot, user }) => {
    const id = context.params.id!;
    const endpoint = await getWebhookEndpoint(taproot.db.db, id);
    if (!endpoint) return apiError(404, 'Webhook endpoint not found.');

    const form = await context.request.formData();
    const method = String(form.get('_method') ?? '');

    const back = (params: Record<string, string>) =>
      context.redirect(`/admin/settings/webhooks?${new URLSearchParams(params)}`, 303);

    if (method === 'delete') {
      /**
       * Confirmed by typing the label, and checked on the server.
       *
       * The same shape as every other destructive form here: a disabled submit button is bypassed by
       * turning JavaScript off, and this admin is server-rendered precisely so it does not depend on
       * it. Deleting an endpoint takes its delivery history with it, which is the part somebody
       * would miss.
       */
      if (String(form.get('confirm') ?? '').trim() !== endpoint.label) {
        return back({ error: `Type ${endpoint.label} exactly to confirm. Nothing was deleted.` });
      }

      await deleteWebhookEndpoint(taproot.db.db, id);

      await recordAuditEntry(taproot.db.db, {
        action: 'webhook.deleted',
        subjectType: 'webhook',
        subjectId: id,
        subjectLabel: endpoint.label,
        actor: user,
        detail: { url: endpoint.url },
      });

      return back({ deleted: endpoint.label });
    }

    if (method === 'rotate') {
      const secret = await rotateWebhookSecret(taproot.db.db, id);

      await recordAuditEntry(taproot.db.db, {
        action: 'webhook.secret_rotated',
        subjectType: 'webhook',
        subjectId: id,
        subjectLabel: endpoint.label,
        actor: user,
        detail: { url: endpoint.url },
      });

      const response = context.redirect('/admin/settings/webhooks?rotated=1', 303);
      response.headers.append(
        'set-cookie',
        revealCookie(
          { label: endpoint.label, secret, rotated: true },
          { secure: taproot.auth.secureCookies },
        ),
      );
      return response;
    }

    if (method === 'pause' || method === 'resume') {
      await updateWebhookEndpoint(taproot.db.db, id, { active: method === 'resume' });

      await recordAuditEntry(taproot.db.db, {
        action: method === 'resume' ? 'webhook.resumed' : 'webhook.paused',
        subjectType: 'webhook',
        subjectId: id,
        subjectLabel: endpoint.label,
        actor: user,
        detail: { url: endpoint.url },
      });

      return back({ [method === 'resume' ? 'resumed' : 'paused']: endpoint.label });
    }

    if (method === 'test') {
      /**
       * Sent **inline and awaited**, unlike every real event.
       *
       * A content event is dispatched after the response because nobody is waiting for it. A test is
       * the opposite: somebody pressed a button to find out what happens, so the answer has to be on
       * the screen they land on rather than in a log they have to go and refresh. The row is written
       * first all the same, so the delivery log shows the attempt whichever way it goes.
       */
      const pending = await enqueueWebhookTest(taproot.db.db, endpoint);
      const outcome = await attemptWebhookDelivery(taproot.db.db, pending);

      await recordAuditEntry(taproot.db.db, {
        action: 'webhook.tested',
        subjectType: 'webhook',
        subjectId: id,
        subjectLabel: endpoint.label,
        actor: user,
        detail: { url: endpoint.url, ok: outcome.ok, status: outcome.status ?? null },
      });

      return outcome.ok
        ? back({ tested: endpoint.label, status: String(outcome.status ?? 200) })
        : back({ error: `Test delivery failed. ${outcome.error ?? ''}`.trim() });
    }

    if (method === 'update') {
      const events = form.getAll('events').map(String) as WebhookEvent[];

      try {
        await updateWebhookEndpoint(taproot.db.db, id, {
          label: String(form.get('label') ?? '').trim() || undefined,
          url: String(form.get('url') ?? '').trim() || undefined,
          events,
        });
      } catch (error) {
        if (error instanceof WebhookEndpointError) return back({ error: error.message });
        throw error;
      }

      await recordAuditEntry(taproot.db.db, {
        action: 'webhook.updated',
        subjectType: 'webhook',
        subjectId: id,
        subjectLabel: endpoint.label,
        actor: user,
        detail: { events },
      });

      return back({ saved: endpoint.label });
    }

    return apiError(400, 'Unsupported form action.');
  },
  { role: 'admin' },
);
