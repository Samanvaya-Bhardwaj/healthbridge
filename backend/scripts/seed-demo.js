#!/usr/bin/env node
// Seeds SYNTHETIC demo data through the real application services (same validation,
// authorisation, RLS and auditing as the API). Never real people or real health data.
// Runs only with DEMO_MODE=true outside production. Idempotent.
//
//   npm run seed:demo -w backend
//
// Accounts use DEMO_USER_PASSWORD from .env and the non-routable demo.healthbridge.local
// domain; all rows are flagged is_demo where the schema supports it.

import { ROLES } from '@healthbridge/shared';
import { buildPrincipal } from '../src/core/authz/principal.js';
import { AppError } from '../src/core/http/errors.js';
import { createScriptRuntime } from './lib/runtime.js';

const DEMO_DOMAIN = 'demo.healthbridge.local';
const email = (local) => `${local}@${DEMO_DOMAIN}`;

const DEMO_USERS = [
  { local: 'patient.asha', fullName: 'Asha Rao (Demo Patient)', roles: [ROLES.PATIENT] },
  { local: 'patient.vikram', fullName: 'Vikram Singh (Demo Patient)', roles: [ROLES.PATIENT] },
  // Doctors register like anyone else; the DOCTOR role comes only from verification.
  { local: 'dr.meera', fullName: 'Meera Iyer (Demo Doctor)', roles: [ROLES.PATIENT] },
  { local: 'dr.rahul', fullName: 'Rahul Menon (Demo Doctor)', roles: [ROLES.PATIENT] },
  { local: 'dr.applicant', fullName: 'Farah Khan (Demo Applicant)', roles: [ROLES.PATIENT] },
  // Clinic administrators hold only their clinic-scoped role.
  { local: 'clinic.admin', fullName: 'Kiran Patel (Demo Clinic Admin)', roles: [] },
  {
    local: 'platform.admin',
    fullName: 'Neha Joshi (Demo Platform Admin)',
    roles: [ROLES.PLATFORM_ADMIN],
  },
  { local: 'support', fullName: 'Arjun Das (Demo Support)', roles: [ROLES.SUPPORT] },
];

const DOCTOR_PROFILES = {
  'dr.meera': {
    professionalName: 'Dr. Meera Iyer',
    registrationNumber: 'DEMO-MH-10421',
    registrationCouncil: 'Demo Medical Council (synthetic)',
    registrationYear: 2011,
    primarySpecialization: 'General Medicine',
    additionalSpecializations: ['Diabetology'],
    qualifications: [{ degree: 'MBBS', institution: 'Demo Medical College', year: 2010 }],
    yearsOfExperience: 14,
    languages: ['English', 'Hindi', 'Marathi'],
    bio: 'Synthetic demo profile. Family physician focused on long-term care.',
  },
  'dr.rahul': {
    professionalName: 'Dr. Rahul Menon',
    registrationNumber: 'DEMO-KL-20877',
    registrationCouncil: 'Demo Medical Council (synthetic)',
    registrationYear: 2015,
    primarySpecialization: 'Paediatrics',
    qualifications: [
      { degree: 'MBBS', institution: 'Demo Medical College', year: 2013 },
      { degree: 'MD Paediatrics', institution: 'Demo Institute', year: 2016 },
    ],
    yearsOfExperience: 9,
    languages: ['English', 'Malayalam'],
    bio: 'Synthetic demo profile.',
  },
  'dr.applicant': {
    professionalName: 'Dr. Farah Khan',
    registrationNumber: 'DEMO-DL-30555',
    registrationCouncil: 'Demo Medical Council (synthetic)',
    registrationYear: 2020,
    primarySpecialization: 'Dermatology',
    qualifications: [{ degree: 'MBBS', institution: 'Demo Medical College', year: 2019 }],
    yearsOfExperience: 4,
    languages: ['English', 'Urdu'],
  },
};

const runtime = createScriptRuntime('seed-demo');
const { config, container, knex } = runtime;
const log = (msg, extra = {}) => console.log(JSON.stringify({ msg, ...extra }));

/** Runs a step; "already done" conflicts make the seed idempotent. */
async function step(name, fn) {
  try {
    const result = await fn();
    log(`${name}: done`);
    return result;
  } catch (err) {
    if (err instanceof AppError && err.status === 409) {
      log(`${name}: already present`);
      return null;
    }
    throw err;
  }
}

