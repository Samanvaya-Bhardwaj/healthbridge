import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuditSealer, sealKeyring } from '../../src/modules/audit/sealing.js';
import { createHarness } from './harness.js';
import { api, createPatient, createPlatformAdmin, expectOk } from './m2fixtures.js';

/**
 * Step 9: the tamper-evident audit log (ADR-0035). Seals are global, append-only state
 * shared by every run against this database, so each check verifies only the seals this
 * run wrote, and every deliberate tampering below is undone before the test ends.
 */
let h;
let sealer;
beforeAll(async () => {
  h = await createHarness();
  // No lag: in a test nothing else is writing, so "settled" can mean "committed".
  sealer = createAuditSealer({
    knex: h.knex,
    keyring: sealKeyring(h.config.clinicalData),
    lagMs: 0,
  });
});
afterAll(async () => {
  await h.close();
});

const sealCount = async () =>
  Number((await h.ownerKnex('audit.audit_seals').count({ n: '*' }).first()).n);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Seals until the range holding the row is sealed; returns that seal. */
async function sealPast(row) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await sealer.sealDue({ maxSeals: 100 });
    const seal = await h
      .ownerKnex('audit.audit_seals')
      .whereRaw('sealed_from <= ?::timestamptz AND sealed_to > ?::timestamptz', [
        row.occurred_text,
        row.occurred_text,
      ])
      .first();
    if (seal) return seal;
    await pause(5); // the seal bound is whole milliseconds, behind the newest row
  }
  throw new Error('range was not sealed');
}

/** Verifies this run's seals only (from `firstSeq` on). */
const verifyFrom = async (firstSeq) =>
  sealer.verify({ latest: (await sealCount()) - Number(firstSeq) + 1 });

