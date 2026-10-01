import {
  AppError,
  BadRequestError,
  NotFoundError,
  PayloadTooLargeError,
  RateLimitedError,
} from './errors.js';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/** Terminal handler for unmatched routes. */
export function notFoundHandler() {
  return (req, _res, next) => next(new NotFoundError(`No route for ${req.method} ${req.path}.`));
}

/** Map framework/body-parser errors onto application errors. */
function normalize(err) {
  if (err instanceof AppError) return err;
  if (err?.type === 'entity.too.large') return new PayloadTooLargeError();
  if (err?.type === 'entity.parse.failed') {
    return new BadRequestError('The request body is not valid JSON.', 'malformed_json');
  }
  if (err?.type === 'encoding.unsupported' || err?.type === 'charset.unsupported') {
    return new BadRequestError('Unsupported request encoding.', 'unsupported_encoding');
  }
  return null;
}

/**
 * Renders every error as problem+json with the request ID. Unexpected errors are
 * logged with their stack and returned as a generic 500; internals never leak.
 */
export function errorHandler() {
  // Express identifies error middleware by arity, so all four parameters are required.
  return (err, req, res, _next) => {
    const known = normalize(err);
    const status = known?.status ?? 500;

    if (status >= 500) {
      req.log?.error({ err }, 'unhandled error');
    } else {
      req.log?.info({ code: known.code, status }, 'request rejected');
    }

    if (known instanceof RateLimitedError) {
      res.setHeader('Retry-After', String(known.retryAfterSeconds));
    }

    const body = {
      type: `https://healthbridge.dev/problems/${known?.code ?? 'internal_error'}`,
      title: known?.title ?? 'Internal server error',
      status,
      detail: known?.detail ?? 'An unexpected error occurred. Please try again later.',
      instance: req.originalUrl?.split('?')[0],
      code: known?.code ?? 'internal_error',
      requestId: req.id,
      ...(known?.extensions ?? {}),
    };

    if (res.headersSent) return;
    res.status(status).type(PROBLEM_CONTENT_TYPE).send(JSON.stringify(body));
  };
}
