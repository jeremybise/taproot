/**
 * Identifier generation.
 *
 * UUIDv7 rather than v4: the leading 48 bits are a millisecond timestamp, so ids sort
 * chronologically. That keeps B-tree inserts append-mostly instead of scattering writes across the
 * index, which matters more on D1 than it would on a local disk, and it means `ORDER BY id` is a
 * usable creation order without a separate column.
 */
export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const timestamp = Date.now();

  // 48-bit big-endian timestamp.
  bytes[0] = (timestamp / 2 ** 40) & 0xff;
  bytes[1] = (timestamp / 2 ** 32) & 0xff;
  bytes[2] = (timestamp / 2 ** 24) & 0xff;
  bytes[3] = (timestamp / 2 ** 16) & 0xff;
  bytes[4] = (timestamp / 2 ** 8) & 0xff;
  bytes[5] = timestamp & 0xff;

  // Version 7 in the high nibble of byte 6, RFC 4122 variant in the top bits of byte 8.
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;

  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * A short, URL-safe, human-typable token. Used for things people copy by hand, not for security.
 * Excludes vowels and lookalike characters so generated values are unambiguous and never spell
 * anything unintended.
 */
export function newShortId(length = 10): string {
  const alphabet = '23456789bcdfghjkmnpqrstvwxz';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = '';
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return out;
}
