import { DateTime } from 'luxon';
import { cityNames, languageForPreference } from '@healthbridge/shared';
import { ForbiddenError } from '../../core/http/errors.js';
import { SELF_RELATIONSHIPS } from '../../core/authz/accessPolicy.js';

const CANDIDATES = 10;
const AVAILABILITY_DAYS = 14;
const AVAILABILITY_CHECKS = 6;

/**
 * Recommendations (M13.3): a small ranked list of doctors with grounded explanations and
 * a next step. Built on the doctor search (ADR-0031), plus what the patient side may
 * already see about this patient:
 *
 * - **Continuity:** doctors in the care team, and doctors the patient has seen before
 *   (the date of the last visit only; never the reason or any clinical content).
 * - **Preferences:** the profile's city and preferred language. They lift a doctor
 *   ("near you", "speaks your language") but never hide anyone, because the person did
 *   not ask for a filter.
 * - **Availability:** the soonest free time in the next two weeks, for the top candidates.
 *
 * Every explanation is a fact from the backend's data, with a code and a value. There is
 * no medical judgement here: "why this doctor" never says anything about the patient's
 * health.
 */
export function createRecommendationService({
  doctorSearchService,
  patientService,
  careService,
  appointmentService,
  availabilityService,
  now = () => new Date(),
}) {
  /**
   * @param {object} principal
   * @param {{ patientId: string, criteria?: object, limit?: number, timeZone?: string,
   *   wanted?: { from: string, to: string, keep: (slot: object) => boolean } }} input
   *   `wanted`: when the person asked for: doctors free then come first.
   */
  async function recommend(
    principal,
    { patientId, criteria = {}, limit = 3, timeZone, wanted },
    req,
  ) {
    // Patient side only (self, or a guardian): a consented doctor may read the profile,
    // but recommendations are for the patient's own choices.
    const profile = await patientService.getProfile(principal, patientId, req);
    if (!SELF_RELATIONSHIPS.has(profile.access?.relationship)) throw new ForbiddenError();

    const team = await careService.listForPatient(principal, patientId, req);
    const careStatus = new Map(team.map((r) => [r.doctorId, r.status]));
    const active = team.filter((r) => r.status === 'active').map((r) => r.doctorId);
    const past = await appointmentService.listForPatient(
      principal,
      { patientId, scope: 'past' },
      req,
    );
    const lastVisit = new Map();
    for (const a of past) {
      if (!['completed', 'checked_in', 'in_consultation'].includes(a.status)) continue;
      const seen = lastVisit.get(a.doctorId);
      if (!seen || a.startsAt > seen) lastVisit.set(a.doctorId, a.startsAt);
    }

    const city = criteria.city ? null : profile.city?.trim() || null;
    const language = criteria.language ? null : languageForPreference(profile.preferredLanguage);
    const nearby = city ? cityNames(city) : [];

    // The search returns its own top few. Doctors this patient already knows, and doctors
    // near them, must reach the scoring below however many others match.
    const known = [...new Set([...active, ...lastVisit.keys()])];
    const search = (extra, context) =>
      doctorSearchService.search(
        { ...criteria, ...extra, limit: CANDIDATES },
        { careTeamDoctorIds: active, ...context },
      );
    const [found, familiar, local] = await Promise.all([
      search(),
      known.length ? search({}, { pool: known }) : { doctors: [] },
      city ? search({ city }) : { doctors: [] },
    ]);
    const candidates = new Map();
    const rank = new Map(); // a doctor's best place in any list, so joining late costs nothing
    for (const list of [found.doctors, familiar.doctors, local.doctors]) {
      list.forEach((d, place) => {
        rank.set(d.id, Math.min(place, rank.get(d.id) ?? place));
        if (candidates.has(d.id)) return;
        // The person did not ask for this city: it is a lift ("near you"), not a match.
        const lifted = list === local.doctors;
        const reasons = lifted ? d.reasons.filter((r) => r.code !== 'city') : d.reasons;
        candidates.set(d.id, { ...d, reasons });
      });
    }

    const scored = [...candidates.values()].map((d) => {
      const explanations = d.reasons
        .filter((r) => r.code !== 'care_team')
        .map((r) => ({ code: `matches_${r.code}`, value: r.value }));
      let score = (CANDIDATES - rank.get(d.id)) / CANDIDATES; // the search's own order first
      if (careStatus.get(d.id) === 'active') {
        score += 1;
        explanations.unshift({ code: 'care_team', value: null });
      }
      if (lastVisit.has(d.id)) {
        score += 1.5;
        explanations.unshift({ code: 'seen_before', value: lastVisit.get(d.id) });
      }
      const site = d.clinics.find((c) => nearby.includes(c.city?.toLowerCase()));
      if (site) {
        score += 0.75;
        explanations.push({ code: 'near_you', value: site.city });
      }
      const spoken =
        language && d.languages.find((l) => l.toLowerCase() === language.toLowerCase());
      if (spoken) {
        score += 0.5;
        explanations.push({ code: 'speaks_your_language', value: spoken });
      }
      return { doctor: d, score, explanations };
    });
    scored.sort(
      (a, b) =>
        b.score - a.score || a.doctor.professionalName.localeCompare(b.doctor.professionalName),
    );

    // Soonest free time for the leading candidates (slots are the shared, eligible ones).
    const from = DateTime.fromJSDate(now()).setZone(timeZone ?? 'Asia/Kolkata');
    const window = {
      from: from.toISODate(),
      to: from.plus({ days: AVAILABILITY_DAYS }).toISODate(),
      ...(criteria.mode ? { mode: criteria.mode } : {}),
    };
    for (const entry of scored.slice(0, AVAILABILITY_CHECKS)) {
      const slots = await availabilityService
        .slots(principal, entry.doctor.id, window)
        .catch(() => []);
      // With a city in the request, an in-clinic time elsewhere is not the soonest for them.
      const asked = criteria.city ? cityNames(criteria.city) : null;
      const sites = asked
        ? entry.doctor.clinics.filter((c) => asked.includes(c.city?.toLowerCase())).map((c) => c.id)
        : null;
      const first = slots.find(
        (s) => !sites || s.mode !== 'in_clinic' || sites.includes(s.clinicId),
      );
      if (first) {
        const days = (new Date(first.startsAt) - now()) / 86_400_000;
        entry.score += 0.5 * Math.max(0, 1 - days / AVAILABILITY_DAYS);
        entry.explanations.push({ code: 'earliest', value: first.startsAt, mode: first.mode });
        entry.earliest = { startsAt: first.startsAt, mode: first.mode };
      }
      if (wanted) {
        const then = await availabilityService
          .slots(principal, entry.doctor.id, {
            from: wanted.from,
            to: wanted.to,
            ...(criteria.mode ? { mode: criteria.mode } : {}),
          })
          .catch(() => []);
        const fit = then.find(wanted.keep);
        if (fit) {
          entry.score += 2;
          entry.explanations.push({ code: 'free_then', value: fit.startsAt, mode: fit.mode });
        }
      }
    }
    scored.sort(
      (a, b) =>
        b.score - a.score || a.doctor.professionalName.localeCompare(b.doctor.professionalName),
    );

    const recommendations = scored.slice(0, limit).map(({ doctor, explanations, earliest }) => {
      const status = careStatus.get(doctor.id) ?? 'none';
      const nextStep =
        status === 'active'
          ? {
              type: 'book',
              ...(earliest ? { startsAt: earliest.startsAt, mode: earliest.mode } : {}),
            }
          : status === 'pending' || status === 'invited'
            ? { type: 'await_acceptance' }
            : { type: 'request_care' };
      return { doctor, careStatus: status, explanations, nextStep };
    });
    return { status: recommendations.length ? 'ok' : 'no_match', recommendations };
  }

  return { recommend };
}
