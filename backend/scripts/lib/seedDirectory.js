import { ROLES } from '@healthbridge/shared';
import { prng, syntheticDirectory } from './syntheticDirectory.js';

const DOMAIN = 'demo.healthbridge.local';
const email = (local) => `${local}@${DOMAIN}`;
const isoDay = (offsetDays) =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

/**
 * Seeds the synthetic directory (scripts/lib/syntheticDirectory.js) through the real
 * services, so every row passes the same validation, authorisation and audit as the app.
 * Idempotent: existing accounts, profiles, memberships, rules and relationships are kept.
 *
 * @param {{ container: object, knex: import('knex').Knex, admin: object, password: string,
 *           principalFor: (userId: string) => Promise<object>, log: Function }} deps
 */
export async function seedDirectory({
  container,
  knex,
  admin,
  password,
  principalFor,
  log = () => {},
  dataset = syntheticDirectory(),
}) {
  const { clinics, doctors, patients } = dataset;
  const svc = container;
  const repos = container.repositories;

  // ── Clinics ─────────────────────────────────────────────────────
  const clinicIds = {};
  for (const c of clinics) {
    let row = await knex('clinics').where({ name: c.name }).whereNull('deleted_at').first();
    if (!row) {
      row = await svc.clinicService.createClinic(admin, {
        name: c.name,
        city: c.city,
        state: c.state,
        postalCode: c.postalCode,
        phone: '+910000000000',
      });
      await knex('clinics').where({ id: row.id }).update({ is_demo: true });
    }
    clinicIds[c.key] = row.id;
  }
  log('directory clinics ready', { count: clinics.length });

  // ── Doctors: apply → verify → join a clinic → publish availability ──
  const doctorIds = {};
  for (const d of doctors) {
    const { id: userId } = await svc.adminUserService.provisionUser({
      email: email(d.key),
      fullName: `${d.professionalName.replace(/^Dr\. /, '')} (Demo Doctor)`,
      password,
      roles: [ROLES.PATIENT],
      isDemo: true,
    });
    let doctor = await repos.doctors.findByUserId(userId);
    let principal = await principalFor(userId);
    if (!doctor) {
      await svc.doctorService.createOwnProfile(
        principal,
        {
          professionalName: d.professionalName,
          registrationNumber: `DEMO-${d.key
            .replace(/[^a-z0-9]/g, '')
            .slice(-14)
            .toUpperCase()}`,
          registrationCouncil: 'Demo Medical Council (synthetic)',
          registrationYear: 2025 - d.yearsOfExperience,
          primarySpecialization: d.primarySpecialization,
          qualifications: [
            {
              degree: 'MBBS',
              institution: 'Demo Medical College',
              year: 2024 - d.yearsOfExperience,
            },
          ],
          yearsOfExperience: d.yearsOfExperience,
          languages: d.languages,
          areasOfPractice: d.areasOfPractice,
          bio: d.bio,
        },
        undefined,
        { isDemo: true },
      );
      doctor = await repos.doctors.findByUserId(userId);
    }
    doctorIds[d.key] = doctor.id;
    if (d.status === 'applicant') continue;
    if (doctor.verification_status === 'unverified') {
      const kase = await svc.doctorService.submitForVerification(principal);
      await svc.doctorService.startReview(admin, kase.id);
      await svc.doctorService.decide(admin, kase.id, {
        decision: 'verified',
        reasonCode: 'credentials_confirmed',
        notes: 'Synthetic demo account.',
      });
      doctor = await repos.doctors.findByUserId(userId);
    }
    if (doctor.verification_status !== 'verified') continue;
    principal = await principalFor(userId);
    // ADR-0038: most directory doctors accept new patients automatically, so the
    // assistant can book them in one conversation; about one in five accepts personally.
    const accepts = !/[05]$/.test(d.key);
    if (Boolean(doctor.accepts_new_patients) !== accepts) {
      await svc.doctorService.updateOwnProfile(principal, { acceptsNewPatients: accepts });
    }

    if (d.clinicKey) {
      const clinicId = clinicIds[d.clinicKey];
      const member = await knex('clinic_memberships')
        .where({ user_id: userId, clinic_id: clinicId, member_role: 'DOCTOR' })
        .whereIn('status', ['invited', 'active'])
        .first();
      if (!member) {
        const invite = await svc.clinicService.inviteDoctor(admin, clinicId, doctor.id);
        await svc.clinicService.respondToInvitation(principal, invite.id, true);
      } else if (member.status === 'invited') {
        await svc.clinicService.respondToInvitation(principal, member.id, true);
      }
    }
    if ((await svc.availabilityService.listRules(principal)).length === 0) {
      const base = { timezone: 'Asia/Kolkata', validFrom: isoDay(0) };
      if (d.online) {
        for (const weekday of [1, 2, 3, 4, 5]) {
          await svc.availabilityService.createRule(principal, {
            ...base,
            mode: 'online',
            weekday,
            startTime: '09:00',
            endTime: '12:00',
            slotMinutes: 15,
            feePaise: d.onlineFeePaise,
          });
        }
      }
      if (d.inClinic && d.clinicKey) {
        for (const weekday of [1, 3, 5, 6]) {
          await svc.availabilityService.createRule(principal, {
            ...base,
            mode: 'in_clinic',
            clinicId: clinicIds[d.clinicKey],
            weekday,
            startTime: '17:00',
            endTime: '20:00',
            slotMinutes: 20,
            feePaise: d.clinicFeePaise,
          });
        }
      }
    }
  }
  log('directory doctors ready', { count: doctors.length });

  // ── Patients: profiles, dependents, care teams and upcoming visits ──
  const bookable = doctors.filter((d) => d.status === 'verified' && !d.suspended);
  for (const p of patients) {
    const { id: userId } = await svc.adminUserService.provisionUser({
      email: email(p.key),
      fullName: `${p.fullName} (Demo Patient)`,
      password,
      roles: [ROLES.PATIENT],
      isDemo: true,
    });
    const principal = await principalFor(userId);
    let profile = await svc.patientService.getOwnProfile(principal).catch(() => null);
    if (!profile) {
      profile = await svc.patientService.createOwnProfile(
        principal,
        { fullName: p.fullName, dateOfBirth: p.dateOfBirth, city: p.city, state: p.state },
        undefined,
        { isDemo: true },
      );
    }
    if (p.dependent && (await svc.patientService.listDependents(principal)).length === 0) {
      await svc.patientService.createDependent(principal, p.dependent, undefined, { isDemo: true });
    }
    // The same doctors every run: chosen by a PRNG seeded from the patient's key.
    const rand = prng([...p.key].reduce((s, ch) => s * 31 + ch.charCodeAt(0), 7));
    const local = bookable.filter((d) => d.city === p.city);
    const team = [...local].sort(() => rand() - 0.5).slice(0, p.careTeamSize);
    const existing = await svc.careService.listForPatient(principal, profile.id);
    for (const [k, d] of team.entries()) {
      const doctorId = doctorIds[d.key];
      if (existing.some((r) => r.doctorId === doctorId)) continue;
      const request = await svc.careService.request(principal, { patientId: profile.id, doctorId });
      // The third request of a large care team is left pending (shows that state).
      if (k < 2) {
        const doctorUser = await repos.doctors.findById(doctorId);
        await svc.careService.act(await principalFor(doctorUser.user_id), request.id, 'accept');
      }
    }
    if (p.books && team[0]) {
      const upcoming = await svc.appointmentService.listForPatient(principal, {
        scope: 'upcoming',
      });
      if (upcoming.length === 0) {
        const doctorId = doctorIds[team[0].key];
        const mode = team[0].online ? 'online' : 'in_clinic';
        const slots = await svc.availabilityService.slots(principal, doctorId, {
          from: isoDay(1),
          to: isoDay(10),
          mode,
        });
        const slot = slots[Math.floor(rand() * Math.min(slots.length, 12))];
        if (slot) {
          await svc.appointmentService.book(principal, {
            patientId: profile.id,
            doctorId,
            startsAt: slot.startsAt,
            mode,
            ...(slot.clinicId ? { clinicId: slot.clinicId } : {}),
            reason: 'Synthetic demo: routine consultation',
          });
        }
      }
    }
  }
  log('directory patients ready', { count: patients.length });

  // ── After the fact: one suspended doctor, one closed clinic (eligibility demo) ──
  for (const d of doctors.filter((x) => x.suspended)) {
    const row = await repos.doctors.findById(doctorIds[d.key]);
    if (row?.verification_status === 'verified') {
      await svc.doctorService.suspend(admin, row.id, {
        reasonCode: 'other',
        notes: 'Synthetic demo: suspended profile.',
      });
    }
  }
  for (const c of clinics.filter((x) => x.closed)) {
    const row = await knex('clinics').where({ id: clinicIds[c.key] }).first();
    if (row.status === 'active') await svc.clinicService.setClinicStatus(admin, row.id, 'inactive');
  }
  log('directory ready', {
    clinics: clinics.length,
    doctors: doctors.length,
    patients: patients.length,
  });
}
