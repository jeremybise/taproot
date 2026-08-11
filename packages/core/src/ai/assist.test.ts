import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveAssistant, AI_UNAVAILABLE, type AiSettings } from './assist.js';
import { aiKeysPresent, defaultAiModel, createAiProvider } from './providers.js';

/**
 * The gating and the refusal handling, which are the two places this fails silently.
 *
 * Every provider call is a `fetch`, so the fetch is faked — and the fake is written to answer the way
 * each provider actually does, including the shapes that are *successful HTTP* and still not an
 * answer. That is the `images.test.ts` lesson: a double that accepts what the real thing rejects is
 * why a suite stays green through a broken feature.
 */
const ON: AiSettings = { provider: 'anthropic', model: null, altText: true, seo: true };

const IMAGE = { bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' };
const CONTEXT = { filename: 'quad.png' };

let calls: Array<{ url: string; init: RequestInit }>;

function respondWith(body: unknown, status = 200) {
  calls = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status });
  });
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const anthropicText = (text: string) => ({ content: [{ type: 'text', text }] });

describe('gating', () => {
  it('is unconfigured when a provider is chosen but its key is absent', () => {
    const a = resolveAssistant({}, ON);
    expect(a.configured).toBe(false);
    expect(a.altText).toBe(false);
    expect(a.seo).toBe(false);
    // Reported rather than thrown: an operator reaches this state in two clicks, so it is a
    // condition Settings describes, not an exception raised by whichever page loads first.
    expect(a.provider).toBe('anthropic');
  });

  it('is unconfigured when a key exists but no provider is chosen', () => {
    const a = resolveAssistant({ TAPROOT_ANTHROPIC_API_KEY: 'k' }, { ...ON, provider: null });
    // The state that would be unsayable if the provider were derived from whichever key is present.
    expect(a.configured).toBe(false);
    expect(a.provider).toBeNull();
  });

  it('gates each feature on its own toggle', () => {
    const env = { TAPROOT_ANTHROPIC_API_KEY: 'k' };
    const a = resolveAssistant(env, { ...ON, seo: false });
    expect(a.altText).toBe(true);
    expect(a.seo).toBe(false);
  });

  it('refuses the call rather than half-working when a feature is off', async () => {
    respondWith(anthropicText('never reached'));
    const a = resolveAssistant({ TAPROOT_ANTHROPIC_API_KEY: 'k' }, { ...ON, altText: false });

    await expect(a.describeImage(IMAGE, CONTEXT)).rejects.toThrow(AI_UNAVAILABLE);
    // The point of the guard: nothing was spent finding out.
    expect(calls).toHaveLength(0);
  });

  it('falls back to the provider default model, so ai_model may stay null', () => {
    const a = resolveAssistant({ TAPROOT_ANTHROPIC_API_KEY: 'k' }, ON);
    expect(a.model).toBe(defaultAiModel('anthropic'));
  });

  it('reports which keys are present and never a value', () => {
    const present = aiKeysPresent({ TAPROOT_OPENAI_API_KEY: 'sk-secret', TAPROOT_GEMINI_API_KEY: ' ' });
    // A whitespace-only key is not a key; and the answer is booleans, so no screen rendering this
    // can leak one.
    expect(present).toEqual({ anthropic: false, openai: true, gemini: false });
    expect(JSON.stringify(present)).not.toContain('secret');
  });
});

