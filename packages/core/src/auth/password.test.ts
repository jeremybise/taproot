import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ITERATIONS,
  MAX_WORKERD_ITERATIONS,
  hashPassword,
  needsRehash,
  verifyPassword,
} from './password.js';

/**
 * These assertions exist because **Node cannot reproduce the failure they guard against**.
 *
 * workerd throws `NotSupportedError` above 100,000 PBKDF2 iterations; Node has no cap. So a count
 * that is wrong for production passes every other test in this repo, works in `npm run dev`, and
 * only surfaces as a 500 on the deployed first-run setup screen — the one screen that must work
 * before anything else can.
 */
describe('the PBKDF2 iteration count', () => {
  it('stays within what workerd will derive', () => {
    expect(DEFAULT_ITERATIONS).toBeLessThanOrEqual(MAX_WORKERD_ITERATIONS);
  });

  it('is embedded in the hash at a count workerd will accept', async () => {
    const encoded = await hashPassword('correct horse battery staple');
    const iterations = Number.parseInt(encoded.split('$')[1] ?? '', 10);

    expect(iterations).toBe(DEFAULT_ITERATIONS);
    expect(iterations).toBeLessThanOrEqual(MAX_WORKERD_ITERATIONS);
  });
});

describe('hashing and verifying', () => {
  it('accepts the right password and refuses the wrong one', async () => {
    const encoded = await hashPassword('correct horse battery staple');

    expect(await verifyPassword('correct horse battery staple', encoded)).toBe(true);
    expect(await verifyPassword('Correct horse battery staple', encoded)).toBe(false);
  });

  it('salts, so the same password hashes differently every time', async () => {
    const a = await hashPassword('same password');
    const b = await hashPassword('same password');

    expect(a).not.toBe(b);
    expect(await verifyPassword('same password', a)).toBe(true);
    expect(await verifyPassword('same password', b)).toBe(true);
  });

  it('returns false rather than throwing for a hash it cannot derive', async () => {
    // A count no runtime will honour, standing in for the cross-runtime case: a hash written where
    // the cap is higher and read where it is lower. It has to read as a wrong password, never as an
    // exception, or the error itself tells an attacker this row is different from the others.
    const unusable = `pbkdf2$${Number.MAX_SAFE_INTEGER}$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=`;

    await expect(verifyPassword('anything', unusable)).resolves.toBe(false);
  });

  it('refuses malformed encodings without throwing', async () => {
    for (const bad of ['', 'nonsense', 'pbkdf2$notanumber$a$b', 'bcrypt$100000$a$b', 'a$b$c']) {
      await expect(verifyPassword('anything', bad)).resolves.toBe(false);
    }
  });
});

describe('needsRehash', () => {
  it('leaves a current hash alone', async () => {
    expect(needsRehash(await hashPassword('x'))).toBe(false);
  });

  it('flags a weaker one, and anything it cannot read', () => {
    expect(needsRehash(`pbkdf2$1000$AAAA==$AAAA=`)).toBe(true);
    expect(needsRehash('nonsense')).toBe(true);
  });
});
