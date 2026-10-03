/**
 * Prescribing rules (ADR-0025). A configurable safety net, not a compliance claim and not
 * a clinical decision: it blocks prescriptions the platform must not issue and asks for
 * complete instructions. The doctor remains responsible for every prescription.
 *
 * Default rule set, modelled on India's Telemedicine Practice Guidelines (2020): narcotic
 * and psychotropic substances (the guidelines' "prohibited list") are never prescribed
 * through a teleconsultation. Before real use the list must be reviewed and maintained
 * by a qualified person.
 */

export const DEFAULT_TELECONSULTATION_PROHIBITED = Object.freeze([
  'alprazolam',
  'buprenorphine',
  'clonazepam',
  'codeine',
  'diazepam',
  'fentanyl',
  'ketamine',
  'lorazepam',
  'methadone',
  'methylphenidate',
  'midazolam',
  'morphine',
  'nitrazepam',
  'oxycodone',
  'pentazocine',
  'pethidine',
  'phenobarbital',
  'tapentadol',
  'tramadol',
  'zolpidem',
]);

const normalise = (s) =>
  String(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9 ]/g, ' ');

/**
 * @param {Array<{ drugName: string }>} items
 * @param {{ mode: 'online'|'in_clinic' }} context
 * @returns {Array<{ position: number, code: string, message: string }>} violations
 */
export function checkPrescribingRules(
  items,
  { mode },
  prohibited = DEFAULT_TELECONSULTATION_PROHIBITED,
) {
  const violations = [];
  const seen = new Map();
  items.forEach((item, i) => {
    const position = i + 1;
    const words = new Set(normalise(item.drugName).split(/\s+/).filter(Boolean));
    if (mode === 'online') {
      const hit = prohibited.find((name) => words.has(name));
      if (hit) {
        violations.push({
          position,
          code: 'prohibited_in_teleconsultation',
          message: `${hit} cannot be prescribed in an online consultation.`,
        });
      }
    }
    const key = normalise(`${item.drugName} ${item.strength ?? ''}`)
      .replace(/\s+/g, ' ')
      .trim();
    if (seen.has(key)) {
      violations.push({
        position,
        code: 'duplicate_item',
        message: `This medicine is already listed as item ${seen.get(key)}.`,
      });
    } else seen.set(key, position);
  });
  return violations;
}
