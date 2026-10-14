import {
  PRACTICE_AREAS,
  doctorSearchCriteriaSchema,
  practiceAreaLabel,
} from '@healthbridge/shared';

const AREA_SPECIALTIES = new Map(PRACTICE_AREAS.map((a) => [a.code, a.specialties]));
// A close (not exact) name match must be this similar; below it, "Divya Reddy" would
// find "Kavya Reddy" — a different doctor.
const NAME_SIMILARITY = 0.7;

/**
 * Doctor search (M13.2): structured criteria over public doctor profiles, with a
 * transparent, deterministic ranking.
 *
 * - **Hard filters:** the one eligibility rule (ADR-0030: bookable doctor), specialty
 *   (canonical), city (an open practice site there), language, consultation mode (an
 *   active rule of that mode at an open site — in that city when one is given) and name.
 *   With areas but no specialty, the kinds of doctor that cover those areas.
 * - **Names:** names containing the text first; only when there are none, close matches
 *   (trigram word similarity), marked approximate so the caller can say so.
 * - **Ranking:** listed areas of practice that match, full-text relevance of the profile
 *   to the specialty and area names (never to patient wording), being in the patient's
 *   care team, then experience. Ties break by name and ID, so the order is stable.
 * - **Reasons:** every result says which criteria it meets, from the data matched.
 *
 * Returns `status: 'no_match'` when nothing meets the criteria. A failure (database
 * down, timeout) is thrown, so callers can tell "nobody matches" from "search failed".
 */
