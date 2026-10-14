/**
 * M13.2: doctor search (metadata + full text). Public, professional data only.
 *
 * - `specialty_terms`: the words doctors use for their specialisation, mapped to the
 *   canonical specialties people search by. `practice_areas`: the areas a doctor may list.
 *   Both are a frozen copy of @healthbridge/shared (doctorSearch.js) at this migration; an
 *   integration test fails if the shared vocabulary and these tables ever differ, so a
 *   vocabulary change ships with its own migration.
 * - `doctors.specialties` (canonical, maintained by a trigger from the free-text
 *   specialisations), `doctors.areas_of_practice` (chosen by the doctor) and
 *   `doctors.search_document` (weighted full text: name and specialties A, areas B,
 *   qualifications C, bio D), backfilled here.
 * - The search itself applies the one eligibility rule (ADR-0030) at query time; nothing
 *   here decides who is bookable.
 */

const SPECIALTY_TERMS = [
  ['general medicine', 'General Medicine'],
  ['general physician', 'General Medicine'],
  ['internal medicine', 'General Medicine'],
  ['internist', 'General Medicine'],
  ['consultant physician', 'General Medicine'],
  ['gp', 'General Medicine'],
  ['general practice', 'General Medicine'],
  ['general practitioner', 'General Medicine'],
  ['family medicine', 'Family Medicine'],
  ['family physician', 'Family Medicine'],
  ['family doctor', 'Family Medicine'],
  ['family practice', 'Family Medicine'],
  ['dermatology', 'Dermatology'],
  ['dermatologist', 'Dermatology'],
  ['skin', 'Dermatology'],
  ['venereology', 'Dermatology'],
  ['cosmetology', 'Dermatology'],
  ['trichology', 'Dermatology'],
  ['paediatrics', 'Paediatrics'],
  ['pediatrics', 'Paediatrics'],
  ['paediatrician', 'Paediatrics'],
  ['pediatrician', 'Paediatrics'],
  ['child specialist', 'Paediatrics'],
  ['neonatology', 'Paediatrics'],
  ['neonatologist', 'Paediatrics'],
  ['gynaecology', 'Gynaecology'],
  ['gynecology', 'Gynaecology'],
  ['gynaecologist', 'Gynaecology'],
  ['gynecologist', 'Gynaecology'],
  ['obstetrics', 'Gynaecology'],
  ['obstetrician', 'Gynaecology'],
  ['obgyn', 'Gynaecology'],
  ['ob gyn', 'Gynaecology'],
  ['cardiology', 'Cardiology'],
  ['cardiologist', 'Cardiology'],
  ['heart specialist', 'Cardiology'],
  ['orthopaedics', 'Orthopaedics'],
  ['orthopedics', 'Orthopaedics'],
  ['orthopaedic', 'Orthopaedics'],
  ['orthopedic', 'Orthopaedics'],
  ['orthopaedician', 'Orthopaedics'],
  ['bone specialist', 'Orthopaedics'],
  ['sports medicine', 'Orthopaedics'],
  ['ent', 'ENT'],
  ['otorhinolaryngology', 'ENT'],
  ['otolaryngology', 'ENT'],
  ['ear nose throat', 'ENT'],
  ['ear nose and throat', 'ENT'],
  ['ophthalmology', 'Ophthalmology'],
  ['ophthalmologist', 'Ophthalmology'],
  ['eye specialist', 'Ophthalmology'],
  ['eye surgeon', 'Ophthalmology'],
  ['psychiatry', 'Psychiatry'],
  ['psychiatrist', 'Psychiatry'],
  ['mental health', 'Psychiatry'],
  ['neurology', 'Neurology'],
  ['neurologist', 'Neurology'],
  ['gastroenterology', 'Gastroenterology'],
  ['gastroenterologist', 'Gastroenterology'],
  ['hepatology', 'Gastroenterology'],
  ['hepatologist', 'Gastroenterology'],
  ['endocrinology', 'Endocrinology'],
  ['endocrinologist', 'Endocrinology'],
  ['diabetology', 'Endocrinology'],
  ['diabetologist', 'Endocrinology'],
  ['pulmonology', 'Pulmonology'],
  ['pulmonologist', 'Pulmonology'],
  ['chest physician', 'Pulmonology'],
  ['respiratory medicine', 'Pulmonology'],
  ['pulmonary medicine', 'Pulmonology'],
];

