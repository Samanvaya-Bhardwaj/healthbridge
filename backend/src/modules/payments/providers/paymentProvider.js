import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/**
 * PaymentProvider port (ADR-0007, ADR-0020). The payments module knows only this
 * interface; vendor adapters live beside it and never leak SDK or HTTP types.
 *
 * @typedef {object} ProviderOrder
 * @property {string} orderId
 * @property {number} amountPaise
 * @property {string} currency
 *
 * @typedef {object} ProviderEvent  provider-neutral, verified webhook event
 * @property {string} eventId
 * @property {string} type           provider event name, e.g. "payment.captured"
 * @property {'authorized'|'captured'|'failed'|'refund_created'|'refund_processed'|'refund_failed'|'ignored'} kind
 * @property {string|null} orderId
 * @property {string|null} paymentId  provider payment id
 * @property {string|null} refundId   provider refund id
 * @property {number|null} amountPaise
 * @property {string|null} currency
 * @property {{ paymentId?: string, appointmentId?: string, refundId?: string }} refs  our ids echoed back via notes
 * @property {string|null} failureCode
 *
 * @typedef {object} PaymentProvider
 * @property {'fake'|'razorpay'} name
 * @property {(input: { paymentId: string, appointmentId: string, amountPaise: number, currency: string }) => Promise<ProviderOrder>} createOrder
 * @property {(rawBody: Buffer, headers: Record<string, string|undefined>) => ProviderEvent} verifyWebhook  throws InvalidWebhookError
 * @property {(input: { providerPaymentId: string, amountPaise: number, idempotencyKey: string, refundId: string }) => Promise<{ refundId: string, status: 'processing'|'processed' }>} refund
 * @property {(orderId: string) => Promise<{ status: 'created'|'attempted'|'paid', paidPaymentId: string|null }>} getPaymentStatus
 * @property {(payment: { orderId: string, amountPaise: number, currency: string }) => Record<string, unknown>} checkoutOptions  public data for the browser
 */

/** Provider-neutral failure. `retryable` tells workers whether a retry can help. */
export class PaymentProviderError extends Error {
  /** @param {'timeout'|'unavailable'|'rejected'|'invalid_response'|'not_configured'} kind */
  constructor(kind, message, { status } = {}) {
    super(message);
    this.name = 'PaymentProviderError';
    this.kind = kind;
    this.status = status;
    this.retryable = ['timeout', 'unavailable', 'invalid_response'].includes(kind);
  }
}

/** The webhook could not be authenticated or parsed; nothing from it may be trusted. */
export class InvalidWebhookError extends Error {
  /** @param {'missing_signature'|'bad_signature'|'malformed_payload'|'missing_event_id'} reason */
  constructor(reason) {
    super(`invalid webhook: ${reason}`);
    this.name = 'InvalidWebhookError';
    this.reason = reason;
  }
}

