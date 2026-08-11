/**
 * Three AI providers behind one interface, over `fetch`, with no SDKs.
 *
 * ## Why adapters here and a webhook for mail
 *
 * `mailer.ts` refuses to carry per-provider adapters and takes a webhook instead, and this file does
 * the opposite. That is a real tension and it resolves the other way for a stated reason: mail had a
 * generic shape available — four senders all accept "to, subject, body", so five lines on the
 * operator's side reaches every one of them. There is no generic shape for "describe this image":
 * the request carries bytes, the auth header differs, and the reply is buried at a different path in
 * each response. A webhook here would mean every operator writing the adapter this file already is,
 * and getting the multipart encoding wrong on their own.
 *
 * No SDKs, for the reason the repo has no native dependencies: three vendor SDKs in `core` is three
 * dependency trees reaching a Workers bundle, and each one wants Node built-ins somewhere. A `fetch`
 * per provider is about thirty lines and cannot pull anything in.
 *
 * ## What every adapter owes the caller
 *
 * A **string**, or a throw. No provider's error shape is exposed, because the caller is a route that
 * has to put something on a screen, and `resolveAssistant`'s `available` flag has already answered
 * the only structural question — whether a key exists. Beyond that, a provider being down is a
 * transient failure the editor retries, not a state the admin models.
 */

/** Which provider to call. Stored in `settings.ai_provider`; the key lives in the environment. */
export type AiProviderName = 'anthropic' | 'openai' | 'gemini';

export const AI_PROVIDERS: readonly AiProviderName[] = ['anthropic', 'openai', 'gemini'];

