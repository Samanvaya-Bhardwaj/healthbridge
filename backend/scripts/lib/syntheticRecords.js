/**
 * Synthetic medical documents for the demo patients (Part 4: records for RAG).
 *
 * Every document is invented for testing: the people, hospitals, laboratories, doctors and
 * values do not exist, and each page says so. The stories are consistent across documents
 * and with the seeded visits (seedHistory.js), so questions such as "how has my HbA1c
 * changed?" or "what did the echo show?" have grounded answers with sources.
 *
 * Lab lines follow "Analyte: value unit (ref low-high)" so the document pipeline can read
 * them; narrative sections give retrieval something to work with.
 */

const SYN = 'SYNTHETIC TEST DATA - not a real person or a real medical record.';

/** "2026-10-04" for a day `daysAgo` before `today` (India time is close enough here). */
const dayOf = (today, daysAgo) =>
  new Date(today.getTime() - daysAgo * 86_400_000).toISOString().slice(0, 10);

function header(lab, address, patient, extra = []) {
  return [
    lab,
    address,
    '',
    `Patient: ${patient.name}    Age/Sex: ${patient.ageSex}    Patient ID: ${patient.mrn}`,
    ...extra,
    '',
  ];
}

const footer = (signedBy) => ['', signedBy, '', SYN];

// ── Asha Rao: type 2 diabetes found this year, vitamin D deficiency ─────────────────────
const asha = { name: 'Asha Rao', ageSex: '36 years / Female', mrn: 'SYN-AR-1042' };

