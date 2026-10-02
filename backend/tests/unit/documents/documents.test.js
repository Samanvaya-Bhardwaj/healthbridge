import net from 'node:net';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { grantConsentSchema, uploadIntentSchema } from '@healthbridge/shared';
import {
  detectContentType,
  validateDocumentContent,
} from '../../../src/modules/documents/fileValidation.js';
import {
  EICAR,
  ScannerError,
  createClamAvScanner,
  createFakeScanner,
} from '../../../src/modules/documents/scanning/documentScanner.js';
import { objectKeys } from '../../../src/modules/documents/service.js';
import { safeDownloadName } from '../../../src/core/storage/documentStorage.js';
import { renderTemplate } from '../../../src/modules/notifications/templates.js';
import { templateForEvent } from '../../../src/modules/notifications/notificationService.js';
import { EVENT_ROUTES } from '../../../src/core/queue/routing.js';
import { ConfigError, loadConfig } from '../../../src/config/index.js';
import { validEnv } from '../../helpers.js';

const PDF = Buffer.from('%PDF-1.7\nsynthetic\n%%EOF');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const sha = (b) => createHash('sha256').update(b).digest('hex');

describe('file validation (magic bytes, never the browser MIME type)', () => {
  it('detects only allowlisted signatures', () => {
    expect(detectContentType(PDF)).toBe('application/pdf');
    expect(detectContentType(PNG)).toBe('image/png');
    expect(detectContentType(JPEG)).toBe('image/jpeg');
    expect(detectContentType(Buffer.from('<html><script>'))).toBeNull();
    expect(detectContentType(Buffer.from('MZ\x90\x00'))).toBeNull(); // Windows executable
  });

  it('checks size, checksum, signature and extension together', () => {
    const base = {
      buffer: PDF,
      declaredContentType: 'application/pdf',
      declaredSize: PDF.length,
      declaredSha256: sha(PDF),
      filename: 'report.pdf',
      maxBytes: 1024,
    };
    expect(validateDocumentContent(base)).toMatchObject({
      ok: true,
      detectedContentType: 'application/pdf',
    });
    expect(validateDocumentContent({ ...base, maxBytes: 4 }).reason).toBe('size_exceeded');
    expect(validateDocumentContent({ ...base, declaredSize: 3 }).reason).toBe('size_mismatch');
    expect(validateDocumentContent({ ...base, declaredSha256: '0'.repeat(64) }).reason).toBe(
      'checksum_mismatch',
    );
    expect(
      validateDocumentContent({
        ...base,
        buffer: PNG,
        declaredSize: PNG.length,
        declaredSha256: sha(PNG),
      }).reason,
    ).toBe('type_mismatch');
    expect(validateDocumentContent({ ...base, filename: 'report.jpg' }).reason).toBe(
      'type_mismatch',
    );
    const html = Buffer.from('<html></html>');
    expect(
      validateDocumentContent({
        ...base,
        buffer: html,
        declaredSize: html.length,
        declaredSha256: sha(html),
      }).reason,
    ).toBe('unsupported_content');
  });
});

describe('upload and consent schemas', () => {
  const ok = {
    documentType: 'lab_report',
    title: 'Blood test',
    filename: 'blood.pdf',
    contentType: 'application/pdf',
    sizeBytes: 100,
    sha256: 'a'.repeat(64),
  };
  it('allowlist, extension match, no path separators or control characters', () => {
    expect(uploadIntentSchema.safeParse(ok).success).toBe(true);
    for (const bad of [
      { contentType: 'image/svg+xml', filename: 'x.svg' },
      { contentType: 'application/pdf', filename: 'x.exe' },
      { filename: '../../etc/passwd.pdf' },
      { filename: 'a\\b.pdf' },
      { title: 'line\nbreak' },
      { sha256: 'XYZ' },
      { sizeBytes: 30 * 1024 * 1024 },
    ]) {
      expect(uploadIntentSchema.safeParse({ ...ok, ...bad }).success).toBe(false);
    }
  });
  it('consent: explicit scopes, manual needs expiry, appointment needs an appointment', () => {
    const base = {
      patientId: '0192a6b0-0000-7000-8000-000000000001',
      doctorId: '0192a6b0-0000-7000-8000-000000000002',
      kind: 'manual',
      scopes: ['medical_documents'],
      purpose: 'ongoing_care',
      expiresInDays: 30,
    };
    expect(grantConsentSchema.safeParse(base).success).toBe(true);
    expect(grantConsentSchema.safeParse({ ...base, scopes: [] }).success).toBe(false);
    expect(grantConsentSchema.safeParse({ ...base, scopes: ['everything'] }).success).toBe(false);
    expect(grantConsentSchema.safeParse({ ...base, expiresInDays: undefined }).success).toBe(false);
    expect(grantConsentSchema.safeParse({ ...base, expiresInDays: 400 }).success).toBe(false);
    expect(grantConsentSchema.safeParse({ ...base, kind: 'appointment' }).success).toBe(false);
    expect(
      grantConsentSchema.safeParse({
        ...base,
        appointmentId: '0192a6b0-0000-7000-8000-000000000003',
      }).success,
    ).toBe(false);
  });
});

