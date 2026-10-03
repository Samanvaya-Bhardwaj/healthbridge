import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Envelope encryption for clinical content at rest (ADR-0025).
 *
 * Each record gets a fresh 256-bit data key. The content is sealed with AES-256-GCM under
 * the data key, and the data key is sealed with AES-256-GCM under the key-encryption key
 * (KEK) named by `keyId`. Both seals bind the caller's associated data (e.g. the note id
 * and patient id), so a ciphertext copied onto another row does not decrypt.
 *
 * Format (version 1):
 *   0x01 | len(keyId) | keyId | wrapIv(12) | wrapTag(16) | wrappedKey(32) | iv(12) | tag(16) | ciphertext
 *
 * Rotation: new records use the current KEK; older records name their KEK and stay
 * readable while it is configured as a previous key.
 *
 * @param {{ currentKeyId: string, keys: Map<string, Buffer> }} keyring
 */
export function createEnvelope({ currentKeyId, keys }) {
  const kek = (id) => {
    const key = keys.get(id);
    if (!key) throw new Error(`clinical data key ${id} is not configured`);
    return key;
  };

  function seal(key, plaintext, aad) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad);
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { iv, tag: cipher.getAuthTag(), ct };
  }

  function open(key, { iv, tag, ct }, aad) {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  }

  return {
    currentKeyId,

    /** @returns {{ keyId: string, blob: Buffer }} */
    encryptJson(value, associatedData) {
      const aad = Buffer.from(associatedData, 'utf8');
      const dataKey = randomBytes(32);
      const wrapped = seal(kek(currentKeyId), dataKey, aad);
      const body = seal(dataKey, Buffer.from(JSON.stringify(value), 'utf8'), aad);
      dataKey.fill(0);
      const id = Buffer.from(currentKeyId, 'ascii');
      return {
        keyId: currentKeyId,
        blob: Buffer.concat([
          Buffer.from([1, id.length]),
          id,
          wrapped.iv,
          wrapped.tag,
          wrapped.ct,
          body.iv,
          body.tag,
          body.ct,
        ]),
      };
    },

    decryptJson(blob, associatedData) {
      const buf = Buffer.from(blob);
      if (buf[0] !== 1) throw new Error('unsupported envelope version');
      const idLength = buf[1];
      const keyId = buf.subarray(2, 2 + idLength).toString('ascii');
      let at = 2 + idLength;
      const take = (n) => buf.subarray(at, (at += n));
      const wrapped = { iv: take(12), tag: take(16), ct: take(32) };
      const body = { iv: take(12), tag: take(16), ct: buf.subarray(at) };
      const aad = Buffer.from(associatedData, 'utf8');
      const dataKey = open(kek(keyId), wrapped, aad);
      try {
        return JSON.parse(open(dataKey, body, aad).toString('utf8'));
      } finally {
        dataKey.fill(0);
      }
    },
  };
}
