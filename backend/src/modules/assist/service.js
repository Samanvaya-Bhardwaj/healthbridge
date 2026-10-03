import { PERMISSIONS } from '@healthbridge/shared';
import { isUuid, newId } from '../../core/db/ids.js';
import { withActor } from '../../core/db/actorContext.js';
import { ConflictError, NotFoundError } from '../../core/http/errors.js';
import { domainMetrics } from '../../core/metrics/domain.js';

export const INSUFFICIENT = 'Insufficient information. Please consult the doctor.';
const BRIEF_CACHE_MS = 12 * 3_600_000;
const BRIEFABLE = ['pending_payment', 'confirmed', 'checked_in', 'in_consultation', 'completed'];

/**
 * AI assistance for treating doctors (ADR-0024): record questions (patient-scoped RAG)
 * and pre-consultation briefs.
 *
 * The backend decides what the AI may see, per request: the patient must have opted in
 * to AI processing, the doctor needs `ai_assist:use` and an active `medical_documents`
 * consent; the AI then receives a scope token naming exactly the documents RLS shows this
 * doctor (their consent's document types) and verified lab facts only — never unverified
 * proposals, intake reasons or other patients' data. Question text is never stored.
 */
export function createAssistService({ knex, aiClient, accessPolicy, audit }) {
  async function context(trx, principal, patientId, req) {
    if (!isUuid(patientId)) throw new NotFoundError();
    const decision = await accessPolicy.enforce({
      principal,
      permission: PERMISSIONS.AI_ASSIST_USE,
      resource: { type: 'patient', id: patientId, patientId },
      req,
      trx,
    });
    const patient = await trx('patients').where({ id: patientId }).first('ai_document_processing');
    if (!patient?.ai_document_processing) {
      throw new ConflictError(
        'The patient has not turned on AI reading of their documents.',
        'ai_processing_disabled',
      );
    }
    // RLS: only AVAILABLE documents of the types this doctor's consent covers.
    const documents = await trx('medical_documents')
      .where({ patient_id: patientId, status: 'available' })
      .orderBy('available_at', 'desc')
      .limit(200)
      .select('id', 'title');
    const labs = await trx('lab_results')
      .where({ patient_id: patientId })
      .orderBy([{ column: 'observed_on', order: 'desc', nulls: 'last' }])
      .limit(60)
      .select('id', 'analyte', 'value_text', 'unit', 'flag', 'reference_range', 'observed_on');
    const facts = labs.map((l) => ({
      id: l.id,
      text: [
        `${l.analyte}: ${l.value_text}${l.unit ? ` ${l.unit}` : ''}`,
        l.flag ? `(${l.flag})` : '',
        l.reference_range ? `reference ${l.reference_range}` : '',
        l.observed_on ? `observed ${l.observed_on}` : '',
        'verified by a doctor',
      ]
        .filter(Boolean)
        .join(' ')
        .slice(0, 300),
    }));
    return {
      decision,
      documentIds: documents.map((d) => d.id),
      titles: new Map(documents.map((d) => [d.id, d.title])),
      labels: new Map(labs.map((l) => [l.id, l.analyte])),
      facts,
    };
  }

  const citationView = (ctx) => (c) => ({
    label: c.label,
    type: c.type === 'document_chunk' ? 'document' : 'lab_result',
    documentId: c.documentId ?? null,
    title:
      c.type === 'document_chunk'
        ? (ctx.titles.get(c.documentId) ?? 'Document')
        : `Verified lab value: ${ctx.labels.get(c.id) ?? 'lab value'}`,
  });

  async function ask(principal, patientId, { question }, req) {
    const ctx = await withActor(knex, principal.userId, (trx) =>
      context(trx, principal, patientId, req),
    );
    if (!aiClient) throw new Error('AI service client not configured');
    const result = await aiClient.askRecord(
      { patientId, question, documentIds: ctx.documentIds, facts: ctx.facts },
      { requestId: req?.id },
    );
    await audit.record(
      {
        category: 'data_access',
        action: 'record.question_answered',
        outcome: 'success',
        resourceType: 'patient',
        resourceId: patientId,
        patientId,
        reason: result.status,
        // Never the question or the answer: counts only.
        metadata: {
          sentences: result.sentences.length,
          citations: result.sentences.reduce((n, s) => n + s.citations.length, 0),
          documentsInScope: ctx.documentIds.length,
          consentId: ctx.decision.consentId ?? null,
        },
      },
      { req },
    );
    domainMetrics.aiAssistRequests.inc({ kind: 'question', status: result.status });
    return {
      status: result.status,
      answer: result.sentences.length ? result.answer : INSUFFICIENT,
      sentences: result.sentences.map((s) => ({
        text: s.text,
        citations: s.citations.map(citationView(ctx)),
      })),
      source: 'ai_generated',
    };
  }

  async function ownAppointment(trx, principal, appointmentId) {
    if (!isUuid(appointmentId)) throw new NotFoundError();
    const appt = await trx('appointments as a')
      .join('doctors as d', 'd.id', 'a.doctor_id')
      .where('a.id', appointmentId)
      .first('a.id', 'a.patient_id', 'a.status', 'd.user_id as doctor_user_id');
    // RLS shows appointments to their parties; a brief is only for the doctor party.
    if (!appt || appt.doctor_user_id !== principal.userId) throw new NotFoundError();
    if (!BRIEFABLE.includes(appt.status)) {
      throw new ConflictError(
        'There is no brief for this appointment.',
        'appointment_not_briefable',
      );
    }
    return appt;
  }

  async function readBrief(trx, appointmentId, ctx) {
    const row = await trx('ai.doctor_briefs')
      .where({ appointment_id: appointmentId })
      .orderBy('created_at', 'desc')
      .first();
    if (!row) return null;
    const feedback = await trx('brief_feedback')
      .where({ brief_id: row.id })
      .first('rating', 'issue');
    return {
      id: row.id,
      status: row.status,
      createdAt: row.created_at,
      source: 'ai_generated',
      message: row.status === 'ready' ? null : INSUFFICIENT,
      sections: (row.sections ?? []).map((section) => ({
        heading: section.heading,
        sentences: section.sentences.map((s) => ({
          text: s.text,
          citations: s.citations.map(citationView(ctx)),
        })),
      })),
      feedback: feedback ?? null,
    };
  }

  /** Latest brief for the doctor's appointment (generated if absent, stale or requested). */
  async function brief(principal, appointmentId, { refresh = false } = {}, req) {
    const { appt, ctx, existing } = await withActor(knex, principal.userId, async (trx) => {
      const a = await ownAppointment(trx, principal, appointmentId);
      const c = await context(trx, principal, a.patient_id, req);
      return { appt: a, ctx: c, existing: await readBrief(trx, appointmentId, c) };
    });
    const fresh = existing && Date.now() - new Date(existing.createdAt).getTime() < BRIEF_CACHE_MS;
    if (existing && fresh && !refresh) {
      await auditBrief('brief.viewed', appt, existing, req);
      return existing;
    }
    if (!aiClient) throw new Error('AI service client not configured');
    await aiClient.generateBrief(
      {
        patientId: appt.patient_id,
        appointmentId,
        doctorUserId: principal.userId,
        documentIds: ctx.documentIds,
        facts: ctx.facts,
      },
      { requestId: req?.id },
    );
    const created = await withActor(knex, principal.userId, (trx) =>
      readBrief(trx, appointmentId, ctx),
    );
    await auditBrief('brief.generated', appt, created, req);
    domainMetrics.aiAssistRequests.inc({ kind: 'brief', status: created.status });
    return created;
  }

  async function auditBrief(action, appt, view, req) {
    await audit.record(
      {
        category: 'data_access',
        action,
        outcome: 'success',
        resourceType: 'appointment',
        resourceId: appt.id,
        patientId: appt.patient_id,
        reason: view.status,
        metadata: { sections: view.sections.length },
      },
      { req },
    );
  }

  async function feedback(principal, briefId, { rating, issue }, req) {
    if (!isUuid(briefId)) throw new NotFoundError();
    return withActor(knex, principal.userId, async (trx) => {
      // RLS: only the brief's doctor, while consent lasts.
      const row = await trx('ai.doctor_briefs').where({ id: briefId }).first('id', 'patient_id');
      if (!row) throw new NotFoundError();
      await trx('brief_feedback')
        .insert({
          id: newId(),
          brief_id: row.id,
          patient_id: row.patient_id,
          doctor_user_id: principal.userId,
          rating,
          issue: issue ?? null,
        })
        .onConflict(['brief_id', 'doctor_user_id'])
        .merge({ rating, issue: issue ?? null });
      domainMetrics.briefFeedback.inc({ rating });
      await audit.record(
        {
          category: 'data_access',
          action: 'brief.feedback',
          outcome: 'success',
          resourceType: 'doctor_brief',
          resourceId: row.id,
          patientId: row.patient_id,
          reason: rating,
        },
        { req, trx },
      );
      return { rating, issue: issue ?? null };
    });
  }

  return { ask, brief, feedback, latestBrief: brief };
}
