import { MODE_LABELS, formatDateOnly, formatDateTime } from '../appointments/format.js';

/**
 * Plain words for why a doctor was suggested (M13.2 search reasons, M13.3 recommendation
 * explanations). Each comes from the backend's data; nothing here is about the patient's
 * health. The care-team badge is shown separately, so it has no text here.
 */
const TEXT = {
  specialty: (e) => e.value,
  area: (e) => `Lists ${e.value}`,
  city: (e) => `Practises in ${e.value}`,
  language: (e) => `Speaks ${e.value}`,
  mode: (e) => (e.value === 'online' ? 'Online consultations' : 'In-clinic visits'),
  name: (e) => (e.approximate ? 'Closest name match' : null),
  seen_before: (e) => `You saw them on ${formatDateOnly(e.value)}`,
  near_you: (e) => `Near you in ${e.value}`,
  speaks_your_language: (e) => `Speaks ${e.value}`,
  earliest: (e) => `Next free: ${formatDateTime(e.value)} (${MODE_LABELS[e.mode] ?? e.mode})`,
};

/** "matches_area" (a recommendation) reads like "area" (a search reason). */
export function explanationText(e) {
  const code = e.code.startsWith('matches_') ? e.code.slice('matches_'.length) : e.code;
  return TEXT[code]?.(e) ?? null;
}

/** One line: the most personal reasons first, then what the doctor matched. */
export function whySuggested(doctor) {
  const items = doctor.explanations?.length ? doctor.explanations : (doctor.reasons ?? []);
  return [...new Set(items.map(explanationText).filter(Boolean))].join(' · ');
}
