import { z } from 'zod';

/**
 * Doctor search vocabulary (M13.2). Public, professional data only.
 *
 * - SPECIALTY_TERMS map the free text doctors write as their specialisation
 *   ("Consultant Dermatologist", "Skin specialist") to the canonical specialties people
 *   search by. The database seeds `specialty_terms` from this list, and a trigger keeps
 *   each doctor's canonical `specialties` in step with the profile text.
 * - PRACTICE_AREAS are the areas a doctor chooses to list on their profile. They describe
 *   the doctor's practice, never a patient's condition. `specialties` says which kinds of
 *   doctor usually cover an area: a search keeps only areas that fit its specialty.
 *
 * Terms and labels are lower-case letters and spaces, matched as whole words after
 * punctuation is turned into spaces, so "OB/GYN" matches "ob gyn".
 */
export const SPECIALTY_TERMS = Object.freeze({
  'General Medicine': [
    'general medicine',
    'general physician',
    'internal medicine',
    'internist',
    'consultant physician',
    'gp',
    'general practice',
    'general practitioner',
  ],
  'Family Medicine': ['family medicine', 'family physician', 'family doctor', 'family practice'],
  Dermatology: ['dermatology', 'dermatologist', 'skin', 'venereology', 'cosmetology', 'trichology'],
  Paediatrics: [
    'paediatrics',
    'pediatrics',
    'paediatrician',
    'pediatrician',
    'child specialist',
    'neonatology',
    'neonatologist',
  ],
  Gynaecology: [
    'gynaecology',
    'gynecology',
    'gynaecologist',
    'gynecologist',
    'obstetrics',
    'obstetrician',
    'obgyn',
    'ob gyn',
  ],
  Cardiology: ['cardiology', 'cardiologist', 'heart specialist'],
  Orthopaedics: [
    'orthopaedics',
    'orthopedics',
    'orthopaedic',
    'orthopedic',
    'orthopaedician',
    'bone specialist',
    'sports medicine',
  ],
  ENT: ['ent', 'otorhinolaryngology', 'otolaryngology', 'ear nose throat', 'ear nose and throat'],
  Ophthalmology: ['ophthalmology', 'ophthalmologist', 'eye specialist', 'eye surgeon'],
  Psychiatry: ['psychiatry', 'psychiatrist', 'mental health'],
  Neurology: ['neurology', 'neurologist'],
  Gastroenterology: ['gastroenterology', 'gastroenterologist', 'hepatology', 'hepatologist'],
  Endocrinology: ['endocrinology', 'endocrinologist', 'diabetology', 'diabetologist'],
  Pulmonology: [
    'pulmonology',
    'pulmonologist',
    'chest physician',
    'respiratory medicine',
    'pulmonary medicine',
  ],
});

/** The canonical specialties people search by (the assistant re-exports this list). */
export const DOCTOR_SPECIALTIES = Object.freeze(Object.keys(SPECIALTY_TERMS));

const S = (...names) => Object.freeze(names);