describe('object keys and download names', () => {
  it('keys are random, bound to patient and document, free of user input', () => {
    const a = objectKeys('p-1', 'd-1');
    const b = objectKeys('p-1', 'd-1');
    expect(a.quarantineKey).toMatch(/^quarantine\/patients\/p-1\/documents\/d-1\/[0-9a-f]{32}$/);
    expect(a.storageKey).toMatch(/^records\/patients\/p-1\/documents\/d-1\/[0-9a-f]{32}$/);
    expect(a.quarantineKey).not.toBe(b.quarantineKey);
  });
  it('download filenames cannot inject headers or paths', () => {
    expect(safeDownloadName('report "x";\r\nSet-Cookie: a=b.pdf')).not.toMatch(/["\r\n;]/);
    expect(safeDownloadName('../../x.pdf')).not.toContain('/');
    expect(safeDownloadName('रिपोर्ट.pdf')).toBe('.pdf');
    expect(safeDownloadName('')).toBe('document');
  });
});

describe('scanners', () => {
  it('fake: clean, infected (EICAR) and failure — and it says it is not protection', async () => {
    const scanner = createFakeScanner();
    expect(scanner.name).toBe('fake');
    expect(await scanner.scan(PDF)).toEqual({ clean: true });
    expect(await scanner.scan(Buffer.from(`%PDF-${EICAR}`))).toEqual({
      clean: false,
      signature: 'Eicar-Test-Signature',
    });
    await expect(scanner.scan(Buffer.from('HB-FAKE-SCANNER-FAILURE'))).rejects.toBeInstanceOf(
      ScannerError,
    );
    scanner.failNext();
    await expect(scanner.scan(PDF)).rejects.toMatchObject({ kind: 'unavailable' });
  });

  describe('ClamAV INSTREAM adapter (against a local fake clamd)', () => {
    let server;
    afterEach(() => server?.close());
    const fakeClamd = (reply, { hang = false } = {}) =>
      new Promise((resolve) => {
        server = net.createServer((socket) => {
          let received = Buffer.alloc(0);
          socket.on('data', (d) => {
            received = Buffer.concat([received, d]);
            // Terminating zero-length chunk received → answer.
            if (!hang && received.subarray(-4).equals(Buffer.alloc(4))) {
              socket.end(reply(received));
            }
          });
        });
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
      });

    it('sends the INSTREAM framing and maps OK / FOUND / errors', async () => {
      let seen;
      const port = await fakeClamd((received) => {
        seen = received;
        return 'stream: OK\0';
      });
      const scanner = createClamAvScanner({ host: '127.0.0.1', port, chunkSize: 4 });
      expect(await scanner.scan(PDF)).toEqual({ clean: true });
      expect(seen.subarray(0, 10).toString()).toBe('zINSTREAM\0');
      expect(seen.readUInt32BE(10)).toBe(4); // first chunk length
      server.close();

      const infected = await fakeClamd(() => 'stream: Eicar-Signature FOUND\0');
      expect(await createClamAvScanner({ host: '127.0.0.1', port: infected }).scan(PDF)).toEqual({
        clean: false,
        signature: 'Eicar-Signature',
      });
      server.close();

      const garbage = await fakeClamd(() => 'INSTREAM size limit exceeded. ERROR\0');
      await expect(
        createClamAvScanner({ host: '127.0.0.1', port: garbage }).scan(PDF),
      ).rejects.toMatchObject({
        kind: 'protocol',
      });
    });

    it('unreachable or silent clamd is a failure, never "clean"', async () => {
      await expect(
        createClamAvScanner({ host: '127.0.0.1', port: 1 }).scan(PDF),
      ).rejects.toMatchObject({
        kind: 'unavailable',
      });
      const port = await fakeClamd(() => '', { hang: true });
      await expect(
        createClamAvScanner({ host: '127.0.0.1', port, timeoutMs: 200 }).scan(PDF),
      ).rejects.toMatchObject({ kind: 'timeout' });
    });
  });
});

describe('configuration', () => {
  const issues = (env) => {
    try {
      loadConfig({ ...validEnv, ...env });
      return [];
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      return err.issues.map((i) => i.variable);
    }
  };
  it('the fake scanner is refused outside development/test; clamav needs a host', () => {
    expect(issues({ APP_ENV: 'staging', AUTH_COOKIE_SECURE: 'true' })).toContain(
      'DOCUMENT_SCANNER',
    );
    expect(issues({ DOCUMENT_SCANNER: 'clamav' })).toContain('CLAMAV_HOST');
    expect(issues({ DOCUMENT_DOWNLOAD_URL_TTL_SECONDS: '3600' })).toContain(
      'DOCUMENT_DOWNLOAD_URL_TTL_SECONDS',
    );
    const config = loadConfig(validEnv);
    expect(config.documents).toMatchObject({
      scanner: 'fake',
      downloadUrlTtlSeconds: 60,
      maxBytes: 10 * 1024 * 1024,
    });
    expect(config.storage.publicEndpoint).toBe(validEnv.S3_ENDPOINT);
  });
});

describe('document notifications', () => {
  it('routes document events and never names the document', () => {
    expect(EVENT_ROUTES['document.uploaded']).toEqual(['documents']);
    expect(templateForEvent('document.available', {})).toBe('document_available');
    const out = renderTemplate('document_available', {
      recipientName: 'Asha',
      patientName: 'Kabir',
      relationship: 'guardian',
      title: 'HIV test result',
    });
    expect(out.text).toContain("Kabir's health record");
    expect(out.text).not.toMatch(/HIV/);
  });
});