async function principalFor(userId) {
  const user = await container.repositories.users.findById(userId);
  const grants = await container.repositories.roles.grantsFor(userId);
  return buildPrincipal({
    userId,
    sessionId: null,
    email: user.email,
    fullName: user.full_name,
    ...grants,
  });
}

try {
  if (!config.demoMode || config.isProduction) {
    throw new Error('Demo seeding requires DEMO_MODE=true and a non-production APP_ENV.');
  }
  const password = process.env.DEMO_USER_PASSWORD;
  if (!password)
    throw new Error('DEMO_USER_PASSWORD is not set (run node scripts/generate-env.mjs --update).');

  const ids = {};
  for (const user of DEMO_USERS) {
    const result = await container.adminUserService.provisionUser({
      email: email(user.local),
      fullName: user.fullName,
      password,
      roles: user.roles,
      isDemo: true,
    });
    ids[user.local] = result.id;
  }
  log('demo accounts ready', { count: DEMO_USERS.length });
  const admin = await principalFor(ids['platform.admin']);

  // ── Clinic + clinic administrator ─────────────────────────────
  let clinic = await knex('clinics')
    .where({ name: 'Sunrise Family Clinic (Demo)' })
    .whereNull('deleted_at')
    .first();
  if (!clinic) {
    clinic = await container.clinicService.createClinic(admin, {
      name: 'Sunrise Family Clinic (Demo)',
      city: 'Pune',
      state: 'Maharashtra',
      postalCode: '411001',
      phone: '+912000000000',
    });
    await knex('clinics').where({ id: clinic.id }).update({ is_demo: true });
  }
  await container.clinicService.appointAdmin(admin, clinic.id, ids['clinic.admin']);
  log('clinic ready', { clinic: 'Sunrise Family Clinic (Demo)' });

  // ── Doctors: apply → submit → review → verify ─────────────────
  for (const local of ['dr.meera', 'dr.rahul', 'dr.applicant']) {
    let doctorPrincipal = await principalFor(ids[local]);
    await step(`${local} profile`, () =>
      container.doctorService.createOwnProfile(doctorPrincipal, DOCTOR_PROFILES[local], undefined, {
        isDemo: true,
      }),
    );
    const doctor = await container.repositories.doctors.findByUserId(ids[local]);
    if (doctor.verification_status === 'unverified') {
      const kase = await container.doctorService.submitForVerification(doctorPrincipal);
      if (local !== 'dr.applicant') {
        await container.doctorService.startReview(admin, kase.id);
        await container.doctorService.decide(admin, kase.id, {
          decision: 'verified',
          reasonCode: 'credentials_confirmed',
          notes: 'Synthetic demo account.',
        });
      }
    }
    if (local !== 'dr.applicant') {
      doctorPrincipal = await principalFor(ids[local]);
      const membership = await step(`${local} clinic invitation`, () =>
        container.clinicService.inviteDoctor(admin, clinic.id, doctor.id),
      );
      if (membership)
        await container.clinicService.respondToInvitation(doctorPrincipal, membership.id, true);
    }
  }

  // ── Patients, a dependent, and care relationships ─────────────
  const asha = await principalFor(ids['patient.asha']);
  const vikram = await principalFor(ids['patient.vikram']);
  const ashaProfile =
    (await step('asha profile', () =>
      container.patientService.createOwnProfile(
        asha,
        {
          fullName: 'Asha Rao',
          dateOfBirth: '1990-05-14',
          sex: 'female',
          phone: '+919800000001',
          city: 'Pune',
          state: 'Maharashtra',
          preferredLanguage: 'en-IN',
          emergencyContactName: 'Rohan Rao (Demo)',
          emergencyContactPhone: '+919800000002',
          emergencyContactRelationship: 'spouse',
        },
        undefined,
        { isDemo: true },
      ),
    )) ?? (await container.patientService.getOwnProfile(asha));
  const vikramProfile =
    (await step('vikram profile', () =>
      container.patientService.createOwnProfile(
        vikram,
        { fullName: 'Vikram Singh', dateOfBirth: '1985-11-02', sex: 'male', city: 'Pune' },
        undefined,
        { isDemo: true },
      ),
    )) ?? (await container.patientService.getOwnProfile(vikram));

  const dependents = await container.patientService.listDependents(asha);
  if (!dependents.some((d) => d.fullName === 'Kamala Rao')) {
    await container.patientService.createDependent(
      asha,
      {
        fullName: 'Kamala Rao',
        dateOfBirth: '1958-03-21',
        sex: 'female',
        relationshipType: 'child',
      },
      undefined,
      { isDemo: true },
    );
  }
  log('patients ready');

  const meera = await container.repositories.doctors.findByUserId(ids['dr.meera']);
  const meeraPrincipal = await principalFor(ids['dr.meera']);
  const request = await step('asha → dr.meera care request', () =>
    container.careService.request(asha, {
      patientId: ashaProfile.id,
      doctorId: meera.id,
      clinicId: clinic.id,
    }),
  );
  if (request) await container.careService.act(meeraPrincipal, request.id, 'accept');
  await step('vikram → dr.meera care request (left pending)', () =>
    container.careService.request(vikram, {
      patientId: vikramProfile.id,
      doctorId: meera.id,
      clinicId: clinic.id,
    }),
  );

  // ── Availability and a synthetic upcoming appointment (M3) ────
  const IN_CLINIC_FEE_PAISE = 50_000; // ₹500, synthetic
  const meeraNow = await principalFor(ids['dr.meera']);
  const existingRules = await container.availabilityService.listRules(meeraNow);
  if (existingRules.length === 0) {
    const today = new Date().toISOString().slice(0, 10);
    for (const weekday of [1, 2, 3, 4, 5]) {
      await container.availabilityService.createRule(meeraNow, {
        mode: 'online',
        weekday,
        startTime: '09:00',
        endTime: '12:00',
        slotMinutes: 15,
        timezone: 'Asia/Kolkata',
        validFrom: today,
        feePaise: 0,
      });
      await container.availabilityService.createRule(meeraNow, {
        mode: 'in_clinic',
        clinicId: clinic.id,
        weekday,
        startTime: '17:00',
        endTime: '19:00',
        slotMinutes: 20,
        timezone: 'Asia/Kolkata',
        validFrom: today,
        feePaise: IN_CLINIC_FEE_PAISE,
      });
    }
    log('dr.meera availability published');
  }
  // M4: in-clinic visits carry a synthetic fee (paid with the fake provider; no money moves).
  // Databases seeded before M4 get their free in-clinic rules replaced once.
  for (const rule of (await container.availabilityService.listRules(meeraNow)).filter(
    (r) => r.mode === 'in_clinic' && r.status === 'active' && r.feePaise === 0,
  )) {
    await container.availabilityService.archiveRule(meeraNow, rule.id);
    const { id: _id, doctorId: _doctor, status: _status, ...input } = rule;
    await container.availabilityService.createRule(meeraNow, {
      ...input,
      validUntil: input.validUntil ?? undefined,
      feePaise: IN_CLINIC_FEE_PAISE,
    });
    log('dr.meera in-clinic fee set', { weekday: rule.weekday });
  }
  const upcoming = await container.appointmentService.listForPatient(asha, { scope: 'upcoming' });
  if (upcoming.length === 0) {
    const from = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 8 * 86_400_000).toISOString().slice(0, 10);
    const [slot] = await container.availabilityService.slots(asha, meera.id, {
      from,
      to,
      mode: 'online',
    });
    if (slot) {
      await container.appointmentService.book(asha, {
        patientId: ashaProfile.id,
        doctorId: meera.id,
        startsAt: slot.startsAt,
        mode: 'online',
        reason: 'Synthetic demo: follow-up on blood sugar readings',
      });
      log('asha appointment booked', { startsAt: slot.startsAt });
    }
  }

  // ── M5: a synthetic consent (documents are added through the app) ──
  const ashaConsents = await container.consentService.listForPatient(asha, ashaProfile.id);
  if (!ashaConsents.some((c) => c.status === 'active' && c.doctor.id === meera.id)) {
    await container.consentService.grant(asha, {
      patientId: ashaProfile.id,
      doctorId: meera.id,
      kind: 'manual',
      scopes: ['patient_profile', 'medical_documents'],
      purpose: 'ongoing_care',
      expiresInDays: 90,
    });
    log('asha granted dr.meera document access (90 days)');
  }

  // ── M6: Asha opts in to AI reading of her (synthetic) documents ──
  const aiSetting = await container.intelligenceService.getAiProcessing(asha, ashaProfile.id);
  if (!aiSetting.enabled) {
    await container.intelligenceService.setAiProcessing(asha, ashaProfile.id, { enabled: true });
    log('asha enabled AI document processing');
  }

  log('demo seed complete', { password: 'DEMO_USER_PASSWORD from .env' });
} catch (err) {
  console.error(
    JSON.stringify({
      level: 'fatal',
      msg: 'demo seed failed',
      error: err.message,
      details: err.extensions,
    }),
  );
  process.exitCode = 1;
} finally {
  await runtime.close();
}
