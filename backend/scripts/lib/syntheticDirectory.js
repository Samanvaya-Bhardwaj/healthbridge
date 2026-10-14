import { PRACTICE_AREAS } from '@healthbridge/shared';

/**
 * A deterministic, SYNTHETIC doctor directory for demos and search evaluation: cities,
 * clinics, doctors (with the free-text specialisations, languages, areas of practice and
 * lay-language bios people really write) and patients. Never real people.
 *
 * It is a pure function of its seed, so the seed script and the search evaluation see
 * the same data, and evaluation labels come from these attributes — not from the search
 * implementation being evaluated.
 */

/** Small, fast, seedable PRNG (mulberry32). */
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const CITIES = Object.freeze([
  { city: 'Pune', state: 'Maharashtra', language: 'Marathi', postalCode: '411001', north: true },
  { city: 'Mumbai', state: 'Maharashtra', language: 'Marathi', postalCode: '400001', north: true },
  { city: 'Delhi', state: 'Delhi', language: 'Punjabi', postalCode: '110001', north: true },
  {
    city: 'Bengaluru',
    state: 'Karnataka',
    language: 'Kannada',
    postalCode: '560001',
    north: false,
  },
  { city: 'Chennai', state: 'Tamil Nadu', language: 'Tamil', postalCode: '600001', north: false },
  { city: 'Hyderabad', state: 'Telangana', language: 'Telugu', postalCode: '500001', north: false },
  { city: 'Kolkata', state: 'West Bengal', language: 'Bengali', postalCode: '700001', north: true },
  { city: 'Ahmedabad', state: 'Gujarat', language: 'Gujarati', postalCode: '380001', north: true },
  { city: 'Jaipur', state: 'Rajasthan', language: 'Hindi', postalCode: '302001', north: true },
  { city: 'Kochi', state: 'Kerala', language: 'Malayalam', postalCode: '682001', north: false },
]);

const CLINIC_WORDS = [
  ['Sunrise', 'Lotus', 'Riverside', 'Green Park', 'Harbour', 'Hilltop', 'Banyan', 'Lakeview'],
  ['Health Centre', 'Family Clinic', 'Care Clinic', 'Polyclinic', 'Medical Centre'],
];

/** Specialty → [weight, ways doctors write it]. */
const SPECIALTIES = {
  'General Medicine': [
    3,
    ['General Medicine', 'General Physician', 'Internal Medicine', 'Consultant Physician'],
  ],
  'Family Medicine': [1, ['Family Medicine', 'Family Physician']],
  Dermatology: [
    1.5,
    ['Dermatology', 'Dermatologist', 'Consultant Dermatologist', 'Skin Specialist (Dermatology)'],
  ],
  Paediatrics: [
    1.5,
    ['Paediatrics', 'Pediatrician', 'Child Specialist', 'Paediatrician and Neonatologist'],
  ],
  Gynaecology: [1.2, ['Gynaecology', 'Obstetrics and Gynaecology', 'OB/GYN', 'Gynecologist']],
  Cardiology: [1, ['Cardiology', 'Cardiologist', 'Heart Specialist']],
  Orthopaedics: [1, ['Orthopaedics', 'Orthopaedic Surgeon', 'Orthopedics and Sports Medicine']],
  ENT: [0.8, ['ENT', 'ENT Surgeon', 'Otorhinolaryngology']],
  Ophthalmology: [0.8, ['Ophthalmology', 'Eye Specialist', 'Ophthalmologist']],
  Psychiatry: [0.8, ['Psychiatry', 'Psychiatrist', 'Mental Health (Psychiatry)']],
  Neurology: [0.7, ['Neurology', 'Neurologist']],
  Gastroenterology: [
    0.7,
    ['Gastroenterology', 'Gastroenterologist', 'Gastroenterology and Hepatology'],
  ],
  Endocrinology: [0.7, ['Endocrinology', 'Endocrinologist', 'Diabetologist']],
  Pulmonology: [0.6, ['Pulmonology', 'Chest Physician', 'Respiratory Medicine']],
};

