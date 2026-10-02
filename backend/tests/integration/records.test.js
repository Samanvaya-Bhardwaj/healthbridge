import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditFor, createHarness } from './harness.js';
import {
  api,
  createClinicWithAdmin,
  createPatient,
  createPlatformAdmin,
  createVerifiedDoctor,
  expectOk,
  linkCare,
  profileInput,
} from './m2fixtures.js';
import {
  FILES,
  asUser,
  documentRow,
  grant,
  intentBody,
  postToStorage,
  sha256,
  uploadDocument,
} from './m5fixtures.js';
import { counterValue, domainMetrics } from '../../src/core/metrics/domain.js';

let h;
let admin;
let patient; // owns the record
let doctor; // treating doctor who receives consent
let otherTreating; // treating doctor without consent
let stranger; // verified doctor with no relationship
let clinicAdmin;
let guardian;
let child; // dependent patient (guardian manages)
let docA; // AVAILABLE lab report of `patient`
let docImaging; // AVAILABLE imaging document of `patient`

beforeAll(async () => {
  h = await createHarness();
  admin = await createPlatformAdmin(h);
  patient = await createPatient(h, 'rec-pt');
  doctor = await createVerifiedDoctor(h, admin, 'rec-doc');
  otherTreating = await createVerifiedDoctor(h, admin, 'rec-doc2');
  stranger = await createVerifiedDoctor(h, admin, 'rec-stranger');
  await linkCare(h, patient, doctor);
  await linkCare(h, patient, otherTreating);
  ({ clinicAdmin } = await createClinicWithAdmin(h, admin, 'rec-clinic'));
  guardian = await createPatient(h, 'rec-guardian');
  child = expectOk(
    await api(h, guardian).post('/patients/me/dependents', {
      ...profileInput('Synthetic Child'),
      relationshipType: 'parent',
    }),
    201,
  );
  docA = (await uploadDocument(h, patient, patient.patient.id, { title: 'Synthetic CBC' })).id;
  docImaging = (
    await uploadDocument(h, patient, patient.patient.id, {
      content: FILES.png(),
      documentType: 'imaging',
      title: 'Synthetic X-ray',
      filename: 'xray.png',
      contentType: 'image/png',
    })
  ).id;
}, 60_000);
afterAll(async () => {
  await h.close();
});

const getDoc = (who, id) => api(h, who).get(`/documents/${id}`);
const download = (who, id) => api(h, who).get(`/documents/${id}/download`);
const listDocs = (who, patientId) => api(h, who).get(`/patients/${patientId}/documents`);

