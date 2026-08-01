/**
 * An allowlist HTML sanitiser for richtext field values.
 *
 * **Why this exists.** Richtext is stored as HTML and rendered with Astro's `set:html`, which does
 * not escape. Without sanitising on the way in, anyone who can edit content — a contributor, the
 * lowest role there is — could store `<script>` or `<img onerror>` and have it run for every
 * visitor and for every editor who opens the item. That is stored XSS, and the session it steals
 * is an administrator's.
 *
 * **Why on the server, on write.** The editor is not a security boundary: the REST API accepts a
 * richtext value from any client holding a session, so a `curl` request bypasses whatever the
 * toolbar permits. Sanitising at the write path covers every route in and every future integration
 * by construction. Sanitising at render instead would leave the stored value hostile and make each
 * consumer — the site, an export, a future MCP server — responsible for remembering.
 *
 * **Why in-tree rather than a dependency.** The usual choices do not fit the runtime: DOMPurify
 * needs a real DOM, and the jsdom-backed wrappers cannot run on Workers, which is the production
 * target.
 *
 * **Why it is safe.** This is an allowlist *serialiser*, not a filter. It parses to a token stream
 * and re-emits only constructs it understands, escaping all text and rebuilding every attribute.
 * Nothing travels from input to output as a substring. Anything it cannot parse becomes nothing,
 * never itself — which is the property that makes the failure mode safe.
 *
 * It is deliberately not a general-purpose HTML cleaner; it handles the small grammar a richtext
 * editor produces.
 */

/**
 * Tags that survive, each mapped to the attributes allowed on it.
 *
 * `h1` is absent on purpose. The page's `<h1>` is its title, rendered by the template; letting body
 * content introduce a second breaks the document outline — a WCAG 1.3.1 failure. Body headings
 * start at `h2`, and `checkRichText` reports one that does not, for content that reached the
 * database without passing through here.
 *
 * `img` is absent too: images belong to the media library, where they carry alt text and a
 * hotspot. An `<img>` pasted into prose has neither and cannot be managed.
 */
const ALLOWED: Record<string, readonly string[]> = {
  p: [],
  br: [],
  strong: [],
  em: [],
  u: [],
  s: [],
  code: [],
  pre: [],
  blockquote: [],
  h2: [],
  h3: [],
  h4: [],
  ul: [],
  ol: [],
  li: [],
  a: ['href', 'title', 'target'],
};

const VOID_TAGS = new Set(['br']);

/**
 * Elements dropped together with their contents.
 *
 * Everything else unknown is *unwrapped* — a `<div>` around a paragraph loses the div and keeps the
 * paragraph. These are the exceptions, because their bodies are code or metadata rather than prose:
 * re-emitting a script body as visible text would be harmless but nonsense.
 */
const DROP_WITH_CONTENTS = new Set(['script', 'style', 'textarea', 'title', 'iframe', 'noscript']);

/** URL schemes allowed on `href`. Everything else — `javascript:`, `data:`, `vbscript:` — is dropped. */
const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:']);

export interface SanitizeOptions {
  /**
   * Restrict the allowlist further, e.g. `['strong', 'em', 'a']` for an inline-only field.
   * Tags outside the set are unwrapped: their text survives, the element does not.
   */
  allowedTags?: readonly string[];
}

