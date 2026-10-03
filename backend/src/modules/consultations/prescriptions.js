import { createHash, createHmac, hkdfSync, randomInt } from 'node:crypto';
import { DateTime } from 'luxon';
import { PERMISSIONS } from '@healthbridge/shared';
import { isUuid, newId } from '../../core/db/ids.js';
import { withActor, withSystem } from '../../core/db/actorContext.js';
import { appendOutboxEvent } from '../../core/events/outbox.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../core/http/errors.js';
import { domainMetrics } from '../../core/metrics/domain.js';
import { renderTextPdf } from '../../core/pdf/textPdf.js';
import { authorizeConsultationParty } from './access.js';
import { checkPrescribingRules } from './prescribingRules.js';

const DATA = 'data_access';
const REFERENCE_ALPHABET = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const ROUTE_LABELS = { oral: 'by mouth', topical: 'on the skin', inhalation: 'inhaled' };

export const newPrescriptionReference = () =>
  `RX-${Array.from({ length: 10 }, () => REFERENCE_ALPHABET[randomInt(REFERENCE_ALPHABET.length)]).join('')}`;

const itemRow = (prescriptionId, patientId) => (item, i) => ({
  id: newId(),
  prescription_id: prescriptionId,
  patient_id: patientId,
  position: i + 1,
  drug_name: item.drugName,
  strength: item.strength ?? '',
  form: item.form ?? '',
  dose: item.dose,
  frequency: item.frequency,
  route: item.route ?? 'oral',
  duration: item.duration,
  instructions: item.instructions ?? '',
});

const itemView = (i) => ({
  position: i.position,
  drugName: i.drug_name,
  strength: i.strength,
  form: i.form,
  dose: i.dose,
  frequency: i.frequency,
  route: i.route,
  duration: i.duration,
  instructions: i.instructions,
});

export function prescriptionView(row, items) {
  return {
    id: row.id,
    reference: row.reference,
    version: row.version,
    status: row.status,
    appointmentId: row.appointment_id,
    patientId: row.patient_id,
    doctorId: row.doctor_id,
    advice: row.advice,
    items: [...items].sort((a, b) => a.position - b.position).map(itemView),
    signedAt: row.signed_at,
    supersedesId: row.supersedes_id,
    correctionReason: row.correction_reason,
    contentSha256: row.content_sha256,
    pdfReady: Boolean(row.pdf_object_key),
  };
}

/**
 * Canonical, order-stable serialisation of a prescription's clinical content. Its SHA-256
 * is fixed at signing; the PDF renderer recomputes it from the database and refuses to
 * render a prescription whose stored content no longer matches.
 */