const ASHA = [
  {
    key: 'asha-wellness',
    daysAgo: 128,
    type: 'lab_report',
    title: 'Annual health check (synthetic)',
    lines: (d) => [
      ...header(
        'Sunrise Diagnostics Laboratory, Pune',
        'FC Road, Shivajinagar, Pune 411005',
        asha,
        [
          `Package: Comprehensive wellness check    Collected: ${d} 08:10    Reported: ${d} 17:40`,
          'Referred by: Self (corporate health check)',
        ],
      ),
      'HAEMATOLOGY - Complete Blood Count',
      'Hemoglobin: 11.9 g/dL (ref 12.0-15.5) L',
      'Total WBC: 6.8 10^3/uL (ref 4.0-11.0)',
      'Platelets: 248 10^3/uL (ref 150-450)',
      'MCV: 79 fL (ref 80-100) L',
      '',
      'DIABETES SCREEN',
      'Fasting Glucose: 112 mg/dL (ref 70-99) H',
      'HbA1c: 6.1 % (ref 4.0-5.6) H',
      '',
      'LIPID PROFILE',
      'Total Cholesterol: 186 mg/dL (ref 0-200)',
      'Triglycerides: 162 mg/dL (ref 0-150) H',
      'HDL Cholesterol: 44 mg/dL (ref 40-60)',
      'LDL Cholesterol: 110 mg/dL (ref 0-130)',
      '',
      'LIVER FUNCTION',
      'ALT (SGPT): 28 U/L (ref 0-35)',
      'AST (SGOT): 24 U/L (ref 0-35)',
      'Total Bilirubin: 0.6 mg/dL (ref 0.2-1.2)',
      '',
      'KIDNEY FUNCTION',
      'Serum Creatinine: 0.7 mg/dL (ref 0.6-1.1)',
      'Blood Urea: 22 mg/dL (ref 15-40)',
      'eGFR: 112 mL/min/1.73m2 (ref 90-140)',
      '',
      'THYROID',
      'TSH: 2.1 uIU/mL (ref 0.4-4.0)',
      '',
      'VITAMINS',
      'Vitamin D (25-OH): 14 ng/mL (ref 30-100) L',
      'Vitamin B12: 410 pg/mL (ref 200-900)',
      '',
      'Comments:',
      'Fasting glucose and HbA1c are in the prediabetes range. Mildly low haemoglobin with low',
      'MCV suggests iron deficiency; correlate clinically. Vitamin D is deficient. Triglycerides',
      'are mildly raised. Please review these results with your physician.',
      ...footer('Dr. Neelima Kulkarni, MD (Pathology) - Consultant Pathologist (synthetic)'),
    ],
  },
  {
    key: 'asha-hba1c-aug',
    daysAgo: 77,
    type: 'lab_report',
    title: 'Diabetes tests: HbA1c, fasting and post-meal sugar (synthetic)',
    lines: (d) => [
      ...header(
        'Sunrise Diagnostics Laboratory, Pune',
        'FC Road, Shivajinagar, Pune 411005',
        asha,
        [
          `Collected: ${d} 07:50 (fasting) and 10:20 (2 hours after breakfast)    Reported: ${d} 18:05`,
          'Referred by: Dr. Meera Iyer (synthetic)',
        ],
      ),
      'Fasting Glucose: 132 mg/dL (ref 70-99) H',
      'Postprandial Glucose: 198 mg/dL (ref 70-140) H',
      'HbA1c: 7.1 % (ref 4.0-5.6) H',
      'Estimated Average Glucose: 157 mg/dL (ref 68-114) H',
      '',
      'Interpretation (as per ADA criteria): HbA1c of 6.5% or more on repeat testing is',
      'consistent with diabetes mellitus. Compared with the wellness check four weeks earlier',
      '(HbA1c 6.1%), glycaemic control has worsened. Clinical correlation is advised.',
      ...footer('Dr. Neelima Kulkarni, MD (Pathology) (synthetic)'),
    ],
  },
  {
    key: 'asha-vitd',
    daysAgo: 76,
    type: 'lab_report',
    title: 'Vitamin D and iron studies (synthetic)',
    lines: (d) => [
      ...header(
        'Sunrise Diagnostics Laboratory, Pune',
        'FC Road, Shivajinagar, Pune 411005',
        asha,
        [
          `Collected: ${d} 08:00    Reported: ${d} 19:10`,
          'Referred by: Dr. Meera Iyer (synthetic)',
        ],
      ),
      'Vitamin D (25-OH): 13 ng/mL (ref 30-100) L',
      'Serum Ferritin: 11 ng/mL (ref 15-150) L',
      'Serum Iron: 48 ug/dL (ref 60-170) L',
      'TIBC: 410 ug/dL (ref 250-450)',
      'Transferrin Saturation: 12 % (ref 20-50) L',
      '',
      'Comments: Vitamin D deficiency (below 20 ng/mL). Low ferritin and transferrin saturation',
      'support iron deficiency. Repeat vitamin D after 8-12 weeks of replacement is suggested.',
      ...footer('Dr. Neelima Kulkarni, MD (Pathology) (synthetic)'),
    ],
  },
  {
    key: 'asha-ecg',
    daysAgo: 75,
    type: 'imaging',
    title: 'ECG report (synthetic)',
    lines: (d) => [
      ...header('Sunrise Family Clinic (Demo), Pune', 'Cardiology diagnostics', asha, [
        `Recorded: ${d} 11:30`,
      ]),
      'Investigation: 12-lead resting electrocardiogram',
      'Heart Rate: 78 bpm (ref 60-100)',
      'PR Interval: 152 ms (ref 120-200)',
      'QRS Duration: 86 ms (ref 70-110)',
      'QTc: 412 ms (ref 350-450)',
      'Axis: Normal',
      '',
      'Findings: Normal sinus rhythm. No ST-T changes. No conduction abnormality.',
      'Impression: Normal ECG.',
      ...footer('Dr. Meera Iyer (synthetic) - reported for baseline before starting treatment'),
    ],
  },
  {
    key: 'asha-dietitian',
    daysAgo: 70,
    type: 'other',
    title: 'Dietitian consultation notes (synthetic)',
    lines: (d) => [
      ...header('Sunrise Family Clinic (Demo), Pune', 'Nutrition and lifestyle clinic', asha, [
        `Seen on: ${d}`,
      ]),
      'Reason for referral: Newly diagnosed type 2 diabetes; vitamin D and iron deficiency.',
      '',
      'Assessment:',
      'Height 160 cm, weight 68 kg, BMI 26.6 kg/m2 (overweight). Waist 86 cm.',
      'Diet history: vegetarian; frequent sweetened tea (4 cups a day), white rice twice daily,',
      'late dinners at 22:30, irregular breakfast. Physical activity: under 30 minutes a week.',
      '',
      'Plan agreed with the patient:',
      '1. Tea without sugar; limit to 2 cups a day.',
      '2. Half plate vegetables, quarter plate protein (dal, paneer, curd, sprouts),',
      '   quarter plate whole grains (millet roti, brown rice) at lunch and dinner.',
      '3. Dinner by 20:30; no fruit juices; whole fruit (guava, apple, orange) up to 2 a day.',
      '4. Brisk walking 30 minutes a day, 5 days a week; build up over 3 weeks.',
      '5. Iron-rich foods (green leafy vegetables, rajma, chana) with vitamin C sources.',
      'Target: lose 3-4 kg in 3 months. Review in 6 weeks with a food diary.',
      ...footer('Ms. Pallavi Deshmukh, RD - Clinical Dietitian (synthetic)'),
    ],
  },
  {
    key: 'asha-urine',
    daysAgo: 45,
    type: 'lab_report',
    title: 'Urine tests: routine and microalbumin (synthetic)',
    lines: (d) => [
      ...header(
        'Sunrise Diagnostics Laboratory, Pune',
        'FC Road, Shivajinagar, Pune 411005',
        asha,
        [`Collected: ${d} 08:15 (first morning sample)    Reported: ${d} 15:30`],
      ),
      'URINE ROUTINE',
      'Colour: Pale yellow',
      'Specific Gravity: 1.020 (ref 1.005-1.030)',
      'pH: 6.0 (ref 4.5-8.0)',
      'Urine Glucose: Negative',
      'Urine Protein: Negative',
      'Pus Cells: 2 /hpf (ref 0-5)',
      '',
      'KIDNEY SCREEN FOR DIABETES',
      'Urine Albumin to Creatinine Ratio: 18 mg/g (ref 0-30)',
      '',
      'Comments: No microalbuminuria. Annual repeat is recommended for people with diabetes.',
      ...footer('Dr. Neelima Kulkarni, MD (Pathology) (synthetic)'),
    ],
  },
  {
    key: 'asha-eye',
    daysAgo: 38,
    type: 'other',
    title: 'Eye check for diabetes: retinal screening (synthetic)',
    lines: (d) => [
      ...header('Clearview Eye Hospital (synthetic), Pune', 'Baner Road, Pune 411045', asha, [
        `Examined: ${d}`,
      ]),
      'Reason: Diabetic retinopathy screening (type 2 diabetes, diagnosed this year).',
      '',
      'Visual acuity: 6/6 in both eyes (with glasses for distance).',
      'Intraocular pressure: 15 mmHg right, 16 mmHg left (ref 10-21).',
      'Fundus (dilated): Clear media. Optic discs healthy. No microaneurysms, haemorrhages or',
      'exudates in either eye. Macula normal.',
      '',
      'Impression: No diabetic retinopathy.',
      'Advice: Repeat dilated eye examination in 12 months, or earlier if vision changes.',
      ...footer('Dr. Sameer Joshi, MS (Ophthalmology) (synthetic)'),
    ],
  },
  {
    key: 'asha-gastro-discharge',
    daysAgo: 940,
    type: 'discharge_summary',
    title: 'Discharge summary: gastroenteritis, 2024 (synthetic)',
    lines: (d) => [
      ...header(
        'City Care Hospital (synthetic), Pune',
        'Kothrud, Pune 411038 - Department of Medicine',
        asha,
        [
          `Admitted: ${d}    Discharged: two days later    Consultant: Dr. Anil Bhosale (synthetic)`,
        ],
      ),
      'Diagnosis: Acute gastroenteritis with moderate dehydration.',
      '',
      'History: Loose stools 8-10 times a day and vomiting for one day after eating outside,',
      'with dizziness on standing. No blood in stools. No known drug allergies.',
      '',
      'Examination: Pulse 108/min, BP 96/60 mmHg, dry mucosa. Abdomen soft, mildly tender.',
      '',
      'Investigations:',
      'Serum Sodium: 132 mmol/L (ref 135-145) L',
      'Serum Potassium: 3.3 mmol/L (ref 3.5-5.1) L',
      'Serum Creatinine: 1.0 mg/dL (ref 0.6-1.1)',
      'Stool routine: no ova or cysts; occult blood negative.',
      '',
      'Course in hospital: Treated with intravenous fluids, oral rehydration and antiemetics.',
      'Diarrhoea settled within 36 hours; tolerated a soft diet before discharge.',
      '',
      'Medicines on discharge: oral rehydration solution as needed; a probiotic for 5 days.',
      'Advice: Drink safe water; return if vomiting recurs or urine output falls.',
      'Follow-up: Not required unless symptoms recur.',
      ...footer('Dr. Anil Bhosale, MD (Medicine) (synthetic)'),
    ],
  },
  {
    key: 'asha-thyroid',
    daysAgo: 127,
    type: 'lab_report',
    title: 'Thyroid profile (synthetic)',
    lines: (d) => [
      ...header(
        'Sunrise Diagnostics Laboratory, Pune',
        'FC Road, Shivajinagar, Pune 411005',
        asha,
        [`Collected: ${d} 08:10    Reported: ${d} 17:40`],
      ),
      'TSH: 2.1 uIU/mL (ref 0.4-4.0)',
      'Free T4: 1.2 ng/dL (ref 0.8-1.8)',
      'Free T3: 3.1 pg/mL (ref 2.3-4.2)',
      '',
      'Comments: Thyroid function is within the reference range.',
      ...footer('Dr. Neelima Kulkarni, MD (Pathology) (synthetic)'),
    ],
  },
];

