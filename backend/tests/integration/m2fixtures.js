// M2 fixtures: everything is created through the public API (same validation,
// authorisation, RLS and auditing as production), never by writing tables directly.

import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { authHeader, createUser } from './harness.js';

let registrationCounter = 0;

export const api = (h, who) => ({
  get: (path) =>
    request(h.app)
      .get(`/api/v1${path}`)
      .set(who ? authHeader(who.session) : {}),
  post: (path, body) =>
    request(h.app)
      .post(`/api/v1${path}`)
      .set(who ? authHeader(who.session) : {})
      .send(body ?? {}),
  patch: (path, body) =>
    request(h.app)
      .patch(`/api/v1${path}`)
      .set(who ? authHeader(who.session) : {})
      .send(body),
  put: (path) =>
    request(h.app)
      .put(`/api/v1${path}`)
      .set(who ? authHeader(who.session) : {}),
});

export function expectOk(res, status = 200) {
  if (res.status !== status) {
    throw new Error(`expected ${status}, got ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return res.body.data;
}

export const profileInput = (fullName = 'Test Patient') => ({
  fullName,
  dateOfBirth: '1991-04-12',
  sex: 'female',
  phone: '+919800001111',
  city: 'Pune',
});

/** A user with a patient profile. */
export async function createPatient(h, label = 'patient') {
  const user = await createUser(h, { label });
  user.patient = expectOk(
    await api(h, user).post('/patients/me', profileInput(`${label} person`)),
    201,
  );
  return user;
}

export async function createPlatformAdmin(h, label = 'padmin') {
  return createUser(h, { label, roles: ['PLATFORM_ADMIN'] });
}

/** A user who applies as a doctor and is verified by `admin` (through the admin API). */
export async function createVerifiedDoctor(h, admin, label = 'doctor') {
  const user = await createUser(h, { label });
  registrationCounter += 1;
  const profile = expectOk(
    await api(h, user).post('/doctors/me', {
      professionalName: `Dr. ${label}`,
      registrationNumber: `TEST-${randomUUID().slice(0, 8)}-${registrationCounter}`,
      registrationCouncil: 'Test Medical Council',
      registrationYear: 2012,
      primarySpecialization: 'General Medicine',
      qualifications: [{ degree: 'MBBS', institution: 'Test College', year: 2011 }],
      yearsOfExperience: 10,
      languages: ['English'],
    }),
    201,
  );
  const kase = expectOk(await api(h, user).post('/doctors/me/verification'), 201);
  expectOk(await api(h, admin).post(`/admin/doctor-verifications/${kase.id}/start-review`));
  expectOk(
    await api(h, admin).post(`/admin/doctor-verifications/${kase.id}/decision`, {
      decision: 'verified',
      reasonCode: 'credentials_confirmed',
    }),
  );
  user.doctor = { ...profile, verificationStatus: 'verified' };
  user.caseId = kase.id;
  return user;
}

export async function createClinicWithAdmin(h, platformAdmin, label = 'clinic') {
  const clinic = expectOk(
    await api(h, platformAdmin).post('/admin/clinics', {
      name: `${label} ${randomUUID().slice(0, 6)}`,
      city: 'Pune',
    }),
    201,
  );
  const clinicAdmin = await createUser(h, { label: `${label}-admin` });
  // Model a staff account: clinic administrators hold only their clinic-scoped role.
  await h.container.repositories.roles.revoke(clinicAdmin.id, 'PATIENT');
  expectOk(
    await api(h, platformAdmin).post(`/admin/clinics/${clinic.id}/admins`, {
      userId: clinicAdmin.id,
    }),
    201,
  );
  return { clinic, clinicAdmin };
}

/** Patient requests the doctor, doctor accepts → ACTIVE. */
export async function linkCare(h, patient, doctor, { clinicId, patientId } = {}) {
  const rel = expectOk(
    await api(h, patient).post('/care-relationships', {
      patientId: patientId ?? patient.patient.id,
      doctorId: doctor.doctor.id,
      ...(clinicId ? { clinicId } : {}),
    }),
    201,
  );
  return expectOk(await api(h, doctor).post(`/care-relationships/${rel.id}/accept`));
}

export const randomId = () => randomUUID();
