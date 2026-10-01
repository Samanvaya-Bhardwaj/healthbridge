import { ValidationError } from './errors.js';

/**
 * Validates request parts with Zod schemas. Parsed (coerced, stripped) values are
 * exposed on `req.valid` — Express 5 makes `req.query` read-only, and handlers
 * should only ever consume validated input.
 *
 * @param {{ body?: import('zod').ZodType, query?: import('zod').ZodType, params?: import('zod').ZodType }} schemas
 */
export function validate(schemas) {
  return (req, _res, next) => {
    const valid = {};
    const errors = [];
    for (const part of ['params', 'query', 'body']) {
      const schema = schemas[part];
      if (!schema) continue;
      const result = schema.safeParse(req[part] ?? {});
      if (result.success) {
        valid[part] = result.data;
      } else {
        for (const issue of result.error.issues) {
          errors.push({ path: [part, ...issue.path].join('.'), message: issue.message });
        }
      }
    }
    if (errors.length) return next(new ValidationError(errors));
    req.valid = valid;
    next();
  };
}