// ── Kamala Rao: hypertension, cholesterol, knee osteoarthritis, cataract surgery ────────
const kamala = { name: 'Kamala Rao', ageSex: '68 years / Female', mrn: 'SYN-KR-0688' };

const KAMALA = [
  {
    key: 'kamala-cataract',
    daysAgo: 330,
    type: 'discharge_summary',
    title: 'Discharge summary: right eye cataract surgery (synthetic)',
    lines: (d) => [
      ...header(
        'Clearview Eye Hospital (synthetic), Pune',
        'Baner Road, Pune 411045 - Day surgery',
        kamala,
        [`Admitted and discharged: ${d}    Surgeon: Dr. Sameer Joshi (synthetic)`],
      ),
      'Diagnosis: Senile mature cataract, right eye.',
      'Procedure: Phacoemulsification with foldable intraocular lens (IOL) implant, right eye,',
      'under topical anaesthesia. Uneventful.',
      '',
      'Pre-operative: Visual acuity right eye 6/36, left eye 6/12. BP 148/88 mmHg on the day.',
      'Medical history: Hypertension for 8 years. No diabetes.',
      '',
      'Medicines on discharge:',
      '- Moxifloxacin eye drops 4 times a day for 2 weeks',
      '- Prednisolone acetate eye drops, tapering over 4 weeks',
      'Continue usual blood pressure medicines.',
      'Advice: Wear the eye shield at night for one week; avoid rubbing the eye.',
      'Follow-up: Day 1, week 1 and week 4. Visual acuity at week 4: 6/9 right eye.',
      ...footer('Dr. Sameer Joshi, MS (Ophthalmology) (synthetic)'),
    ],
  },
  {
    key: 'kamala-lipid-march',
    daysAgo: 210,
    type: 'lab_report',
    title: 'Lipid profile, March (synthetic)',
    lines: (d) => [
      ...header(
        'Sunrise Diagnostics Laboratory, Pune',
        'FC Road, Shivajinagar, Pune 411005',
        kamala,
        [`Collected: ${d} 08:20 (12 hours fasting)    Reported: ${d} 16:00`],
      ),
      'Total Cholesterol: 238 mg/dL (ref 0-200) H',
      'Triglycerides: 176 mg/dL (ref 0-150) H',
      'HDL Cholesterol: 46 mg/dL (ref 40-60)',
      'LDL Cholesterol: 160 mg/dL (ref 0-130) H',
      'VLDL Cholesterol: 35 mg/dL (ref 5-40)',
      'Non-HDL Cholesterol: 192 mg/dL (ref 0-160) H',
      '',
      'Comments: Raised LDL and non-HDL cholesterol. Cardiovascular risk assessment advised.',
      ...footer('Dr. Neelima Kulkarni, MD (Pathology) (synthetic)'),
    ],
  },
  {
    key: 'kamala-cardiology-rx',
    daysAgo: 205,
    type: 'prescription',
    title: 'Prescription from Deccan Heart Clinic (synthetic)',
    lines: (d) => [
      ...header(
        'Deccan Heart Clinic (synthetic), Pune',
        'Prabhat Road, Pune 411004 - OPD',
        kamala,
        [`Date: ${d}    Doctor: Dr. Rohan Kale, DM (Cardiology) (synthetic)`],
      ),
      'Complaints: Occasional headache; home BP 150-160/90-95 mmHg over two weeks.',
      'Findings: BP 156/94 mmHg, pulse 76/min regular. Heart sounds normal.',
      'Diagnosis: Essential hypertension, not controlled; dyslipidaemia.',
      '',
      'Medicines:',
      '1. Telmisartan 40 mg - one tablet once daily in the morning - 3 months',
      '2. Atorvastatin 10 mg - one tablet at night - 3 months',
      '',
      'Advice: Salt under 5 g a day; walk 30 minutes daily as knees allow; home BP log twice a',
      'day. Repeat kidney function and electrolytes in 4 weeks (telmisartan started).',
      ...footer('Dr. Rohan Kale (synthetic) - signature on the original'),
    ],
  },
  {
    key: 'kamala-knee-xray',
    daysAgo: 460,
    type: 'imaging',
    title: 'X-ray of both knees (synthetic)',
    lines: (d) => [
      ...header('City Care Hospital (synthetic), Pune', 'Department of Radiology', kamala, [
        `Examined: ${d}`,
      ]),
      'Examination: X-ray of both knees, standing AP and lateral views.',
      '',
      'Findings: Mild narrowing of the medial joint spaces on both sides, more on the right.',
      'Small marginal osteophytes at the tibial plateaus and patellae. No fracture. No loose',
      'bodies. Soft tissues unremarkable.',
      '',
      'Impression: Bilateral knee osteoarthritis, Kellgren-Lawrence grade 2.',
      ...footer('Dr. Farah Siddiqui, MD (Radiology) (synthetic)'),
    ],
  },
  {
    key: 'kamala-ortho',
    daysAgo: 455,
    type: 'other',
    title: 'Orthopaedic consultation letter (synthetic)',
    lines: (d) => [
      ...header(
        'City Care Hospital (synthetic), Pune',
        'Department of Orthopaedics - OPD letter',
        kamala,
        [`Date: ${d}`],
      ),
      'Dear Doctor,',
      'I saw Mrs Kamala Rao for pain in both knees for two years, worse on climbing stairs and',
      'after sitting for long. No swelling or locking. Examination: crepitus in both knees,',
      'full range of movement, no effusion. X-ray shows grade 2 osteoarthritis.',
      '',
      'Plan:',
      '- Physiotherapy: quadriceps strengthening exercises, 6 sessions, then home programme.',
      '- Paracetamol 500 mg when needed for pain, up to 3 times a day.',
      '- Avoid regular anti-inflammatory painkillers (NSAIDs) because of her blood pressure',
      '  and age; a topical diclofenac gel is acceptable for short periods.',
      '- Weight reduction and a walking stick on longer walks.',
      'Review in 6 months, or earlier if pain limits walking.',
      ...footer('Dr. Vivek Patil, MS (Orthopaedics) (synthetic)'),
    ],
  },
  {
    key: 'kamala-kft',
    daysAgo: 30,
    type: 'lab_report',
    title: 'Kidney function and electrolytes (synthetic)',
    lines: (d) => [
      ...header(
        'Sunrise Diagnostics Laboratory, Pune',
        'FC Road, Shivajinagar, Pune 411005',
        kamala,
        [
          `Collected: ${d} 08:30    Reported: ${d} 14:10    Referred by: Dr. Meera Iyer (synthetic)`,
        ],
      ),
      'Serum Creatinine: 1.0 mg/dL (ref 0.6-1.1)',
      'eGFR: 58 mL/min/1.73m2 (ref 90-140) L',
      'Blood Urea: 34 mg/dL (ref 15-40)',
      'Serum Sodium: 136 mmol/L (ref 135-145)',
      'Serum Potassium: 4.4 mmol/L (ref 3.5-5.1)',
      'Serum Uric Acid: 5.9 mg/dL (ref 2.4-6.0)',
      '',
      'Comments: eGFR mildly reduced (CKD stage G3a range if persistent over 3 months).',
      'Electrolytes normal. Medicines cleared by the kidneys may need dose review.',
      ...footer('Dr. Neelima Kulkarni, MD (Pathology) (synthetic)'),
    ],
  },
  {
    key: 'kamala-ecg',
    daysAgo: 22,
    type: 'imaging',
    title: 'ECG report (synthetic)',
    lines: (d) => [
      ...header('Deccan Heart Clinic (synthetic), Pune', 'Non-invasive cardiology', kamala, [
        `Recorded: ${d} 10:05`,
      ]),
      'Investigation: 12-lead resting electrocardiogram',
      'Heart Rate: 72 bpm (ref 60-100)',
      'PR Interval: 168 ms (ref 120-200)',
      'QRS Duration: 92 ms (ref 70-110)',
      'QTc: 428 ms (ref 350-460)',
      '',
      'Findings: Sinus rhythm. Voltage criteria for left ventricular hypertrophy are borderline.',
      'No acute ST-T changes. No arrhythmia during the recording.',
      'Impression: Borderline LVH by voltage; correlate with echocardiography.',
      ...footer('Dr. Rohan Kale, DM (Cardiology) (synthetic)'),
    ],
  },
  {
    key: 'kamala-echo',
    daysAgo: 12,
    type: 'imaging',
    title: '2D echocardiography report (synthetic)',
    lines: (d) => [
      ...header('Deccan Heart Clinic (synthetic), Pune', 'Echocardiography laboratory', kamala, [
        `Study date: ${d}`,
      ]),
      'Indication: Hypertension; borderline LVH on ECG.',
      '',
      'Measurements:',
      'LV Ejection Fraction: 60 % (ref 55-70)',
      'IVS Thickness: 11.8 mm (ref 6-10) H',
      'LV Posterior Wall: 11.2 mm (ref 6-10) H',
      'Left Atrium: 38 mm (ref 27-38)',
      'E/A Ratio: 0.7 (ref 0.8-2.0) L',
      '',
      'Findings: Normal left ventricular size with mild concentric hypertrophy. Normal systolic',
      'function, no regional wall motion abnormality. Grade 1 diastolic dysfunction (impaired',
      'relaxation). Valves structurally normal; trace mitral regurgitation. No pericardial',
      'effusion.',
      '',
      'Impression: Mild concentric LVH with grade 1 diastolic dysfunction and normal ejection',
      'fraction, consistent with hypertensive heart changes. Blood pressure control advised.',
      ...footer('Dr. Rohan Kale, DM (Cardiology) (synthetic)'),
    ],
  },
  {
    key: 'kamala-bp-log',
    daysAgo: 18,
    type: 'other',
    title: 'Home blood pressure log summary (synthetic)',
    lines: (d) => [
      `Home blood pressure log - ${kamala.name} - two weeks ending ${d}`,
      'Kept by her daughter Asha Rao with an upper-arm automatic monitor (validated model).',
      '',
      'Morning readings (before medicines), average of 14 days: 148/90 mmHg',
      'Evening readings, average of 14 days: 142/86 mmHg',
      "Highest reading: 162/96 mmHg (a morning after a poor night's sleep)",
      'Lowest reading: 132/82 mmHg',
      'Pulse: 68-80 per minute',
      '',
      'Notes: Two mild headaches in the mornings. No dizziness or falls. Takes telmisartan 40 mg',
      'each morning (Deccan Heart Clinic); amlodipine 5 mg was added by Dr. Meera Iyer the day',
      'before this log started.',
      '',
      SYN,
    ],
  },
];