/** How patients describe an area (bios use these words, so ranking has meaning to find). */
export const LAY_WORDS = Object.freeze({
  acne: 'pimples and breakouts',
  eczema: 'dry, itchy skin',
  psoriasis: 'scaly skin patches',
  hair_loss: 'hair fall',
  skin_allergies: 'rashes and hives',
  pigmentation: 'dark spots',
  fever_infections: 'fevers and infections',
  diabetes: 'blood sugar control',
  blood_pressure: 'high blood pressure',
  health_checkups: 'routine check-ups',
  weight_lifestyle: 'weight and healthy habits',
  elderly_care: 'care for older adults',
  long_term_conditions: 'long-term conditions',
  child_growth: "children's growth",
  vaccinations: 'vaccinations',
  newborn_care: 'newborns',
  childhood_infections: "children's coughs and fevers",
  pregnancy_care: 'pregnancy',
  menstrual_health: 'period problems',
  fertility: 'trying to conceive',
  menopause: 'menopause',
  pcos: 'PCOS',
  heart_rhythm: 'palpitations',
  heart_failure: 'heart failure',
  cholesterol: 'cholesterol',
  cardiac_rehab: 'recovery after heart problems',
  joint_pain: 'knee and joint pain',
  back_neck_pain: 'back and neck pain',
  sports_injuries: 'sprains and sports injuries',
  fractures: 'fractures',
  arthritis: 'arthritis',
  ear_hearing: 'ear pain and hearing',
  sinus: 'blocked sinuses',
  throat_voice: 'sore throat and voice',
  snoring: 'snoring',
  vision: 'blurry vision and glasses',
  cataract: 'cataracts',
  glaucoma: 'glaucoma',
  eye_infections: 'red, sore eyes',
  anxiety: 'worry and panic',
  depression: 'low mood',
  sleep: 'trouble sleeping',
  addiction: 'addiction',
  headache_migraine: 'headaches and migraines',
  epilepsy: 'seizure disorders',
  nerve_pain: 'tingling and nerve pain',
  memory: 'memory problems',
  acidity_reflux: 'acidity and heartburn',
  bowel_problems: 'bowel problems',
  liver: 'liver problems',
  stomach_pain: 'stomach aches',
  thyroid: 'thyroid problems',
  hormones: 'hormone problems',
  asthma: 'asthma and wheezing',
  copd: 'long-term breathlessness',
  long_cough: 'coughs that will not go away',
  breathing_allergies: 'allergies that affect breathing',
});

const FIRST = [
  'Aarav',
  'Aditi',
  'Akash',
  'Ananya',
  'Anil',
  'Anjali',
  'Arjun',
  'Bhavna',
  'Chetan',
  'Deepa',
  'Divya',
  'Gaurav',
  'Harish',
  'Isha',
  'Jaya',
  'Karan',
  'Kavya',
  'Lakshmi',
  'Manish',
  'Meena',
  'Mohan',
  'Nandini',
  'Neha',
  'Nikhil',
  'Pooja',
  'Pradeep',
  'Priya',
  'Rahul',
  'Rajesh',
  'Rekha',
  'Ritu',
  'Rohan',
  'Sanjay',
  'Sarita',
  'Shalini',
  'Shreya',
  'Sunil',
  'Suresh',
  'Tanvi',
  'Uma',
  'Varun',
  'Vidya',
  'Vikas',
  'Yamini',
  'Zoya',
  'Farhan',
  'Imran',
  'Sana',
  'Joseph',
  'Mary',
];
const LAST_BY_STATE = {
  Maharashtra: ['Patil', 'Deshpande', 'Kulkarni', 'Joshi', 'Shinde', 'Gokhale'],
  Delhi: ['Sharma', 'Verma', 'Gupta', 'Malhotra', 'Kapoor', 'Arora'],
  Karnataka: ['Rao', 'Shetty', 'Hegde', 'Gowda', 'Kamath', 'Bhat'],
  'Tamil Nadu': ['Iyer', 'Subramanian', 'Krishnan', 'Raman', 'Natarajan', 'Pillai'],
  Telangana: ['Reddy', 'Naidu', 'Rao', 'Varma', 'Chowdary', 'Goud'],
  'West Bengal': ['Banerjee', 'Chatterjee', 'Mukherjee', 'Sen', 'Das', 'Ghosh'],
  Gujarat: ['Patel', 'Shah', 'Mehta', 'Desai', 'Parikh', 'Trivedi'],
  Rajasthan: ['Singh', 'Rathore', 'Agarwal', 'Jain', 'Mathur', 'Sharma'],
  Kerala: ['Menon', 'Nair', 'Kurian', 'Thomas', 'Pillai', 'Varghese'],
};

const pick = (rand, list) => list[Math.floor(rand() * list.length)];
const weighted = (rand, entries) => {
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rand() * total;
  for (const [value, w] of entries) {
    r -= w;
    if (r <= 0) return value;
  }
  return entries.at(-1)[0];
};
const sample = (rand, list, n) => {
  const pool = [...list];
  const out = [];
  while (out.length < n && pool.length)
    out.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  return out;
};
const slug = (s) => s.toLowerCase().replace(/[^a-z]+/g, '');

/**
 * @param {{ seed?: number, doctorsPerCity?: number, patientsPerCity?: number }} [options]
 */
