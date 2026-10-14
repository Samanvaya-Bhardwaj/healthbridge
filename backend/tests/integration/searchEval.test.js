import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PRACTICE_AREAS } from '@healthbridge/shared';
import { buildPrincipal } from '../../src/core/authz/principal.js';
import { CITIES, prng, syntheticDirectory } from '../../scripts/lib/syntheticDirectory.js';
import { seedDirectory } from '../../scripts/lib/seedDirectory.js';
import { createHarness } from './harness.js';

/**
 * Held-out evaluation of doctor search (M13.2, step 11 of the delivery plan).
 *
 * - Data: a synthetic directory with its own seed (7: 10 cities × 5 doctors), never used
 *   to build or tune the search, seeded through the real services.
 * - Queries: generated from the dataset with another seed (99), never seen while tuning.
 * - Truth: computed from the generator's attributes (specialty, languages, city, practice,
 *   status, closed clinic) — NOT from the search's SQL — so the two are independent.
 * - Isolation: the search is limited to this dataset (`pool`), so other suites' doctors in
 *   the shared database cannot crowd the results.
 *
 * Limits (stated in docs/evaluations/DOCTOR_SEARCH.md): synthetic data, a small directory,
 * and lexical ranking only (no embedding provider in this harness).
 */
const DATASET = syntheticDirectory({ seed: 7, doctorsPerCity: 5, patientsPerCity: 0 });
const LIMIT = 10;
// The dataset's accounts are never signed in to; a fresh random password each run keeps any
// credential-looking literal out of the repository.
const PASSWORD = `${randomBytes(18).toString('base64url')}aA1`;

let h;
let ids; // dataset doctor key → database doctor id
let byId; // database doctor id → dataset doctor
beforeAll(async () => {
  h = await createHarness();
  // The dataset persists between runs (seeding is idempotent), so its clinics belong to a
  // persistent synthetic admin, not to a per-run test user that the harness deletes.
  const adminUser = await h.container.adminUserService.provisionUser({
    email: 'eval.admin@demo.healthbridge.local',
    fullName: 'Evaluation Admin (Demo)',
    password: PASSWORD,
    roles: ['PLATFORM_ADMIN'],
    isDemo: true,
  });
  const principalFor = async (userId) => {
    const user = await h.container.repositories.users.findById(userId);
    const grants = await h.container.repositories.roles.grantsFor(userId);
    return buildPrincipal({
      userId,
      sessionId: null,
      email: user.email,
      fullName: user.full_name,
      ...grants,
    });
  };
  await seedDirectory({
    container: h.container,
    knex: h.knex,
    admin: await principalFor(adminUser.id),
    password: PASSWORD,
    principalFor,
    dataset: DATASET,
  });
  ids = {};
  for (const d of DATASET.doctors) {
    const user = await h
      .ownerKnex('users')
      .where({ email: `${d.key}@demo.healthbridge.local` })
      .first('id');
    const doctor = await h.ownerKnex('doctors').where({ user_id: user.id }).first('id');
    ids[d.key] = doctor.id;
  }
  byId = new Map(DATASET.doctors.map((d) => [ids[d.key], d]));
}, 300_000);
afterAll(async () => {
  await h.close();
});

// ── Truth, from the generator's attributes only ──────────────────────────────
const closedClinics = new Set(DATASET.clinics.filter((c) => c.closed).map((c) => c.key));
const clinicCity = new Map(DATASET.clinics.map((c) => [c.key, c.city]));
const eligible = (d) => d.status === 'verified' && !d.suspended;
const openSite = (d) => d.clinicKey && !closedClinics.has(d.clinicKey);
function satisfies(d, q) {
  if (!eligible(d)) return false;
  if (q.specialty && d.specialty !== q.specialty) return false;
  if (q.language && !d.languages.some((l) => l.toLowerCase() === q.language.toLowerCase())) {
    return false;
  }
  if (q.city && !(openSite(d) && clinicCity.get(d.clinicKey) === q.city)) return false;
  if (q.mode === 'online' && !d.online) return false;
  if (q.mode === 'in_clinic') {
    if (!(d.inClinic && openSite(d))) return false;
    if (q.city && clinicCity.get(d.clinicKey) !== q.city) return false;
  }
  if (!q.specialty && q.areas?.length) {
    const kinds = new Set(
      PRACTICE_AREAS.filter((a) => q.areas.includes(a.code)).flatMap((a) => a.specialties),
    );
    if (!kinds.has(d.specialty) && !d.areasOfPractice.some((a) => q.areas.includes(a)))
      return false;
  }
  return true;
}

