import { describe, expect, it, vi } from 'vitest';
import { createFakePaymentProvider } from '../../../src/modules/payments/providers/fakePaymentProvider.js';
import { createRazorpayPaymentProvider } from '../../../src/modules/payments/providers/razorpayPaymentProvider.js';
import {
  InvalidWebhookError,
  PaymentProviderError,
  hmacHex,
} from '../../../src/modules/payments/providers/paymentProvider.js';
import { createPaymentProvider } from '../../../src/modules/payments/providers/index.js';
import { ConfigError, loadConfig } from '../../../src/config/index.js';
import { validEnv } from '../../helpers.js';

const SECRET = 'unit-test-webhook-secret-0001';
const PAYMENT_ID = '0192a6b0-0000-7000-8000-000000000001';
const APPOINTMENT_ID = '0192a6b0-0000-7000-8000-000000000002';

describe('FakePaymentProvider', () => {
  it('is deterministic and needs no network', async () => {
    const a = createFakePaymentProvider({ webhookSecret: SECRET });
    const b = createFakePaymentProvider({ webhookSecret: SECRET });
    const input = {
      paymentId: PAYMENT_ID,
      appointmentId: APPOINTMENT_ID,
      amountPaise: 50000,
      currency: 'INR',
    };
    expect(await a.createOrder(input)).toEqual(await b.createOrder(input));
    expect((await a.createOrder(input)).orderId).toMatch(/^order_fake_[0-9a-f]{14}$/);
    const r1 = await a.refund({
      providerPaymentId: 'pay_1',
      amountPaise: 100,
      idempotencyKey: 'key-0001',
      refundId: 'r',
    });
    const r2 = await a.refund({
      providerPaymentId: 'pay_1',
      amountPaise: 100,
      idempotencyKey: 'key-0001',
      refundId: 'r',
    });
    expect(r1).toEqual(r2); // idempotent by key
  });

  it('verifies its own signed webhooks and rejects tampering', () => {
    const p = createFakePaymentProvider({ webhookSecret: SECRET });
    const signed = p.webhook('payment.captured', {
      orderId: 'order_fake_1',
      amountPaise: 50000,
      notes: { hb_payment_id: PAYMENT_ID, hb_appointment_id: APPOINTMENT_ID },
    });
    const event = p.verifyWebhook(signed.rawBody, signed.headers);
    expect(event).toMatchObject({
      kind: 'captured',
      type: 'payment.captured',
      orderId: 'order_fake_1',
      amountPaise: 50000,
      currency: 'INR',
      refs: { paymentId: PAYMENT_ID, appointmentId: APPOINTMENT_ID },
    });
    const other = createFakePaymentProvider({ webhookSecret: 'a-different-secret-000' });
    expect(() => other.verifyWebhook(signed.rawBody, signed.headers)).toThrow(InvalidWebhookError);
    const tampered = Buffer.from(signed.rawBody.toString().replace('50000', '1'));
    expect(() => p.verifyWebhook(tampered, signed.headers)).toThrow(/bad_signature/);
    const noId = { ...signed.headers };
    delete noId['x-fake-event-id'];
    expect(() => p.verifyWebhook(signed.rawBody, noId)).toThrow(/missing_event_id/);
  });

  it('injects failures on demand', async () => {
    const p = createFakePaymentProvider({ webhookSecret: SECRET });
    p.failNext('createOrder', 'timeout');
    await expect(
      p.createOrder({ paymentId: PAYMENT_ID, amountPaise: 1, currency: 'INR' }),
    ).rejects.toMatchObject({
      kind: 'timeout',
      retryable: true,
    });
    await expect(
      p.createOrder({ paymentId: PAYMENT_ID, amountPaise: 1, currency: 'INR' }),
    ).resolves.toBeTruthy();
  });
});

