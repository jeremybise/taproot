import {
  WEBHOOK_EVENTS,
  WebhookEndpointError,
  createWebhookEndpoint,
  listWebhookEndpoints,
  recordAuditEntry,
  type WebhookEvent,
} from '@taprootcms/core';
import { z } from 'zod';

import { apiError, handle, json, readJson } from '../_shared.js';
import { revealCookie } from './revealCookie.js';

/**
 * Webhook endpoints.
 *
 * Admin-only in both directions, matching API keys. Creating one points a stream of content events
 * — including the titles and paths of unpublished work — at a URL somebody typed, and the list is an
 * inventory of what this deployment talks to.
 *
 * **No response here ever contains a secret**, except the one that mints one. `listWebhookEndpoints`
 * is redacted by construction rather than by this route remembering to strip a field.
 */
export const GET = handle(
  async ({ taproot }) => json({ endpoints: await listWebhookEndpoints(taproot.db.db) }),
  { role: 'admin' },
);

const createSchema = z.strictObject(
  {
    label: z.string().min(1).max(200),
    url: z.string().min(1),
    events: z
      .array(z.enum(WEBHOOK_EVENTS as unknown as [WebhookEvent, ...WebhookEvent[]]))
      .min(1),
  },
  {
    error: (issue) =>
      issue.code === 'unrecognized_keys'
        ? { message: `Unknown field(s): ${issue.keys.join(', ')}.` }
        : undefined,
  },
);

export const POST = handle(
  async ({ context, taproot, user }) => {
    const isForm = (context.request.headers.get('content-type') ?? '').includes('form');

    const back = (params: Record<string, string>) =>
      context.redirect(`/admin/settings/webhooks?${new URLSearchParams(params)}`, 303);

    let input: z.infer<typeof createSchema>;

    if (isForm) {
      const form = await context.request.formData();
      const label = String(form.get('label') ?? '').trim();
      if (!label) {
        return back({ error: 'Give it a name, so you can tell it from the others.' });
      }

      // `getAll`, or an endpoint subscribing to several events would silently be created with one.
      const events = form.getAll('events').map(String) as WebhookEvent[];

      input = { label, url: String(form.get('url') ?? ''), events };
    } else {
      input = await readJson(context.request, createSchema);
    }

    try {
      const { endpoint, secret } = await createWebhookEndpoint(taproot.db.db, {
        label: input.label,
        url: input.url,
        events: input.events,
        userId: user.id,
      });

      await recordAuditEntry(taproot.db.db, {
        action: 'webhook.created',
        subjectType: 'webhook',
        subjectId: endpoint.id,
        subjectLabel: endpoint.label,
        actor: user,
        // The URL, because "where does this deployment send content" is the question somebody
        // reading the log later is asking. Never the secret.
        detail: { url: endpoint.url, events: endpoint.events },
      });

      if (isForm) {
        /**
         * The secret travels back in a short-lived, HttpOnly cookie rather than the query string,
         * for the reason a minted API key does: a URL lands in history, in `Referer`, and in access
         * logs. The screen reads it once and clears it in the same response.
         */
        const response = context.redirect('/admin/settings/webhooks?created=1', 303);
        response.headers.append(
          'set-cookie',
          revealCookie({ label: endpoint.label, secret }, { secure: taproot.auth.secureCookies }),
        );
        return response;
      }

      return json({ endpoint, secret }, { status: 201 });
    } catch (error) {
      /**
       * A refused URL or an empty event list is the request's fault, not the server's.
       *
       * 400 rather than 500, and the message is the one core wrote — it names the rule and why it
       * exists, which is what an operator staring at a rejected `http://` URL needs.
       */
      if (error instanceof WebhookEndpointError) {
        return isForm ? back({ error: error.message }) : apiError(400, error.message);
      }
      throw error;
    }
  },
  { role: 'admin' },
);
