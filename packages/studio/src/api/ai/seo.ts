import { z } from 'zod';

import { apiError, handle, json } from '../_shared.js';
import { assistantFor } from '../../runtime/ai.js';

const schema = z.object({ itemId: z.string().min(1) });

/**
 * How much of a page's prose reaches the provider.
 *
 * A cap rather than the whole thing, and it is cost control on a button an editor may press
 * repeatedly: a long page is thousands of tokens per press, and a meta description is drawn from the
 * opening far more than the tail. Characters rather than tokens because that is what is measurable
 * here without a tokeniser, and the number is generous enough that no ordinary page is cut.
 */
const MAX_PROSE = 6000;

/**
 * Propose a meta title and description for one item. **Writes nothing.**
 *
 * Like the alt-text route, this has no path to `content_items.seo` — the answer fills two inputs a
 * human accepts. A meta description is a claim about what a page is *for*, and the person who wrote
 * the page is the one who can judge it.
 *
 * `contributor`, matching who may edit an item's SEO panel at all.
 */
export const POST = handle(
  async ({ context, taproot }) => {
    const { itemId } = schema.parse(await context.request.json());

    const assistant = await assistantFor(taproot);
    if (!assistant.seo) return apiError(409, 'AI SEO suggestions are not enabled.');

    const item = await taproot.db.db
      .selectFrom('content_items')
      .select(['title'])
      .where('id', '=', itemId)
      .executeTakeFirst();

    if (!item) return apiError(404, 'Content item not found.');

    /*
     * The search index's own flattened text, not a fresh walk over `data`.
     *
     * `content_item_text` already holds this item's prose with blocks and repeater rows flattened,
     * rebuilt in the item's write batch — so what the model reads is exactly what search matches,
     * and there is no second walk to drift from the first. It also costs one indexed lookup instead
     * of loading `data` and reconstructing the walk on a button press.
     *
     * A missing row means "never indexed" rather than "holds nothing", which is the state a database
     * sits in between the migration and `npm run db:reindex`. Saying so is better than generating a
     * confident description of a page the model was shown nothing of.
     */
    const indexed = await taproot.db.db
      .selectFrom('content_item_text')
      .select(['text'])
      .where('content_item_id', '=', itemId)
      .executeTakeFirst();

    if (!indexed) {
      return apiError(
        409,
        'That item has not been indexed yet, so there is no text to summarise. Run ' +
          '`npm run db:reindex`, or save the item once.',
      );
    }

    const text = indexed.text.trim();
    if (!text) {
      // Distinct from unindexed, and a different instruction: the walk ran and found no prose, so
      // the fix is to write some rather than to reindex.
      return apiError(409, 'That item has no text to summarise yet.');
    }

    try {
      const suggestion = await assistant.suggestSeo({
        title: item.title,
        text: text.slice(0, MAX_PROSE),
      });
      return json(suggestion);
    } catch (cause) {
      return apiError(502, cause instanceof Error ? cause.message : 'The provider did not answer.');
    }
  },
  { role: 'contributor' },
);