describe('RazorpayPaymentProvider (mocked HTTP; no real keys, no money)', () => {
  const jsonResponse = (status, body) => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  });
  const make = (fetchImpl) =>
    createRazorpayPaymentProvider({
      keyId: 'rzp_test_unit',
      keySecret: 'not-a-real-secret',
      webhookSecret: SECRET,
      timeoutMs: 1000,
      fetch: fetchImpl,
    });

  it('creates orders server-side with the authoritative amount and identifier-only notes', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { id: 'order_123', amount: 50000, currency: 'INR', status: 'created' }),
    );
    const order = await make(fetchImpl).createOrder({
      paymentId: PAYMENT_ID,
      appointmentId: APPOINTMENT_ID,
      amountPaise: 50000,
      currency: 'INR',
    });
    expect(order).toEqual({ orderId: 'order_123', amountPaise: 50000, currency: 'INR' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.razorpay.com/v1/orders');
    expect(init.headers.authorization).toBe(
      `Basic ${Buffer.from('rzp_test_unit:not-a-real-secret').toString('base64')}`,
    );
    expect(JSON.parse(init.body)).toEqual({
      amount: 50000,
      currency: 'INR',
      receipt: PAYMENT_ID,
      payment_capture: 1,
      notes: { hb_payment_id: PAYMENT_ID, hb_appointment_id: APPOINTMENT_ID },
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('maps timeouts, 5xx, 4xx and malformed responses to provider-neutral errors', async () => {
    const cases = [
      [
        async () => {
          throw Object.assign(new Error('t'), { name: 'TimeoutError' });
        },
        'timeout',
        true,
      ],
      [
        async () => {
          throw new TypeError('fetch failed');
        },
        'unavailable',
        true,
      ],
      [async () => jsonResponse(502, {}), 'unavailable', true],
      [async () => jsonResponse(429, {}), 'unavailable', true],
      [async () => jsonResponse(400, { error: { code: 'BAD_REQUEST_ERROR' } }), 'rejected', false],
      [
        async () => ({
          status: 200,
          ok: true,
          json: async () => {
            throw new SyntaxError('x');
          },
        }),
        'invalid_response',
        true,
      ],
      [async () => jsonResponse(200, { unexpected: true }), 'invalid_response', true],
    ];
    for (const [impl, kind, retryable] of cases) {
      const err = await make(impl)
        .createOrder({
          paymentId: PAYMENT_ID,
          appointmentId: APPOINTMENT_ID,
          amountPaise: 1,
          currency: 'INR',
        })
        .catch((e) => e);
      expect(err).toBeInstanceOf(PaymentProviderError);
      expect(err).toMatchObject({ kind, retryable });
      expect(err.message).not.toContain('not-a-real-secret');
    }
  });

  it('refunds idempotently: an existing refund with our id is reused, not duplicated', async () => {
    const fetchImpl = vi.fn(async (url) =>
      url.endsWith('/refunds')
        ? jsonResponse(200, {
            items: [{ id: 'rfnd_1', status: 'processed', notes: { hb_refund_id: 'our-refund' } }],
          })
        : jsonResponse(500, {}),
    );
    const result = await make(fetchImpl).refund({
      providerPaymentId: 'pay_1',
      amountPaise: 100,
      idempotencyKey: 'k',
      refundId: 'our-refund',
    });
    expect(result).toEqual({ refundId: 'rfnd_1', status: 'processed' });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // no second POST

    const fresh = vi.fn(async (url, init) =>
      init.method === 'POST'
        ? jsonResponse(200, { id: 'rfnd_2', status: 'pending' })
        : jsonResponse(200, { items: [] }),
    );
    expect(
      await make(fresh).refund({
        providerPaymentId: 'pay_1',
        amountPaise: 100,
        idempotencyKey: 'k',
        refundId: 'new',
      }),
    ).toEqual({ refundId: 'rfnd_2', status: 'processing' });
    expect(JSON.parse(fresh.mock.calls[1][1].body)).toMatchObject({
      amount: 100,
      notes: { hb_refund_id: 'new' },
    });
  });

  it('verifies Razorpay webhook signatures over the raw body', () => {
    const body = Buffer.from(
      JSON.stringify({
        entity: 'event',
        event: 'refund.processed',
        payload: {
          refund: {
            entity: {
              id: 'rfnd_9',
              payment_id: 'pay_9',
              amount: 100,
              currency: 'INR',
              notes: { hb_refund_id: PAYMENT_ID },
            },
          },
          payment: {
            entity: { id: 'pay_9', order_id: 'order_9', amount: 500, currency: 'INR', notes: [] },
          },
        },
      }),
    );
    const provider = make(vi.fn());
    const headers = {
      'x-razorpay-signature': hmacHex(body, SECRET),
      'x-razorpay-event-id': 'evt_9',
    };
    expect(provider.verifyWebhook(body, headers)).toMatchObject({
      kind: 'refund_processed',
      refundId: 'rfnd_9',
      paymentId: 'pay_9',
      amountPaise: 100,
      refs: { refundId: PAYMENT_ID },
    });
    expect(() =>
      provider.verifyWebhook(body, {
        ...headers,
        'x-razorpay-signature': hmacHex(body, 'wrong-secret-000000'),
      }),
    ).toThrow(InvalidWebhookError);
    expect(() => provider.verifyWebhook(body, { 'x-razorpay-event-id': 'evt_9' })).toThrow(
      /missing_signature/,
    );
    const unsignedJunk = Buffer.from('not json');
    expect(() =>
      provider.verifyWebhook(unsignedJunk, {
        ...headers,
        'x-razorpay-signature': hmacHex(unsignedJunk, SECRET),
      }),
    ).toThrow(/malformed_payload/);
    // Checkout data for the browser: public key id and order only.
    expect(
      Object.keys(
        provider.checkoutOptions({ orderId: 'o', amountPaise: 1, currency: 'INR' }),
      ).sort(),
    ).toEqual(['amountPaise', 'currency', 'keyId', 'name', 'orderId', 'provider']);
  });
});

describe('payment and notification configuration', () => {
  const load = (env) => loadConfig({ ...validEnv, ...env });
  const issues = (env) => {
    try {
      load(env);
      return [];
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      return err.issues.map((i) => i.variable);
    }
  };
  const PROD = {
    APP_ENV: 'production',
    AUTH_COOKIE_SECURE: 'true',
    // M5: production also requires a real document scanner.
    DOCUMENT_SCANNER: 'clamav',
    CLAMAV_HOST: 'clamav.internal',
    NOTIFICATION_EMAIL_PROVIDER: 'smtp',
    SMTP_HOST: 'smtp.example.test',
    // M9: a dedicated clinical data key and a real video provider (test-only values).
    CLINICAL_DATA_KEY: Buffer.alloc(32, 7).toString('base64'),
    VIDEO_PROVIDER: 'livekit',
    LIVEKIT_URL: 'wss://video.example.test',
    LIVEKIT_API_KEY: 'test-key',
    LIVEKIT_API_SECRET: 'test-only-livekit-secret-0123456789abcdef',
  };

  it('defaults to the fake provider and simulation outside production', () => {
    const config = load({});
    expect(config.payments.provider).toBe('fake');
    expect(config.payments.simulationEnabled).toBe(true);
    expect(createPaymentProvider(config.payments).name).toBe('fake');
    expect(config.notifications.reminderOffsetsMinutes).toEqual([1440, 60]);
  });

  it('refuses the fake payment or notification provider in production', () => {
    expect(issues({ ...PROD, PAYMENT_PROVIDER: 'fake' })).toContain('PAYMENT_PROVIDER');
    expect(issues({ APP_ENV: 'production', PAYMENT_PROVIDER: 'fake' })).toContain(
      'NOTIFICATION_EMAIL_PROVIDER',
    );
  });

  it('requires Razorpay credentials and keeps live keys out of non-production', () => {
    expect(issues({ PAYMENT_PROVIDER: 'razorpay' })).toEqual(
      expect.arrayContaining(['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'PAYMENT_WEBHOOK_SECRET']),
    );
    const razorpay = {
      PAYMENT_PROVIDER: 'razorpay',
      RAZORPAY_KEY_SECRET: 'not-a-real-secret',
      PAYMENT_WEBHOOK_SECRET: 'not-a-real-webhook-secret',
    };
    expect(issues({ ...razorpay, RAZORPAY_KEY_ID: 'rzp_live_abc' })).toContain('RAZORPAY_KEY_ID');
    expect(issues({ ...PROD, ...razorpay, RAZORPAY_KEY_ID: 'rzp_test_abc' })).toContain(
      'RAZORPAY_KEY_ID',
    );
    const prod = load({ ...PROD, ...razorpay, RAZORPAY_KEY_ID: 'rzp_live_abc' });
    expect(prod.payments).toMatchObject({ provider: 'razorpay', simulationEnabled: false });
    expect(createPaymentProvider(prod.payments).name).toBe('razorpay');
    // Errors name variables, never values.
    try {
      load({ ...razorpay, RAZORPAY_KEY_ID: 'rzp_live_abc' });
    } catch (err) {
      expect(err.message).not.toContain('not-a-real-secret');
    }
  });

  it('SMTP notifications need a host; reminder offsets are validated', () => {
    expect(issues({ NOTIFICATION_EMAIL_PROVIDER: 'smtp' })).toContain('SMTP_HOST');
    expect(issues({ REMINDER_OFFSETS_MINUTES: '1' }).length).toBeGreaterThan(0);
    expect(
      load({ REMINDER_OFFSETS_MINUTES: '60,1440,60' }).notifications.reminderOffsetsMinutes,
    ).toEqual([1440, 60]);
  });
});
