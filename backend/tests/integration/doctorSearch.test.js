import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PRACTICE_AREAS, SPECIALTY_TERMS, canonicalSpecialties } from '@healthbridge/shared';
import { createHarness } from './harness.js';
import {
  api,
  createClinicWithAdmin,
  createPatient,
  createPlatformAdmin,
  createVerifiedDoctor,
  expectOk,
} from './m2fixtures.js';

/**
 * M13.2 doctor search: structured criteria over public profiles, the one eligibility
 * rule (ADR-0030) at query time, a deterministic ranking and the reasons for each result.
 * Doctors here share a random made-up language, so other suites' doctors never interfere.
 */
let h;
let admin;
let patient;
beforeAll(async () => {
  h = await createHarness();
  admin = await createPlatformAdmin(h, 'search-admin');
  patient = await createPatient(h, 'search-pt');
});
afterAll(async () => {
  await h.close();
});

const isoDate = (offsetDays) =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
const letters = () =>
  Array.from({ length: 8 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join(
    '',
  );

async function publish(doctor, { mode, clinicId }) {
  expectOk(
    await api(h, doctor).post('/doctors/me/availability', {
      mode,
      ...(clinicId ? { clinicId } : {}),
      weekday: 1,
      startTime: mode === 'online' ? '14:00' : '09:00',
      endTime: mode === 'online' ? '18:00' : '13:00',
      slotMinutes: 15,
      validFrom: isoDate(-1),
    }),
    201,
  );
}

/** A verified doctor with the given profile, practising online and/or at a clinic. */
async function doctorWith(label, profile, { online = true, clinic } = {}) {
  const doctor = await createVerifiedDoctor(h, admin, label);
  expectOk(await api(h, doctor).patch('/doctors/me', profile));
  if (clinic) {
    const invite = expectOk(
      await api(h, clinic.clinicAdmin).post(`/clinics/${clinic.clinic.id}/doctors`, {
        doctorId: doctor.doctor.id,
      }),
      201,
    );
    expectOk(await api(h, doctor).post(`/clinic-memberships/${invite.id}/accept`));
    await publish(doctor, { mode: 'in_clinic', clinicId: clinic.clinic.id });
  }
  if (online) await publish(doctor, { mode: 'online' });
  return doctor;
}

const search = async (query) => {
  const res = await api(h, patient).get(`/doctors/search?${new URLSearchParams(query)}`);
  const list = expectOk(res);
  list.status = res.body.meta.status;
  return list;
};
const ids = (list) => list.map((d) => d.id);

describe('vocabulary', () => {
  it('the database tables are exactly the shared vocabulary', async () => {
    const terms = await h.ownerKnex('specialty_terms').select('term', 'specialty');
    const expected = Object.entries(SPECIALTY_TERMS).flatMap(([specialty, list]) =>
      list.map((term) => ({ term, specialty })),
    );
    const byTerm = (a, b) => a.term.localeCompare(b.term);
    expect(terms.sort(byTerm)).toEqual(expected.sort(byTerm));

    const areas = await h.ownerKnex('practice_areas').select('code', 'label', 'specialties');
    expect(areas.sort((a, b) => a.code.localeCompare(b.code))).toEqual(
      PRACTICE_AREAS.map((a) => ({
        code: a.code,
        label: a.label,
        specialties: [...a.specialties],
      })).sort((a, b) => a.code.localeCompare(b.code)),
    );
  });

  it('free-text specialisations map to canonical specialties the same way in SQL and JS', async () => {
    const samples = [
      'Consultant Dermatologist (MD)',
      'OB/GYN',
      'Chest Physician',
      'Skin & Hair specialist',
      'Paediatrician, Neonatologist',
      'Physician',
      'ENT surgeon',
      'Heart specialist',
      'Diabetologist',
      'Orthopaedic surgeon; sports medicine',
    ];
    for (const text of samples) {
      const { rows } = await h.ownerKnex.raw('SELECT doctor_canonical_specialties(?) AS s', [
        [text],
      ]);
      expect([...rows[0].s].sort(), text).toEqual([...canonicalSpecialties(text)].sort());
    }
  });
});

describe('GET /doctors/search', () => {
  let lang;
  let pune;
  let derm;
  let dermAcne;
  let gp;
  beforeAll(async () => {
    lang = letters();
    pune = await createClinicWithAdmin(h, admin, 'search-pune');
    derm = await doctorWith(
      `search-derm-${lang}`,
      { primarySpecialization: 'Consultant Dermatologist', languages: ['English', lang] },
      { clinic: pune, online: false },
    );
    dermAcne = await doctorWith(`search-acne-${lang}`, {
      primarySpecialization: 'Dermatology',
      languages: [lang, 'Hindi'],
      areasOfPractice: ['acne', 'eczema'],
    });
    gp = await doctorWith(`search-gp-${lang}`, {
      primarySpecialization: 'General Physician',
      languages: [lang],
    });
  });

  it('filters by canonical specialty, whatever the doctor wrote', async () => {
    const res = await search({ specialty: 'Dermatology', language: lang });
    expect(ids(res).sort()).toEqual([derm.doctor.id, dermAcne.doctor.id].sort());
    expect(res.status).toBe('ok');
    const found = res.find((d) => d.id === derm.doctor.id);
    expect(found.specialties).toEqual(['Dermatology']);
    expect(found.reasons).toContainEqual({ code: 'specialty', value: 'Dermatology' });
  });

  it('ranks listed areas of practice first, and says so', async () => {
    const res = await search({ specialty: 'Dermatology', areas: 'acne', language: lang });
    expect(res[0].id).toBe(dermAcne.doctor.id);
    expect(res[0].reasons).toContainEqual({ code: 'area', value: 'Acne' });
    expect(res[1].reasons.map((r) => r.code)).not.toContain('area');
  });

  it('areas without a specialty keep to the kinds of doctor that cover them', async () => {
    const res = await search({ areas: 'acne', language: lang });
    expect(ids(res)).not.toContain(gp.doctor.id);
    expect(ids(res)).toContain(dermAcne.doctor.id);
  });

  it('filters by city (an open practice site) and by consultation mode', async () => {
    expect(ids(await search({ city: 'pune', language: lang }))).toEqual([derm.doctor.id]);
    expect(ids(await search({ mode: 'in_clinic', city: 'Pune', language: lang }))).toEqual([
      derm.doctor.id,
    ]);
    const online = ids(await search({ mode: 'online', language: lang }));
    expect(online.sort()).toEqual([dermAcne.doctor.id, gp.doctor.id].sort());
    const res = await search({ city: 'Pune', language: lang });
    expect(res[0].reasons).toContainEqual({ code: 'city', value: 'Pune' });
    expect(res[0].clinics.map((c) => c.city)).toEqual(['Pune']);
    expect(res[0].modes).toEqual(['in_clinic']);
  });

  it('matches language case-insensitively and names approximately', async () => {
    expect(ids(await search({ language: lang.toUpperCase() })).length).toBe(3);
    const byName = await search({ name: `search-gp-${lang}`.slice(0, 18), language: lang });
    expect(ids(byName)).toEqual([gp.doctor.id]);
  });

  it('falls back to close name matches only when none contain the text, and says so', async () => {
    const tongue = letters();
    const kavya = await doctorWith('search-kavya', {
      professionalName: 'Dr. Kavya Reddy',
      languages: [tongue],
    });
    const exact = await search({ name: 'Kavya Reddy', language: tongue });
    expect(ids(exact)).toEqual([kavya.doctor.id]);
    expect(exact[0].reasons).toContainEqual({ code: 'name', value: 'Dr. Kavya Reddy' });
    const typo = await search({ name: 'Kavya Reddi', language: tongue });
    expect(ids(typo)).toEqual([kavya.doctor.id]);
    expect(typo[0].reasons).toContainEqual({
      code: 'name',
      value: 'Dr. Kavya Reddy',
      approximate: true,
    });
    // A different person with a similar name is not offered as a match.
    expect(ids(await search({ name: 'Divya Reddy', language: tongue }))).toEqual([]);
  });

  it('says when nobody matches (not an error)', async () => {
    const res = await search({ specialty: 'Cardiology', language: lang });
    expect([...res]).toEqual([]);
    expect(res.status).toBe('no_match');
  });

  it('applies the eligibility rule at query time', async () => {
    const other = letters();
    const clinic = await createClinicWithAdmin(h, admin, 'search-closing');
    const doctor = await doctorWith(
      `search-closing-${other}`,
      { primarySpecialization: 'Cardiology', languages: [other] },
      { clinic, online: true },
    );
    expect(ids(await search({ city: 'Pune', language: other }))).toEqual([doctor.doctor.id]);
    expectOk(
      await api(h, admin).patch(`/admin/clinics/${clinic.clinic.id}/status`, {
        status: 'inactive',
      }),
    );
    // The closed clinic no longer places the doctor in Pune; online practice continues.
    expect(ids(await search({ city: 'Pune', language: other }))).toEqual([]);
    expect(ids(await search({ mode: 'online', language: other }))).toEqual([doctor.doctor.id]);
    expectOk(
      await api(h, admin).patch(`/admin/users/${doctor.id}/status`, {
        status: 'disabled',
        reasonCode: 'security_concern',
      }),
    );
    expect(ids(await search({ language: other }))).toEqual([]);
  });

  it('refuses free text and unknown values', async () => {
    for (const query of [{ specialty: 'Astrology' }, { areas: 'bogus' }, { city: 'Pune; DROP' }]) {
      expect(
        (await api(h, patient).get(`/doctors/search?${new URLSearchParams(query)}`)).status,
      ).toBe(400);
    }
  });

  it('lets doctors list only known areas of practice', async () => {
    expect((await api(h, gp).patch('/doctors/me', { areasOfPractice: ['bogus'] })).status).toBe(
      400,
    );
    const profile = expectOk(
      await api(h, gp).patch('/doctors/me', { areasOfPractice: ['diabetes'] }),
    );
    expect(profile.areasOfPractice).toEqual(['diabetes']);
    expect(profile.specialties).toEqual(['General Medicine']);
  });
});

describe('vector ranking (hybrid)', () => {
  // A stand-in embedding model with a notion of meaning: words for the same idea share a
  // direction ("pimples" and "breakouts" sit with "acne"; "hair" and "scalp" together).
  const CONCEPTS = [/acne|pimple|breakout/i, /hair|scalp|transplant/i, /dermatolog/i];
  const embed = (text) => {
    const v = new Array(1024).fill(0);
    CONCEPTS.forEach((re, i) => {
      if (re.test(text)) v[i] = 1;
    });
    v[1023] = 0.01; // never the zero vector
    return v;
  };
  let down = false;
  const calls = [];
  const aiClient = {
    async embedPublic({ purpose, kind, texts }) {
      calls.push({ purpose, kind, count: texts.length });
      if (down) throw Object.assign(new Error('AI service responded 503'), { status: 503 });
      return { model: 'concept-test', dimensions: 1024, vectors: texts.map(embed) };
    },
  };
  let h2;
  let viewer;
  let tongue;
  let breakouts;
  let hair;
  beforeAll(async () => {
    h2 = await createHarness({ aiClient });
    const padmin = await createPlatformAdmin(h2, 'vector-admin');
    viewer = await createPatient(h2, 'vector-pt');
    tongue = letters();
    const make = async (label, bio) => {
      const doctor = await createVerifiedDoctor(h2, padmin, label);
      expectOk(
        await api(h2, doctor).patch('/doctors/me', {
          primarySpecialization: 'Dermatology',
          languages: [tongue],
          bio,
        }),
      );
      return doctor;
    };
    // Alphabetical order would put "alpha" first.
    hair = await make('vector-alpha', 'Hair transplant and scalp care.');
    breakouts = await make('vector-zeta', 'Treats pimples and breakouts in teenagers.');
  });
  afterAll(async () => {
    await h2.close();
  });
  const find = async (query) => {
    const res = await api(h2, viewer).get(`/doctors/search?${new URLSearchParams(query)}`);
    return { ids: expectOk(res).map((d) => d.id), ranking: res.body.meta.ranking };
  };

  it('ranks by meaning when the index has embeddings, and only re-embeds what changed', async () => {
    const before = await find({ specialty: 'Dermatology', areas: 'acne', language: tongue });
    expect(before.ranking).toBe('hybrid'); // the query embeds even before profiles do
    expect(before.ids).toEqual([hair.doctor.id, breakouts.doctor.id]); // no profile vectors yet

    const first = await h2.container.doctorSearchIndex.refresh({ limit: 5000 });
    expect(first.embedded).toBeGreaterThanOrEqual(2);
    const after = await find({ specialty: 'Dermatology', areas: 'acne', language: tongue });
    expect(after.ids).toEqual([breakouts.doctor.id, hair.doctor.id]);

    expect((await h2.container.doctorSearchIndex.refresh({ limit: 5000 })).embedded).toBe(0);
    expectOk(await api(h2, hair).patch('/doctors/me', { bio: 'Hair loss clinic.' }));
    expect((await h2.container.doctorSearchIndex.refresh({ limit: 5000 })).embedded).toBe(1);
    // Profiles are documents; the search query is built from vocabulary, not patient words.
    expect(calls.some((c) => c.purpose === 'doctor_profile' && c.kind === 'document')).toBe(true);
    expect(
      calls.filter((c) => c.purpose === 'doctor_search_query').every((c) => c.count === 1),
    ).toBe(true);
  });

  it('falls back to text ranking when embeddings are unavailable, never failing the search', async () => {
    down = true;
    const res = await find({ specialty: 'Dermatology', areas: 'eczema', language: tongue });
    down = false;
    expect(res.ranking).toBe('lexical');
    expect(res.ids.sort()).toEqual([breakouts.doctor.id, hair.doctor.id].sort());
  });
});