describe('alt text', () => {
  it('returns the description for a human to accept', async () => {
    respondWith(anthropicText('Students crossing the main quad between lectures'));
    const a = resolveAssistant({ TAPROOT_ANTHROPIC_API_KEY: 'k' }, ON);

    expect(await a.describeImage(IMAGE, CONTEXT)).toBe(
      'Students crossing the main quad between lectures',
    );
  });

  it('sends the image as bytes, before the text', async () => {
    respondWith(anthropicText('ok'));
    await resolveAssistant({ TAPROOT_ANTHROPIC_API_KEY: 'k' }, ON).describeImage(IMAGE, CONTEXT);

    const body = JSON.parse(String(calls[0]!.init.body));
    const content = body.messages[0].content;
    expect(content[0].type).toBe('image');
    expect(content[0].source).toMatchObject({ type: 'base64', media_type: 'image/png' });
    expect(content[1].type).toBe('text');
    // Bytes, not a URL — the asset may sit in R2 behind a route the provider cannot reach.
    expect(JSON.stringify(body)).not.toContain('http');
  });

  it('throws on a refusal rather than writing an empty description', async () => {
    // A refusal is a 200 with empty content. Reading `content[0].text` would yield undefined, and a
    // caller that stored it would mark the image *decorative* — the one thing a machine must never do.
    respondWith({ stop_reason: 'refusal', content: [] });
    const a = resolveAssistant({ TAPROOT_ANTHROPIC_API_KEY: 'k' }, ON);

    await expect(a.describeImage(IMAGE, CONTEXT)).rejects.toThrow(/declined/);
  });

  it('throws on a successful response carrying no text', async () => {
    respondWith({ content: [] });
    const a = resolveAssistant({ TAPROOT_ANTHROPIC_API_KEY: 'k' }, ON);

    await expect(a.describeImage(IMAGE, CONTEXT)).rejects.toThrow(/no text/);
  });

  it('does not put the provider error body on screen in full', async () => {
    // A provider error can echo the request, which for this call is a base64 image; the message
    // reaches an editor's screen and the server log.
    respondWith({ error: 'x'.repeat(2000) }, 500);
    const a = resolveAssistant({ TAPROOT_ANTHROPIC_API_KEY: 'k' }, ON);

    const error = await a.describeImage(IMAGE, CONTEXT).catch((cause: Error) => cause);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('500');
    expect((error as Error).message.length).toBeLessThan(400);
  });
});

describe('seo', () => {
  it('parses the labelled two-line reply', async () => {
    respondWith(anthropicText('TITLE: Apply to Riverbend\nDESCRIPTION: How to apply, and when.'));
    const a = resolveAssistant({ TAPROOT_ANTHROPIC_API_KEY: 'k' }, ON);

    expect(await a.suggestSeo({ title: 'Apply', text: 'Deadlines and steps.' })).toEqual({
      title: 'Apply to Riverbend',
      description: 'How to apply, and when.',
    });
  });

  it('throws rather than putting an unlabelled reply in the title field', async () => {
    // The failure mode a fallback would create: an editor pressing Generate and being handed a
    // paragraph of prose as their meta title, which looks like the feature working.
    respondWith(anthropicText('Here are some ideas for your page!'));
    const a = resolveAssistant({ TAPROOT_ANTHROPIC_API_KEY: 'k' }, ON);

    await expect(a.suggestSeo({ title: 'Apply', text: 'x' })).rejects.toThrow(/expected format/);
  });

  it('carries the guidance numbers from SEO_GUIDANCE rather than its own copy', async () => {
    respondWith(anthropicText('TITLE: a\nDESCRIPTION: b'));
    await resolveAssistant({ TAPROOT_ANTHROPIC_API_KEY: 'k' }, ON).suggestSeo({
      title: 'Apply',
      text: 'x',
    });

    // Asserted against the constant, not the literals — a second copy in the prompt would drift
    // from the counter that turns amber beside the field the answer lands in.
    const body = JSON.parse(String(calls[0]!.init.body));
    const { SEO_GUIDANCE } = await import('../content/seo.js');
    expect(body.messages[0].content[0].text).toContain(String(SEO_GUIDANCE.titleChars));
    expect(body.messages[0].content[0].text).toContain(String(SEO_GUIDANCE.descriptionChars));
  });
});