describe('upload: quarantine → scan → promotion', () => {
  it('a clean PDF becomes AVAILABLE only after the scan; keys are server-generated', async () => {
    const before = await counterValue(domainMetrics.documentPromoted);
    const content = FILES.pdf();
    const intent = expectOk(
      await api(h, patient).post(
        `/patients/${patient.patient.id}/documents/upload-intent`,
        intentBody(content, { title: 'Synthetic lipid panel' }),
      ),
      201,
    );
    expect(intent.document.status).toBe('pending_upload');
    expect(intent.upload.method).toBe('POST');
    // Browser-facing data: no credentials, no permanent object URL.
    expect(JSON.stringify(intent)).not.toMatch(/secret|SecretAccessKey|records\//i);
    expect(intent.upload.fields.key).toMatch(
      new RegExp(
        `^quarantine/patients/${patient.patient.id}/documents/${intent.document.id}/[0-9a-f]{32}$`,
      ),
    );

    expect((await postToStorage(intent.upload, content)).status).toBe(204);
    // Uploaded but unscanned: never available, not downloadable.
    const done = expectOk(await api(h, patient).post(`/documents/${intent.document.id}/complete`));
    expect(done.status).toBe('quarantined');
    expect((await download(patient, intent.document.id)).body.code).toBe('document_not_available');

    expect((await h.container.documentPipeline.scanAndPromote(intent.document.id)).outcome).toBe(
      'available',
    );
    const row = await documentRow(h, intent.document.id);
    expect(row).toMatchObject({
      status: 'available',
      scanner: 'fake',
      detected_content_type: 'application/pdf',
    });
    expect(row.verified_sha256).toBe(sha256(content));
    expect(row.storage_key).toMatch(/^records\/patients\/.+\/[0-9a-f]{32}$/);
    expect(row.storage_key).not.toContain('lipid');
    expect(await counterValue(domainMetrics.documentPromoted)).toBe(before + 1);
    const actions = (await auditFor(h.knex, { resource_id: intent.document.id })).map(
      (a) => a.action,
    );
    expect(actions).toEqual(
      expect.arrayContaining([
        'document.upload_intent_created',
        'document.upload_completed',
        'document.scan_started',
        'document.promoted',
      ]),
    );
  });

  it('infected files are rejected and removed; scanner failures stay non-available and retry safely', async () => {
    const infected = await uploadDocument(h, patient, patient.patient.id, {
      content: FILES.infectedPdf(),
    });
    expect(infected.scan).toEqual({ outcome: 'rejected', reason: 'infected' });
    const row = await documentRow(h, infected.id);
    expect(row).toMatchObject({ status: 'rejected', rejection_reason: 'infected' });
    expect(await h.container.documentStorage.statObject(row.quarantine_key)).toBeNull();
    expect((await download(patient, infected.id)).body.code).toBe('document_not_available');

    const flaky = await uploadDocument(h, patient, patient.patient.id, { scan: false });
    h.documentScanner.failNext(2);
    for (let i = 0; i < 2; i += 1) {
      await expect(h.container.documentPipeline.scanAndPromote(flaky.id)).rejects.toThrow(
        /scanner failure/,
      );
      expect((await documentRow(h, flaky.id)).status).toBe('quarantined');
    }
    expect((await h.container.documentPipeline.scanAndPromote(flaky.id)).outcome).toBe('available');
    expect((await documentRow(h, flaky.id)).scan_attempts).toBe(3);
    const failed = await auditFor(h.knex, {
      resource_id: flaky.id,
      action: 'document.scan_failed',
    });
    expect(failed).toHaveLength(2);
  });

  it('validates type, extension, content, size and checksum; never trusts the browser', async () => {
    const pdf = FILES.pdf();
    const path = `/patients/${patient.patient.id}/documents/upload-intent`;
    const post = (body) => api(h, patient).post(path, body);
    // Allowlist and extension ↔ type.
    expect(
      (await post(intentBody(pdf, { contentType: 'text/html', filename: 'x.html' }))).status,
    ).toBe(400);
    expect((await post(intentBody(pdf, { filename: 'report.png' }))).status).toBe(400);
    // Path traversal in names never reaches a key (and is refused).
    expect((await post(intentBody(pdf, { filename: '../../etc/passwd.pdf' }))).status).toBe(400);
    // Server-side fields cannot be supplied.
    expect((await post({ ...intentBody(pdf), status: 'available' })).status).toBe(400);
    // Too large (configured maximum).
    const big = await post(intentBody(pdf, { sizeBytes: h.config.documents.maxBytes + 1 }));
    expect(big.status).toBe(413);
    expect(big.body.code).toBe('file_too_large');

    // Declared PDF, actually PNG bytes → type mismatch at scan (magic bytes).
    const png = FILES.png();
    const mismatch = await uploadDocument(h, patient, patient.patient.id, { content: png });
    expect(mismatch.scan.reason).toBe('type_mismatch');
    // Checksum mismatch: bytes differ from what was declared (same length).
    const declared = FILES.pdf();
    const tampered = Buffer.from(declared);
    tampered[tampered.length - 2] ^= 0xff;
    const altered = await uploadDocument(h, patient, patient.patient.id, {
      content: declared,
      uploadContent: tampered,
    });
    expect(altered.scan.reason).toBe('checksum_mismatch');
    // Uploading more than declared is refused by the storage policy itself.
    const small = FILES.pdf();
    const intent = expectOk(await post(intentBody(small)), 201);
    const tooMuch = await postToStorage(intent.upload, Buffer.concat([small, Buffer.alloc(4096)]));
    expect(tooMuch.status).toBeGreaterThanOrEqual(400);
    expect(
      (await api(h, patient).post(`/documents/${intent.document.id}/complete`)).body.code,
    ).toBe('upload_not_found');
  });

  it('duplicate completion and duplicate scan jobs promote exactly once; a crash mid-promotion recovers', async () => {
    const doc = await uploadDocument(h, patient, patient.patient.id, { scan: false });
    const again = expectOk(await api(h, patient).post(`/documents/${doc.id}/complete`));
    expect(again.status).toBe('quarantined');
    const outcomes = await Promise.all([
      h.container.documentPipeline.scanAndPromote(doc.id),
      h.container.documentPipeline.scanAndPromote(doc.id),
    ]);
    expect(outcomes.filter((o) => o.outcome === 'available')).toHaveLength(1);
    expect(
      await auditFor(h.knex, { resource_id: doc.id, action: 'document.promoted' }),
    ).toHaveLength(1);
    expect(
      await auditFor(h.knex, { resource_id: doc.id, action: 'document.upload_completed' }),
    ).toHaveLength(1);

    // Crash after the copy, before the status commit: the row is left SCANNING.
    const crashed = await uploadDocument(h, patient, patient.patient.id, { scan: false });
    const row = await documentRow(h, crashed.id);
    await h.container.documentStorage.copyObject(row.quarantine_key, row.storage_key);
    await h.ownerKnex.raw("SELECT set_config('app.system_purpose', 'documents', false)");
    await h.ownerKnex('medical_documents').where({ id: crashed.id }).update({ status: 'scanning' });
    expect((await h.container.documentPipeline.scanAndPromote(crashed.id)).outcome).toBe(
      'available',
    );
  });

  it('stale upload intents are rejected by housekeeping', async () => {
    const pdf = FILES.pdf();
    const intent = expectOk(
      await api(h, patient).post(
        `/patients/${patient.patient.id}/documents/upload-intent`,
        intentBody(pdf),
      ),
      201,
    );
    await h
      .ownerKnex('medical_documents')
      .where({ id: intent.document.id })
      .update({ upload_expires_at: h.ownerKnex.raw("now() - interval '1 minute'") });
    await h.container.documentPipeline.expireStaleIntents();
    expect(await documentRow(h, intent.document.id)).toMatchObject({
      status: 'rejected',
      rejection_reason: 'upload_expired',
    });
  });
});

describe('consent lifecycle', () => {
  it('patient grants a scoped, expiring consent to a treating doctor only', async () => {
    const res = await grant(h, patient, {
      patientId: patient.patient.id,
      doctorId: doctor.doctor.id,
    });
    const consent = expectOk(res, 201);
    expect(consent).toMatchObject({
      status: 'active',
      kind: 'manual',
      scopes: ['medical_documents'],
      grantedBy: 'patient',
    });
    expect(new Date(consent.expiresAt).getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    expect(
      (await grant(h, patient, { patientId: patient.patient.id, doctorId: doctor.doctor.id })).body
        .code,
    ).toBe('consent_exists');
    expect(
      (await grant(h, patient, { patientId: patient.patient.id, doctorId: stranger.doctor.id }))
        .body.code,
    ).toBe('care_relationship_required');
    // Doctors cannot grant themselves access; strangers cannot grant for others.
    expect(
      (await grant(h, doctor, { patientId: patient.patient.id, doctorId: doctor.doctor.id }))
        .status,
    ).toBe(404);
    const received = expectOk(await api(h, doctor).get('/consents/received'));
    expect(received.map((c) => c.id)).toContain(consent.id);
    expect(
      expectOk(await api(h, otherTreating).get('/consents/received')).map((c) => c.id),
    ).not.toContain(consent.id);
    expect((await api(h, doctor).get(`/consents?patientId=${patient.patient.id}`)).status).toBe(
      404, // not the patient side: same as an unknown patient
    );
    const audit = await auditFor(h.knex, { action: 'consent.granted', resource_id: consent.id });
    expect(audit).toHaveLength(1);
  });

  it('guardians control consent for dependents; view-only guardians cannot', async () => {
    const paed = await createVerifiedDoctor(h, admin, 'rec-paed');
    await linkCare(h, guardian, paed, { patientId: child.id });
    const consent = expectOk(
      await grant(h, guardian, { patientId: child.id, doctorId: paed.doctor.id }),
      201,
    );
    expect(consent.grantedBy).toBe('guardian');
    const viewer = await createPatient(h, 'rec-view-guardian');
    await h.ownerKnex('patient_guardianships').insert({
      id: randomUUID(),
      patient_id: child.id,
      guardian_user_id: viewer.id,
      relationship_type: 'grandparent',
      access_scope: 'view',
      basis: 'legal_authority',
      started_at: new Date(),
      status: 'active',
      created_by_user_id: guardian.id,
    });
    expect((await api(h, viewer).post(`/consents/${consent.id}/revoke`, {})).status).toBe(404);
    expect(expectOk(await api(h, viewer).get(`/consents?patientId=${child.id}`))).toHaveLength(1);
    // A guardian of one child has no access to an unrelated patient.
    expect((await listDocs(guardian, patient.patient.id)).status).toBe(404);
    // Guardian uploads into the dependent's record.
    const doc = await uploadDocument(h, guardian, child.id);
    expect(doc.scan.outcome).toBe('available');
    expect((await documentRow(h, doc.id)).uploaded_by_relationship).toBe('guardian');
  });

  it('appointment-scoped consent ends with the appointment', async () => {
    const pt = await createPatient(h, 'rec-appt-pt');
    const dr = await createVerifiedDoctor(h, admin, 'rec-appt-doc');
    await linkCare(h, pt, dr);
    for (let weekday = 1; weekday <= 7; weekday += 1) {
      expectOk(
        await api(h, dr).post('/doctors/me/availability', {
          mode: 'online',
          weekday,
          startTime: '06:00',
          endTime: '22:00',
          slotMinutes: 15,
          validFrom: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
        }),
        201,
      );
    }
    const from = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    const [slot] = expectOk(
      await api(h, pt).get(`/doctors/${dr.doctor.id}/slots?from=${from}&to=${to}`),
    );
    const appt = expectOk(
      await api(h, pt).post('/appointments', {
        patientId: pt.patient.id,
        doctorId: dr.doctor.id,
        startsAt: slot.startsAt,
        mode: 'online',
        reason: 'Synthetic: review of reports',
      }),
      201,
    );
    const doc = await uploadDocument(h, pt, pt.patient.id);
    const consent = expectOk(
      await grant(h, pt, {
        patientId: pt.patient.id,
        doctorId: dr.doctor.id,
        kind: 'appointment',
        appointmentId: appt.id,
        purpose: 'consultation',
        expiresInDays: undefined,
      }),
      201,
    );
    expect(new Date(consent.expiresAt).getTime()).toBe(
      new Date(appt.endsAt).getTime() + 72 * 3_600_000,
    );
    expect((await getDoc(dr, doc.id)).status).toBe(200);
    expectOk(
      await api(h, pt).post(`/appointments/${appt.id}/cancel`, { reasonCode: 'patient_request' }),
    );
    expect((await getDoc(dr, doc.id)).status).toBe(403);
  });
});

describe('document access: permission + relationship + active consent + scope', () => {
  let consentId;
  beforeAll(async () => {
    consentId = expectOk(
      await grant(h, patient, {
        patientId: patient.patient.id,
        doctorId: otherTreating.doctor.id,
        documentTypes: ['lab_report'],
      }),
      201,
    ).id;
  });

  it('the patient sees everything; a consented doctor sees only available documents in scope', async () => {
    const own = expectOk(await listDocs(patient, patient.patient.id));
    expect(own.map((d) => d.status)).toEqual(expect.arrayContaining(['available', 'rejected']));
    const viewed = expectOk(await listDocs(otherTreating, patient.patient.id));
    expect(viewed.length).toBeGreaterThan(0);
    expect(viewed.every((d) => d.status === 'available' && d.documentType === 'lab_report')).toBe(
      true,
    );
    expect(viewed.map((d) => d.id)).toContain(docA);
    expect(viewed.map((d) => d.id)).not.toContain(docImaging);
    // Metadata only.
    expect(JSON.stringify(viewed)).not.toMatch(/quarantine\/|records\/|http|sha256/i);
    // Outside the consent's scope (document type): denied at gate 3.
    expect((await getDoc(otherTreating, docImaging)).body.code).toBe('consent_required');
    // In scope: view + download.
    expect((await getDoc(otherTreating, docA)).status).toBe(200);
    const dl = expectOk(await download(otherTreating, docA));
    expect(new Date(dl.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(
      h.config.documents.downloadUrlTtlSeconds * 1000 + 1000,
    );
    const file = await fetch(dl.url);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(
      (await auditFor(h.knex, { action: 'document.download_authorized', resource_id: docA }))[0]
        .metadata,
    ).not.toHaveProperty('url');
  });

  it('no consent, wrong scope, strangers, clinic and platform admins are all denied', async () => {
    // The first treating doctor has no consent for documents yet (its consent is created
    // in the lifecycle test above, so use a fresh treating doctor).
    const fresh = await createVerifiedDoctor(h, admin, 'rec-fresh');
    await linkCare(h, patient, fresh);
    expect((await listDocs(fresh, patient.patient.id)).body.code).toBe('consent_required');
    expect((await getDoc(fresh, docA)).body.code).toBe('consent_required');
    // Profile-only consent does not open documents.
    expectOk(
      await grant(h, patient, {
        patientId: patient.patient.id,
        doctorId: fresh.doctor.id,
        scopes: ['patient_profile'],
      }),
      201,
    );
    expect((await download(fresh, docA)).body.code).toBe('consent_required');
    // No relationship at all: indistinguishable from a missing document.
    const unrelated = await getDoc(stranger, docA);
    const missing = await getDoc(stranger, randomUUID());
    expect([unrelated.status, missing.status]).toEqual([404, 404]);
    expect(unrelated.body.detail).toBe(missing.body.detail);
    expect((await listDocs(stranger, patient.patient.id)).status).toBe(404);
    // Clinic and platform administrators have no medical-record permission.
    for (const who of [clinicAdmin, admin]) {
      expect((await listDocs(who, patient.patient.id)).status).toBe(403);
      expect((await getDoc(who, docA)).status).toBe(403);
    }
    // Another patient guessing ids.
    const other = await createPatient(h, 'rec-other');
    expect((await getDoc(other, docA)).status).toBe(404);
    expect((await listDocs(other, patient.patient.id)).status).toBe(404);
    const denied = await auditFor(h.knex, { action: 'document.access_denied' });
    expect(denied.length).toBeGreaterThan(0);
  });

  it('RLS blocks the same accesses when the application layer is bypassed', async () => {
    const visible = (userId) =>
      asUser(h, userId, (trx) =>
        trx('medical_documents')
          .where({ patient_id: patient.patient.id })
          .select('id', 'status', 'document_type'),
      );
    expect(await visible(stranger.id)).toHaveLength(0);
    expect(await visible(clinicAdmin.id)).toHaveLength(0);
    expect(await visible(admin.id)).toHaveLength(0);
    const consented = await visible(otherTreating.id);
    expect(
      consented.every((r) => r.status === 'available' && r.document_type === 'lab_report'),
    ).toBe(true);
    expect((await visible(patient.id)).length).toBeGreaterThan(consented.length);
    // Consents are visible to the patient side and the grantee only.
    expect(
      await asUser(h, stranger.id, (trx) => trx('consents').where({ id: consentId })),
    ).toHaveLength(0);
    // Users can never update documents: status, patient, storage key, uploader.
    for (const patch of [
      { status: 'available' },
      { patient_id: randomUUID() },
      { storage_key: 'records/x' },
      { uploaded_by_user_id: stranger.id },
    ]) {
      expect(
        await asUser(h, patient.id, (trx) =>
          trx('medical_documents').where({ id: docA }).update(patch),
        ),
      ).toBe(0);
    }
    // Inserting an already-AVAILABLE document is refused by policy.
    const id = randomUUID();
    await expect(
      asUser(h, patient.id, (trx) =>
        trx('medical_documents').insert({
          id,
          patient_id: patient.patient.id,
          uploaded_by_user_id: patient.id,
          uploaded_by_relationship: 'patient_self',
          document_type: 'other',
          title: 'x',
          original_filename: 'x.pdf',
          declared_content_type: 'application/pdf',
          declared_size_bytes: 10,
          declared_sha256: 'a'.repeat(64),
          quarantine_key: `quarantine/patients/${patient.patient.id}/documents/${id}/${'0'.repeat(32)}`,
          storage_key: `records/patients/${patient.patient.id}/documents/${id}/${'1'.repeat(32)}`,
          status: 'available',
          upload_expires_at: new Date(),
        }),
      ),
    ).rejects.toThrow(/row-level security/);
    // A user transaction cannot borrow the documents system purpose.
    const borrowed = await asUser(h, stranger.id, async (trx) => {
      await trx.raw("SELECT set_config('app.system_purpose', 'documents', true)");
      return trx('medical_documents').where({ patient_id: patient.patient.id });
    });
    expect(borrowed).toHaveLength(0);
    // Even the owner cannot rewrite identity columns or skip the lifecycle.
    await expect(
      h.ownerKnex('medical_documents').where({ id: docA }).update({ storage_key: 'records/evil' }),
    ).rejects.toThrow();
    await expect(
      h.ownerKnex('medical_documents').where({ id: docA }).update({ status: 'pending_upload' }),
    ).rejects.toThrow(/invalid medical document transition/);
    // The application role cannot delete records.
    await expect(h.knex.raw('DELETE FROM medical_documents WHERE id = ?', [docA])).rejects.toThrow(
      /permission denied/,
    );
  });

  it('storage: no anonymous access, no permanent URLs, signed URLs expire', async () => {
    const row = await documentRow(h, docA);
    const direct = await fetch(
      `${h.config.storage.endpoint}/${h.config.storage.documentsBucket}/${row.storage_key}`,
    );
    expect(direct.status).toBe(403);
    const short = await h.container.documentStorage.getDownloadUrl(row.storage_key, {
      filename: 'x.pdf',
      contentType: 'application/pdf',
      ttlSeconds: 1,
    });
    expect((await fetch(short.url)).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect((await fetch(short.url)).status).toBe(403);
  }, 20_000);
});

describe('revocation takes effect on the next request', () => {
  it('list/download work, revoke, then every new request is denied; issued URLs only live until their TTL', async () => {
    const pt = await createPatient(h, 'rev-pt');
    const dr = await createVerifiedDoctor(h, admin, 'rev-doc');
    await linkCare(h, pt, dr);
    const doc = await uploadDocument(h, pt, pt.patient.id);
    const consent = expectOk(
      await grant(h, pt, { patientId: pt.patient.id, doctorId: dr.doctor.id }),
      201,
    );

    expect(expectOk(await listDocs(dr, pt.patient.id)).map((d) => d.id)).toContain(doc.id);
    const issued = expectOk(await download(dr, doc.id));

    const revoked = expectOk(
      await api(h, pt).post(`/consents/${consent.id}/revoke`, { reasonCode: 'privacy' }),
    );
    expect(revoked.status).toBe('revoked');
    expect((await api(h, pt).post(`/consents/${consent.id}/revoke`, {})).body.code).toBe(
      'consent_not_active',
    );
    expect((await api(h, dr).post(`/consents/${consent.id}/revoke`, {})).status).toBe(404);

    // Next requests: denied (no cache).
    expect((await listDocs(dr, pt.patient.id)).body.code).toBe('consent_required');
    expect((await getDoc(dr, doc.id)).body.code).toBe('consent_required');
    expect((await download(dr, doc.id)).body.code).toBe('consent_required');
    expect(
      await asUser(h, dr.id, (trx) => trx('medical_documents').where({ id: doc.id })),
    ).toHaveLength(0);
    // The URL issued before revocation remains usable only until its short expiry
    // (documented limitation; TTL ≤ DOCUMENT_DOWNLOAD_URL_TTL_SECONDS).
    expect(new Date(issued.expiresAt).getTime()).toBeLessThanOrEqual(
      Date.now() + h.config.documents.downloadUrlTtlSeconds * 1000,
    );
    expect(
      await auditFor(h.knex, { action: 'consent.revoked', resource_id: consent.id }),
    ).toHaveLength(1);
  });

  it('an expired consent grants nothing, even before housekeeping marks it', async () => {
    const pt = await createPatient(h, 'exp-pt');
    const dr = await createVerifiedDoctor(h, admin, 'exp-doc');
    await linkCare(h, pt, dr);
    const doc = await uploadDocument(h, pt, pt.patient.id);
    const consent = expectOk(
      await grant(h, pt, { patientId: pt.patient.id, doctorId: dr.doctor.id }),
      201,
    );
    expect((await getDoc(dr, doc.id)).status).toBe(200);
    await h
      .ownerKnex('consents')
      .where({ id: consent.id })
      .update({
        granted_at: h.ownerKnex.raw("now() - interval '2 days'"),
        expires_at: h.ownerKnex.raw("now() - interval '1 minute'"),
      });
    expect((await getDoc(dr, doc.id)).body.code).toBe('consent_required');
    const listed = expectOk(await api(h, pt).get(`/consents?patientId=${pt.patient.id}`));
    expect(listed[0].status).toBe('expired');
    await h.container.consentService.expireDue();
    expect((await h.ownerKnex('consents').where({ id: consent.id }).first()).status).toBe(
      'expired',
    );
    expect(
      await auditFor(h.knex, { action: 'consent.expired', resource_id: consent.id }),
    ).toHaveLength(1);
    // The document itself remains stored and available to the patient.
    expect((await getDoc(pt, doc.id)).status).toBe(200);
  });
});

describe('doctor uploads and retirement', () => {
  it('a treating doctor uploads only with an upload-scoped consent', async () => {
    const pt = await createPatient(h, 'up-pt');
    const dr = await createVerifiedDoctor(h, admin, 'up-doc');
    await linkCare(h, pt, dr);
    const pdf = FILES.pdf();
    const path = `/patients/${pt.patient.id}/documents/upload-intent`;
    expect((await api(h, dr).post(path, intentBody(pdf))).body.code).toBe('consent_required');
    expectOk(
      await grant(h, pt, {
        patientId: pt.patient.id,
        doctorId: dr.doctor.id,
        scopes: ['medical_documents_upload'],
      }),
      201,
    );
    const doc = await uploadDocument(h, dr, pt.patient.id, { content: pdf });
    expect(doc.scan.outcome).toBe('available');
    const row = await documentRow(h, doc.id);
    expect(row.uploaded_by_relationship).toBe('treating_doctor');
    expect(row.uploader_consent_id).not.toBeNull();
    // Upload scope is not read scope.
    expect((await getDoc(dr, doc.id)).body.code).toBe('consent_required');
  });

  it('the patient retires a document: the record is kept, nobody else sees it', async () => {
    const doc = await uploadDocument(h, patient, patient.patient.id, {
      title: 'Synthetic old report',
    });
    expect((await api(h, otherTreating).post(`/documents/${doc.id}/retire`, {})).status).toBe(403);
    expect(expectOk(await api(h, patient).post(`/documents/${doc.id}/retire`, {})).status).toBe(
      'retired',
    );
    expect((await documentRow(h, doc.id)).status).toBe('retired');
    expect(expectOk(await listDocs(patient, patient.patient.id)).map((d) => d.id)).not.toContain(
      doc.id,
    );
    expect(
      expectOk(await listDocs(otherTreating, patient.patient.id)).map((d) => d.id),
    ).not.toContain(doc.id);
  });
});

describe('patient access log', () => {
  it('shows who did what in plain language, without internals', async () => {
    const page = await api(h, patient).get(`/patients/${patient.patient.id}/access-log?limit=100`);
    const items = expectOk(page);
    const text = items.map((i) => i.description);
    expect(text.some((t) => /Dr\. rec-doc2 downloaded “Synthetic CBC”/.test(t))).toBe(true);
    expect(text.some((t) => /You gave Dr\. rec-doc2 access/.test(t))).toBe(true);
    expect(text.some((t) => /You uploaded “Synthetic CBC”/.test(t))).toBe(true);
    expect(text.some((t) => /was denied access/.test(t))).toBe(true);
    // Strangers stay anonymous; no ids, IPs or raw metadata.
    expect(text.join(' ')).not.toContain('rec-stranger');
    const json = JSON.stringify(items);
    expect(json).not.toMatch(
      /"ip"|userAgent|requestId|metadata|resourceId|[0-9a-f]{8}-[0-9a-f]{4}-/,
    );
    // Only the patient side can read it.
    expect((await api(h, doctor).get(`/patients/${patient.patient.id}/access-log`)).status).toBe(
      404, // doctors also hold PATIENT; not the patient side → 404
    );
    expect((await api(h, guardian).get(`/patients/${patient.patient.id}/access-log`)).status).toBe(
      404,
    );
    expect((await api(h, admin).get(`/patients/${patient.patient.id}/access-log`)).status).toBe(
      403,
    );
  });
});
