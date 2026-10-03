import { newId } from '../../core/db/ids.js';
import { withSystem } from '../../core/db/actorContext.js';

const MODE = { online: 'Online consultation', in_clinic: 'In-clinic visit' };
const UPLOADER_PROVENANCE = {
  patient_self: 'patient_reported',
  guardian: 'guardian_reported',
  treating_doctor: 'doctor_reported',
};

/**
 * Timeline projector (ADR-0023). Re-reads each source row (never trusts event payloads)
 * and upserts exactly one event per source: replays, duplicates and out-of-order
 * delivery converge on the current state. `rebuildPatient` re-projects everything.
 */
export function createTimelineProjector({ knex, logger }) {
  async function upsert(trx, event) {
    await trx('medical_events')
      .insert({ id: newId(), ...event, detail: JSON.stringify(event.detail ?? {}) })
      .onConflict(['source_type', 'source_id'])
      .merge({
        occurred_at: event.occurred_at,
        date_precision: event.date_precision,
        title: event.title,
        status: event.status,
        provenance: event.provenance,
        actor_label: event.actor_label,
        detail: JSON.stringify(event.detail ?? {}),
        document_type: event.document_type ?? null,
        doctor_user_id: event.doctor_user_id ?? null,
        hidden: event.hidden ?? false,
        projected_at: trx.fn.now(),
      });
  }

  async function projectAppointment(trx, id) {
    const a = await trx('appointments as a')
      .join('doctors as d', 'd.id', 'a.doctor_id')
      .leftJoin('clinics as c', 'c.id', 'a.clinic_id')
      .where('a.id', id)
      .first('a.*', 'd.professional_name', 'd.user_id as doctor_user_id', 'c.name as clinic_name');
    if (!a) return false;
    await upsert(trx, {
      patient_id: a.patient_id,
      event_type: 'appointment',
      source_type: 'appointment',
      source_id: a.id,
      occurred_at: a.starts_at,
      date_precision: 'instant',
      title: `${MODE[a.mode]} with ${a.professional_name}`.slice(0, 200),
      status: a.status,
      provenance: 'system_recorded',
      actor_label: a.professional_name,
      detail: {
        mode: a.mode,
        clinicName: a.clinic_name ?? null,
        reference: a.id.slice(-8).toUpperCase(),
      },
      doctor_user_id: a.doctor_user_id,
      // Abandoned payment holds are not part of anyone's health history.
      hidden: a.status === 'expired',
    });
    return true;
  }

  async function projectDocument(trx, id) {
    const d = await trx('medical_documents as m')
      .leftJoin('doctors as dr', 'dr.user_id', 'm.uploaded_by_user_id')
      .where('m.id', id)
      .first('m.*', 'dr.professional_name as uploader_doctor');
    if (!d || !['available', 'retired'].includes(d.status)) return false;
    const meta = await trx('document_metadata')
      .where({ document_id: id, is_current: true })
      .first();
    await upsert(trx, {
      patient_id: d.patient_id,
      event_type: 'document',
      source_type: 'medical_document',
      source_id: d.id,
      occurred_at: meta?.document_date ? `${meta.document_date}T12:00:00Z` : d.available_at,
      date_precision: meta?.document_date ? 'day' : 'instant',
      title: d.title,
      status: d.status,
      provenance: UPLOADER_PROVENANCE[d.uploaded_by_relationship],
      actor_label: d.uploaded_by_relationship === 'treating_doctor' ? d.uploader_doctor : null,
      detail: {
        documentType: d.document_type,
        detectedType: meta?.detected_type ?? null,
        issuer: meta?.issuer ?? null,
        // Date and issuer were read by AI and validated, not entered by a person.
        aiDerivedFields: [
          ...(meta?.document_date ? ['documentDate'] : []),
          ...(meta?.issuer ? ['issuer'] : []),
        ],
      },
      document_type: d.document_type,
      hidden: d.status === 'retired',
    });
    return true;
  }

  async function projectLabResult(trx, id) {
    const l = await trx('lab_results as l')
      .leftJoin('doctors as d', 'd.user_id', 'l.verified_by_user_id')
      .where('l.id', id)
      .first('l.*', 'd.professional_name as verifier');
    if (!l) return false;
    await upsert(trx, {
      patient_id: l.patient_id,
      event_type: 'lab_result',
      source_type: 'lab_result',
      source_id: l.id,
      occurred_at: l.observed_on ? `${l.observed_on}T12:00:00Z` : l.verified_at,
      date_precision: l.observed_on ? 'day' : 'instant',
      title: `${l.analyte}: ${l.value_text}${l.unit ? ` ${l.unit}` : ''}`.slice(0, 200),
      status: l.flag,
      provenance: 'doctor_verified',
      actor_label: l.verifier,
      detail: {
        analyte: l.analyte,
        value: l.value_text,
        unit: l.unit,
        referenceRange: l.reference_range,
        flag: l.flag,
        documentId: l.document_id,
        sourceQuote: l.source_quote,
      },
      document_type: l.document_type,
    });
    return true;
  }

  /** Projects the source of one outbox event. */
  async function handleEvent({ eventType, aggregateType, aggregateId, payload = {} }) {
    return withSystem(knex, 'timeline', async (trx) => {
      if (aggregateType === 'appointment')
        return { projected: await projectAppointment(trx, aggregateId) };
      if (eventType === 'lab_result.verified') {
        let n = 0;
        for (const id of payload.labResultIds ?? []) n += (await projectLabResult(trx, id)) ? 1 : 0;
        return { projected: n };
      }
      if (aggregateType === 'medical_document')
        return { projected: await projectDocument(trx, aggregateId) };
      return { projected: false };
    });
  }

  /** Re-projects every source of one patient (repair / backfill). */
  async function rebuildPatient(patientId) {
    return withSystem(knex, 'timeline', async (trx) => {
      // Sequential: one transaction is one connection.
      const appts = await trx('appointments').where({ patient_id: patientId }).pluck('id');
      const documents = await trx('medical_documents').where({ patient_id: patientId }).pluck('id');
      const labResults = await trx('lab_results').where({ patient_id: patientId }).pluck('id');
      let n = 0;
      for (const id of appts) n += (await projectAppointment(trx, id)) ? 1 : 0;
      for (const id of documents) n += (await projectDocument(trx, id)) ? 1 : 0;
      for (const id of labResults) n += (await projectLabResult(trx, id)) ? 1 : 0;
      return { projected: n };
    });
  }

  /** Backfill for every patient with sources but no projection yet. */
  async function backfill({ limit = 500 } = {}) {
    const patients = await withSystem(knex, 'timeline', async (trx) => {
      const { rows } = await trx.raw(
        `SELECT DISTINCT s.patient_id FROM (
           SELECT patient_id FROM appointments
           UNION SELECT patient_id FROM medical_documents WHERE status IN ('available', 'retired')
           UNION SELECT patient_id FROM lab_results) s
          WHERE NOT EXISTS (SELECT 1 FROM medical_events e WHERE e.patient_id = s.patient_id)
          LIMIT ?`,
        [limit],
      );
      return rows.map((r) => r.patient_id);
    });
    for (const patientId of patients) await rebuildPatient(patientId);
    logger?.info({ patients: patients.length }, 'timeline backfill');
    return { patients: patients.length };
  }

  return { handleEvent, rebuildPatient, backfill };
}