/** Constant-time HMAC-SHA256 (hex) comparison. */
export function verifyHmacSignature(rawBody, signature, secret) {
  if (typeof signature !== 'string' || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

export const hmacHex = (rawBody, secret) =>
  createHmac('sha256', secret).update(rawBody).digest('hex');

// ── Razorpay-format event payloads (the fake provider uses the same wire format) ──

const notesSchema = z
  .union([z.record(z.string(), z.unknown()), z.array(z.unknown())])
  .optional()
  .transform((n) => (Array.isArray(n) ? {} : (n ?? {})));
const paymentEntity = z.looseObject({
  id: z.string().min(1).max(64),
  order_id: z.string().min(1).max(64).nullable().optional(),
  amount: z.number().int().nonnegative(),
  currency: z.string().length(3),
  status: z.string().max(32).optional(),
  error_code: z.string().max(64).nullable().optional(),
  notes: notesSchema,
});
const refundEntity = z.looseObject({
  id: z.string().min(1).max(64),
  payment_id: z.string().min(1).max(64),
  amount: z.number().int().positive(),
  currency: z.string().length(3),
  status: z.string().max(32).optional(),
  notes: notesSchema,
});
const eventSchema = z.looseObject({
  entity: z.literal('event'),
  event: z.string().regex(/^[a-z_]+\.[a-z_]+$/),
  payload: z.looseObject({
    payment: z.looseObject({ entity: paymentEntity }).optional(),
    refund: z.looseObject({ entity: refundEntity }).optional(),
    order: z.looseObject({ entity: z.looseObject({ id: z.string().max(64) }) }).optional(),
  }),
});

const KINDS = {
  'payment.authorized': 'authorized',
  'payment.captured': 'captured',
  'order.paid': 'captured',
  'payment.failed': 'failed',
  'refund.created': 'refund_created',
  'refund.processed': 'refund_processed',
  'refund.failed': 'refund_failed',
};

const normaliseCode = (code) =>
  code
    ? String(code)
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '_')
        .slice(0, 64)
    : null;

const uuidOrUndefined = (value) =>
  typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value) ? value.toLowerCase() : undefined;

/**
 * Parses an already-authenticated Razorpay-format body into a ProviderEvent.
 * @param {Buffer} rawBody
 * @param {string} eventId
 */
export function parseRazorpayEvent(rawBody, eventId) {
  let json;
  try {
    json = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new InvalidWebhookError('malformed_payload');
  }
  const parsed = eventSchema.safeParse(json);
  if (!parsed.success) throw new InvalidWebhookError('malformed_payload');
  const { event, payload } = parsed.data;
  const kind = KINDS[event] ?? 'ignored';
  const payment = payload.payment?.entity;
  const refund = payload.refund?.entity;
  if (kind.startsWith('refund_') && !refund) throw new InvalidWebhookError('malformed_payload');
  if (['authorized', 'captured', 'failed'].includes(kind) && !payment) {
    throw new InvalidWebhookError('malformed_payload');
  }
  const notes = { ...(payment?.notes ?? {}), ...(refund?.notes ?? {}) };
  const money = refund ?? payment;
  return {
    eventId,
    type: event,
    kind,
    orderId: payment?.order_id ?? payload.order?.entity.id ?? null,
    paymentId: refund?.payment_id ?? payment?.id ?? null,
    refundId: refund?.id ?? null,
    amountPaise: money?.amount ?? null,
    currency: money?.currency ?? null,
    refs: {
      paymentId: uuidOrUndefined(notes.hb_payment_id),
      appointmentId: uuidOrUndefined(notes.hb_appointment_id),
      refundId: uuidOrUndefined(notes.hb_refund_id),
    },
    failureCode:
      kind === 'failed' ? (normaliseCode(payment?.error_code) ?? 'payment_failed') : null,
  };
}

/** Wraps fetch with a timeout and maps failures to PaymentProviderError kinds. */
export async function providerFetch(fetchImpl, url, { timeoutMs, ...init }) {
  let res;
  try {
    res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new PaymentProviderError('timeout', 'payment provider timed out');
    }
    throw new PaymentProviderError('unavailable', 'payment provider unreachable');
  }
  if (res.status >= 500 || res.status === 429) {
    throw new PaymentProviderError('unavailable', `payment provider error ${res.status}`, {
      status: res.status,
    });
  }
  let body;
  try {
    body = await res.json();
  } catch {
    throw new PaymentProviderError('invalid_response', 'payment provider returned invalid JSON', {
      status: res.status,
    });
  }
  if (!res.ok) {
    throw new PaymentProviderError('rejected', `payment provider rejected the request`, {
      status: res.status,
    });
  }
  return body;
}

/** Validates a provider response shape; a malformed response is a provider failure. */
export function expectShape(schema, body) {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new PaymentProviderError('invalid_response', 'unexpected payment provider response');
  }
  return parsed.data;
}
