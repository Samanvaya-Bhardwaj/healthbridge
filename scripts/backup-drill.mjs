#!/usr/bin/env node
// Local backup + restore drill against the running development stack (ADR-0028):
// generates a throw-away age key pair, takes an encrypted backup into a temporary
// volume, restores it into a scratch database and requires an exact manifest match.
// Nothing is kept: the key, the volume and the scratch database are removed.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = parseEnv(readFileSync(join(root, '.env'), 'utf8'));
const keys = mkdtempSync(join(tmpdir(), 'hb-drill-'));
const volume = `hb-drill-${Date.now()}`;
const docker = (args, opts = {}) =>
  spawnSync('docker', args, {
    encoding: 'utf8',
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
    ...opts,
  });

let ok = false;
try {
  const gen = docker([
    'run',
    '--rm',
    '--entrypoint',
    'sh',
    '-v',
    `${keys}:/keys`,
    'healthbridge-backup:local',
    '-c',
    'age-keygen -o /keys/identity.txt 2>/dev/null; chmod 644 /keys/identity.txt; grep "public key" /keys/identity.txt',
  ]);
  const recipient = gen.stdout.trim().split(' ').pop();
  if (!recipient?.startsWith('age1')) throw new Error(`key generation failed: ${gen.stderr}`);

  const backupRun = (cmd) =>
    docker([
      'run',
      '--rm',
      '--network',
      'healthbridge_private',
      '-v',
      `${volume}:/backups`,
      '-v',
      `${join(keys, 'identity.txt')}:/run/secrets/backup-identity.txt:ro`,
      '-e',
      'PGHOST=postgres',
      '-e',
      `PGDATABASE=${env.POSTGRES_DB}`,
      '-e',
      `PGUSER=${env.POSTGRES_USER}`,
      '-e',
      `PGPASSWORD=${env.POSTGRES_PASSWORD}`,
      '-e',
      `S3_ACCESS_KEY_ID=${env.S3_ACCESS_KEY_ID}`,
      '-e',
      `S3_SECRET_ACCESS_KEY=${env.S3_SECRET_ACCESS_KEY}`,
      '-e',
      `S3_BUCKET_DOCUMENTS=${env.S3_BUCKET_DOCUMENTS}`,
      '-e',
      `BACKUP_AGE_RECIPIENT=${recipient}`,
      '-e',
      'BACKUP_OBJECTS_PASSWORD=local-drill-only',
      'healthbridge-backup:local',
      cmd,
    ]);

  const backup = backupRun('backup');
  process.stdout.write(
    backup.stdout
      .split('\n')
      .filter((l) => l.includes('backup complete'))
      .join('\n') + '\n',
  );
  if (backup.status !== 0) throw new Error(backup.stderr || 'backup failed');
  const drill = backupRun('drill');
  process.stdout.write(drill.stdout);
  if (drill.status !== 0) throw new Error(drill.stderr || 'drill failed');
  ok = JSON.parse(drill.stdout.trim().split('\n').pop()).manifestMatch === true;
} catch (err) {
  console.error(err.message);
} finally {
  docker(['volume', 'rm', '-f', volume]);
  rmSync(keys, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
