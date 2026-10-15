import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { domainMetrics } from '../../core/metrics/domain.js';

/**
 * Step 9: tamper-evident audit log (ADR-0035).
 *
 * The sealer covers consecutive time ranges of `audit.audit_logs` with a keyed hash chain
 * in `audit.audit_seals`. A range is sealed only once it is older than `lagMs`, longer than
 * any transaction can stay open (statement and idle-in-transaction timeouts are 15 s and
 * 30 s), so no row can still commit into it. Verification recomputes every seal from the
 * rows as they are now.
 *
 * Timestamps of seal bounds are whole milliseconds, so JavaScript dates carry them
 * exactly; row timestamps are hashed at full (microsecond) precision as UTC text.
 */

export const SEAL_ORIGIN = new Date(0);
const PAGE = 5_000;

// Columns in hashing order. Text forms are canonical: UTC microsecond timestamps,
// PostgreSQL's own text output for uuid, inet, text[] and jsonb (jsonb normalises keys).
const ROW_COLUMNS = `
  id::text AS id,
  to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at,
  category, action, outcome, actor_type,
  actor_user_id::text AS actor_user_id, actor_roles::text AS actor_roles,
  session_id::text AS session_id, resource_type, resource_id,
  patient_id::text AS patient_id, reason, request_id, ip::text AS ip, user_agent,
  metadata::text AS metadata`;
const ROW_KEYS = [
  'id',
  'occurred_at',
  'category',
  'action',
  'outcome',
  'actor_type',
  'actor_user_id',
  'actor_roles',
  'session_id',
  'resource_type',
  'resource_id',
  'patient_id',
  'reason',
  'request_id',
  'ip',
  'user_agent',
  'metadata',
];

/** The seal key for a key ID, derived from the clinical data key ring (never stored). */
export function sealKeyring(clinicalData) {
  return {
    currentKeyId: clinicalData.currentKeyId,
    key(keyId) {
      const kek = clinicalData.keys.get(keyId);
      if (!kek) return null;
      return Buffer.from(hkdfSync('sha256', kek, 'healthbridge', 'audit-log-seal', 32));
    },
  };
}

const chainInput = ({ previous, seq, from, to, rowCount, rowsSha256 }) =>
  [
    previous ?? '',
    String(seq),
    from.toISOString(),
    to.toISOString(),
    String(rowCount),
    rowsSha256,
  ].join('|');

/** SHA-256 over the rows of [from, to) in (occurred_at, id) order, and how many there are. */
async function digestRange(db, from, to) {
  const hash = createHash('sha256');
  let count = 0;
  let after = null;
  for (;;) {
    const rows = (
      await db.raw(
        `SELECT ${ROW_COLUMNS} FROM audit.audit_logs
          WHERE occurred_at >= ? AND occurred_at < ?
            ${after ? 'AND (occurred_at, id) > (?::timestamptz, ?::uuid)' : ''}
          ORDER BY occurred_at, id
          LIMIT ${PAGE}`,
        after ? [from, to, after.occurred_at, after.id] : [from, to],
      )
    ).rows;
    for (const row of rows) hash.update(`${JSON.stringify(ROW_KEYS.map((k) => row[k]))}\n`);
    count += rows.length;
    if (rows.length < PAGE) break;
    after = rows.at(-1);
  }
  return { rowCount: count, rowsSha256: hash.digest('hex') };
}

const equalHex = (a, b) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));

/**
 * @param {{ knex: import('knex').Knex, keyring: ReturnType<typeof sealKeyring>,
 *   logger?: import('pino').Logger, lagMs?: number, maxRowsPerSeal?: number,
 *   heartbeatMs?: number }} deps
 */
