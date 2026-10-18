import { createHmac, hkdfSync } from 'node:crypto';

/**
 * Keyed digests of free-text AI inputs (ADR-0012 reproducibility, ADR-0029).
 *
 * An AI run record keeps a digest of its input so that two runs over the same input can be
 * recognised without storing the input. A plain SHA-256 of a short free-text message can
 * be reversed by hashing guesses, so these digests are HMAC-SHA256 under a dedicated,
 * backend-only secret (`AI_INPUT_DIGEST_KEY`). The AI service never holds the key: the
 * backend sends it the finished `{ keyId, value }`, which it stores as is.
 *
 * - **Purpose separation:** each purpose below gets its own subkey (HKDF label
 *   `ai-input-digest/<purpose>/v1`), so equal text in two workflows yields unrelated
 *   digests.
 * - **Versioning:** the stored `keyId` names the key; the `/v1` label is the scheme
 *   (subkey derivation and input encoding). A scheme change needs a new key ID, so the
 *   stored key ID always identifies both.
 * - **Rotation:** a new key gives new digests, so runs before and after a rotation cannot
 *   be compared. Nothing reads these digests to make a decision (telemetry only), so no
 *   previous keys are kept.
 */
export const AI_INPUT_DIGEST_PURPOSES = Object.freeze([
  'care_assistant_message',
  'record_question',
  'follow_up_summary',
  // ADR-0040: a message the health library answers.
  'health_info_message',
]);

/** @param {{ currentKeyId: string, keys: Map<string, Buffer> }} config */
export function createInputDigester({ currentKeyId, keys }) {
  const root = keys?.get(currentKeyId);
  if (!Buffer.isBuffer(root) || root.length !== 32) {
    throw new Error(`AI input digest key ${currentKeyId} must be 32 bytes`);
  }
  const subkeys = new Map(
    AI_INPUT_DIGEST_PURPOSES.map((purpose) => [
      purpose,
      Buffer.from(hkdfSync('sha256', root, 'healthbridge', `ai-input-digest/${purpose}/v1`, 32)),
    ]),
  );
  return {
    keyId: currentKeyId,
    /**
     * @param {string} purpose one of AI_INPUT_DIGEST_PURPOSES
     * @param {string | unknown[]} input text, or a JSON array (encoded with JSON.stringify)
     * @returns {{ keyId: string, value: string }} value: 64 lowercase hex characters
     */
    digest(purpose, input) {
      const key = subkeys.get(purpose);
      if (!key) throw new Error(`unknown AI input digest purpose: ${purpose}`);
      const data = typeof input === 'string' ? input : JSON.stringify(input);
      return { keyId: currentKeyId, value: createHmac('sha256', key).update(data).digest('hex') };
    },
  };
}
