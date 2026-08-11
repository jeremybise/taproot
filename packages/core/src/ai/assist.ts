import { SEO_GUIDANCE } from '../content/seo.js';
import {
  createAiProvider,
  defaultAiModel,
  isAiProvider,
  type AiEnv,
  type AiImage,
  type AiProviderName,
} from './providers.js';

/**
 * The two things AI assist does, and the flag that decides whether to offer them.
 *
 * ## `available` is the mailer's `delivers` again
 *
 * A Generate button that 500s because nobody set a key is the same failure as a forgot-password form
 * whose success message is a lie: the screen made a promise the deployment cannot keep. So every
 * affordance gates on `available`, which is true only when a provider is chosen, its key is in the
 * environment, and the feature's own toggle is on. Three conditions, one boolean, checked in the
 * template rather than discovered on submit.
 *
 * ## Nothing here writes to a row
 *
 * Both functions return a string for a human to accept. That is the rule the three-state alt-text
 * model forces: a machine writing `''` would mark an image **decorative**, which is a claim that it
 * carries no information and which makes a screen reader skip it. No generator can know that, and no
 * amount of prompt care makes an empty completion safe to store. The same reasoning is milder but
 * real for a meta description — it is a claim about what a page is *for*, and the person who wrote
 * the page is the one who can judge it.
 */

/** What an editor is told when the feature is off, so a screen never has to word this itself. */
export const AI_UNAVAILABLE =
  'AI assist is not configured. An administrator sets a provider key in the environment and turns ' +
  'the feature on under Settings → AI.';

export interface AiSettings {
  provider: string | null;
  model: string | null;
  altText: boolean;
  seo: boolean;
}

export interface Assistant {
  /** Which provider would be called, and with which model. Reported on Settings → System. */
  readonly provider: AiProviderName | null;
  readonly model: string | null;
  /** A provider is chosen and its key exists. Neither feature is offered without this. */
  readonly configured: boolean;
  /** `configured` **and** this feature's own toggle. What a template gates on. */
  readonly altText: boolean;
  readonly seo: boolean;
  /**
   * A sentence describing one image, for an editor to accept or rewrite.
   *
   * Takes **bytes**, never a URL. The asset may live in R2 behind a Worker route, and a provider
   * fetching `TAPROOT_MEDIA_URL` from its own network is a request that can fail for reasons this
   * deployment cannot see — a private bucket, a host that only answers inside the zone. Reading
   * through the storage adapter is the one path known to work wherever the CMS runs.
   */
  describeImage(image: AiImage, context: AltTextContext): Promise<string>;
  /** A meta title and description proposed from the page's own prose. */
  suggestSeo(input: SeoContext): Promise<{ title: string; description: string }>;
}

export interface AltTextContext {
  /** The filename, which is often the only clue about intent — `dean-portrait-2027.jpg`. */
  filename: string;
  /** The page or item the image sits on, when the caller knows it. Alt text is context-dependent. */
  usedOn?: string | null;
}

export interface SeoContext {
  title: string;
  /**
   * The item's prose, already flattened and capped by the caller.
   *
   * The caller passes `content_item_text`'s row — the same flattened text the search index holds, so
   * what the model reads is what the page says, including prose inside blocks and repeater rows. It
   * is capped rather than sent whole: a long page is thousands of tokens on every press of a button,
   * and a meta description is drawn from the opening far more than the tail.
   */
  text: string;
}

/** Enough headroom that thinking plus a sentence cannot truncate. See `AiRequest.maxTokens`. */
const TASK_TOKENS = 2048;

const ALT_SYSTEM =
  'You write alt text for a public university website. Describe what the image conveys in its ' +
  'context, in one sentence, as if to somebody who cannot see it. Never begin with "image of", ' +
  '"photo of", or "picture of" — a screen reader already announces that it is an image. Do not end ' +
  'with a full stop unless the text is a complete sentence. Reply with the description alone: no ' +
  'quotation marks, no preamble, no alternatives, no explanation.';

const SEO_SYSTEM =
  'You write search-engine metadata for a public university website. Reply with exactly two lines: ' +
  'the first "TITLE: " followed by the meta title, the second "DESCRIPTION: " followed by the meta ' +
  'description. Write plainly for a prospective student or a member of the public. Do not pad with ' +
  'marketing language, do not invent facts the page does not state, and do not repeat the title ' +
  'inside the description.';

/**
 * Parse the two-line reply.
 *
 * A labelled two-line format rather than JSON, and that is a deliberate downgrade. A structured
 * output is available on one of the three providers and would need a different mechanism on each of
 * the others, so the shared shape is the plainest one every provider can hit. What makes it safe is
 * that a **failure to parse throws** rather than falling back to putting the whole reply in the
 * title field — an editor accepting a Generate result must never be handed an unlabelled blob.
 */
function parseSeo(reply: string): { title: string; description: string } {
  const title = /^\s*TITLE:\s*(.+)$/im.exec(reply)?.[1]?.trim();
  const description = /^\s*DESCRIPTION:\s*([\s\S]+)$/im.exec(reply)?.[1]?.trim();
  if (!title || !description) {
    throw new Error('The provider did not answer in the expected format. Try again.');
  }
  return { title, description };
}

function unavailable(): never {
  throw new Error(AI_UNAVAILABLE);
}

/**
 * Build the assistant from the environment and the settings row.
 *
 * Both halves are needed and neither is sufficient: the key says the deployment *can* call a
 * provider, the settings row says an operator *chose* to. Deriving the provider from whichever key
 * happens to be present would pick for them when several are set, and would make "a key is
 * configured but the feature is off" — a perfectly reasonable state — unsayable.
 */
export function resolveAssistant(env: AiEnv, settings: AiSettings): Assistant {
  const provider = isAiProvider(settings.provider) ? settings.provider : null;
  const adapter = provider ? createAiProvider(env, provider, settings.model) : null;
  const configured = adapter !== null;

  return {
    provider,
    model: adapter?.model ?? (provider ? defaultAiModel(provider) : null),
    configured,
    altText: configured && settings.altText,
    seo: configured && settings.seo,

    async describeImage(image, context) {
      if (!adapter || !settings.altText) unavailable();

      const where = context.usedOn ? ` It appears on the page “${context.usedOn}”.` : '';
      return adapter.generate({
        system: ALT_SYSTEM,
        prompt: `The file is named “${context.filename}”.${where} Write its alt text.`,
        image,
        maxTokens: TASK_TOKENS,
      });
    },

    async suggestSeo(input) {
      if (!adapter || !settings.seo) unavailable();

      /*
       * The length guidance comes from `SEO_GUIDANCE`, not from numbers written out here.
       *
       * That constant is already the one place those limits live — the editor's warning thresholds
       * read it too — so spelling them in this prompt would be a second copy free to drift from the
       * counter that turns amber beside the field the answer lands in.
       */
      const reply = await adapter.generate({
        system: SEO_SYSTEM,
        prompt:
          `Page title: ${input.title}\n\n` +
          `Page content:\n${input.text}\n\n` +
          `Keep the meta title near ${SEO_GUIDANCE.titleChars} characters and the meta ` +
          `description near ${SEO_GUIDANCE.descriptionChars}.`,
        maxTokens: TASK_TOKENS,
      });

      return parseSeo(reply);
    },
  };
}
