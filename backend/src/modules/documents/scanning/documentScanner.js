import net from 'node:net';

/**
 * DocumentScanner port (ADR-0021).
 *
 * @typedef {{ clean: true } | { clean: false, signature: string }} ScanResult
 * @typedef {{ name: string, scan: (buffer: Buffer) => Promise<ScanResult> }} DocumentScanner
 *
 * A scanner either returns a verdict or throws ScannerError. A thrown error NEVER means
 * "clean": the document stays non-available and the scan is retried.
 */

export class ScannerError extends Error {
  /** @param {'unavailable'|'timeout'|'protocol'} kind */
  constructor(kind, message) {
    super(message);
    this.name = 'ScannerError';
    this.kind = kind;
    this.retryable = true;
  }
}

/** Industry-standard harmless test string every anti-virus reports as infected. */
export const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
/** Marker that makes the fake scanner fail (tests the failure path). */
export const FAKE_SCANNER_FAILURE_MARKER = 'HB-FAKE-SCANNER-FAILURE';

/**
 * Deterministic scanner for development and tests. It provides NO malware protection:
 * it only recognises the EICAR test string (infected) and a failure marker (error).
 * Configuration refuses it in staging and production.
 * @returns {DocumentScanner & { failNext: (times?: number) => void, scans: number }}
 */
export function createFakeScanner() {
  let failures = 0;
  const scanner = {
    name: 'fake',
    scans: 0,
    failNext(times = 1) {
      failures += times;
    },
    async scan(buffer) {
      scanner.scans += 1;
      if (failures > 0) {
        failures -= 1;
        throw new ScannerError('unavailable', 'fake scanner failure (injected)');
      }
      const text = buffer.toString('latin1');
      if (text.includes(FAKE_SCANNER_FAILURE_MARKER)) {
        throw new ScannerError('unavailable', 'fake scanner failure (marker)');
      }
      if (text.includes(EICAR)) return { clean: false, signature: 'Eicar-Test-Signature' };
      return { clean: true };
    },
  };
  return scanner;
}

/**
 * ClamAV over clamd's INSTREAM protocol (TCP):
 *   "zINSTREAM\0", then chunks of [4-byte big-endian length][bytes], then a zero length;
 *   reply "stream: OK\0" | "stream: <signature> FOUND\0" | "... ERROR\0".
 * @param {{ host: string, port: number, timeoutMs?: number, chunkSize?: number }} options
 * @returns {DocumentScanner}
 */
export function createClamAvScanner({ host, port, timeoutMs = 30_000, chunkSize = 64 * 1024 }) {
  return {
    name: 'clamav',
    scan(buffer) {
      return new Promise((resolve, reject) => {
        const socket = net.createConnection({ host, port });
        const replies = [];
        let settled = false;
        const finish = (fn, value) => {
          if (settled) return;
          settled = true;
          socket.destroy();
          fn(value);
        };
        socket.setTimeout(timeoutMs, () =>
          finish(reject, new ScannerError('timeout', 'clamd timed out')),
        );
        socket.on('error', (err) =>
          finish(
            reject,
            new ScannerError('unavailable', `clamd unreachable: ${err.code ?? err.name}`),
          ),
        );
        socket.on('data', (data) => replies.push(data));
        socket.on('end', () => {
          const reply = Buffer.concat(replies).toString('utf8').replace(/\0/g, '').trim();
          if (/^stream: OK$/.test(reply)) return finish(resolve, { clean: true });
          const found = /^stream: (.+) FOUND$/.exec(reply);
          if (found) return finish(resolve, { clean: false, signature: found[1].slice(0, 120) });
          return finish(reject, new ScannerError('protocol', 'unexpected clamd reply'));
        });
        socket.on('connect', () => {
          socket.write('zINSTREAM\0');
          for (let offset = 0; offset < buffer.length; offset += chunkSize) {
            const chunk = buffer.subarray(offset, offset + chunkSize);
            const size = Buffer.alloc(4);
            size.writeUInt32BE(chunk.length);
            socket.write(size);
            socket.write(chunk);
          }
          socket.write(Buffer.alloc(4)); // end of stream
        });
      });
    },
  };
}

/** @param {ReturnType<typeof import('../../../config/index.js').loadConfig>['documents']} documents */
export function createDocumentScanner(documents) {
  return documents.scanner === 'clamav'
    ? createClamAvScanner({ host: documents.clamav.host, port: documents.clamav.port })
    : createFakeScanner();
}