export function isAiProvider(value: unknown): value is AiProviderName {
  return typeof value === 'string' && (AI_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Provider keys, read from the environment and never from the database.
 *
 * One per provider rather than a single `TAPROOT_AI_API_KEY`, so switching provider in Settings does
 * not mean redeploying with a different secret under the same name — and so Settings can report
 * *which* providers are configured rather than just "a key is set somewhere".
 */
export interface AiEnv {
  TAPROOT_ANTHROPIC_API_KEY?: string;
  TAPROOT_OPENAI_API_KEY?: string;
  TAPROOT_GEMINI_API_KEY?: string;
}

/** An image to describe, as bytes. Never a URL — see `describeImage` in `assist.ts`. */
export interface AiImage {
  bytes: Uint8Array;
  mimeType: string;
}

export interface AiRequest {
  /** The role and the rules. Sent in each provider's own system slot, never prepended to `prompt`. */
  system: string;
  prompt: string;
  image?: AiImage;
  /**
   * A ceiling on the reply, and it has to be generous rather than tight.
   *
   * On a current reasoning model this bounds thinking *plus* the answer, so a value sized to the
   * twenty words of alt text actually wanted truncates mid-sentence. Every task here asks for a
   * sentence or two and passes something in the low thousands.
   */
  maxTokens: number;
}

export class AiError extends Error {
  override name = 'AiError';
}

export interface AiProvider {
  readonly name: AiProviderName;
  readonly model: string;
  generate(request: AiRequest): Promise<string>;
}

/**
 * Bytes to base64, chunked.
 *
 * `toBase64` in `auth/password.ts` already does this and is not reused: it appends one character at
 * a time, which is correct and unremarkable for the 32-byte digest it was written for and is a
 * different proposition for a five-megabyte photograph. Chunked `fromCharCode` is the faster shape,
 * and the chunk size is what keeps it safe — spreading a whole image into an argument list is how
 * this overflows the stack, which is a crash rather than a slow path.
 */
const CHUNK = 0x8000;

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** The one place a non-2xx becomes an error, so no adapter invents its own wording. */
async function readOrThrow(
  response: Response,
  provider: AiProviderName,
  model?: string,
): Promise<unknown> {
  if (!response.ok) {
    /*
     * The body is read for the message but deliberately truncated. A provider error can carry the
     * echoed request — which for a describe call is a base64 image — and this string reaches an
     * editor's screen and the server log.
     */
    const detail = (await response.text().catch(() => '')).slice(0, 300);
    /*
     * The model is named on a 4xx because it is the likeliest cause and the least visible one: the
     * settings field takes any string, so a typo or an unsupported model surfaces here as a
     * provider error about a parameter rather than as "that model is wrong". Left off a 5xx, where
     * the model is not the problem and saying so would misdirect.
     */
    const where = model && response.status < 500 ? ` (model: ${model})` : '';
    throw new AiError(`${provider} responded ${response.status}${where}. ${detail}`.trim());
  }
  return response.json();
}

function requireText(value: string | undefined, provider: AiProviderName): string {
  const text = value?.trim();
  if (!text) throw new AiError(`${provider} returned no text.`);
  return text;
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

/**
 * The default model, and the reason it is a constant rather than a required setting.
 *
 * `settings.ai_model` overrides it; null means "whatever this provider's sensible default is", so an
 * operator who has set a key and nothing else gets a working feature. A required model field would
 * make the first run a configuration error, which is the same argument the mailer's log fallback
 * makes.
 */
const ANTHROPIC_MODEL = 'claude-opus-5';
const ANTHROPIC_VERSION = '2023-06-01';

/**
 * Models that accept `output_config.effort`. Anything not listed is sent **without** it.
 *
 * `effort` is a cost and latency optimisation on a one-sentence task, and it is not universally
 * accepted — it **errors** on Haiku 4.5 and Sonnet 4.5, which are exactly the models somebody reaches
 * for on a bulk alt-text run over hundreds of images. Sending it unconditionally made those two fail
 * every request with a 400 that named the parameter and not the cause, so an operator who picked the
 * cheapest model got a feature that looked broken.
 *
 * **An allowlist rather than a denylist, and unknown means omit**, because the two directions fail
 * very differently. Omitting `effort` from a model that would have accepted it costs some tokens.
 * Sending it to one that refuses costs the whole feature. So a model released after this line was
 * written — or a dated snapshot somebody pinned — quietly loses the optimisation and keeps working,
 * which is the only safe way for this list to go stale.
 */
const EFFORT_MODELS = new Set([
  'claude-fable-5',
  'claude-mythos-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-opus-4-5',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
]);

/** Exported for the test, which asserts the request body rather than this set's contents. */
export function anthropicSupportsEffort(model: string): boolean {
  return EFFORT_MODELS.has(model);
}

function anthropic(apiKey: string, model: string): AiProvider {
  return {
    name: 'anthropic',
    model,
    async generate({ system, prompt, image, maxTokens }) {
      const content: unknown[] = [];
      // Image before text, which is the documented ordering and the one that reads better anyway:
      // the instruction refers to something the model has already been shown.
      if (image) {
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: image.mimeType, data: toBase64(image.bytes) },
        });
      }
      content.push({ type: 'text', text: prompt });

      const body = await readOrThrow(
        await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
          },
          body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            system,
            /*
             * `low` effort rather than disabling thinking, and only where the model takes it.
             *
             * Both cut latency and tokens on a one-sentence task, and disabling has failure modes
             * this code would have to defend against — internal tags leaking into the visible reply
             * being the one that matters here, since the reply goes straight into an input an editor
             * accepts. Lowering effort has none of them.
             *
             * Omitted entirely for a model outside `EFFORT_MODELS`; see that list for why silence is
             * the safe default.
             */
            ...(anthropicSupportsEffort(model) ? { output_config: { effort: 'low' } } : {}),
            messages: [{ role: 'user', content }],
          }),
        }),
        'anthropic',
        model,
      );

      const payload = body as {
        stop_reason?: string;
        content?: Array<{ type: string; text?: string }>;
      };

      /*
       * A refusal is a 200, so it has to be read before the content is trusted.
       *
       * Safety classifiers can decline a request, and the response then carries an empty or partial
       * `content` array rather than an error. Indexing straight into `content[0]` turns that into
       * either a crash or — worse — a confident empty description written onto an image.
       */
      if (payload.stop_reason === 'refusal') {
        throw new AiError('anthropic declined this request.');
      }

      const text = payload.content?.find((block) => block.type === 'text')?.text;
      return requireText(text, 'anthropic');
    },
  };
}

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

