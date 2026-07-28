/**
 * Password hashing on Web Crypto only.
 *
 * Deliberately **not** bcrypt or argon2: both are native modules that cannot run on Cloudflare
 * Workers, which is the v1 production target. PBKDF2-SHA256 is available identically in Node and
 * in Workers via `crypto.subtle`, so one implementation covers every environment.
 *
 * Encoded form: `pbkdf2$<iterations>$<salt-base64>$<hash-base64>`. The iteration count travels
 * with the hash so it can be raised later without invalidating existing passwords.
 */

/** OWASP's recommended minimum for PBKDF2-HMAC-SHA256. */
const DEFAULT_ITERATIONS = 210_000;
const SALT_BYTES = 16;
const KEY_BITS = 256;

export async function hashPassword(
  password: string,
  iterations: number = DEFAULT_ITERATIONS,
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await deriveBits(password, salt, iterations);
  return `pbkdf2$${iterations}$${toBase64(salt)}$${toBase64(hash)}`;
}

/**
 * Verify a password against an encoded hash.
 *
 * Returns `false` for malformed input rather than throwing, so a corrupt row cannot be
 * distinguished from a wrong password by an attacker watching for error responses.
 */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;

  const iterations = Number.parseInt(parts[1] ?? '', 10);
  if (!Number.isInteger(iterations) || iterations <= 0) return false;

  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = fromBase64(parts[2] ?? '');
    expected = fromBase64(parts[3] ?? '');
  } catch {
    return false;
  }

  const actual = await deriveBits(password, salt, iterations);
  return timingSafeEqual(actual, expected);
}

/** True when a stored hash used a weaker iteration count and should be upgraded on next login. */
export function needsRehash(encoded: string, iterations: number = DEFAULT_ITERATIONS): boolean {
  const parts = encoded.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return true;
  const stored = Number.parseInt(parts[1] ?? '', 10);
  return !Number.isInteger(stored) || stored < iterations;
}

async function deriveBits(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );

  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    key,
    KEY_BITS,
  );

  return new Uint8Array(bits);
}

/**
 * Compare two byte arrays without leaking their contents through timing.
 *
 * The length check short-circuits, which is fine: hash length is not secret.
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a[i] as number) ^ (b[i] as number);
  }
  return diff === 0;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
