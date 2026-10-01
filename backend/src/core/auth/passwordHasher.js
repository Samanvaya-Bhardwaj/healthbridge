import { hash, verify } from '@node-rs/argon2';

const ARGON2ID = 2; // @node-rs/argon2 Algorithm.Argon2id (a TypeScript const enum)

/** OWASP Password Storage Cheat Sheet minimum for Argon2id: m=19 MiB, t=2, p=1. */
export const DEFAULT_ARGON2_PARAMS = Object.freeze({
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
});

// Unicode normalisation so visually identical passwords hash identically.
const normalize = (password) => password.normalize('NFKC');

function parseParams(encoded) {
  const match = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(encoded ?? '');
  return match && { memoryCost: +match[1], timeCost: +match[2], parallelism: +match[3] };
}

/**
 * Argon2id password hashing. Plaintext passwords exist only transiently in memory;
 * they are never stored, logged or returned.
 */
export function createPasswordHasher(params = DEFAULT_ARGON2_PARAMS) {
  const options = { ...params, algorithm: ARGON2ID };
  // Used to equalise timing when the account does not exist (enumeration resistance).
  const dummyHash = hash('timing-equalisation-placeholder', options);

  return {
    hash: (password) => hash(normalize(password), options),

    async verify(encodedHash, password) {
      try {
        return await verify(encodedHash, normalize(password));
      } catch {
        return false;
      }
    },

    /** Performs a full verification against a fixed hash and always returns false. */
    async verifyDummy(password) {
      await verify(await dummyHash, normalize(password)).catch(() => false);
      return false;
    },

    /** True when the stored hash uses weaker parameters than the current policy. */
    needsRehash(encodedHash) {
      const current = parseParams(encodedHash);
      return (
        !current ||
        current.memoryCost < params.memoryCost ||
        current.timeCost < params.timeCost ||
        current.parallelism !== params.parallelism
      );
    },
  };
}
