import { Redis } from 'ioredis';

/**
 * General-purpose Redis connection (rate limiting, cache, health).
 * BullMQ creates its own connections with queue-specific options.
 * @param {{ host: string, port: number, password: string }} redis
 */
export function createRedis(redis, connectionName = 'healthbridge-api') {
  return new Redis({
    host: redis.host,
    port: redis.port,
    password: redis.password,
    // ElastiCache / managed Redis with in-transit encryption (ADR-0028).
    ...(redis.tls ? { tls: { servername: redis.host } } : {}),
    connectionName,
    lazyConnect: true,
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
  });
}
