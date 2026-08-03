/**
 * Password hashing on Web Crypto only.
 *
 * Deliberately **not** bcrypt or argon2: both are native modules that cannot run on Cloudflare
 * Workers, which is the v1 production target. PBKDF2-SHA256 is reachable in both Node and Workers
 * through `crypto.subtle`, so one implementation covers every environment — but *not* identically,
 * which is the trap this file exists to document.
 *
 * Encoded form: `pbkdf2$<iterations>$<salt-base64>$<hash-base64>`. The iteration count travels
 * with the hash so it can be raised later without invalidating existing passwords.
 */

/**
 * **workerd refuses more than 100,000 PBKDF2 iterations**, and the refusal is a thrown
 * `NotSupportedError`, not a clamp. This is a ceiling imposed by the runtime, not a security
 * preference — OWASP asks for more, and `crypto.subtle` on Workers is the only KDF available to a
 * CMS that ships zero native dependencies.
 *
 * The cost of getting this wrong is total and invisible until deployment: at 210,000 the first-run
 * setup screen 500s, so a Cloudflare deployment cannot create its first administrator, and every
 * sign-in attempt for an address that does not exist 500s too, because that path derives against
 * `DUMMY_HASH` to equalise timing. Nothing in Node reproduces it — Node has no cap, so every test,
 * every `npm run dev` session, and every local sign-in works perfectly.
 *
 * Raising this above 100,000 breaks production. If a future runtime lifts the cap, raise it there
 * first and confirm with `npm run preview`, which is the only local command that runs in workerd.
 */
export const MAX_WORKERD_ITERATIONS = 100_000;

/**
 * The iteration count new hashes use.
 *
 * One number for every environment on purpose: a hash written in dev has to verify in production
 * and the other way round, and a per-platform count would make a database that moves between them
 * hold passwords nobody can check.
 */
export const DEFAULT_ITERATIONS = MAX_WORKERD_ITERATIONS;
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

  let actual: Uint8Array;
  try {
    actual = await deriveBits(password, salt, iterations);
  } catch {
    // A stored count this runtime will not derive — a hash written where the cap is higher, read
    // where it is lower. Returning false keeps the contract above: no exception escapes to
    // distinguish one stored row from another. It does mean such a hash reads as a wrong password,
    // which is why DEFAULT_ITERATIONS is the same number everywhere rather than per-platform.
    return false;
  }

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