describe('providers', () => {
  it('puts the Gemini key in a header, never the query string', async () => {
    respondWith({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] });
    const provider = createAiProvider({ TAPROOT_GEMINI_API_KEY: 'sk-secret' }, 'gemini')!;
    await provider.generate({ system: 's', prompt: 'p', maxTokens: 64 });

    // A URL lands in access logs and `Referer` — the reason a reset token rides a cookie.
    expect(calls[0]!.url).not.toContain('sk-secret');
    expect((calls[0]!.init.headers as Record<string, string>)['x-goog-api-key']).toBe('sk-secret');
  });

  it('joins Gemini text parts rather than taking the first', async () => {
    // Reading `parts[0]` returns the opening clause of a complete answer — a working-looking feature
    // that writes truncated alt text.
    respondWith({ candidates: [{ content: { parts: [{ text: 'Students crossing ' }, { text: 'the quad' }] } }] });
    const provider = createAiProvider({ TAPROOT_GEMINI_API_KEY: 'k' }, 'gemini')!;

    expect(await provider.generate({ system: 's', prompt: 'p', maxTokens: 64 })).toBe(
      'Students crossing the quad',
    );
  });

  it('returns null for a provider with no key, per provider', () => {
    const env = { TAPROOT_OPENAI_API_KEY: 'k' };
    expect(createAiProvider(env, 'openai')).not.toBeNull();
    expect(createAiProvider(env, 'anthropic')).toBeNull();
    expect(createAiProvider(env, 'gemini')).toBeNull();
  });

  it('encodes a multi-megabyte image without overflowing the stack', async () => {
    // The reason the base64 helper chunks instead of spreading: spreading an image into an argument
    // list is a crash, not a slow path.
    respondWith(anthropicText('ok'));
    const big = { bytes: new Uint8Array(3 * 1024 * 1024), mimeType: 'image/jpeg' };
    const a = resolveAssistant({ TAPROOT_ANTHROPIC_API_KEY: 'k' }, ON);

    await expect(a.describeImage(big, CONTEXT)).resolves.toBe('ok');
  });
});

describe('effort', () => {
  /**
   * `effort` errors on Haiku 4.5 and Sonnet 4.5, and sending it unconditionally made those two fail
   * every request — the models somebody reaches for first on a bulk alt-text run over hundreds of
   * images. These assert the **request body**, not the contents of the allowlist, so the tests stay
   * about the behaviour rather than restating the set.
   */
  async function callWith(model: string) {
    respondWith(anthropicText('ok'));
    const provider = createAiProvider({ TAPROOT_ANTHROPIC_API_KEY: 'k' }, 'anthropic', model)!;
    await provider.generate({ system: 's', prompt: 'p', maxTokens: 512 });
    return JSON.parse(String(calls[0]!.init.body)) as { output_config?: unknown; model: string };
  }

  it('sends effort to a model that accepts it', async () => {
    expect((await callWith('claude-opus-5')).output_config).toEqual({ effort: 'low' });
  });

  it('omits effort for Haiku 4.5, which rejects it', async () => {
    // The bug this closes: the cheapest model was the one that could not be used at all.
    const body = await callWith('claude-haiku-4-5');
    expect(body.output_config).toBeUndefined();
    expect(body.model).toBe('claude-haiku-4-5');
  });

  it('omits effort for Sonnet 4.5, which rejects it', async () => {
    expect((await callWith('claude-sonnet-4-5')).output_config).toBeUndefined();
  });

  it('omits effort for a model it has never heard of', async () => {
    /*
     * The direction the allowlist fails in, and the reason it is an allowlist. A model released
     * after this code was written loses an optimisation; it does not lose the feature.
     */
    expect((await callWith('claude-something-unreleased')).output_config).toBeUndefined();
  });

  it('names the model on a 4xx but not on a 5xx', async () => {
    // A wrong model is the likeliest cause of a 400 and the least visible: the settings field takes
    // any string, so the provider's complaint is about a parameter rather than about the model.
    respondWith({ error: 'bad model' }, 400);
    const bad = createAiProvider({ TAPROOT_ANTHROPIC_API_KEY: 'k' }, 'anthropic', 'claude-nope')!;
    const e400 = await bad
      .generate({ system: 's', prompt: 'p', maxTokens: 64 })
      .catch((c: Error) => c);
    expect((e400 as Error).message).toContain('claude-nope');

    // On a 5xx the model is not the problem, and naming it would misdirect.
    respondWith({ error: 'upstream' }, 503);
    const e503 = await bad
      .generate({ system: 's', prompt: 'p', maxTokens: 64 })
      .catch((c: Error) => c);
    expect((e503 as Error).message).not.toContain('claude-nope');
  });
});
