// Integration tests against real PostgreSQL, Redis and MinIO.
// Prerequisites: `docker compose up -d --wait postgres redis minio`, then
// `npm run migrate:latest -w backend` and `npm run storage:bootstrap -w backend`.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import knexFactory from 'knex';
import { HeadBucketCommand, GetBucketVersioningCommand } from '@aws-sdk/client-s3';
import { loadConfig } from '../../src/config/index.js';
import { createKnex } from '../../src/core/db/knex.js';
import { createRedis } from '../../src/core/cache/redis.js';
import { createS3Client } from '../../src/core/storage/s3.js';

const envFile = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const env = {
  ...process.env,
  // The AI service is not needed here; satisfy config validation.
  AI_SERVICE_URL: process.env.AI_SERVICE_URL ?? 'http://localhost:8000',
};
const config = loadConfig(env);

let appDb;
let ownerDb;
let redis;
let s3;

beforeAll(async () => {
  appDb = createKnex(config.db, 'healthbridge-integration-test');
  // Imported after .env is loaded: knexfile validates its environment on import.
  const { migrationConfig } = await import('../../knexfile.js');
  ownerDb = knexFactory(migrationConfig(env));
  redis = createRedis(config.redis, 'healthbridge-integration-test');
  await redis.connect();
  s3 = createS3Client(config.storage);
});

afterAll(async () => {
  await Promise.allSettled([appDb?.destroy(), ownerDb?.destroy(), redis?.quit()]);
  s3?.destroy();
});

describe('PostgreSQL', () => {
  it('accepts connections from the least-privilege application role', async () => {
    const { rows } = await appDb.raw('select current_user as role');
    expect(rows[0].role).toBe(config.db.user);
  });

  it('application role is neither superuser nor able to bypass RLS', async () => {
    const { rows } = await appDb.raw(
      'select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb from pg_roles where rolname = current_user',
    );
    expect(rows[0]).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcreaterole: false,
      rolcreatedb: false,
    });
  });

  it('application role cannot create tables (schema changes go through migrations)', async () => {
    await expect(appDb.raw('create table public.should_fail (id int)')).rejects.toThrow(
      /permission denied/,
    );
  });

  it('has the required extensions installed', async () => {
    const { rows } = await ownerDb.raw('select extname from pg_extension');
    const names = rows.map((r) => r.extname);
    expect(names).toEqual(
      expect.arrayContaining(['pgcrypto', 'citext', 'btree_gist', 'pg_trgm', 'vector']),
    );
  });

  it('supports pgvector distance operators', async () => {
    const { rows } = await appDb.raw("select '[1,0,0]'::vector <=> '[0,1,0]'::vector as distance");
    expect(Number(rows[0].distance)).toBeCloseTo(1, 5);
  });

  it('has the ai and audit schemas', async () => {
    const { rows } = await ownerDb.raw(
      "select schema_name from information_schema.schemata where schema_name in ('ai','audit')",
    );
    expect(rows.map((r) => r.schema_name).sort()).toEqual(['ai', 'audit']);
  });

  it('grants the AI role no access to the core public schema', async () => {
    const aiRole = env.DB_AI_USER ?? 'hb_ai';
    const { rows } = await ownerDb.raw(
      "select has_schema_privilege(?, 'public', 'USAGE') as public_usage, has_schema_privilege(?, 'ai', 'USAGE') as ai_usage",
      [aiRole, aiRole],
    );
    expect(rows[0]).toEqual({ public_usage: false, ai_usage: true });
  });

  it('has no pending migrations', async () => {
    const [, pending] = await ownerDb.migrate.list();
    expect(pending).toEqual([]);
  });
});

describe('Redis', () => {
  it('responds to PING with authentication', async () => {
    expect(await redis.ping()).toBe('PONG');
  });
});

describe('Object storage', () => {
  it('has the documents bucket with versioning enabled', async () => {
    const bucket = config.storage.documentsBucket;
    await expect(s3.send(new HeadBucketCommand({ Bucket: bucket }))).resolves.toBeDefined();
    const versioning = await s3.send(new GetBucketVersioningCommand({ Bucket: bucket }));
    expect(versioning.Status).toBe('Enabled');
  });
});
