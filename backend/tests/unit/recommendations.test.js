import { describe, expect, it, vi } from 'vitest';
import { createRecommendationService } from '../../src/modules/patients/recommendationService.js';

const NOW = new Date('2026-11-02T04:00:00Z');
const principal = { userId: 'u1' };

const doctor = (id, city, reasons = []) => ({
  id,
  professionalName: `Dr. ${id}`,
  languages: ['English'],
  clinics: city ? [{ id: `clinic-${id}`, name: 'A clinic', city }] : [],
  reasons,
});

/** Ten doctors elsewhere fill the search's own list, as in a directory of hundreds. */
const elsewhere = Array.from({ length: 10 }, (_, i) => doctor(`far${i}`, 'Jaipur'));

function service({ profile = {}, team = [], past = [], slots = async () => [] } = {}) {
  const search = vi.fn(async (criteria, context) => {
    if (context.pool) {
      return {
        doctors: context.pool.map((id) => doctor(id, 'Delhi')),
      };
    }
    if (criteria.city) {
      return { doctors: [doctor('near', 'Bengaluru', [{ code: 'city', value: 'Bengaluru' }])] };
    }
    return { doctors: elsewhere };
  });
  return {
    search,
    recommendations: createRecommendationService({
      doctorSearchService: { search },
      patientService: {
        getProfile: async () => ({ access: { relationship: 'patient_self' }, ...profile }),
      },
      careService: { listForPatient: async () => team },
      appointmentService: { listForPatient: async () => past },
      availabilityService: { slots: vi.fn(slots) },
      now: () => NOW,
    }),
  };
}

const ids = (result) => result.recommendations.map((r) => r.doctor.id);

describe('recommendations reach beyond the search’s own top few', () => {
  it('a doctor near the patient is considered, whatever the directory’s size', async () => {
    // The profile says Bangalore; the clinic says Bengaluru. One city.
    const { recommendations } = service({ profile: { city: 'Bangalore' } });
    const result = await recommendations.recommend(principal, { patientId: 'p1', limit: 5 });
    expect(ids(result)).toContain('near');
    const near = result.recommendations.find((r) => r.doctor.id === 'near');
    expect(near.explanations).toContainEqual({ code: 'near_you', value: 'Bengaluru' });
    // Nobody asked for this city: it lifts the doctor, it is not a match.
    expect(near.explanations.map((e) => e.code)).not.toContain('matches_city');
    // Equally relevant, the doctor nearby comes before the search's own first doctor.
    expect(ids(result)[0]).toBe('near');
  });

  it('a doctor the patient has seen comes first, even outside the search’s list', async () => {
    const { recommendations, search } = service({
      past: [{ doctorId: 'seen', status: 'completed', startsAt: new Date('2026-09-01') }],
    });
    const result = await recommendations.recommend(principal, { patientId: 'p1', limit: 5 });
    expect(ids(result)[0]).toBe('seen');
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 10 }),
      expect.objectContaining({ pool: ['seen'] }),
    );
  });

  it('asks only once when there is nobody familiar and no city to look in', async () => {
    const { recommendations, search } = service();
    await recommendations.recommend(principal, { patientId: 'p1' });
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('a stated city is a filter, so no second list is needed for it', async () => {
    const { recommendations, search } = service({ profile: { city: 'Pune' } });
    await recommendations.recommend(principal, { patientId: 'p1', criteria: { city: 'Delhi' } });
    expect(search).toHaveBeenCalledTimes(1);
  });
});

describe('recommendations for a time the person asked for', () => {
  it('puts a doctor free then first, and says why', async () => {
    const free = '2026-11-02T10:30:00Z';
    const { recommendations } = service({
      slots: async (_p, id) => (id === 'far3' ? [{ startsAt: free, mode: 'online' }] : []),
    });
    const wanted = { from: '2026-11-01', to: '2026-11-03', keep: () => true };
    const result = await recommendations.recommend(principal, { patientId: 'p1', wanted });
    expect(ids(result)[0]).toBe('far3');
    expect(result.recommendations[0].explanations).toContainEqual({
      code: 'free_then',
      value: free,
      mode: 'online',
    });
  });

  it('with a city, an in-clinic time elsewhere is not their soonest', async () => {
    const { recommendations } = service({
      slots: async () => [
        { startsAt: '2026-11-03T04:00:00Z', mode: 'in_clinic', clinicId: 'somewhere-else' },
        { startsAt: '2026-11-04T04:00:00Z', mode: 'in_clinic', clinicId: 'clinic-near' },
      ],
    });
    const result = await recommendations.recommend(principal, {
      patientId: 'p1',
      criteria: { city: 'Bengaluru' },
    });
    const earliest = result.recommendations
      .find((r) => r.doctor.id === 'near')
      .explanations.find((e) => e.code === 'earliest');
    expect(earliest.value).toBe('2026-11-04T04:00:00Z');
  });
});