// ── Vikram Singh: asthma since childhood, allergic rhinitis, recent exacerbation ────────
const vikram = { name: 'Vikram Singh', ageSex: '41 years / Male', mrn: 'SYN-VS-2210' };

const VIKRAM = [
  {
    key: 'vikram-asthma-discharge',
    daysAgo: 300,
    type: 'discharge_summary',
    title: 'Discharge summary: asthma attack (synthetic)',
    lines: (d) => [
      ...header(
        'City Care Hospital (synthetic), Pune',
        'Kothrud, Pune 411038 - Department of Pulmonology',
        vikram,
        [`Admitted: ${d}    Length of stay: 3 days    Consultant: Dr. Kavita Rane (synthetic)`],
      ),
      'Diagnosis: Acute exacerbation of bronchial asthma (moderate); allergic rhinitis.',
      '',
      'History: Asthma since childhood, usually controlled with a reliever inhaler only.',
      'Three days of cough, wheeze and breathlessness after a viral cold, with night waking.',
      'Ex-smoker (stopped 6 years ago, 5 pack-years). Works in an office; has a pet cat.',
      '',
      'On admission: Respiratory rate 26/min, SpO2 91% on room air, widespread wheeze, able to',
      'speak in phrases. Peak flow 220 L/min (about 40% of predicted).',
      '',
      'Investigations:',
      'Hemoglobin: 14.6 g/dL (ref 13.0-17.0)',
      'Total WBC: 10.9 10^3/uL (ref 4.0-11.0)',
      'Eosinophils: 8 % (ref 1-6) H',
      'CRP: 9 mg/L (ref 0-5) H',
      'Chest X-ray: hyperinflated lungs, no consolidation or pneumothorax.',
      '',
      'Course: Nebulised salbutamol and ipratropium, oral prednisolone 40 mg for 5 days, oxygen',
      'for the first 24 hours. Peak flow 410 L/min at discharge. Inhaler technique reviewed.',
      '',
      'Medicines on discharge:',
      '- Budesonide-formoterol 200/6 inhaler, 2 puffs twice daily, and 1 puff when needed',
      '- Montelukast 10 mg once at night',
      '- Prednisolone 40 mg once daily to complete 5 days',
      'Advice: Written asthma action plan given; avoid smoke and dust; annual flu vaccine.',
      'Follow-up: Pulmonology clinic in 4 weeks with spirometry.',
      ...footer('Dr. Kavita Rane, DM (Pulmonology) (synthetic)'),
    ],
  },
  {
    key: 'vikram-cxr',
    daysAgo: 300,
    type: 'imaging',
    title: 'Chest X-ray report (synthetic)',
    lines: (d) => [
      ...header('City Care Hospital (synthetic), Pune', 'Department of Radiology', vikram, [
        `Examined: ${d}`,
      ]),
      'Examination: Chest X-ray, PA view.',
      'Findings: Hyperinflated lungs with flattened diaphragms. No consolidation, effusion or',
      'pneumothorax. Heart size normal. Bony thorax normal.',
      'Impression: Hyperinflation, in keeping with an asthma exacerbation. No pneumonia.',
      ...footer('Dr. Farah Siddiqui, MD (Radiology) (synthetic)'),
    ],
  },
  {
    key: 'vikram-spirometry',
    daysAgo: 270,
    type: 'lab_report',
    title: 'Spirometry (lung function) report (synthetic)',
    lines: (d) => [
      ...header('Pune Lung and Allergy Centre (synthetic)', 'Aundh, Pune 411007', vikram, [
        `Tested: ${d}    Height 176 cm, weight 79 kg`,
      ]),
      'Pre-bronchodilator:',
      'FEV1: 2.71 L (ref 3.30-4.40) L',
      'FVC: 3.98 L (ref 4.10-5.40) L',
      'FEV1/FVC Ratio: 0.68 (ref 0.70-0.85) L',
      'FEV1 Percent Predicted: 72 % (ref 80-120) L',
      '',
      'Post-bronchodilator (salbutamol 400 mcg):',
      'FEV1: 3.09 L (ref 3.30-4.40) L',
      'FEV1 Change: 14 % (ref 0-12) H',
      '',
      'Interpretation: Moderate obstruction with significant reversibility (14% and 380 mL),',
      'consistent with asthma. Good effort and reproducibility (grade A).',
      ...footer('Dr. Kavita Rane, DM (Pulmonology) (synthetic)'),
    ],
  },
  {
    key: 'vikram-allergy',
    daysAgo: 268,
    type: 'lab_report',
    title: 'Allergy blood tests (synthetic)',
    lines: (d) => [
      ...header(
        'Sunrise Diagnostics Laboratory, Pune',
        'FC Road, Shivajinagar, Pune 411005',
        vikram,
        [`Collected: ${d} 09:00    Reported: two days later`],
      ),
      'Total IgE: 480 IU/mL (ref 0-100) H',
      'Specific IgE, house dust mite (D. pteronyssinus): 18.2 kUA/L (ref 0-0.35) H',
      'Specific IgE, cockroach: 2.4 kUA/L (ref 0-0.35) H',
      'Specific IgE, cat dander: 0.9 kUA/L (ref 0-0.35) H',
      'Specific IgE, grass pollen mix: 0.2 kUA/L (ref 0-0.35)',
      '',
      'Comments: Sensitisation to house dust mite (strong), cockroach and cat dander.',
      ...footer('Dr. Neelima Kulkarni, MD (Pathology) (synthetic)'),
    ],
  },
  {
    key: 'vikram-pulm-letter',
    daysAgo: 240,
    type: 'other',
    title: 'Pulmonology follow-up letter (synthetic)',
    lines: (d) => [
      ...header(
        'Pune Lung and Allergy Centre (synthetic)',
        'Aundh, Pune 411007 - Clinic letter',
        vikram,
        [`Date: ${d}`],
      ),
      'Seen four weeks after admission for an asthma exacerbation. Feels well; no night waking;',
      'uses the reliever about once a week. Peak flow 480 L/min (personal best 520).',
      '',
      'Spirometry: moderate obstruction with 14% reversibility. Allergy tests: house dust mite,',
      'cockroach and cat dander.',
      '',
      'Plan:',
      '1. Continue budesonide-formoterol 200/6, 2 puffs twice daily, with a spacer. Consider',
      '   stepping down to 1 puff twice daily after 3 months without symptoms.',
      '2. Continue montelukast 10 mg at night for allergic rhinitis.',
      '3. Mite-proof mattress and pillow covers; keep the cat out of the bedroom.',
      '4. Influenza vaccine every year; pneumococcal vaccine advised.',
      '5. Asthma action plan reviewed: green, amber and red zones by peak flow.',
      'Review in 6 months, or earlier if the reliever is needed more than twice a week.',
      ...footer('Dr. Kavita Rane, DM (Pulmonology) (synthetic)'),
    ],
  },
  {
    key: 'vikram-lipid',
    daysAgo: 150,
    type: 'lab_report',
    title: 'Lipid profile and sugar (synthetic)',
    lines: (d) => [
      ...header(
        'Sunrise Diagnostics Laboratory, Pune',
        'FC Road, Shivajinagar, Pune 411005',
        vikram,
        [`Collected: ${d} 08:00 (fasting)    Reported: ${d} 15:00`],
      ),
      'Total Cholesterol: 214 mg/dL (ref 0-200) H',
      'Triglycerides: 138 mg/dL (ref 0-150)',
      'HDL Cholesterol: 42 mg/dL (ref 40-60)',
      'LDL Cholesterol: 142 mg/dL (ref 0-130) H',
      'Fasting Glucose: 94 mg/dL (ref 70-99)',
      'HbA1c: 5.4 % (ref 4.0-5.6)',
      '',
      'Comments: Borderline high LDL cholesterol. Sugar levels normal.',
      ...footer('Dr. Neelima Kulkarni, MD (Pathology) (synthetic)'),
    ],
  },
  {
    key: 'vikram-vaccines',
    daysAgo: 220,
    type: 'other',
    title: 'Vaccination record (synthetic)',
    lines: (d) => [
      `Adult vaccination record - ${vikram.name} (${vikram.mrn})`,
      'Pune Lung and Allergy Centre (synthetic)',
      '',
      `Influenza (quadrivalent), dose for this season: given ${d}, left arm, batch SYN-FLU-118`,
      'Pneumococcal conjugate vaccine (PCV20): given 3 weeks later, right arm, batch SYN-PCV-42',
      'Tetanus-diphtheria (Td) booster: given 4 years earlier (per patient card)',
      'COVID-19: primary series and one booster (per patient card)',
      '',
      'Next due: influenza every year before the monsoon season; Td booster in 6 years.',
      '',
      SYN,
    ],
  },
];

