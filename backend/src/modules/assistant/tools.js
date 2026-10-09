import { z } from 'zod';
import { ASSISTANT_SPECIALTIES, ASSISTANT_TIME_WINDOWS, PERMISSIONS } from '@healthbridge/shared';
import { AppError } from '../../core/http/errors.js';
import { domainMetrics } from '../../core/metrics/domain.js';
import { slotQuery } from './calendar.js';

/**
 * The care assistant's tools (M13.1, ADR-0029): an explicit allow-list. The AI service
 * only *names* a tool and its arguments; the backend validates the arguments strictly,
 * checks the permission, and runs the tool as the signed-in user against the session's
 * patient — which the AI never supplies. Every tool calls an existing domain service, so
 * AccessPolicy (permission → relationship → consent) and RLS apply unchanged.
 *
 * M13.1 tools are read-only. Results sent back to the AI carry IDs and public doctor
 * facts only (never patient data); the full public views stay here as `evidence`, from
 * which the reply's cards are built, so every card shows backend data.
 */

const uuid = z.uuid();
const MAX_DOCTORS = 10;
const MAX_SLOTS = 6;

const TOOL_ARGS = {
  getPatientContext: z.object({}).strict(),
  getPatientCareTeam: z.object({}).strict(),
  searchDoctors: z
    .object({
      specialty: z.enum(ASSISTANT_SPECIALTIES).optional(),
      name: z
        .string()
        .regex(/^[A-Za-z][A-Za-z .'-]{1,59}$/)
        .optional(),
      language: z
        .string()
        .regex(/^[A-Za-z][A-Za-z ]{1,29}$/)
        .optional(),
    })
    .strict()
    .refine((a) => a.specialty || a.name || a.language, 'Search needs a criterion.'),
  getDoctorProfile: z.object({ doctorId: uuid }).strict(),
  findAvailableSlots: z
    .object({
      doctorId: uuid,
      date: z.iso.date().optional(),
      timeWindow: z.enum(ASSISTANT_TIME_WINDOWS).optional(),
      mode: z.enum(['online', 'in_clinic']).optional(),
    })
    .strict(),
};

const TOOL_PERMISSIONS = {
  getPatientContext: PERMISSIONS.ASSISTANT_USE,
  getPatientCareTeam: PERMISSIONS.CARE_RELATIONSHIPS_READ,
  searchDoctors: PERMISSIONS.DOCTORS_READ,
  getDoctorProfile: PERMISSIONS.DOCTORS_READ,
  findAvailableSlots: PERMISSIONS.DOCTORS_READ,
};

export const TOOL_NAMES = Object.freeze(Object.keys(TOOL_ARGS));

const errorCode = (err) =>
  err instanceof AppError && /^[a-z_]{1,48}$/.test(err.code ?? '') ? err.code : 'tool_failed';

const doctorFacts = (d) => ({
  id: d.id,
  professionalName: d.professionalName,
  primarySpecialization: d.primarySpecialization,
  languages: d.languages ?? [],
  yearsOfExperience: d.yearsOfExperience ?? null,
  clinics: (d.clinics ?? []).map((c) => ({ id: c.id, name: c.name, city: c.city ?? null })),
});

/**
 * One tool context per assistant turn.
 * @param {{ principal: object, patientId: string, actingFor: 'self'|'dependent', timeZone: string, req?: object }} turn
 */
export function createToolContext(
  { accessPolicy, careService, doctorService, availabilityService, logger },
  { principal, patientId, actingFor, timeZone, req },
) {
  const evidence = { doctors: new Map(), slots: new Map(), careTeam: null };
  let careTeamPromise = null;

  // The session's care team, read through the existing service (AccessPolicy enforced).
  const careTeam = () => {
    careTeamPromise ??= careService.listForPatient(principal, patientId, req).then((rows) => {
      evidence.careTeam = new Map(rows.map((r) => [r.doctorId, r.status]));
      for (const r of rows) {
        if (r.doctor && !evidence.doctors.has(r.doctorId)) {
          evidence.doctors.set(r.doctorId, {
            id: r.doctorId,
            professionalName: r.doctor.professionalName,
            primarySpecialization: r.doctor.primarySpecialization,
            languages: [],
            yearsOfExperience: null,
            clinics: [],
          });
        }
      }
      return evidence.careTeam;
    });
    return careTeamPromise;
  };

  const run = {
    async getPatientContext() {
      return { actingFor };
    },
    async getPatientCareTeam() {
      const team = await careTeam();
      return {
        doctors: [...team.entries()]
          .slice(0, 20)
          .map(([doctorId, status]) => ({ doctorId, status })),
      };
    },
    async searchDoctors({ specialty, name, language }) {
      const page = await doctorService.directory({
        ...(name ? { q: name } : {}),
        ...(specialty ? { specialization: specialty } : {}),
        limit: 50,
      });
      const team = await careTeam();
      const wanted = language?.toLowerCase();
      const doctors = page.items
        .filter((d) => !wanted || (d.languages ?? []).some((l) => l.toLowerCase() === wanted))
        .slice(0, MAX_DOCTORS);
      for (const d of doctors) evidence.doctors.set(d.id, doctorFacts(d));
      return {
        doctors: doctors.map((d) => ({
          doctorId: d.id,
          specialty: d.primarySpecialization,
          languages: d.languages ?? [],
          inCareTeam: team.get(d.id) === 'active',
        })),
      };
    },
    async getDoctorProfile({ doctorId }) {
      const d = await doctorService.publicProfile(doctorId);
      evidence.doctors.set(d.id, doctorFacts(d));
      return { doctorId: d.id, specialty: d.primarySpecialization, languages: d.languages ?? [] };
    },
    async findAvailableSlots({ doctorId, date, timeWindow, mode }) {
      const query = slotQuery({ date, timeWindow }, timeZone);
      const slots = (
        await availabilityService.slots(principal, doctorId, {
          from: query.from,
          to: query.to,
          ...(mode ? { mode } : {}),
        })
      )
        .filter(query.keep)
        .slice(0, MAX_SLOTS);
      if (!evidence.doctors.has(doctorId)) {
        const d = await doctorService.publicProfile(doctorId);
        evidence.doctors.set(d.id, doctorFacts(d));
      }
      for (const s of slots) evidence.slots.set(`${doctorId}|${s.startsAt}`, { doctorId, ...s });
      return { doctorId, slots: slots.map((s) => ({ startsAt: s.startsAt, mode: s.mode })) };
    },
  };

  /** Runs one tool call requested by the AI. Never throws: failures become results. */
  async function execute(name, args) {
    const started = performance.now();
    const outcome = (label) => {
      domainMetrics.agentToolCalls.inc({
        tool: TOOL_ARGS[name] ? name : 'unknown',
        outcome: label,
      });
      domainMetrics.agentToolLatency.observe(
        { tool: TOOL_ARGS[name] ? name : 'unknown' },
        (performance.now() - started) / 1000,
      );
    };
    if (!Object.hasOwn(TOOL_ARGS, name)) {
      outcome('rejected');
      return { ok: false, errorCode: 'tool_unknown' };
    }
    const parsed = TOOL_ARGS[name].safeParse(args ?? {});
    if (!parsed.success) {
      outcome('rejected');
      return { ok: false, errorCode: 'tool_invalid_arguments' };
    }
    const permitted = await accessPolicy.evaluate({
      principal,
      permission: TOOL_PERMISSIONS[name],
    });
    if (!permitted.allowed) {
      outcome('denied');
      return { ok: false, errorCode: 'tool_forbidden' };
    }
    try {
      const data = await run[name](parsed.data);
      outcome('ok');
      return { ok: true, data };
    } catch (err) {
      outcome('error');
      if (!(err instanceof AppError)) logger?.warn({ err, tool: name }, 'assistant tool failed');
      return { ok: false, errorCode: errorCode(err) };
    }
  }

  return { execute, evidence, careTeam };
}
