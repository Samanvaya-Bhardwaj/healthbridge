import { DOCUMENT_CONTENT_TYPES } from '@healthbridge/shared';

export const DOCUMENT_TYPE_LABELS = {
  lab_report: 'Lab report',
  prescription: 'Prescription',
  imaging: 'Imaging',
  discharge_summary: 'Discharge summary',
  other: 'Other',
};

/** What each document state means, in the words a patient would use. */
export const STATUS_HINTS = {
  pending_upload:
    'Uploading… If the upload was interrupted, upload the file again: unfinished uploads are cleared automatically.',
  quarantined: 'Processing: checking the file for safety. This usually takes under a minute.',
  scanning: 'Processing: checking the file for safety. This usually takes under a minute.',
  available: 'Secure: passed the safety check.',
  rejected: 'Rejected',
  retired: 'Removed',
};

export const REJECTION_LABELS = {
  infected: 'The file failed the safety scan.',
  unsupported_content: 'This file type is not supported.',
  type_mismatch: 'The file’s content does not match its type.',
  size_exceeded: 'The file is too large.',
  size_mismatch: 'The upload was incomplete.',
  checksum_mismatch: 'The file changed during upload. Please try again.',
  upload_missing: 'The upload did not arrive. Please try again.',
  upload_expired: 'The upload was not finished in time.',
};

export const ACCEPT = Object.entries(DOCUMENT_CONTENT_TYPES)
  .flatMap(([type, exts]) => [type, ...exts.map((e) => `.${e}`)])
  .join(',');

/** Content type from the extension (the server re-checks the file's actual bytes). */
export function contentTypeFor(filename) {
  const ext = /\.([A-Za-z0-9]+)$/.exec(filename)?.[1]?.toLowerCase();
  return Object.entries(DOCUMENT_CONTENT_TYPES).find(([, exts]) => exts.includes(ext))?.[0] ?? null;
}

export async function sha256Hex(file) {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const formatBytes = (n) =>
  n >= 1024 * 1024
    ? `${(n / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(n / 1024))} KB`;

/**
 * Sends the file to object storage with the presigned POST from the upload intent.
 * XMLHttpRequest (not fetch) because it reports upload progress.
 * @param {{ url: string, fields: Record<string, string> }} upload
 */
export function postToStorage(upload, file, onProgress) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    for (const [key, value] of Object.entries(upload.fields)) form.append(key, value);
    form.append('file', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', upload.url);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error('The upload was refused by storage. Check the file and try again.'));
    xhr.onerror = () =>
      reject(new Error('The upload failed. Check your connection and try again.'));
    xhr.send(form);
  });
}
