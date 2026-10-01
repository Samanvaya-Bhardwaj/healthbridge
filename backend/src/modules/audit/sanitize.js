/**
 * Audit metadata sanitiser. Audit rows record *that* something happened, never secrets
 * or clinical content. Keys that look sensitive are redacted; structures are bounded.
 */

const SENSITIVE_KEY =
  /pass(word|phrase)?|secret|token|authorization|cookie|api[-_]?key|credential|otp|hash|signature|private/i;
const MAX_DEPTH = 3;
const MAX_KEYS = 20;
const MAX_ARRAY = 20;
const MAX_STRING = 200;

export const REDACTED = '[REDACTED]';

export function sanitizeMetadata(value, depth = 0) {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_DEPTH) return '[TRUNCATED]';
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY).map((item) => sanitizeMetadata(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, MAX_KEYS)) {
      out[key] = SENSITIVE_KEY.test(key) ? REDACTED : sanitizeMetadata(item, depth + 1);
    }
    return out;
  }
  return String(value);
}