export function createAuditSealer({
  knex,
  keyring,
  logger,
  lagMs = 10 * 60_000,
  maxRowsPerSeal = 20_000,
  heartbeatMs = 60 * 60_000,
}) {
  const hmac = (keyId, input) => {
    const key = keyring.key(keyId);
    return key ? createHmac('sha256', key).update(input).digest('hex') : null;
  };

  /** Seals one more range, or returns null when nothing is due yet. */
  async function sealNext() {
    return knex.transaction(async (trx) => {
      // One sealer at a time across all workers; the others wait, then find less to do.
      await trx.raw(`SELECT pg_advisory_xact_lock(hashtext('audit.audit_seals'))`);
      const last = await trx('audit.audit_seals').orderBy('seq', 'desc').first();
      const from = last ? last.sealed_to : SEAL_ORIGIN;
      const { cutoff } = (
        await trx.raw(
          `SELECT date_trunc('milliseconds', now() - (? * interval '1 millisecond')) AS cutoff`,
          [lagMs],
        )
      ).rows[0];
      if (cutoff <= from) return null;

      // Large backlogs are sealed in pieces of about maxRowsPerSeal rows.
      let to = cutoff;
      const overflow = (
        await trx.raw(
          `SELECT date_trunc('milliseconds', occurred_at) AS t FROM audit.audit_logs
            WHERE occurred_at >= ? AND occurred_at < ?
            ORDER BY occurred_at, id OFFSET ? LIMIT 1`,
          [from, cutoff, maxRowsPerSeal],
        )
      ).rows[0];
      if (overflow && overflow.t > from) to = overflow.t;

      const { rowCount, rowsSha256 } = await digestRange(trx, from, to);
      // Nothing new: wait for rows, but seal at least hourly so the chain stays current.
      if (rowCount === 0 && last && to - from < heartbeatMs) return null;

      const seq = (last ? Number(last.seq) : 0) + 1;
      const keyId = keyring.currentKeyId;
      const chain = hmac(
        keyId,
        chainInput({ previous: last?.chain_hmac, seq, from, to, rowCount, rowsSha256 }),
      );
      await trx('audit.audit_seals').insert({
        seq,
        sealed_from: from,
        sealed_to: to,
        row_count: rowCount,
        rows_sha256: rowsSha256,
        chain_hmac: chain,
        key_id: keyId,
      });
      return { seq, from, to, rowCount, chain, more: to < cutoff };
    });
  }

  /**
   * Seals every range that is due (bounded per run). The chain value of each new seal is
   * also logged, so a copy of the chain lives outside the database.
   */
  async function sealDue({ maxSeals = 20 } = {}) {
    const sealed = [];
    while (sealed.length < maxSeals) {
      const seal = await sealNext();
      if (!seal) break;
      sealed.push(seal);
      domainMetrics.auditSealsWritten.inc();
      logger?.info(
        {
          auditSeal: {
            seq: seal.seq,
            to: seal.to.toISOString(),
            rows: seal.rowCount,
            chain: seal.chain,
          },
        },
        'audit range sealed',
      );
      if (!seal.more) break;
    }
    return { sealed: sealed.length, through: sealed.at(-1)?.to ?? null };
  }

  /**
   * Recomputes seals in order and reports the first one that no longer matches.
   * `latest` limits the check to the most recent seals (the admin view); the verify
   * command checks the whole chain.
   */
  async function verify({ latest } = {}) {
    const total = Number((await knex('audit.audit_seals').count({ n: '*' }).first()).n);
    const startSeq = latest ? Math.max(1, total - latest + 1) : 1;
    let previous =
      startSeq > 1
        ? await knex('audit.audit_seals')
            .where({ seq: startSeq - 1 })
            .first()
        : null;
    let checked = 0;
    let failure = null;
    let lastSeal = previous;
    for (let seq = startSeq; seq <= total && !failure; seq += 200) {
      const seals = await knex('audit.audit_seals')
        .where('seq', '>=', seq)
        .andWhere('seq', '<', seq + 200)
        .orderBy('seq');
      for (const seal of seals) {
        const expectedFrom = previous ? previous.sealed_to : SEAL_ORIGIN;
        const expectedSeq = previous ? Number(previous.seq) + 1 : 1;
        const at = { seq: Number(seal.seq), from: seal.sealed_from, to: seal.sealed_to };
        if (
          Number(seal.seq) !== expectedSeq ||
          seal.sealed_from.getTime() !== expectedFrom.getTime()
        ) {
          failure = { ...at, problem: 'seal_missing' };
          break;
        }
        const { rowCount, rowsSha256 } = await digestRange(knex, seal.sealed_from, seal.sealed_to);
        const expected = hmac(
          seal.key_id,
          chainInput({
            previous: previous?.chain_hmac,
            seq: Number(seal.seq),
            from: seal.sealed_from,
            to: seal.sealed_to,
            rowCount: seal.row_count,
            rowsSha256: seal.rows_sha256,
          }),
        );
        if (expected === null) {
          failure = { ...at, problem: 'key_unavailable' };
        } else if (!equalHex(expected, seal.chain_hmac)) {
          failure = { ...at, problem: 'seal_altered' };
        } else if (rowCount !== seal.row_count || rowsSha256 !== seal.rows_sha256) {
          failure = {
            ...at,
            problem: 'rows_changed',
            rowsNow: rowCount,
            rowsSealed: seal.row_count,
          };
        }
        if (failure) break;
        checked += 1;
        previous = seal;
        lastSeal = seal;
      }
    }
    if (failure) domainMetrics.auditSealFailures.inc({ problem: failure.problem });
    const sealedThrough = lastSeal?.sealed_to ?? null;
    const unsealed = Number(
      (
        await knex('audit.audit_logs')
          .where('occurred_at', '>=', sealedThrough ?? SEAL_ORIGIN)
          .count({ n: '*' })
          .first()
      ).n,
    );
    return {
      status: failure ? 'failed' : total === 0 ? 'not_sealed_yet' : 'verified',
      seals: total,
      checked,
      fromSeq: startSeq,
      sealedThrough: failure ? null : sealedThrough,
      unsealedEntries: failure ? null : unsealed,
      failure,
    };
  }

  return { sealDue, verify };
}
