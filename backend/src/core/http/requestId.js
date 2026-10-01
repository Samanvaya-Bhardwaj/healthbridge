import { REQUEST_ID_HEADER } from '@healthbridge/shared';
import { newId } from '../db/ids.js';

// Accept upstream IDs (Nginx $request_id is 32 hex chars; clients may send UUIDs)
// but only in a safe, bounded format so they cannot be used for log injection.
const SAFE_REQUEST_ID = /^[A-Za-z0-9-]{16,64}$/;

/** Assigns `req.id` and echoes it in the `X-Request-Id` response header. */
export function requestId() {
  return (req, res, next) => {
    const incoming = req.get(REQUEST_ID_HEADER);
    req.id = incoming && SAFE_REQUEST_ID.test(incoming) ? incoming : newId();
    res.setHeader('X-Request-Id', req.id);
    next();
  };
}
