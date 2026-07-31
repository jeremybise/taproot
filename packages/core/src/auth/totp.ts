/**
 * TOTP (RFC 6238) on Web Crypto, so it runs unchanged in Node and on Workers.
 *
 * Implemented and tested here because it is small and self-contained — and then never wired up.
 * There is no enrolment (QR code, confirm-a-code step) and sign-in never challenges for a second
 * factor, so **everything in this file is currently unreachable**: a grep for `totp` across
 * `packages/astro` returns nothing. The `totp_secrets` table exists and is empty.
 *
 * Kept rather than deleted because it is verified against the RFC 6238 test vectors, which is the
 * expensive part; what remains is an enrolment screen and a step in the login flow. Recorded here
 * plainly so nobody reads "TOTP is implemented" off the export list and assumes the account is
 * protected by it.
 */

const DIGITS = 6;
const PERIOD_SECONDS = 30;

/** Generate a new shared secret, base32-encoded as authenticator apps expect. */
export function generateTotpSecret(): string {
  return base32Encode(crypto.getRandomValues(new Uint8Array(20)));
}

/** Compute the code for a given moment. `atMs` exists so tests are not time-dependent. */
export async function generateTotpCode(secret: string, atMs: number = Date.now()): Promise<string> {
  const counter = Math.floor(atMs / 1000 / PERIOD_SECONDS);
  return generateHotpCode(base32Decode(secret), counter);
}

/**
 * Verify a submitted code.
 *
 * `window` counts periods checked either side of now, absorbing clock drift between the server
 * and the user's phone. One period (±30s) is the usual compromise between usability and keeping
 * the acceptance window tight.
 */
export async function verifyTotpCode(
  secret: string,
  code: string,
  options: { atMs?: number; window?: number } = {},
): Promise<boolean> {
  return (await findTotpStep(secret, code, options)) !== null;
}

/**
 * The time step a code matched, or `null`.
 *
 * The step is what makes replay protection possible: a code stays valid for its whole period plus
 * the drift window, so without recording which step was spent, a code observed over someone's
 * shoulder — or captured by a phishing page and relayed — works a second time for up to ninety
 * seconds. The caller stores the highest step it has accepted and refuses anything at or below it.
 *
 * Returning the step leaks nothing: it is derived from the clock, which is not a secret. The
 * constant-time property being protected here is *whether an early candidate matched*, and every
 * candidate is still evaluated.
 */
export async function findTotpStep(
  secret: string,
  code: string,
  options: { atMs?: number; window?: number } = {},
): Promise<number | null> {
  const submitted = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(submitted)) return null;

  const atMs = options.atMs ?? Date.now();
  const window = options.window ?? 1;
  const key = base32Decode(secret);
  const counter = Math.floor(atMs / 1000 / PERIOD_SECONDS);

  let matched: number | null = null;
  // Every candidate is checked even after a match so verification takes constant time.
  for (let offset = -window; offset <= window; offset++) {
    const step = counter + offset;
    const candidate = await generateHotpCode(key, step);
    if (constantTimeStringEqual(candidate, submitted)) matched = step;
  }
  return matched;
}

/** The `otpauth://` URI an authenticator app scans. */
export function totpUri(secret: string, accountName: string, issuer = 'Taproot'): string {
  const label = encodeURIComponent(`${issuer}:${accountName}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

async function generateHotpCode(key: Uint8Array, counter: number): Promise<string> {
  const message = new Uint8Array(8);
  // 64-bit big-endian counter. Written via DataView halves because a JS number cannot hold 2^64.
  new DataView(message.buffer).setUint32(0, Math.floor(counter / 2 ** 32));
  new DataView(message.buffer).setUint32(4, counter >>> 0);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key as BufferSource,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, message));

  // Dynamic truncation, RFC 4226 §5.3.
  const offset = (signature[signature.length - 1] as number) & 0x0f;
  const binary =
    (((signature[offset] as number) & 0x7f) << 24) |
    (((signature[offset + 1] as number) & 0xff) << 16) |
    (((signature[offset + 2] as number) & 0xff) << 8) |
    ((signature[offset + 3] as number) & 0xff);

  return (binary % 10 ** DIGITS).toString().padStart(DIGITS, '0');
}

function constantTimeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(value: string): Uint8Array {
  const normalized = value.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let acc = 0;
  const out: number[] = [];

  for (const char of normalized) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`Invalid base32 character: ${char}`);
    acc = (acc << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((acc >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}
