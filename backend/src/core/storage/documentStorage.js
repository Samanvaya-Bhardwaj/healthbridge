import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createS3Client } from './s3.js';

/** Storage failure in provider-neutral terms. */
export class StorageError extends Error {
  /** @param {'not_found'|'too_large'|'unavailable'} kind */
  constructor(kind, message) {
    super(message);
    this.name = 'StorageError';
    this.kind = kind;
    this.retryable = kind === 'unavailable';
  }
}

const isNotFound = (err) =>
  err?.$metadata?.httpStatusCode === 404 || ['NotFound', 'NoSuchKey'].includes(err?.name);

/** ASCII-only, quote-free filename for Content-Disposition. */
export function safeDownloadName(name) {
  const cleaned = String(name)
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/["\\;\r\n/]/g, '_')
    .trim()
    .slice(0, 120);
  return cleaned || 'document';
}

/**
 * DocumentStorage (ADR-0021): the only module that talks to S3/MinIO for medical
 * documents. Callers pass server-generated keys; nothing here derives a key from user
 * input. Browsers never receive credentials or permanent URLs — only short-lived,
 * single-purpose presigned requests issued after authorisation.
 *
 * Two clients: `internal` (the API/worker network endpoint) for operations, and
 * `presign` (the browser-facing endpoint) for signing. Signing is local computation.
 *
 * @param {ReturnType<typeof import('../../config/index.js').loadConfig>['storage']} storage
 */
export function createDocumentStorage(storage) {
  const bucket = storage.documentsBucket;
  const internal = createS3Client(storage);
  const presign = createS3Client({ ...storage, endpoint: storage.publicEndpoint });

  async function send(command) {
    try {
      return await internal.send(command);
    } catch (err) {
      if (isNotFound(err)) throw new StorageError('not_found', 'object not found');
      throw new StorageError('unavailable', `object storage error: ${err.name ?? 'unknown'}`);
    }
  }

  return {
    bucket,

    /**
     * Presigned POST to the quarantine key: the storage service itself enforces the exact
     * key, the content type and the maximum size.
     */
    async createUploadIntent({ key, contentType, maxBytes, ttlSeconds }) {
      const { url, fields } = await createPresignedPost(presign, {
        Bucket: bucket,
        Key: key,
        Conditions: [
          ['content-length-range', 1, maxBytes],
          ['eq', '$Content-Type', contentType],
        ],
        Fields: { 'Content-Type': contentType },
        Expires: ttlSeconds,
      });
      return { method: 'POST', url, fields, expiresAt: new Date(Date.now() + ttlSeconds * 1000) };
    },

    /** Size and stored type of an uploaded object, or null if it does not exist. */
    async statObject(key) {
      try {
        const head = await send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return { size: Number(head.ContentLength ?? 0), contentType: head.ContentType ?? null };
      } catch (err) {
        if (err.kind === 'not_found') return null;
        throw err;
      }
    },

    /** Reads a whole object (bounded) for scanning and validation. */
    async readObject(key, maxBytes) {
      const res = await send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const chunks = [];
      let total = 0;
      for await (const chunk of res.Body) {
        total += chunk.length;
        if (total > maxBytes) {
          res.Body.destroy?.();
          throw new StorageError('too_large', 'object exceeds the maximum size');
        }
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    },

    /** Promotion copy (quarantine → records). Idempotent: same source, same target. */
    async copyObject(fromKey, toKey) {
      await send(
        new CopyObjectCommand({
          Bucket: bucket,
          Key: toKey,
          CopySource: `${bucket}/${fromKey}`,
        }),
      );
    },

    /** Short-lived download URL. Authorisation happens before this is called. */
    async getDownloadUrl(key, { filename, contentType, ttlSeconds }) {
      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ResponseContentDisposition: `attachment; filename="${safeDownloadName(filename)}"`,
        ResponseContentType: contentType,
        ResponseCacheControl: 'no-store',
      });
      const url = await getSignedUrl(presign, command, { expiresIn: ttlSeconds });
      return { url, expiresAt: new Date(Date.now() + ttlSeconds * 1000) };
    },

    /** Removes an object (quarantine cleanup, infected files). Missing is fine. */
    async removeObject(key) {
      try {
        await send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      } catch (err) {
        if (err.kind !== 'not_found') throw err;
      }
    },

    destroy() {
      internal.destroy();
      presign.destroy();
    },
  };
}
