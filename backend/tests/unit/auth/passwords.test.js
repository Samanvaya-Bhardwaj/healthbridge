import { describe, expect, it } from 'vitest';
import { createPasswordHasher } from '../../../src/core/auth/passwordHasher.js';
import { checkPasswordPolicy } from '../../../src/modules/identity/domain/passwordPolicy.js';
import { FAST_HASH_PARAMS } from '../../helpers.js';

const hasher = createPasswordHasher(FAST_HASH_PARAMS);

describe('password hashing (Argon2id)', () => {
  it('produces a salted argon2id hash that never contains the password', async () => {
    const password = 'correct horse battery staple';
    const a = await hasher.hash(password);
    const b = await hasher.hash(password);
    expect(a).toMatch(/^\$argon2id\$v=19\$m=4096,t=1,p=1\$/);
    expect(a).not.toBe(b); // unique salt per hash
    expect(a).not.toContain(password);
  });

  it('verifies correct passwords and rejects wrong ones', async () => {
    const encoded = await hasher.hash('a long synthetic passphrase');
    await expect(hasher.verify(encoded, 'a long synthetic passphrase')).resolves.toBe(true);
    await expect(hasher.verify(encoded, 'a long synthetic passphrasE')).resolves.toBe(false);
    await expect(hasher.verify('not-a-hash', 'anything')).resolves.toBe(false);
  });

  it('normalises Unicode (NFKC) so equivalent inputs verify', async () => {
    const encoded = await hasher.hash('ﬁligree passphrase'); // U+FB01 ligature
    await expect(hasher.verify(encoded, 'filigree passphrase')).resolves.toBe(true);
  });

  it('flags hashes weaker than the current policy for rehash', async () => {
    const strong = createPasswordHasher({ memoryCost: 8192, timeCost: 2, parallelism: 1 });
    expect(strong.needsRehash(await hasher.hash('a long synthetic passphrase'))).toBe(true);
    expect(strong.needsRehash(await strong.hash('a long synthetic passphrase'))).toBe(false);
    expect(strong.needsRehash('$2b$10$legacybcrypt')).toBe(true);
  });

  it('dummy verification always fails (timing equalisation for unknown accounts)', async () => {
    await expect(hasher.verifyDummy('anything at all')).resolves.toBe(false);
  });
});

describe('password policy', () => {
  it('accepts a long, uncommon passphrase', () => {
    expect(
      checkPasswordPolicy('river lantern quiet mango', { email: 'asha@example.test' }),
    ).toBeNull();
  });

  it.each([
    ['short1', /at least 12/],
    ['aaaaaaaaaaaaaa', /repetitive/],
    ['Password-1234', /too common/],
    ['qwerty123456', /too common/],
    ['healthbridge123', /too common/],
  ])('rejects %s', (password, message) => {
    expect(checkPasswordPolicy(password)).toMatch(message);
  });

  it('rejects passwords containing the email local part or the name', () => {
    expect(
      checkPasswordPolicy('ashaverma-2026-secure', { email: 'ashaverma@example.test' }),
    ).toMatch(/email/);
    expect(checkPasswordPolicy('my name is Verma 2026!', { fullName: 'Asha Verma' })).toMatch(
      /name/,
    );
  });

  it('counts Unicode code points, not UTF-16 units', () => {
    // 12 code points but 23 UTF-16 units: accepted.
    expect(checkPasswordPolicy('🔒🌿🌙⭐🍋🎵🚲🌊📚🧭🎈x')).toBeNull();
    // 6 code points but 12 UTF-16 units: still too short.
    expect(checkPasswordPolicy('🔒🌿🌙🍋🎵🚲')).toMatch(/at least 12/);
  });
});
