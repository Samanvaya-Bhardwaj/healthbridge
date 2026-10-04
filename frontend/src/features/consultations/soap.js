/** Sections of a clinical note (SOAP), with their labels and hints. */
export const SOAP = [
  ['subjective', 'Subjective', 'What the patient reports'],
  ['objective', 'Objective', 'Findings and observations'],
  ['assessment', 'Assessment', 'Clinical impression'],
  ['plan', 'Plan', 'Management, advice and follow-up'],
];

/** The same sections in the words a patient would use. */
export const PATIENT_SOAP_LABELS = {
  subjective: 'What you told the doctor',
  objective: 'What the doctor found',
  assessment: 'The doctor’s assessment',
  plan: 'Plan and advice',
};
