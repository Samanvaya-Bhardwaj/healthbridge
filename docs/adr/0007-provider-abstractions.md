# ADR-0007: Provider abstractions for LLM, video, payments, storage and notifications

- **Status:** Accepted
- **Date:** 2026-10-01

## Context

External vendors change on commercial, legal and technical grounds. Business logic that
calls vendor SDKs directly becomes expensive to change and hard to test.

## Decision

Each external capability is defined as an interface owned by the application, with
vendor adapters kept in the infrastructure layer. Only the adapter imports the vendor SDK.

| Capability | Interface (domain-facing) | First adapter | Test/demo adapter |
|---|---|---|---|
| LLM | `LLMProvider.generate()`, `resolve_model(tier)` | `ClaudeProvider` | `FakeLLMProvider` |
| Video | `VideoProvider.createRoom()`, `joinRoom()`, `endRoom()`, `participantStatus()` | `LiveKitProvider` | mock |
| Payments | `PaymentProvider.createPayment()`, `verifyPayment()`, `verifyWebhook()`, `refund()`, `cancel()` | `RazorpayProvider` | mock |
| Storage | presigned upload/download, head, move | S3 API (MinIO locally) | MinIO |
| Notifications | `send(channel, template, recipient)` | SMTP/SES, SMS/WhatsApp | Mailpit / in-memory |

Rules:

- The domain layer knows only the interface. The consultation domain sees `createRoom`,
  `joinRoom`, `endRoom` and `participantStatus`, never LiveKit concepts.
- Adapters map vendor errors to provider-neutral error kinds (e.g. `LLMErrorKind`) and
  never leak SDK types.
- **Payments:** an appointment is confirmed only by the backend after server-side payment
  verification and a verified webhook. Frontend state is never trusted. Webhook events are
  deduplicated with `UNIQUE (provider, provider_event_id)`, and creation, refund and cancel
  operations are idempotent via idempotency keys.
- One factory per capability chooses the adapter from configuration.

## Consequences

- Switching or adding vendors touches one adapter and the configuration.
- Deterministic fakes make the test suite and demo mode independent of paid APIs.
- We must avoid designing interfaces around one vendor's feature set. Interfaces cover
  only what the domain needs.
