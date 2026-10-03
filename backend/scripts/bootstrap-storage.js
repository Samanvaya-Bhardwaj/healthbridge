#!/usr/bin/env node
// Creates the documents bucket with versioning for MinIO: local/CI environments, and the
// self-hosted single-host deployment (infra/deploy/compose.prod.yml sets
// STORAGE_BOOTSTRAP=self-hosted). On AWS, buckets, encryption (SSE-KMS), versioning and
// lifecycle policies are provisioned by infrastructure-as-code, never by the application.

import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketVersioningCommand,
  S3Client,
} from '@aws-sdk/client-s3';

const env = process.env;
const log = (msg, extra = {}) =>
  console.log(
    JSON.stringify({ level: 'info', service: 'healthbridge-storage-bootstrap', msg, ...extra }),
  );

const selfHosted = env.STORAGE_BOOTSTRAP === 'self-hosted' && Boolean(env.S3_ENDPOINT);
if (['staging', 'production'].includes(env.APP_ENV) && !selfHosted) {
  console.error('Refusing to bootstrap storage in staging/production; use infrastructure-as-code.');
  process.exit(1);
}

const bucket = env.S3_BUCKET_DOCUMENTS;
const client = new S3Client({
  region: env.S3_REGION,
  endpoint: env.S3_ENDPOINT,
  forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true',
  credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
});

async function bucketExists() {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    return true;
  } catch (err) {
    if (err.$metadata?.httpStatusCode === 404 || err.name === 'NotFound') return false;
    throw err;
  }
}

async function main() {
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      if (!(await bucketExists())) {
        await client.send(new CreateBucketCommand({ Bucket: bucket }));
        log('bucket created', { bucket });
      } else {
        log('bucket exists', { bucket });
      }
      // Versioning protects original medical documents against overwrite/deletion.
      await client.send(
        new PutBucketVersioningCommand({
          Bucket: bucket,
          VersioningConfiguration: { Status: 'Enabled' },
        }),
      );
      log('versioning enabled', { bucket });
      return;
    } catch (err) {
      if (attempt === 30) throw err;
      log('storage not ready, retrying', { attempt, error: err.name });
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}

main()
  .catch((err) => {
    console.error(
      JSON.stringify({ level: 'fatal', msg: 'storage bootstrap failed', error: err.message }),
    );
    process.exitCode = 1;
  })
  .finally(() => client.destroy());