/** Areas of practice a doctor can list (code, label, specialties that usually cover it). */
export const PRACTICE_AREAS = Object.freeze(
  [
    ['acne', 'Acne', S('Dermatology')],
    ['eczema', 'Eczema and dermatitis', S('Dermatology')],
    ['psoriasis', 'Psoriasis', S('Dermatology')],
    ['hair_loss', 'Hair loss', S('Dermatology')],
    ['skin_allergies', 'Skin allergies and rashes', S('Dermatology')],
    ['pigmentation', 'Pigmentation', S('Dermatology')],
    ['fever_infections', 'Fever and infections', S('General Medicine', 'Family Medicine')],
    ['diabetes', 'Diabetes', S('General Medicine', 'Family Medicine', 'Endocrinology')],
    ['blood_pressure', 'Blood pressure', S('General Medicine', 'Family Medicine', 'Cardiology')],
    ['health_checkups', 'Health check-ups', S('General Medicine', 'Family Medicine')],
    [
      'weight_lifestyle',
      'Weight and lifestyle',
      S('General Medicine', 'Family Medicine', 'Endocrinology'),
    ],
    ['elderly_care', 'Elderly care', S('General Medicine', 'Family Medicine')],
    ['long_term_conditions', 'Long-term conditions', S('General Medicine', 'Family Medicine')],
    ['child_growth', 'Child growth and development', S('Paediatrics')],
    ['vaccinations', 'Vaccinations', S('Paediatrics', 'Family Medicine')],
    ['newborn_care', 'Newborn care', S('Paediatrics')],
    ['childhood_infections', 'Childhood infections', S('Paediatrics')],
    ['pregnancy_care', 'Pregnancy care', S('Gynaecology')],
    ['menstrual_health', 'Menstrual health', S('Gynaecology')],
    ['fertility', 'Fertility', S('Gynaecology')],
    ['menopause', 'Menopause', S('Gynaecology')],
    ['pcos', 'PCOS', S('Gynaecology', 'Endocrinology')],
    ['heart_rhythm', 'Heart rhythm', S('Cardiology')],
    ['heart_failure', 'Heart failure', S('Cardiology')],
    ['cholesterol', 'Cholesterol', S('Cardiology', 'General Medicine', 'Endocrinology')],
    ['cardiac_rehab', 'Cardiac rehabilitation', S('Cardiology')],
    ['joint_pain', 'Joint pain', S('Orthopaedics')],
    ['back_neck_pain', 'Back and neck pain', S('Orthopaedics', 'Neurology')],
    ['sports_injuries', 'Sports injuries', S('Orthopaedics')],
    ['fractures', 'Fractures', S('Orthopaedics')],
    ['arthritis', 'Arthritis', S('Orthopaedics', 'General Medicine')],
    ['ear_hearing', 'Ear problems and hearing', S('ENT')],
    ['sinus', 'Sinus problems', S('ENT')],
    ['throat_voice', 'Throat and voice', S('ENT')],
    ['snoring', 'Snoring', S('ENT', 'Pulmonology')],
    ['vision', 'Vision and glasses', S('Ophthalmology')],
    ['cataract', 'Cataract', S('Ophthalmology')],
    ['glaucoma', 'Glaucoma', S('Ophthalmology')],
    ['eye_infections', 'Eye infections', S('Ophthalmology')],
    ['anxiety', 'Anxiety', S('Psychiatry')],
    ['depression', 'Depression', S('Psychiatry')],
    ['sleep', 'Sleep problems', S('Psychiatry', 'Neurology', 'Pulmonology')],
    ['addiction', 'Addiction', S('Psychiatry')],
    ['headache_migraine', 'Headaches and migraine', S('Neurology', 'General Medicine')],
    ['epilepsy', 'Epilepsy', S('Neurology')],
    ['nerve_pain', 'Nerve pain', S('Neurology')],
    ['memory', 'Memory problems', S('Neurology', 'Psychiatry')],
    ['acidity_reflux', 'Acidity and reflux', S('Gastroenterology', 'General Medicine')],
    ['bowel_problems', 'Bowel problems', S('Gastroenterology')],
    ['liver', 'Liver conditions', S('Gastroenterology')],
    ['stomach_pain', 'Stomach pain', S('Gastroenterology', 'General Medicine')],
    ['thyroid', 'Thyroid', S('Endocrinology', 'General Medicine')],
    ['hormones', 'Hormone problems', S('Endocrinology')],
    ['asthma', 'Asthma', S('Pulmonology', 'Paediatrics')],
    ['copd', 'COPD', S('Pulmonology')],
    ['long_cough', 'Long-lasting cough', S('Pulmonology', 'General Medicine')],
    ['breathing_allergies', 'Breathing allergies', S('Pulmonology', 'ENT')],
  ].map(([code, label, specialties]) => Object.freeze({ code, label, specialties })),
);

export const PRACTICE_AREA_CODES = Object.freeze(PRACTICE_AREAS.map((a) => a.code));
const AREA_BY_CODE = new Map(PRACTICE_AREAS.map((a) => [a.code, a]));

export const practiceAreaLabel = (code) => AREA_BY_CODE.get(code)?.label ?? null;

/** Whether an area fits a specialty (no specialty: every area fits). */
export const areaFitsSpecialty = (code, specialty) =>
  !specialty || (AREA_BY_CODE.get(code)?.specialties.includes(specialty) ?? false);

const words = (text) =>
  ` ${String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z]+/g, ' ')
    .trim()} `;

/**
 * Canonical specialties named in free text (the same whole-word rule as the database
 * trigger, so tests can check the two agree).
 */
export function canonicalSpecialties(...texts) {
  const haystack = texts.flat().map(words).join('|');
  return DOCTOR_SPECIALTIES.filter((specialty) =>
    SPECIALTY_TERMS[specialty].some((term) => haystack.includes(` ${term} `)),
  );
}

export const CONSULTATION_MODES = Object.freeze(['online', 'in_clinic']);

const place = (max) =>
  z
    .string()
    .trim()
    .regex(/^[A-Za-z][A-Za-z .'-]{1,39}$/)
    .max(max);

/** Structured doctor search: every field narrows the result; none is free text. */
export const doctorSearchCriteriaSchema = z
  .object({
    specialty: z.enum(DOCTOR_SPECIALTIES).optional(),
    areas: z.array(z.enum(PRACTICE_AREA_CODES)).max(3).optional(),
    city: place(40).optional(),
    language: z
      .string()
      .trim()
      .regex(/^[A-Za-z][A-Za-z ]{1,29}$/)
      .optional(),
    mode: z.enum(CONSULTATION_MODES).optional(),
    name: z
      .string()
      .trim()
      .regex(/^[A-Za-z][A-Za-z .'-]{1,59}$/)
      .optional(),
    excludeDoctorIds: z.array(z.uuid()).max(20).optional(),
    limit: z.number().int().min(1).max(10).default(5),
  })
  .strict();

/** Why a doctor was suggested: each reason names a criterion the doctor actually meets. */
export const SEARCH_REASONS = Object.freeze([
  'specialty',
  'area',
  'city',
  'language',
  'mode',
  'name',
  'care_team',
  'available_soon',
]);