const PRACTICE_AREAS = [
  ['acne', 'Acne', ['Dermatology']],
  ['eczema', 'Eczema and dermatitis', ['Dermatology']],
  ['psoriasis', 'Psoriasis', ['Dermatology']],
  ['hair_loss', 'Hair loss', ['Dermatology']],
  ['skin_allergies', 'Skin allergies and rashes', ['Dermatology']],
  ['pigmentation', 'Pigmentation', ['Dermatology']],
  ['fever_infections', 'Fever and infections', ['General Medicine', 'Family Medicine']],
  ['diabetes', 'Diabetes', ['General Medicine', 'Family Medicine', 'Endocrinology']],
  ['blood_pressure', 'Blood pressure', ['General Medicine', 'Family Medicine', 'Cardiology']],
  ['health_checkups', 'Health check-ups', ['General Medicine', 'Family Medicine']],
  [
    'weight_lifestyle',
    'Weight and lifestyle',
    ['General Medicine', 'Family Medicine', 'Endocrinology'],
  ],
  ['elderly_care', 'Elderly care', ['General Medicine', 'Family Medicine']],
  ['long_term_conditions', 'Long-term conditions', ['General Medicine', 'Family Medicine']],
  ['child_growth', 'Child growth and development', ['Paediatrics']],
  ['vaccinations', 'Vaccinations', ['Paediatrics', 'Family Medicine']],
  ['newborn_care', 'Newborn care', ['Paediatrics']],
  ['childhood_infections', 'Childhood infections', ['Paediatrics']],
  ['pregnancy_care', 'Pregnancy care', ['Gynaecology']],
  ['menstrual_health', 'Menstrual health', ['Gynaecology']],
  ['fertility', 'Fertility', ['Gynaecology']],
  ['menopause', 'Menopause', ['Gynaecology']],
  ['pcos', 'PCOS', ['Gynaecology', 'Endocrinology']],
  ['heart_rhythm', 'Heart rhythm', ['Cardiology']],
  ['heart_failure', 'Heart failure', ['Cardiology']],
  ['cholesterol', 'Cholesterol', ['Cardiology', 'General Medicine', 'Endocrinology']],
  ['cardiac_rehab', 'Cardiac rehabilitation', ['Cardiology']],
  ['joint_pain', 'Joint pain', ['Orthopaedics']],
  ['back_neck_pain', 'Back and neck pain', ['Orthopaedics', 'Neurology']],
  ['sports_injuries', 'Sports injuries', ['Orthopaedics']],
  ['fractures', 'Fractures', ['Orthopaedics']],
  ['arthritis', 'Arthritis', ['Orthopaedics', 'General Medicine']],
  ['ear_hearing', 'Ear problems and hearing', ['ENT']],
  ['sinus', 'Sinus problems', ['ENT']],
  ['throat_voice', 'Throat and voice', ['ENT']],
  ['snoring', 'Snoring', ['ENT', 'Pulmonology']],
  ['vision', 'Vision and glasses', ['Ophthalmology']],
  ['cataract', 'Cataract', ['Ophthalmology']],
  ['glaucoma', 'Glaucoma', ['Ophthalmology']],
  ['eye_infections', 'Eye infections', ['Ophthalmology']],
  ['anxiety', 'Anxiety', ['Psychiatry']],
  ['depression', 'Depression', ['Psychiatry']],
  ['sleep', 'Sleep problems', ['Psychiatry', 'Neurology', 'Pulmonology']],
  ['addiction', 'Addiction', ['Psychiatry']],
  ['headache_migraine', 'Headaches and migraine', ['Neurology', 'General Medicine']],
  ['epilepsy', 'Epilepsy', ['Neurology']],
  ['nerve_pain', 'Nerve pain', ['Neurology']],
  ['memory', 'Memory problems', ['Neurology', 'Psychiatry']],
  ['acidity_reflux', 'Acidity and reflux', ['Gastroenterology', 'General Medicine']],
  ['bowel_problems', 'Bowel problems', ['Gastroenterology']],
  ['liver', 'Liver conditions', ['Gastroenterology']],
  ['stomach_pain', 'Stomach pain', ['Gastroenterology', 'General Medicine']],
  ['thyroid', 'Thyroid', ['Endocrinology', 'General Medicine']],
  ['hormones', 'Hormone problems', ['Endocrinology']],
  ['asthma', 'Asthma', ['Pulmonology', 'Paediatrics']],
  ['copd', 'COPD', ['Pulmonology']],
  ['long_cough', 'Long-lasting cough', ['Pulmonology', 'General Medicine']],
  ['breathing_allergies', 'Breathing allergies', ['Pulmonology', 'ENT']],
];

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  for (const [term] of SPECIALTY_TERMS) {
    if (!/^[a-z]+( [a-z]+)*$/.test(term)) throw new Error(`Invalid specialty term: ${term}`);
  }
  await knex.raw(`
    CREATE TABLE specialty_terms (
      term text PRIMARY KEY CHECK (term ~ '^[a-z]+( [a-z]+)*$'),
      specialty text NOT NULL
    );
    CREATE TABLE practice_areas (
      code text PRIMARY KEY CHECK (code ~ '^[a-z_]{2,40}$'),
      label text NOT NULL,
      specialties text[] NOT NULL
    );

    ALTER TABLE doctors
      ADD COLUMN specialties text[] NOT NULL DEFAULT '{}',
      ADD COLUMN areas_of_practice text[] NOT NULL DEFAULT '{}',
      ADD COLUMN search_document tsvector,
      ADD CONSTRAINT doctors_areas_bounded CHECK (cardinality(areas_of_practice) <= 8);
  `);
  await knex('specialty_terms').insert(
    SPECIALTY_TERMS.map(([term, specialty]) => ({ term, specialty })),
  );
  await knex('practice_areas').insert(
    PRACTICE_AREAS.map(([code, label, specialties]) => ({ code, label, specialties })),
  );
  await knex.raw(`
    -- Free text → canonical specialties: whole words after punctuation becomes spaces.
    CREATE FUNCTION doctor_canonical_specialties(p_texts text[]) RETURNS text[]
      LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $fn$
      SELECT coalesce(array_agg(DISTINCT t.specialty ORDER BY t.specialty), '{}')
        FROM specialty_terms t
       WHERE EXISTS (
         SELECT 1 FROM unnest(p_texts) x
          WHERE ' ' || trim(regexp_replace(lower(x), '[^a-z]+', ' ', 'g')) || ' '
                LIKE '% ' || t.term || ' %')
    $fn$;

    CREATE FUNCTION doctors_search_maintain() RETURNS trigger
      LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$
    BEGIN
      IF EXISTS (SELECT 1 FROM unnest(NEW.areas_of_practice) a
                  WHERE a NOT IN (SELECT code FROM practice_areas)) THEN
        RAISE EXCEPTION 'unknown area of practice' USING ERRCODE = 'check_violation',
          CONSTRAINT = 'doctors_areas_known';
      END IF;
      NEW.specialties := doctor_canonical_specialties(
        array_prepend(NEW.primary_specialization, coalesce(NEW.additional_specializations, '{}')));
      NEW.search_document :=
        setweight(to_tsvector('english', coalesce(NEW.professional_name, '')), 'A')
        || setweight(to_tsvector('english', concat_ws(' ', NEW.primary_specialization,
             array_to_string(coalesce(NEW.additional_specializations, '{}'), ' '),
             array_to_string(NEW.specialties, ' '))), 'A')
        || setweight(to_tsvector('english', coalesce((
             SELECT string_agg(p.label, ' ') FROM practice_areas p
              WHERE p.code = ANY (NEW.areas_of_practice)), '')), 'B')
        || setweight(to_tsvector('english', coalesce((
             SELECT string_agg(q->>'degree', ' ')
               FROM jsonb_array_elements(coalesce(NEW.qualifications, '[]'::jsonb)) q), '')), 'C')
        || setweight(to_tsvector('english', coalesce(NEW.bio, '')), 'D');
      RETURN NEW;
    END $fn$;
    CREATE TRIGGER doctors_search_maintain BEFORE INSERT OR UPDATE OF
      professional_name, primary_specialization, additional_specializations,
      areas_of_practice, qualifications, bio ON doctors
      FOR EACH ROW EXECUTE FUNCTION doctors_search_maintain();

    -- Backfill through the trigger.
    UPDATE doctors SET professional_name = professional_name;

    CREATE INDEX doctors_search_document_idx ON doctors USING gin (search_document);
    CREATE INDEX doctors_specialties_idx ON doctors USING gin (specialties);
    CREATE INDEX doctors_areas_idx ON doctors USING gin (areas_of_practice);
    CREATE INDEX doctors_name_trgm_idx ON doctors USING gin (professional_name gin_trgm_ops);
    CREATE INDEX clinics_city_lower_idx ON clinics (lower(city));
  `);
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.raw(`
    DROP INDEX IF EXISTS clinics_city_lower_idx;
    DROP TRIGGER IF EXISTS doctors_search_maintain ON doctors;
    DROP FUNCTION IF EXISTS doctors_search_maintain();
    DROP FUNCTION IF EXISTS doctor_canonical_specialties(text[]);
    ALTER TABLE doctors
      DROP CONSTRAINT IF EXISTS doctors_areas_bounded,
      DROP COLUMN IF EXISTS search_document,
      DROP COLUMN IF EXISTS areas_of_practice,
      DROP COLUMN IF EXISTS specialties;
    DROP TABLE IF EXISTS practice_areas;
    DROP TABLE IF EXISTS specialty_terms;
  `);
}
