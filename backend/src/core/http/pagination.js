import { z } from 'zod';
import { BadRequestError } from './errors.js';

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

/** Query-string fields shared by every cursor-paginated list endpoint. */
export const paginationQuery = {
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
};

/** Opaque cursor: base64url-encoded JSON of the last row's sort key. */
export const encodeCursor = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

export function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof value !== 'object' || value === null) throw new Error('invalid');
    return value;
  } catch {
    throw new BadRequestError('Invalid pagination cursor.', 'invalid_cursor');
  }
}