const OPENAI_MODEL = 'gpt-4o';

function openai(apiKey: string, model: string): AiProvider {
  return {
    name: 'openai',
    model,
    async generate({ system, prompt, image, maxTokens }) {
      const content: unknown[] = [];
      if (image) {
        // A `data:` URL rather than a hosted one, for `describeImage`'s reason: the asset may sit in
        // R2 behind a Worker route this request cannot reach.
        content.push({
          type: 'image_url',
          image_url: { url: `data:${image.mimeType};base64,${toBase64(image.bytes)}` },
        });
      }
      content.push({ type: 'text', text: prompt });

      const body = await readOrThrow(
        await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model,
            max_completion_tokens: maxTokens,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content },
            ],
          }),
        }),
        'openai',
        model,
      );

      const payload = body as { choices?: Array<{ message?: { content?: string } }> };
      return requireText(payload.choices?.[0]?.message?.content, 'openai');
    },
  };
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

const GEMINI_MODEL = 'gemini-2.5-flash';

function gemini(apiKey: string, model: string): AiProvider {
  return {
    name: 'gemini',
    model,
    async generate({ system, prompt, image, maxTokens }) {
      const parts: unknown[] = [];
      if (image) {
        parts.push({ inline_data: { mime_type: image.mimeType, data: toBase64(image.bytes) } });
      }
      parts.push({ text: prompt });

      const body = await readOrThrow(
        await fetch(
          // The key goes in a header, not the query string. Both are accepted and only one of them
          // stays out of access logs and `Referer` — the same reason a reset token rides a cookie.
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
            body: JSON.stringify({
              system_instruction: { parts: [{ text: system }] },
              contents: [{ role: 'user', parts }],
              generationConfig: { maxOutputTokens: maxTokens },
            }),
          },
        ),
        'gemini',
        model,
      );

      const payload = body as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      /*
       * Parts are joined rather than taking the first. A reply can arrive split across several text
       * parts, and reading `parts[0]` silently returns the opening clause of a complete answer —
       * which looks like a working feature that writes truncated alt text.
       */
      const text = payload.candidates?.[0]?.content?.parts
        ?.map((part) => part.text ?? '')
        .join('')
        .trim();
      return requireText(text, 'gemini');
    },
  };
}

// ---------------------------------------------------------------------------

/** Whether each provider has a key. What Settings reports; never the value itself. */
export function aiKeysPresent(env: AiEnv): Record<AiProviderName, boolean> {
  return {
    anthropic: !!env.TAPROOT_ANTHROPIC_API_KEY?.trim(),
    openai: !!env.TAPROOT_OPENAI_API_KEY?.trim(),
    gemini: !!env.TAPROOT_GEMINI_API_KEY?.trim(),
  };
}

/** The default model per provider, so `settings.ai_model` may stay null. */
export function defaultAiModel(provider: AiProviderName): string {
  if (provider === 'anthropic') return ANTHROPIC_MODEL;
  if (provider === 'openai') return OPENAI_MODEL;
  return GEMINI_MODEL;
}

/**
 * Build the adapter for a chosen provider, or `null` when its key is absent.
 *
 * Null rather than a throw: "chosen but unconfigured" is a state an operator can reach in two clicks
 * and Settings → System reports it, so it is a condition to be described rather than an exception to
 * be raised on whichever page happens to touch it first.
 */
export function createAiProvider(
  env: AiEnv,
  provider: AiProviderName,
  model?: string | null,
): AiProvider | null {
  const resolved = model?.trim() || defaultAiModel(provider);

  if (provider === 'anthropic') {
    const key = env.TAPROOT_ANTHROPIC_API_KEY?.trim();
    return key ? anthropic(key, resolved) : null;
  }
  if (provider === 'openai') {
    const key = env.TAPROOT_OPENAI_API_KEY?.trim();
    return key ? openai(key, resolved) : null;
  }
  const key = env.TAPROOT_GEMINI_API_KEY?.trim();
  return key ? gemini(key, resolved) : null;
}