/**
 * Documents per demo patient, with dates relative to `today`.
 * @returns {{ patient: 'asha'|'kamala'|'vikram', key: string, type: string, title: string,
 *   filename: string, pages: string[][] }[]}
 */
export function syntheticRecords(today = new Date()) {
  const build = (patient, docs) =>
    docs.map((doc) => {
      const lines = doc.lines(dayOf(today, doc.daysAgo));
      return {
        patient,
        key: doc.key,
        type: doc.type,
        title: doc.title,
        filename: `${doc.key}.pdf`,
        pages: paginate(lines),
      };
    });
  return [...build('asha', ASHA), ...build('kamala', KAMALA), ...build('vikram', VIKRAM)];
}

const LINES_PER_PAGE = 46;
const WIDTH = 92;

/** Wraps long lines and splits into pages, so longer documents run over several pages. */
function paginate(lines) {
  const wrapped = [];
  for (const line of lines) {
    if (line.length <= WIDTH) {
      wrapped.push(line);
      continue;
    }
    let rest = line;
    while (rest.length > WIDTH) {
      const cut = rest.lastIndexOf(' ', WIDTH);
      const at = cut > 20 ? cut : WIDTH;
      wrapped.push(rest.slice(0, at));
      rest = `  ${rest.slice(at).trimStart()}`;
    }
    wrapped.push(rest);
  }
  const pages = [];
  for (let i = 0; i < wrapped.length; i += LINES_PER_PAGE) {
    pages.push(wrapped.slice(i, i + LINES_PER_PAGE));
  }
  return pages;
}
