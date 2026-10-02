import { createHash } from 'node:crypto';
import { AppError, NotFoundError } from '../../core/http/errors.js';
import { domainMetrics } from '../../core/metrics/domain.js';
import { InvalidWebhookError } from './providers/paymentProvider.js';

class InvalidWebhookRequestError extends AppError {
  constructor() {
    super({
      status: 400,
      code: 'invalid_webhook',
      title: 'Invalid webhook',
      detail: 'The webhook could not be verified.',
    });
  }
}

/**
 * Provider webhook entry point (ADR-0020): the ONLY way a payment becomes paid.
 *
 * 1. Verify the signature over the raw body (nothing in an unverified body is trusted).
 * 2. Hand the provider-neutral event to settlement, which records the event id and
 *    applies its effects in one transaction (duplicates are no-ops).
 * 3. Answer quickly; notifications and refunds happen in workers via the outbox.
 */
export function createWebhookService({ provider, settlement, audit, logger }) {
  /**
   * @param {string} providerName  from the URL
   * @param {Buffer} rawBody
   * @param {Record<string, string|undefined>} headers  lower-case header names
   */
  async function handle(providerName, rawBody, headers, req) {
    if (providerName !== provider.name) throw new NotFoundError();
    domainMetrics.webhooksReceived.inc({ provider: provider.name });
    const end = domainMetrics.webhookLatency.startTimer();

    let event;
    try {
      if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
        throw new InvalidWebhookError('malformed_payload');
      }
      event = provider.verifyWebhook(rawBody, headers);
    } catch (err) {
      if (!(err instanceof InvalidWebhookError)) throw err;
      domainMetrics.webhooksInvalid.inc({ reason: err.reason });
      end({ outcome: 'invalid' });
      await audit.recordBestEffort(
        {
          category: 'financial',
          action: 'payment.webhook_invalid',
          outcome: 'denied',
          actor: null,
          reason: err.reason,
          metadata: { provider: provider.name },
        },
        { req },
      );
      logger?.warn({ reason: err.reason, provider: provider.name }, 'payment webhook rejected');
      throw new InvalidWebhookRequestError();
    }

    const payloadSha256 = createHash('sha256').update(rawBody).digest('hex');
    try {
      const result = await settlement.applyProviderEvent(event, { payloadSha256, req });
      if (result.duplicate) {
        domainMetrics.webhooksDuplicate.inc();
        await audit.recordBestEffort(
          {
            category: 'financial',
            action: 'payment.webhook_duplicate',
            outcome: 'success',
            actor: 'system',
            reason: 'duplicate_event',
            metadata: { provider: provider.name, eventType: event.type },
          },
          { req },
        );
      }
      end({ outcome: result.duplicate ? 'duplicate' : (result.status ?? 'processed') });
      logger?.info(
        {
          provider: provider.name,
          eventType: event.type,
          duplicate: result.duplicate,
          status: result.status,
          outcome: result.outcome,
        },
        'payment webhook handled',
      );
      return {
        duplicate: result.duplicate,
        status: result.status ?? 'duplicate',
        outcome: result.outcome,
      };
    } catch (err) {
      // Nothing was committed: the provider will retry and processing starts over.
      end({ outcome: 'error' });
      throw err;
    }
  }

  return { handle };
}