export function createDoctorSearchService({ knex }) {
  async function query(c, { areas, careTeamDoctorIds, approximateName }) {
    // Bindings are collected in the order the fragments appear in the SQL text, so every
    // fragment below is built in reading order: CTE, select list, WHERE, ORDER BY, LIMIT.
    const bindings = [];
    const p = (value) => {
      bindings.push(value);
      return '?';
    };

    const phrases = [c.specialty, ...areas.map(practiceAreaLabel)].filter(Boolean);
    const tsq = phrases.length
      ? phrases.map((phrase) => `plainto_tsquery('english', ${p(phrase)})`).join(' || ')
      : "''::tsquery";
    const selectInTeam = `d.id = ANY (${p(careTeamDoctorIds)}::uuid[])`;

    const where = ['authz.doctor_is_bookable(d.id)'];
    if (c.specialty) where.push(`${p(c.specialty)} = ANY (d.specialties)`);
    // Areas without a specialty: the kinds of doctor that cover those areas.
    if (!c.specialty && areas.length) {
      const covering = [...new Set(areas.flatMap((code) => AREA_SPECIALTIES.get(code) ?? []))];
      where.push(
        `(d.specialties && ${p(covering)}::text[] OR d.areas_of_practice && ${p(areas)}::text[])`,
      );
    }
    if (c.language) {
      where.push(
        `EXISTS (SELECT 1 FROM unnest(d.languages) l WHERE lower(l) = lower(${p(c.language)}))`,
      );
    }
    if (c.city) {
      where.push(`EXISTS (SELECT 1 FROM open_sites s
                           WHERE s.doctor_id = d.id AND lower(s.city) = lower(${p(c.city)}))`);
    }
    if (c.mode) {
      const mode = p(c.mode);
      const inCity =
        c.mode === 'in_clinic' && c.city ? `AND lower(oc.city) = lower(${p(c.city)})` : '';
      where.push(`EXISTS (SELECT 1 FROM offered o LEFT JOIN clinics oc ON oc.id = o.clinic_id
                           WHERE o.doctor_id = d.id AND o.mode = ${mode} ${inCity})`);
    }
    if (c.name && approximateName) {
      where.push(`word_similarity(${p(c.name)}, d.professional_name) >= ${NAME_SIMILARITY}`);
    } else if (c.name) {
      const pattern = `%${c.name.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
      where.push(`d.professional_name ILIKE ${p(pattern)}`);
    }
    if (c.excludeDoctorIds?.length) {
      where.push(`NOT (d.id = ANY (${p(c.excludeDoctorIds)}::uuid[]))`);
    }

    const orderName =
      c.name && approximateName ? `word_similarity(${p(c.name)}, d.professional_name) DESC,` : '';
    const orderAreas = `cardinality(ARRAY(SELECT unnest(d.areas_of_practice)
                                          INTERSECT SELECT unnest(${p(areas)}::text[])))`;
    const orderInTeam = `d.id = ANY (${p(careTeamDoctorIds)}::uuid[])`;
    const limit = p(c.limit);

    const sql = `WITH open_sites AS (
         SELECT d.id AS doctor_id, c.id, c.name, c.city
           FROM doctors d
           JOIN clinic_memberships m ON m.user_id = d.user_id
            AND m.member_role = 'DOCTOR' AND m.status = 'active'
           JOIN clinics c ON c.id = m.clinic_id AND c.status = 'active' AND c.deleted_at IS NULL
       ), offered AS (
         SELECT DISTINCT r.doctor_id, r.mode, r.clinic_id
           FROM availability_rules r
          WHERE r.status = 'active'
            AND (r.valid_until IS NULL OR r.valid_until >= current_date)
            AND authz.practice_site_open(r.doctor_id, r.clinic_id)
       ), q AS (SELECT ${tsq} AS tsq)
       SELECT d.id, d.professional_name, d.primary_specialization, d.specialties,
              d.areas_of_practice, d.languages, d.years_of_experience,
              coalesce((SELECT jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'city', s.city)
                                         ORDER BY s.name)
                          FROM open_sites s WHERE s.doctor_id = d.id), '[]') AS clinics,
              coalesce((SELECT array_agg(DISTINCT o.mode ORDER BY o.mode)
                          FROM offered o WHERE o.doctor_id = d.id), '{}') AS modes,
              ${selectInTeam} AS in_care_team
         FROM doctors d CROSS JOIN q
        WHERE ${where.join('\n          AND ')}
        ORDER BY ${orderName}
                 (2.0 * ${orderAreas}
                  + ts_rank_cd(d.search_document, q.tsq, 32)
                  + CASE WHEN ${orderInTeam} THEN 0.5 ELSE 0 END
                  + least(coalesce(d.years_of_experience, 0), 30) / 300.0) DESC,
                 d.professional_name, d.id
        LIMIT ${limit}`;
    // Guard: one binding per placeholder, so a reordering mistake fails loudly.
    if ((sql.match(/\?/g) ?? []).length !== bindings.length) {
      throw new Error('doctor search: bindings do not match placeholders');
    }
    const { rows } = await knex.raw(sql, bindings);
    return rows;
  }

  /**
   * @param {import('zod').input<typeof doctorSearchCriteriaSchema>} input
   * @param {{ careTeamDoctorIds?: string[] }} [context]
   */
  async function search(input, { careTeamDoctorIds = [] } = {}) {
    const c = doctorSearchCriteriaSchema.parse(input);
    const options = { areas: c.areas ?? [], careTeamDoctorIds, approximateName: false };
    let rows = await query(c, options);
    let approximateName = false;
    if (c.name && rows.length === 0) {
      approximateName = true;
      rows = await query(c, { ...options, approximateName });
    }
    const doctors = rows.map((row) => toResult(row, c, options.areas, approximateName));
    return { status: doctors.length ? 'ok' : 'no_match', doctors };
  }

  return { search };
}

/** The public result: profile facts plus the reasons it was suggested. */
function toResult(row, c, areas, approximateName) {
  const clinics = row.clinics ?? [];
  const matchedAreas = (row.areas_of_practice ?? []).filter((a) => areas.includes(a));
  const reasons = [];
  if (c.specialty) reasons.push({ code: 'specialty', value: c.specialty });
  for (const a of matchedAreas) reasons.push({ code: 'area', value: practiceAreaLabel(a) });
  if (c.city) {
    const site = clinics.find((s) => s.city?.toLowerCase() === c.city.toLowerCase());
    reasons.push({ code: 'city', value: site?.city ?? c.city });
  }
  if (c.language) {
    const spoken = (row.languages ?? []).find((l) => l.toLowerCase() === c.language.toLowerCase());
    reasons.push({ code: 'language', value: spoken ?? c.language });
  }
  if (c.mode) reasons.push({ code: 'mode', value: c.mode });
  if (c.name) {
    reasons.push({
      code: 'name',
      value: row.professional_name,
      ...(approximateName ? { approximate: true } : {}),
    });
  }
  if (row.in_care_team) reasons.push({ code: 'care_team', value: null });
  return {
    id: row.id,
    professionalName: row.professional_name,
    primarySpecialization: row.primary_specialization,
    specialties: row.specialties ?? [],
    areasOfPractice: row.areas_of_practice ?? [],
    languages: row.languages ?? [],
    yearsOfExperience: row.years_of_experience ?? null,
    clinics,
    modes: row.modes ?? [],
    reasons,
  };
}