export function canonicalContent(row, items, signedAt) {
  return JSON.stringify({
    reference: row.reference,
    version: row.version,
    patientId: row.patient_id,
    doctorId: row.doctor_id,
    appointmentId: row.appointment_id,
    signedAt: new Date(signedAt).toISOString(),
    advice: row.advice,
    items: [...items]
      .sort((a, b) => a.position - b.position)
      .map((i) => [
        i.position,
        i.drug_name,
        i.strength,
        i.form,
        i.dose,
        i.frequency,
        i.route,
        i.duration,
        i.instructions,
      ]),
  });
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/**
 * Prescribing (ADR-0025, ADR-0009). One prescription chain per consultation:
 *   draft (editable by the consulting doctor while the consultation is live)
 *   → signed (content hash + HMAC integrity seal; immutable)
 *   → superseded by a signed correction (new version, reason required).
 * The PDF is rendered once per version by a worker, stored server-side and served only
 * through short-lived, audited URLs.
 */
export function createPrescriptionService({
  knex,
  config,
  accessPolicy,
  audit,
  storage,
  logger,
  now = () => new Date(),
}) {
  const { currentKeyId, keys } = config.clinicalData;
  const sealKey = (keyId) => {
    const kek = keys.get(keyId);
    if (!kek) throw new Error(`clinical data key ${keyId} is not configured`);
    return Buffer.from(hkdfSync('sha256', kek, 'healthbridge', 'prescription-integrity-seal', 32));
  };
  const seal = (keyId, contentSha) =>
    createHmac('sha256', sealKey(keyId)).update(contentSha).digest('hex');

  const authorize = (trx, principal, id, permission, req, options) =>
    authorizeConsultationParty({ accessPolicy }, trx, principal, id, permission, req, options);

  async function itemsOf(trx, ids) {
    if (!ids.length) return [];
    return trx('prescription_items').whereIn('prescription_id', ids).orderBy('position');
  }

  function enforceRules(items, mode) {
    const violations = checkPrescribingRules(items, { mode });
    if (violations.length) {
      throw new ValidationError(
        violations.map((v) => ({ path: `items.${v.position - 1}.drugName`, message: v.message })),
        'The prescription breaks a prescribing rule.',
      );
    }
  }

  async function signRow(trx, row, items) {
    const signedAt = now();
    const contentSha = sha256(canonicalContent(row, items, signedAt));
    return {
      signed_at: signedAt,
      content_sha256: contentSha,
      integrity_seal: seal(currentKeyId, contentSha),
      seal_key_id: currentKeyId,
    };
  }

  async function emitSigned(trx, row, req) {
    await appendOutboxEvent(trx, {
      aggregateType: 'prescription',
      aggregateId: row.id,
      eventType: 'prescription.signed',
      requestId: req?.id ?? null,
      payload: {
        prescriptionId: row.id,
        appointmentId: row.appointment_id,
        patientId: row.patient_id,
        version: row.version,
        supersedesId: row.supersedes_id ?? null,
      },
    });
  }

  /** Doctor: create or replace the draft for a live consultation. */
  async function saveDraft(principal, appointmentId, { items, advice }, req) {
    return withActor(knex, principal.userId, async (trx) => {
      const { row: appt, party } = await authorize(
        trx,
        principal,
        appointmentId,
        PERMISSIONS.PRESCRIPTIONS_SIGN,
        req,
        { lock: true },
      );
      if (party !== 'doctor') {
        throw new ForbiddenError('Only the consulting doctor can prescribe.', 'wrong_party');
      }
      const c = await trx('consultations').where({ appointment_id: appointmentId }).first();
      if (!c || c.status !== 'live') {
        throw new ConflictError(
          'Prescriptions are written during a live consultation.',
          'consultation_not_live',
        );
      }
      enforceRules(items, c.mode);
      const chain = await trx('prescriptions')
        .where({ consultation_id: c.id })
        .forUpdate()
        .select('id', 'status', 'version');
      if (chain.some((p) => p.status === 'signed')) {
        throw new ConflictError(
          'The prescription is signed. Use a correction to change it.',
          'prescription_already_signed',
        );
      }
      let draft = chain.find((p) => p.status === 'draft');
      if (draft) {
        await trx('prescription_items').where({ prescription_id: draft.id }).del();
        await trx('prescriptions')
          .where({ id: draft.id })
          .update({ advice: advice ?? '', updated_at: trx.fn.now() });
      } else {
        draft = { id: newId() };
        await trx('prescriptions').insert({
          id: draft.id,
          reference: newPrescriptionReference(),
          consultation_id: c.id,
          appointment_id: appointmentId,
          patient_id: appt.patient_id,
          doctor_id: appt.doctor_id,
          doctor_user_id: principal.userId,
          clinic_id: appt.clinic_id,
          version: Math.max(0, ...chain.map((p) => p.version)) + 1,
          status: 'draft',
          advice: advice ?? '',
        });
      }
      await trx('prescription_items').insert(items.map(itemRow(draft.id, appt.patient_id)));
      await audit.record(
        {
          category: DATA,
          action: 'prescription.draft_saved',
          outcome: 'success',
          resourceType: 'prescription',
          resourceId: draft.id,
          patientId: appt.patient_id,
          metadata: { items: items.length },
        },
        { req, trx },
      );
      const saved = await trx('prescriptions').where({ id: draft.id }).first();
      return prescriptionView(saved, await itemsOf(trx, [draft.id]));
    });
  }

  async function lockOwn(trx, principal, prescriptionId, req) {
    if (!isUuid(prescriptionId)) throw new NotFoundError();
    // Gate 1 first: other roles are refused before any lookup.
    await accessPolicy.enforce({ principal, permission: PERMISSIONS.PRESCRIPTIONS_SIGN, req, trx });
    // RLS (FOR UPDATE applies the update policy): only the author's own prescriptions.
    const row = await trx('prescriptions').where({ id: prescriptionId }).forUpdate().first();
    if (!row) throw new NotFoundError();
    if (row.doctor_user_id !== principal.userId) {
      throw new ForbiddenError('Only the prescribing doctor can do this.', 'not_author');
    }
    return row;
  }

  /** Doctor: sign the draft. Its content is frozen from here on. */
  async function sign(principal, prescriptionId, req) {
    return withActor(knex, principal.userId, async (trx) => {
      const row = await lockOwn(trx, principal, prescriptionId, req);
      await authorize(trx, principal, row.appointment_id, PERMISSIONS.PRESCRIPTIONS_SIGN, req);
      if (row.status !== 'draft') {
        throw new ConflictError('Only a draft can be signed.', 'prescription_not_draft');
      }
      const c = await trx('consultations').where({ id: row.consultation_id }).first();
      if (c.status !== 'live') {
        throw new ConflictError(
          'Prescriptions are signed during a live consultation.',
          'consultation_not_live',
        );
      }
      const items = await itemsOf(trx, [row.id]);
      enforceRules(items.map(itemView), c.mode);
      const signed = await signRow(trx, row, items);
      await trx('prescriptions')
        .where({ id: row.id })
        .update({ status: 'signed', ...signed, updated_at: trx.fn.now() });
      await audit.record(
        {
          category: DATA,
          action: 'prescription.signed',
          outcome: 'success',
          resourceType: 'prescription',
          resourceId: row.id,
          patientId: row.patient_id,
          metadata: {
            reference: row.reference,
            version: row.version,
            items: items.length,
            contentSha256: signed.content_sha256,
          },
        },
        { req, trx },
      );
      await emitSigned(trx, row, req);
      domainMetrics.prescriptions.inc({ event: 'signed' });
      const updated = await trx('prescriptions').where({ id: row.id }).first();
      return prescriptionView(updated, items);
    });
  }

  /** Doctor (author): correct a signed prescription → new signed version. */
  async function correct(principal, prescriptionId, { items, advice, reason }, req) {
    return withActor(knex, principal.userId, async (trx) => {
      const current = await lockOwn(trx, principal, prescriptionId, req);
      await authorize(trx, principal, current.appointment_id, PERMISSIONS.PRESCRIPTIONS_SIGN, req);
      if (current.status !== 'signed') {
        throw new ConflictError(
          'Only the current signed prescription can be corrected.',
          'prescription_not_current',
        );
      }
      enforceRules(
        items,
        (await trx('consultations').where({ id: current.consultation_id }).first('mode')).mode,
      );
      await trx('prescriptions')
        .where({ id: current.id })
        .update({ status: 'superseded', updated_at: trx.fn.now() });
      const next = {
        ...current,
        id: newId(),
        version: current.version + 1,
        advice: advice ?? '',
        supersedes_id: current.id,
      };
      const itemRows = items.map(itemRow(next.id, current.patient_id));
      await trx('prescriptions').insert({
        id: next.id,
        reference: current.reference,
        consultation_id: current.consultation_id,
        appointment_id: current.appointment_id,
        patient_id: current.patient_id,
        doctor_id: current.doctor_id,
        doctor_user_id: principal.userId,
        clinic_id: current.clinic_id,
        version: next.version,
        status: 'draft',
        advice: next.advice,
        supersedes_id: current.id,
        correction_reason: reason,
      });
      await trx('prescription_items').insert(itemRows);
      const signed = await signRow(trx, next, itemRows);
      await trx('prescriptions')
        .where({ id: next.id })
        .update({ status: 'signed', ...signed, updated_at: trx.fn.now() });
      await audit.record(
        {
          category: DATA,
          action: 'prescription.corrected',
          outcome: 'success',
          resourceType: 'prescription',
          resourceId: next.id,
          patientId: current.patient_id,
          metadata: {
            reference: current.reference,
            version: next.version,
            supersedesId: current.id,
            items: items.length,
          },
        },
        { req, trx },
      );
      await emitSigned(trx, next, req);
      domainMetrics.prescriptions.inc({ event: 'corrected' });
      const saved = await trx('prescriptions').where({ id: next.id }).first();
      return prescriptionView(saved, itemRows);
    });
  }

  /**
   * Read access: the author always; otherwise the patient policy (patient side, or a
   * treating doctor with a consent covering the `prescription` document type).
   */
  async function authorizeRead(trx, principal, row, req) {
    if (row.doctor_user_id === principal.userId) {
      return accessPolicy.enforce({
        principal,
        permission: PERMISSIONS.PRESCRIPTIONS_READ,
        req,
        trx,
      });
    }
    return accessPolicy.enforce({
      principal,
      permission: PERMISSIONS.PRESCRIPTIONS_READ,
      resource: {
        type: 'patient',
        id: row.patient_id,
        patientId: row.patient_id,
        documentType: 'prescription',
      },
      req,
      trx,
    });
  }

  async function get(principal, prescriptionId, req) {
    if (!isUuid(prescriptionId)) throw new NotFoundError();
    return withActor(knex, principal.userId, async (trx) => {
      const row = await trx('prescriptions').where({ id: prescriptionId }).first();
      if (!row) throw new NotFoundError();
      await authorizeRead(trx, principal, row, req);
      return prescriptionView(row, await itemsOf(trx, [row.id]));
    });
  }

  async function listForPatient(principal, patientId, req) {
    if (!isUuid(patientId)) throw new NotFoundError();
    return withActor(knex, principal.userId, async (trx) => {
      const decision = await accessPolicy.enforce({
        principal,
        permission: PERMISSIONS.PRESCRIPTIONS_READ,
        resource: { type: 'patient', id: patientId, patientId, documentType: 'prescription' },
        req,
        trx,
      });
      const rows = await trx('prescriptions as p')
        .join('doctors as d', 'd.id', 'p.doctor_id')
        .where('p.patient_id', patientId)
        .whereIn('p.status', ['signed', 'superseded'])
        .orderBy([
          { column: 'p.signed_at', order: 'desc' },
          { column: 'p.version', order: 'desc' },
        ])
        .limit(200)
        .select('p.*', 'd.professional_name as doctor_name');
      const items = await itemsOf(
        trx,
        rows.map((r) => r.id),
      );
      if (decision.relationship === 'treating_doctor') {
        await audit.record(
          {
            category: DATA,
            action: 'prescription.list_viewed',
            outcome: 'success',
            resourceType: 'patient',
            resourceId: patientId,
            patientId,
            metadata: { count: rows.length, consentId: decision.consentId ?? null },
          },
          { req, trx },
        );
      }
      return rows.map((r) => ({
        ...prescriptionView(
          r,
          items.filter((i) => i.prescription_id === r.id),
        ),
        doctorName: r.doctor_name,
      }));
    });
  }

  /** Short-lived, audited download URL of the signed PDF. */
  async function pdfUrl(principal, prescriptionId, req) {
    if (!isUuid(prescriptionId)) throw new NotFoundError();
    return withActor(knex, principal.userId, async (trx) => {
      const row = await trx('prescriptions').where({ id: prescriptionId }).first();
      if (!row || !['signed', 'superseded'].includes(row.status)) throw new NotFoundError();
      const decision = await authorizeRead(trx, principal, row, req);
      if (!row.pdf_object_key) {
        throw new ConflictError(
          'The PDF is being prepared. Try again in a moment.',
          'pdf_not_ready',
        );
      }
      const url = await storage.getDownloadUrl(row.pdf_object_key, {
        filename: `${row.reference}-v${row.version}.pdf`,
        contentType: 'application/pdf',
        ttlSeconds: config.documents.downloadUrlTtlSeconds,
      });
      await audit.record(
        {
          category: DATA,
          action: 'prescription.downloaded',
          outcome: 'success',
          resourceType: 'prescription',
          resourceId: row.id,
          patientId: row.patient_id,
          reason: decision.relationship ?? 'author',
          metadata: { version: row.version, pdfSha256: row.pdf_sha256 },
        },
        { req, trx },
      );
      return { ...url, sha256: row.pdf_sha256 };
    });
  }

  // ── PDF rendering (worker, system purpose `prescriptions`) ─────────

  function pdfBlocks({ rx, items, patient, doctor, clinic, mode }) {
    const when = DateTime.fromJSDate(new Date(rx.signed_at))
      .setZone('Asia/Kolkata')
      .toFormat("d LLL yyyy, h:mm a 'IST'");
    const age = patient.date_of_birth
      ? Math.floor(
          DateTime.fromJSDate(new Date(rx.signed_at)).diff(
            DateTime.fromISO(patient.date_of_birth),
            'years',
          ).years,
        )
      : null;
    const blocks = [
      { text: 'HealthBridge', size: 9 },
      { text: 'Prescription', size: 18, bold: true, gapBefore: 4 },
      {
        text: `Reference ${rx.reference} · Version ${rx.version} · Signed ${when}`,
        size: 9,
        gapBefore: 4,
      },
    ];
    if (rx.supersedes_id) {
      blocks.push({
        text: `This version corrects version ${rx.version - 1}. Reason: ${rx.correction_reason}`,
        size: 9,
      });
    }
    blocks.push(
      { text: 'Doctor', bold: true, gapBefore: 14 },
      { text: doctor.professional_name },
      {
        text: [
          (doctor.qualifications ?? [])
            .map((q) => q.degree)
            .filter(Boolean)
            .join(', ') || null,
          doctor.primary_specialization,
          `Reg. no. ${doctor.registration_number}${doctor.registration_council ? ` (${doctor.registration_council})` : ''}`,
        ]
          .filter(Boolean)
          .join(' · '),
        size: 9,
      },
      {
        text:
          mode === 'online'
            ? 'Online consultation'
            : `In-clinic visit${clinic ? ` · ${clinic.name}${clinic.city ? `, ${clinic.city}` : ''}` : ''}`,
        size: 9,
      },
      { text: 'Patient', bold: true, gapBefore: 10 },
      {
        text: [
          patient.full_name,
          age !== null ? `${age} years` : null,
          patient.sex && patient.sex !== 'unspecified' ? patient.sex : null,
        ]
          .filter(Boolean)
          .join(' · '),
      },
      { text: 'Rx', size: 14, bold: true, gapBefore: 14 },
    );
    for (const i of items) {
      blocks.push({
        text: `${i.position}. ${i.drug_name}${i.strength ? ` ${i.strength}` : ''}${i.form ? ` (${i.form})` : ''}`,
        bold: true,
        gapBefore: 6,
      });
      blocks.push({
        text: `${i.dose}, ${i.frequency}, ${ROUTE_LABELS[i.route] ?? i.route}, for ${i.duration}`,
        indent: 14,
      });
      if (i.instructions) blocks.push({ text: i.instructions, indent: 14, size: 9 });
    }
    if (rx.advice) {
      blocks.push({ text: 'Advice', bold: true, gapBefore: 12 }, { text: rx.advice });
    }
    blocks.push(
      {
        text: `Electronically signed by ${doctor.professional_name} on ${when}.`,
        gapBefore: 18,
        size: 9,
      },
      { text: `Content SHA-256: ${rx.content_sha256}`, size: 7 },
    );
    if (!config.isProduction) {
      blocks.push({
        text: 'DEMONSTRATION ONLY - synthetic data, not valid for dispensing.',
        bold: true,
        size: 9,
        gapBefore: 8,
      });
    }
    return blocks;
  }

  /** Idempotent: renders a signed version once; a redelivered job finds the PDF recorded. */
  async function renderPdf(prescriptionId) {
    const loaded = await withSystem(knex, 'prescriptions', async (trx) => {
      const rx = await trx('prescriptions').where({ id: prescriptionId }).first();
      if (!rx) return { done: 'not_found' };
      if (rx.pdf_object_key) return { done: 'exists' };
      if (!['signed', 'superseded'].includes(rx.status)) return { done: 'not_signed' };
      const items = await trx('prescription_items')
        .where({ prescription_id: rx.id })
        .orderBy('position');
      // Integrity: the stored content must still be what was signed.
      const contentSha = sha256(canonicalContent(rx, items, rx.signed_at));
      if (
        contentSha !== rx.content_sha256 ||
        seal(rx.seal_key_id, contentSha) !== rx.integrity_seal
      ) {
        return { failed: 'integrity_mismatch' };
      }
      const [patient, doctor, clinic, consultation] = [
        await trx('patients')
          .where({ id: rx.patient_id })
          .first('full_name', 'date_of_birth', 'sex'),
        await trx('doctors').where({ id: rx.doctor_id }).first(),
        rx.clinic_id
          ? await trx('clinics').where({ id: rx.clinic_id }).first('name', 'city')
          : null,
        await trx('consultations').where({ id: rx.consultation_id }).first('mode'),
      ];
      return { rx, items, patient, doctor, clinic, mode: consultation.mode };
    });
    if (loaded.done) return { outcome: loaded.done };
    if (loaded.failed) {
      logger?.error({ prescriptionId }, 'prescription content does not match its signature');
      domainMetrics.prescriptions.inc({ event: 'integrity_mismatch' });
      throw new Error('prescription integrity check failed');
    }
    const pdf = renderTextPdf(pdfBlocks(loaded), {
      footer: `${loaded.rx.reference} v${loaded.rx.version}`,
    });
    const pdfSha = sha256(pdf);
    const key = `prescriptions/${loaded.rx.patient_id}/${loaded.rx.id}-v${loaded.rx.version}.pdf`;
    await storage.putObject(key, pdf, { contentType: 'application/pdf', sha256: pdfSha });
    await withSystem(knex, 'prescriptions', (trx) =>
      trx('prescriptions').where({ id: prescriptionId }).whereNull('pdf_object_key').update({
        pdf_object_key: key,
        pdf_sha256: pdfSha,
        pdf_generated_at: trx.fn.now(),
      }),
    );
    domainMetrics.prescriptions.inc({ event: 'pdf_rendered' });
    return { outcome: 'rendered', bytes: pdf.length };
  }

  return { saveDraft, sign, correct, get, listForPatient, pdfUrl, renderPdf };
}
