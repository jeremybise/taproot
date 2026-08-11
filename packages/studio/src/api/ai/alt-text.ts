import { z } from 'zod';

import { apiError, handle, json } from '../_shared.js';
import { assistantFor } from '../../runtime/ai.js';

const schema = z.object({
  mediaId: z.string().min(1),
  /** The page the image sits on, when the caller knows it. Alt text is context-dependent. */
  usedOn: z.string().max(200).nullish(),
});

/**
 * Propose alt text for one asset. **Writes nothing.**
 *
 * The response is a suggestion the editor accepts, edits, or ignores — the endpoint has no path to
 * `media.alt_text` at all, which is the structural version of the rule rather than a promise about
 * how the client behaves. A machine writing an empty description would mark the image *decorative*,
 * a claim that it carries no information and the one thing the three-state model exists to protect.
 *
 * `contributor`, matching who may upload and describe an asset. Generating a sentence for an image
 * already in the library is not a higher privilege than typing one.
 */
export const POST = handle(
  async ({ context, taproot }) => {
    const input = schema.parse(await context.request.json());

    const assistant = await assistantFor(taproot);
    // 409 rather than 400: the request is well-formed and the deployment is not configured for it,
    // which is a state the caller cannot fix by sending different fields.
    if (!assistant.altText) return apiError(409, 'AI alt text is not enabled.');

    const asset = await taproot.db.db
      .selectFrom('media')
      .select(['storage_key', 'filename', 'mime_type'])
      .where('id', '=', input.mediaId)
      .executeTakeFirst();

    if (!asset) return apiError(404, 'Media asset not found.');
    if (!asset.mime_type.startsWith('image/')) {
      return apiError(422, 'Only an image can be described.');
    }

    /*
     * Bytes through the storage adapter, never a URL.
     *
     * A provider fetching `publicUrl` would be a request from *its* network to ours, which fails for
     * reasons this deployment cannot see — a private bucket, a host that only answers inside the
     * zone, a Worker route that needs a session. Reading the object is the one path that works
     * wherever the CMS runs, and it is why `describeImage` takes an `AiImage` rather than a link.
     */
    const bytes = await taproot.storage.get(asset.storage_key);
    if (!bytes) return apiError(404, 'The stored file for that asset is missing.');

    try {
      const altText = await assistant.describeImage(
        { bytes, mimeType: asset.mime_type },
        { filename: asset.filename, usedOn: input.usedOn ?? null },
      );
      return json({ altText });
    } catch (cause) {
      // A provider being down is transient and belongs on screen as itself, not as a 500 with an
      // internal message. `handle` would otherwise map the throw to "something went wrong".
      return apiError(502, cause instanceof Error ? cause.message : 'The provider did not answer.');
    }
  },
  { role: 'contributor' },
);
