import { createHash } from 'node:crypto';
import { withActor } from '../../src/core/db/actorContext.js';
import { syntheticPdf } from './syntheticPdf.js';
import { syntheticRecords } from './syntheticRecords.js';

/**
 * Part 4: a realistic, synthetic medical record for the main demo patients (about 25
 * multi-page documents: discharge summaries, lab reports over time, imaging, letters,
 * prescriptions from outside clinics, vaccinations), uploaded through the real pipeline
 * (upload intent → object → complete → scan → promote → AI reading with the opt-in).
 *
 * - Asha uploads her own and, as Kamala's managing guardian, Kamala's; Vikram his own.
 * - AI reading is on for all three, so record questions (patient side, and Dr. Meera with
 *   consent) and doctor briefs have sources to cite.
 * - Kamala shares her documents with Dr. Meera (consent), as Asha already does.
 *
 * Idempotent: documents with the same title are not uploaded again.
 */
export async function seedRecords({
  live,
  knex,
  principalFor,
  ids,
  ashaProfile,
  vikramProfile,
  log,
}) {
  const asha = await principalFor(ids['patient.asha']);
  const vikram = await principalFor(ids['patient.vikram']);
  const meera = await live.repositories.doctors.findByUserId(ids['dr.meera']);
  const kamala = (await live.patientService.listDependents(asha)).find(
    (d) => d.fullName === 'Kamala Rao',
  );
  const owners = {
    asha: { principal: asha, patientId: ashaProfile.id },
    vikram: { principal: vikram, patientId: vikramProfile.id },
    ...(kamala ? { kamala: { principal: asha, patientId: kamala.id } } : {}),
  };

  // AI reading of documents: on for all three (Asha's was turned on earlier).
  for (const [name, owner] of Object.entries(owners)) {
    const setting = await live.intelligenceService.getAiProcessing(
      owner.principal,
      owner.patientId,
    );
    if (!setting.enabled) {
      await live.intelligenceService.setAiProcessing(owner.principal, owner.patientId, {
        enabled: true,
      });
      log(`${name}: AI document reading on`);
    }
  }

  // Kamala shares her records with Dr. Meera (her doctor since the BP review).
  if (kamala && meera) {
    const consents = await live.consentService.listForPatient(asha, kamala.id);
    if (!consents.some((c) => c.status === 'active' && c.doctor.id === meera.id)) {
      await live.consentService.grant(asha, {
        patientId: kamala.id,
        doctorId: meera.id,
        kind: 'manual',
        scopes: ['patient_profile', 'medical_documents'],
        purpose: 'ongoing_care',
        expiresInDays: 90,
      });
      log('kamala granted dr.meera document access (90 days)');
    }
  }

  let uploaded = 0;
  const existing = new Map();
  for (const doc of syntheticRecords()) {
    const owner = owners[doc.patient];
    if (!owner) continue;
    if (!existing.has(doc.patient)) {
      const list = await live.documentService.list(owner.principal, owner.patientId);
      existing.set(doc.patient, new Set(list.map((d) => d.title)));
    }
    if (existing.get(doc.patient).has(doc.title)) continue;
    const content = syntheticPdf(doc.pages);
    const sha256 = createHash('sha256').update(content).digest('hex');
    const { document } = await live.documentService.createUploadIntent(
      owner.principal,
      owner.patientId,
      {
        documentType: doc.type,
        title: doc.title,
        filename: doc.filename,
        contentType: 'application/pdf',
        sizeBytes: content.length,
        sha256,
      },
    );
    // The key is random and server-generated; the uploader can read it on their own row.
    const { quarantine_key: key } = await withActor(knex, owner.principal.userId, (trx) =>
      trx('medical_documents').where({ id: document.id }).first('quarantine_key'),
    );
    await live.documentStorage.putObject(key, content, { contentType: 'application/pdf', sha256 });
    await live.documentService.complete(owner.principal, document.id);
    existing.get(doc.patient).add(doc.title);
    uploaded += 1;
  }
  log('synthetic medical records', { uploaded });
}
