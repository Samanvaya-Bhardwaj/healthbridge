import { createHash } from 'node:crypto';
import { DOCUMENT_CONTENT_TYPES } from '@healthbridge/shared';

/**
 * Content checks applied to the stored object (never the browser's claims alone):
 * magic bytes, declared type ↔ detected type ↔ file extension, size limits and the
 * client-declared SHA-256.
 */

const SIGNATURES = [
  { type: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] }, // %PDF-
  { type: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { type: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
];

/** Content type from the file signature, or null if not on the allowlist. */
export function detectContentType(buffer) {
  for (const { type, bytes } of SIGNATURES) {
    if (buffer.length >= bytes.length && bytes.every((b, i) => buffer[i] === b)) return type;
  }
  return null;
}

export const extensionOf = (name) => /\.([A-Za-z0-9]{1,8})$/.exec(name)?.[1].toLowerCase() ?? null;

/**
 * @param {{ buffer: Buffer, declaredContentType: string, declaredSize: number, declaredSha256: string, filename: string, maxBytes: number }} input
 * @returns {{ ok: true, detectedContentType: string, sha256: string, size: number } | { ok: false, reason: string, sha256?: string, size: number }}
 */
export function validateDocumentContent({
  buffer,
  declaredContentType,
  declaredSize,
  declaredSha256,
  filename,
  maxBytes,
}) {
  const size = buffer.length;
  if (size > maxBytes) return { ok: false, reason: 'size_exceeded', size };
  if (size !== declaredSize) return { ok: false, reason: 'size_mismatch', size };
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  if (sha256 !== declaredSha256) return { ok: false, reason: 'checksum_mismatch', sha256, size };
  const detected = detectContentType(buffer);
  if (!detected) return { ok: false, reason: 'unsupported_content', sha256, size };
  if (
    detected !== declaredContentType ||
    !DOCUMENT_CONTENT_TYPES[detected].includes(extensionOf(filename) ?? '')
  ) {
    return { ok: false, reason: 'type_mismatch', sha256, size };
  }
  return { ok: true, detectedContentType: detected, sha256, size };
}
