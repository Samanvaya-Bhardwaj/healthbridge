import { S3Client } from '@aws-sdk/client-s3';

/**
 * S3-compatible client (MinIO locally, S3 in production).
 * The storage adapter that issues signed URLs is built on this in the records milestone.
 * Without static keys the SDK's default credential chain is used (ECS task role on AWS).
 * @param {{ endpoint?: string, region: string, accessKeyId?: string, secretAccessKey?: string, forcePathStyle: boolean }} storage
 */
export function createS3Client(storage) {
  return new S3Client({
    region: storage.region,
    endpoint: storage.endpoint,
    forcePathStyle: storage.forcePathStyle,
    ...(storage.accessKeyId
      ? {
          credentials: {
            accessKeyId: storage.accessKeyId,
            secretAccessKey: storage.secretAccessKey,
          },
        }
      : {}),
    maxAttempts: 2,
  });
}
