import { RateLimiterMemory, RateLimiterRedis } from 'rate-limiter-flexible';
import { RateLimitedError } from './errors.js';

/**
 * Redis-backed rate limiter. If Redis is unavailable it degrades to a per-process
 * in-memory limiter instead of failing open or blocking all traffic.
 *
 * @param {{ redis?: import('ioredis').Redis, keyPrefix: string, points: number, durationSeconds: number, key?: (req: import('express').Request) => string }} options
 */
export function rateLimit({ redis, keyPrefix, points, durationSeconds, key = (req) => req.ip }) {
  const insurance = new RateLimiterMemory({ keyPrefix, points, duration: durationSeconds });
  const limiter = redis
    ? new RateLimiterRedis({
        storeClient: redis,
        keyPrefix: `rl:${keyPrefix}`,
        points,
        duration: durationSeconds,
        insuranceLimiter: insurance,
      })
    : insurance;

  return async (req, res, next) => {
    try {
      const result = await limiter.consume(key(req));
      res.setHeader('RateLimit-Limit', String(points));
      res.setHeader('RateLimit-Remaining', String(result.remainingPoints));
      next();
    } catch (rejection) {
      if (rejection instanceof Error) return next(rejection);
      next(new RateLimitedError(Math.max(1, Math.ceil(rejection.msBeforeNext / 1000))));
    }
  };
}