// ── Held-out queries ─────────────────────────────────────────────────────────
function queries() {
  const rand = prng(99);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const specialties = [...new Set(DATASET.doctors.map((d) => d.specialty))];
  const languages = [
    'English',
    'Hindi',
    'Marathi',
    'Tamil',
    'Kannada',
    'Bengali',
    'Malayalam',
    'Gujarati',
    'Telugu',
    'Urdu',
  ];
  const out = [];
  // 70 "positive" queries, each built from a real doctor's attributes (≥ 1 correct answer).
  const bookable = DATASET.doctors.filter(eligible);
  for (let i = 0; i < 70; i += 1) {
    const d = pick(bookable);
    const q = {};
    if (rand() < 0.8) q.specialty = d.specialty;
    if (openSite(d) && rand() < 0.5) q.city = clinicCity.get(d.clinicKey);
    if (rand() < 0.3) q.language = pick(d.languages);
    if (rand() < 0.3) {
      const offered = [d.online && 'online', d.inClinic && openSite(d) && 'in_clinic'].filter(
        Boolean,
      );
      if (offered.length) q.mode = pick(offered);
    }
    if (d.areasOfPractice.length && rand() < 0.5) q.areas = [pick(d.areasOfPractice)];
    if (!Object.keys(q).length) q.specialty = d.specialty;
    out.push(q);
  }
  // 30 random combinations (often nobody matches: tests the no-match answer).
  for (let i = 0; i < 30; i += 1) {
    const q = {};
    if (rand() < 0.75) q.specialty = pick(specialties);
    if (rand() < 0.4) {
      const fitting = PRACTICE_AREAS.filter(
        (a) => !q.specialty || a.specialties.includes(q.specialty),
      );
      if (fitting.length) q.areas = [pick(fitting).code];
    }
    if (rand() < 0.6) q.city = pick(CITIES).city;
    if (rand() < 0.35) q.language = pick(languages);
    if (rand() < 0.35) q.mode = rand() < 0.5 ? 'online' : 'in_clinic';
    if (!Object.keys(q).length) q.city = pick(CITIES).city;
    out.push(q);
  }
  // Names: exact and with one typo, for verified doctors.
  for (const d of bookable.slice(0, 10)) {
    out.push({ name: d.professionalName.replace(/^Dr[.] /, ''), expect: d.key });
    const typo = d.professionalName.replace(/^Dr[.] /, '').replace(/([aeiou])(?!.*[aeiou])/, 'y');
    out.push({ name: typo, expect: d.key, approximate: true });
  }
  return out;
}

describe('doctor search: held-out evaluation', () => {
  it('meets its quality bars on synthetic held-out queries', async () => {
    const pool = Object.values(ids);
    const metrics = {
      queries: 0,
      results: 0,
      constraintViolations: 0,
      eligibilityViolations: 0,
      recallNumerator: 0,
      recallDenominator: 0,
      noMatchCorrect: 0,
      areaQueries: 0,
      areaReciprocalRank: 0,
      nameQueries: 0,
      nameReciprocalRank: 0,
    };
    for (const q of queries()) {
      const { expect: expected, approximate: _a, ...criteria } = q;
      const res = await h.container.doctorSearchService.search(
        { ...criteria, limit: LIMIT },
        { pool },
      );
      metrics.queries += 1;
      const returned = res.doctors.map((r) => byId.get(r.id));
      metrics.results += returned.length;

      if (expected) {
        metrics.nameQueries += 1;
        const rank = res.doctors.findIndex((r) => r.id === ids[expected]);
        metrics.nameReciprocalRank += rank >= 0 ? 1 / (rank + 1) : 0;
        continue;
      }
      for (const d of returned) {
        if (!eligible(d)) metrics.eligibilityViolations += 1;
        else if (!satisfies(d, criteria)) metrics.constraintViolations += 1;
      }
      const relevant = DATASET.doctors.filter((d) => satisfies(d, criteria));
      const found = returned.filter((d) => relevant.includes(d)).length;
      metrics.recallNumerator += found;
      metrics.recallDenominator += Math.min(relevant.length, LIMIT);
      if ((relevant.length === 0) === (res.status === 'no_match')) metrics.noMatchCorrect += 1;

      // Ranking: when some relevant doctor lists the area, one of them should come first.
      if (criteria.areas && relevant.some((d) => d.areasOfPractice.includes(criteria.areas[0]))) {
        metrics.areaQueries += 1;
        const rank = returned.findIndex((d) => d.areasOfPractice.includes(criteria.areas[0]));
        metrics.areaReciprocalRank += rank >= 0 ? 1 / (rank + 1) : 0;
      }
    }
    const report = {
      dataset: {
        doctors: DATASET.doctors.length,
        bookable: DATASET.doctors.filter(eligible).length,
        clinics: DATASET.clinics.length,
        closedClinics: closedClinics.size,
      },
      queries: metrics.queries,
      resultsReturned: metrics.results,
      constraintPrecision: 1 - metrics.constraintViolations / Math.max(1, metrics.results),
      eligibilityViolations: metrics.eligibilityViolations,
      recallAt10: metrics.recallNumerator / Math.max(1, metrics.recallDenominator),
      noMatchAccuracy: metrics.noMatchCorrect / (metrics.queries - metrics.nameQueries),
      areaMRR: metrics.areaReciprocalRank / Math.max(1, metrics.areaQueries),
      areaQueries: metrics.areaQueries,
      nameMRR: metrics.nameReciprocalRank / Math.max(1, metrics.nameQueries),
      nameQueries: metrics.nameQueries,
    };
    console.log(JSON.stringify({ doctorSearchEvaluation: report }));

    expect(report.eligibilityViolations).toBe(0);
    expect(report.constraintPrecision).toBe(1);
    expect(report.recallAt10).toBe(1);
    expect(report.noMatchAccuracy).toBe(1);
    expect(report.areaMRR).toBeGreaterThanOrEqual(0.95);
    expect(report.nameMRR).toBeGreaterThanOrEqual(0.95);
  }, 300_000);
});