export function sanitizeHtml(input: string, options: SanitizeOptions = {}): string {
  if (!input) return '';

  const allowed = options.allowedTags
    ? new Set(options.allowedTags.filter((tag) => tag in ALLOWED))
    : new Set(Object.keys(ALLOWED));

  const out: string[] = [];
  /** Elements this function has actually emitted, so a closing tag can only close one of them. */
  const stack: string[] = [];

  for (const token of tokenize(input)) {
    if (token.kind === 'text') {
      out.push(escapeText(token.value));
      continue;
    }

    // Comments, doctypes, CDATA, and dropped elements. `<!--` in particular is a standard way to
    // smuggle markup past a filter that only looks at tags.
    if (token.kind === 'other') continue;

    const tag = token.name;
    if (!allowed.has(tag)) continue;

    if (token.kind === 'open') {
      if (VOID_TAGS.has(tag)) {
        out.push(`<${tag}>`);
        continue;
      }
      out.push(`<${tag}${serializeAttributes(tag, token.attributes)}>`);
      stack.push(tag);
      continue;
    }

    const index = stack.lastIndexOf(tag);
    // A stray `</p>` closes nothing rather than unbalancing the output.
    if (index === -1) continue;
    // Close anything opened inside it as well, rather than emitting overlapping tags.
    for (let i = stack.length - 1; i >= index; i--) out.push(`</${stack[i]}>`);
    stack.length = index;
  }

  // Close whatever the input left open, so the result is always well-formed.
  for (let i = stack.length - 1; i >= 0; i--) out.push(`</${stack[i]}>`);

  return out.join('');
}

export type HtmlToken =
  | { kind: 'text'; value: string }
  | { kind: 'open'; name: string; attributes: string }
  | { kind: 'close'; name: string }
  | { kind: 'other' };

/**
 * Split HTML into a token stream.
 *
 * Strict on purpose: a `<` that does not begin something tag-shaped is emitted as literal text and
 * escaped downstream, which is what browsers do and what stops `< script>`-style tricks.
 *
 * Exported because the accessibility checker walks the same stored HTML looking for heading order
 * and link text. A second parser — a regex over `<h[2-4]>`, say — would be a second answer to "what
 * does this markup say", and the one that has been attacked in tests is this one.
 */