export function syntheticDirectory({
  seed = 2026,
  doctorsPerCity = 12,
  patientsPerCity = 4,
  // A non-default dataset (e.g. the search evaluation) gets its own accounts and clinics.
  prefix = seed === 2026 ? '' : `s${seed}.`,
} = {}) {
  const rand = prng(seed);
  const clinics = [];
  const doctors = [];
  const patients = [];
  const specialtyEntries = Object.entries(SPECIALTIES).map(([name, [w]]) => [name, w]);

  CITIES.forEach((place, cityIndex) => {
    const cityClinics = [0, 1].map((k) => ({
      key: `${prefix}${slug(place.city)}-${k}`,
      name: `${CLINIC_WORDS[0][(cityIndex * 2 + k) % CLINIC_WORDS[0].length]} ${pick(rand, CLINIC_WORDS[1])} ${place.city} (Demo${prefix ? ` ${prefix.slice(0, -1)}` : ''})`,
      city: place.city,
      state: place.state,
      postalCode: place.postalCode,
      // One clinic closes after its doctors joined: shows the eligibility rule in the demo.
      closed: place.city === 'Kochi' && k === 1,
    }));
    clinics.push(...cityClinics);

    for (let i = 0; i < doctorsPerCity; i += 1) {
      const specialty = weighted(rand, specialtyEntries);
      const written = pick(rand, SPECIALTIES[specialty][1]);
      const first = pick(rand, FIRST);
      const last = pick(rand, LAST_BY_STATE[place.state]);
      const languages = ['English'];
      if (rand() < (place.north ? 0.75 : 0.35) && place.language !== 'Hindi')
        languages.push('Hindi');
      if (rand() < 0.7) languages.push(place.language);
      if (place.language === 'Hindi' && !languages.includes('Hindi')) languages.push('Hindi');
      if (rand() < 0.12)
        languages.push(pick(rand, ['Urdu', 'Tamil', 'Bengali', 'Marathi', 'Telugu']));
      const fitting = PRACTICE_AREAS.filter((a) => a.specialties.includes(specialty)).map(
        (a) => a.code,
      );
      const areas =
        rand() < 0.2
          ? []
          : sample(rand, fitting, 1 + Math.floor(rand() * Math.min(4, fitting.length)));
      const years = 2 + Math.floor(rand() * 33);
      const practice = weighted(rand, [
        ['both', 0.6],
        ['online', 0.2],
        ['in_clinic', 0.2],
      ]);
      const clinic = practice === 'online' ? null : pick(rand, cityClinics);
      const bio = [
        areas.length
          ? `Sees patients for ${areas.map((a) => LAY_WORDS[a]).join(', ')}.`
          : `Practises ${specialty.toLowerCase()} in ${place.city}.`,
        `${years} years of practice. Synthetic demo profile.`,
      ].join(' ');
      doctors.push({
        key: `dr.${prefix}${slug(first)}.${slug(last)}.${cityIndex}${String(i).padStart(2, '0')}`,
        professionalName: `Dr. ${first} ${last}`,
        specialty,
        primarySpecialization: written,
        languages: [...new Set(languages)],
        areasOfPractice: areas,
        yearsOfExperience: years,
        bio,
        city: place.city,
        clinicKey: clinic?.key ?? null,
        online: practice !== 'in_clinic',
        inClinic: practice !== 'online',
        onlineFeePaise: rand() < 0.3 ? 0 : 20_000 + 5_000 * Math.floor(rand() * 9),
        clinicFeePaise: 40_000 + 10_000 * Math.floor(rand() * 9),
        // A few profiles never finish verification; one verified doctor is later suspended.
        status: i === doctorsPerCity - 1 && cityIndex % 3 === 0 ? 'applicant' : 'verified',
        suspended: cityIndex === 2 && i === 0,
      });
    }

    for (let i = 0; i < patientsPerCity; i += 1) {
      const first = pick(rand, FIRST);
      const last = pick(rand, LAST_BY_STATE[place.state]);
      patients.push({
        key: `patient.${prefix}${slug(first)}.${cityIndex}${i}`,
        fullName: `${first} ${last}`,
        dateOfBirth: `${1960 + Math.floor(rand() * 40)}-0${1 + Math.floor(rand() * 9)}-1${Math.floor(rand() * 9)}`,
        city: place.city,
        state: place.state,
        language: rand() < 0.5 ? place.language : 'English',
        dependent:
          rand() < 0.35
            ? {
                fullName: `${pick(rand, FIRST)} ${last}`,
                dateOfBirth:
                  rand() < 0.5
                    ? `20${10 + Math.floor(rand() * 12)}-06-15`
                    : `194${Math.floor(rand() * 9)}-02-11`,
                relationshipType: rand() < 0.5 ? 'parent' : 'child',
              }
            : null,
        careTeamSize: 1 + Math.floor(rand() * 3),
        books: rand() < 0.45,
      });
    }
  });
  return { clinics, doctors, patients };
}