/** Runs `fn` with one append-only trigger switched off (owner only), always restoring it. */
async function withoutTrigger(table, trigger, fn) {
  await h.ownerKnex.raw(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
  try {
    return await fn();
  } finally {
    await h.ownerKnex.raw(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
  }
}

/** The newest audit row of a user, with its timestamp at full precision. */
async function latestRowOf(userId) {
  return (
    await h.ownerKnex.raw(
      `SELECT id, occurred_at, occurred_at::text AS occurred_text, reason
         FROM audit.audit_logs WHERE actor_user_id = ? ORDER BY occurred_at DESC LIMIT 1`,
      [userId],
    )
  ).rows[0];
}

describe('audit seals (step 9)', () => {
  it('seal settled ranges into a contiguous keyed chain that verifies', async () => {
    const patient = await createPatient(h, 'seal-p1');
    const row = await latestRowOf(patient.id);
    const seal = await sealPast(row);

    const result = await verifyFrom(seal.seq);
    expect(result).toMatchObject({ status: 'verified', failure: null });
    expect(result.checked).toBeGreaterThanOrEqual(1);
    expect(result.sealedThrough.getTime()).toBeGreaterThan(row.occurred_at.getTime());

    // Contiguous: each seal starts exactly where the one before it ended.
    const recent = await h
      .ownerKnex('audit.audit_seals')
      .where('seq', '>=', Math.max(1, Number(seal.seq) - 1))
      .orderBy('seq');
    for (let i = 1; i < recent.length; i += 1) {
      expect(recent[i].sealed_from.getTime()).toBe(recent[i - 1].sealed_to.getTime());
    }
    // Nothing new: no empty seal until the hourly heartbeat is due.
    await pause(5);
    expect((await sealer.sealDue()).sealed).toBe(0);
  });

  it('detect a changed, deleted or back-dated entry and an altered seal, and pass once undone', async () => {
    const patient = await createPatient(h, 'seal-p2');
    const row = await latestRowOf(patient.id);
    const seal = await sealPast(row);
    const expectFailure = async (problem) => {
      const result = await verifyFrom(seal.seq);
      expect(result.status).toBe('failed');
      expect(result.failure).toMatchObject({ seq: Number(seal.seq), problem });
      return result.failure;
    };

    await withoutTrigger('audit.audit_logs', 'audit_logs_no_update_delete', async () => {
      // Changed.
      await h.ownerKnex('audit.audit_logs').where({ id: row.id }).update({ reason: 'edited' });
      await expectFailure('rows_changed');
      await h.ownerKnex('audit.audit_logs').where({ id: row.id }).update({ reason: row.reason });
      expect((await verifyFrom(seal.seq)).status).toBe('verified');

      // Deleted (and put back exactly, microseconds included).
      const saved = (
        await h.ownerKnex.raw(
          `SELECT row_to_json(a)::text AS j FROM audit.audit_logs a WHERE id = ?`,
          [row.id],
        )
      ).rows[0].j;
      await h.ownerKnex('audit.audit_logs').where({ id: row.id }).del();
      const deleted = await expectFailure('rows_changed');
      expect(deleted.rowsNow).toBe(deleted.rowsSealed - 1);
      await h.ownerKnex.raw(
        `INSERT INTO audit.audit_logs SELECT * FROM json_populate_record(NULL::audit.audit_logs, ?::json)`,
        [saved],
      );
      expect((await verifyFrom(seal.seq)).status).toBe('verified');

      // Back-dated into the sealed range.
      const forgedId = randomUUID();
      await h.ownerKnex.raw(
        `INSERT INTO audit.audit_logs (id, occurred_at, category, action, outcome, actor_type)
         VALUES (?, ?::timestamptz, 'data_access', 'record.viewed', 'success', 'system')`,
        [forgedId, row.occurred_text],
      );
      const added = await expectFailure('rows_changed');
      expect(added.rowsNow).toBe(added.rowsSealed + 1);
      await h.ownerKnex('audit.audit_logs').where({ id: forgedId }).del();
      expect((await verifyFrom(seal.seq)).status).toBe('verified');
    });

    // A seal rewritten to match changed rows breaks the keyed chain.
    await withoutTrigger('audit.audit_seals', 'audit_seals_no_update_delete', async () => {
      await h
        .ownerKnex('audit.audit_seals')
        .where({ seq: seal.seq })
        .update({ rows_sha256: 'f'.repeat(64) });
      await expectFailure('seal_altered');
      await h
        .ownerKnex('audit.audit_seals')
        .where({ seq: seal.seq })
        .update({ rows_sha256: seal.rows_sha256 });
    });
    expect((await verifyFrom(seal.seq)).status).toBe('verified');
  });

  it('are append-only and contiguous, even for the database owner', async () => {
    await createPatient(h, 'seal-p3');
    await sealer.sealDue();
    const last = await h.ownerKnex('audit.audit_seals').orderBy('seq', 'desc').first();
    // The application role may only read and append.
    await expect(
      h.knex('audit.audit_seals').where({ seq: last.seq }).update({ row_count: 0 }),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(h.knex('audit.audit_seals').where({ seq: last.seq }).del()).rejects.toMatchObject({
      code: '42501',
    });
    // A seal that does not continue the chain is refused.
    await expect(
      h.knex('audit.audit_seals').insert({
        seq: Number(last.seq) + 1,
        sealed_from: new Date(0),
        sealed_to: new Date(),
        row_count: 0,
        rows_sha256: '0'.repeat(64),
        chain_hmac: '0'.repeat(64),
        key_id: 'k1',
      }),
    ).rejects.toMatchObject({ code: '23514' });
    // The owner is stopped by the trigger.
    await expect(
      h.ownerKnex('audit.audit_seals').where({ seq: last.seq }).update({ row_count: 0 }),
    ).rejects.toThrow(/append-only/);
  });

  it('concurrent sealers write a single chain', async () => {
    for (const label of ['seal-c1', 'seal-c2']) await createPatient(h, label);
    const firstSeq = (await sealCount()) + 1;
    await pause(5);
    const runs = await Promise.all([sealer.sealDue(), sealer.sealDue(), sealer.sealDue()]);
    expect(runs.reduce((n, r) => n + r.sealed, 0)).toBeGreaterThanOrEqual(1);
    expect(await verifyFrom(firstSeq)).toMatchObject({ status: 'verified' });
  });

  it('report a seal whose key is no longer configured', async () => {
    await createPatient(h, 'seal-p4');
    await sealer.sealDue();
    const blind = createAuditSealer({
      knex: h.knex,
      keyring: { currentKeyId: 'k1', key: () => null },
      lagMs: 0,
    });
    const result = await blind.verify({ latest: 1 });
    expect(result).toMatchObject({ status: 'failed', failure: { problem: 'key_unavailable' } });
  });

  it('platform administrators can check integrity; the check is audited; others are refused', async () => {
    const admin = await createPlatformAdmin(h, 'seal-admin');
    const patient = await createPatient(h, 'seal-p5');
    await sealer.sealDue();
    const data = expectOk(await api(h, admin).get('/admin/audit-integrity'));
    expect(data).toMatchObject({ status: 'verified', failure: null });
    expect(data.checked).toBeGreaterThanOrEqual(1);
    expect(typeof data.unsealedEntries).toBe('number');
    expect((await api(h, patient).get('/admin/audit-integrity')).status).toBe(403);
    const checked = await h
      .ownerKnex('audit.audit_logs')
      .where({ action: 'audit.integrity_checked', actor_user_id: admin.id });
    expect(checked).toHaveLength(1);
    expect(checked[0].outcome).toBe('success');
  });
});