export function* tokenize(input: string): Generator<HtmlToken> {
  let i = 0;

  while (i < input.length) {
    const lt = input.indexOf('<', i);

    if (lt === -1) {
      yield { kind: 'text', value: input.slice(i) };
      return;
    }

    if (lt > i) yield { kind: 'text', value: input.slice(i, lt) };

    if (input.startsWith('<!', lt)) {
      yield { kind: 'other' };
      i = input.startsWith('<!--', lt) ? indexAfter(input, '-->', lt) : indexAfter(input, '>', lt);
      continue;
    }

    if (input.startsWith('</', lt)) {
      const close = /^<\/\s*([a-zA-Z][a-zA-Z0-9]*)\s*>/.exec(input.slice(lt));
      if (!close) {
        yield { kind: 'text', value: '<' };
        i = lt + 1;
        continue;
      }
      yield { kind: 'close', name: close[1]!.toLowerCase() };
      i = lt + close[0].length;
      continue;
    }

    // Quoted runs are matched whole so a `>` inside an attribute value does not end the tag.
    const open = /^<([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/.exec(input.slice(lt));
    if (!open) {
      // A bare `<` in prose. Emit as text so it is escaped rather than swallowed.
      yield { kind: 'text', value: '<' };
      i = lt + 1;
      continue;
    }

    const name = open[1]!.toLowerCase();
    i = lt + open[0].length;

    /**
     * Consume a dropped element's body here rather than in the sanitiser.
     *
     * Doing it in the tokenizer means the body never becomes a text token, so `<script>alert(1)`
     * loses its contents as well as its tags — while the sanitiser's "unknown tags are unwrapped"
     * rule stays simple for everything else.
     */
    if (DROP_WITH_CONTENTS.has(name)) {
      const at = input.toLowerCase().indexOf(`</${name}`, i);
      i = at === -1 ? input.length : indexAfter(input, '>', at);
      yield { kind: 'other' };
      continue;
    }

    yield { kind: 'open', name, attributes: open[2] ?? '' };
  }
}

/** Index just past the first occurrence of `needle`, or the end of the string. */
function indexAfter(haystack: string, needle: string, from: number): number {
  const at = haystack.indexOf(needle, from);
  return at === -1 ? haystack.length : at + needle.length;
}

/**
 * Re-emit only the attributes allowed for this tag, with rebuilt values.
 *
 * Nothing is passed through: an attribute absent from the list — every `on*` handler, `style`,
 * `srcdoc` — never reaches the output at all.
 */
function serializeAttributes(tag: string, raw: string): string {
  const allowed = ALLOWED[tag] ?? [];
  if (allowed.length === 0 || !raw.trim()) return '';

  const found = new Map<string, string>();
  const pattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;

  for (const match of raw.matchAll(pattern)) {
    const name = match[1]!.toLowerCase();
    if (!allowed.includes(name)) continue;
    found.set(name, decodeEntities(match[2] ?? match[3] ?? match[4] ?? ''));
  }

  if (tag === 'a') return serializeAnchor(found);

  return [...found].map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`).join('');
}

/**
 * Anchors, handled apart because their attributes constrain each other.
 *
 * A link opening in a new tab without `rel="noopener"` hands the opened page a reference back
 * through `window.opener`. Current browsers imply it for `target="_blank"`, older ones do not, and
 * being explicit costs nothing — so `target` is only ever emitted with the `rel` that protects it.
 * `rel` is therefore not author-controlled, which is why it is absent from the allowlist.
 */
function serializeAnchor(attributes: Map<string, string>): string {
  const href = safeUrl(attributes.get('href') ?? '');
  // A link with no usable destination is not a link. Dropping the attribute leaves `<a>` wrapping
  // its text, which is inert and keeps the words.
  if (!href) return '';

  const parts = [` href="${escapeAttribute(href)}"`];

  const title = attributes.get('title');
  if (title) parts.push(` title="${escapeAttribute(title)}"`);

  if (attributes.get('target') === '_blank') {
    parts.push(' target="_blank"', ' rel="noopener noreferrer"');
  }

  return parts.join('');
}

/** Characters browsers strip before parsing a URL, and which therefore cannot be trusted in one. */
const URL_NOISE = /[\u0000-\u0020\u007F]/g;

/**
 * Return the URL if its scheme is safe, otherwise null.
 *
 * Relative URLs (`/about`, `#section`, `?page=2`) are kept — they carry no scheme, and internal
 * links are the common case. Anything with an explicit scheme must be one of the four allowed.
 *
 * The scheme is tested against a copy with control characters and whitespace removed, because
 * `java\tscript:` and `java&#0;script:` are both parsed as `javascript:` by browsers but would slip
 * past a test on the literal text. Those characters are then stripped from what is returned, so the
 * value that reaches the page is the value that was checked.
 */
function safeUrl(value: string): string | null {
  const cleaned = value.replace(URL_NOISE, '');
  if (!cleaned) return null;

  if (cleaned.startsWith('/') || cleaned.startsWith('#') || cleaned.startsWith('?')) return cleaned;

  // A colon before any slash means an explicit scheme; otherwise it is a relative path.
  const colon = cleaned.indexOf(':');
  const slash = cleaned.indexOf('/');
  if (colon === -1 || (slash !== -1 && slash < colon)) return cleaned;

  return SAFE_SCHEMES.has(cleaned.slice(0, colon + 1).toLowerCase()) ? cleaned : null;
}

function escapeText(value: string): string {
  return decodeEntities(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Decode entities before re-escaping, so encoding cannot be used to hide anything.
 *
 * Numeric forms are decoded too: `&#106;avascript:` is the standard way to smuggle a scheme past a
 * filter that only reads literal text. Decoding then re-escaping is idempotent for ordinary prose —
 * `&amp;` decodes to `&` and escapes back to `&amp;`.
 */
function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);?/g, (_, hex: string) => codePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_, dec: string) => codePoint(parseInt(dec, 10)))
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&');
}

function codePoint(value: number): string {
  return Number.isFinite(value) && value >= 0 && value <= 0x10ffff
    ? String.fromCodePoint(value)
    : '';
}

/**
 * Plain text of a richtext value, for excerpts, search indexing, and length checks.
 *
 * Tags become a space so `<p>a</p><p>b</p>` reads as two words rather than one.
 */
export function htmlToText(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}
