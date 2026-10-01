/**
 * Application errors rendered as RFC 9457 (formerly 7807) problem details.
 * `code` is stable and machine-readable; `detail` must never contain PHI or secrets.
 */
export class AppError extends Error {
  /**
   * @param {{ status: number, code: string, title: string, detail?: string, extensions?: Record<string, unknown>, cause?: unknown }} options
   */
  constructor({ status, code, title, detail, extensions, cause }) {
    super(detail ?? title, cause ? { cause } : undefined);
    this.name = this.constructor.name;
    this.status = status;
    this.code = code;
    this.title = title;
    this.detail = detail;
    this.extensions = extensions;
  }
}

export class ValidationError extends AppError {
  /** @param {{ path: string, message: string }[]} errors */
  constructor(errors, detail = 'The request contains invalid fields.') {
    super({
      status: 400,
      code: 'validation_failed',
      title: 'Validation failed',
      detail,
      extensions: { errors },
    });
  }
}

export class BadRequestError extends AppError {
  constructor(detail = 'The request could not be processed.', code = 'bad_request') {
    super({ status: 400, code, title: 'Bad request', detail });
  }
}

/**
 * Codes: unauthenticated | token_expired | token_invalid | session_invalid |
 * invalid_credentials | refresh_conflict.
 */
export class UnauthorizedError extends AppError {
  constructor(detail = 'Authentication is required.', code = 'unauthenticated') {
    super({ status: 401, code, title: 'Unauthenticated', detail });
  }
}

export class ForbiddenError extends AppError {
  constructor(detail = 'You do not have permission to perform this action.', code = 'forbidden') {
    super({ status: 403, code, title: 'Forbidden', detail });
  }
}

/**
 * Also used for resources outside the caller's scope, so that the existence of
 * another patient's record is never revealed (404-on-deny).
 */
export class NotFoundError extends AppError {
  constructor(detail = 'The requested resource was not found.') {
    super({ status: 404, code: 'not_found', title: 'Not found', detail });
  }
}

export class ConflictError extends AppError {
  constructor(detail = 'The request conflicts with the current state.', code = 'conflict') {
    super({ status: 409, code, title: 'Conflict', detail });
  }
}

export class PayloadTooLargeError extends AppError {
  constructor() {
    super({
      status: 413,
      code: 'payload_too_large',
      title: 'Payload too large',
      detail: 'The request body exceeds the allowed size.',
    });
  }
}

export class RateLimitedError extends AppError {
  constructor(retryAfterSeconds) {
    super({
      status: 429,
      code: 'rate_limited',
      title: 'Too many requests',
      detail: 'Too many requests. Please retry later.',
      extensions: { retryAfterSeconds },
    });
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(detail = 'A required service is temporarily unavailable.') {
    super({ status: 503, code: 'service_unavailable', title: 'Service unavailable', detail });
  }
}
