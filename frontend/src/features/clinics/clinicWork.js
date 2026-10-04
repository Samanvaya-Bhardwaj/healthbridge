import { useQuery } from '@tanstack/react-query';
import { schedulingApi } from '../../lib/domainApi.js';
import { formatFee, formatTime } from '../appointments/format.js';

/**
 * Clinic operations helpers. A clinic administrator sees times, doctors, modes, statuses,
 * references and payment state; never patient identity, visit reasons or clinical data
 * (the API does not return them to the clinic).
 */

export const DAY_MS = 86_400_000;
export const ACTIVE = ['pending_payment', 'confirmed', 'checked_in', 'in_consultation'];
export const GONE = ['cancelled', 'expired'];
/** Late arrival: in-clinic visits not checked in this long after the start. */
export const LATE_MINUTES = 15;

export const adminClinicIds = (user) => [
  ...new Set(
    (user.clinicRoles ?? []).filter((g) => g.role === 'CLINIC_ADMIN').map((g) => g.clinicId),
  ),
];

export const dayStart = (d) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};

export function useClinicDay(clinicId, day) {
  const from = dayStart(day);
  const to = new Date(from.getTime() + DAY_MS);
  return useQuery({
    queryKey: ['clinic-board', clinicId, from.toISOString()],
    queryFn: () => schedulingApi.clinicSchedule(clinicId, from.toISOString(), to.toISOString()),
    enabled: Boolean(clinicId),
    refetchInterval: 60_000,
  });
}

/** Payment state for one fee-bearing appointment (status only; no amounts beyond the fee). */
export function usePaymentState(a) {
  return useQuery({
    queryKey: ['appointment', a.id],
    queryFn: () => schedulingApi.get(a.id),
    enabled: a.feePaise > 0,
    staleTime: 30_000,
    select: (d) => d.paymentStatus,
  });
}

export function paymentText(a, status) {
  if (!a.feePaise) return 'No fee';
  const fee = formatFee(a.feePaise);
  switch (status) {
    case 'paid':
      return `Paid ${fee}`;
    case 'refunded':
      return `Refunded ${fee}`;
    case 'partially_refunded':
      return `Partly refunded (of ${fee})`;
    case 'pending':
    case 'authorized':
      return `Awaiting payment · ${fee}`;
    case 'failed':
      return `Payment failed · ${fee}`;
    case 'cancelled':
      return 'Not paid';
    default:
      return a.status === 'pending_payment' ? `Awaiting payment · ${fee}` : fee;
  }
}

/** A refund can be issued while money was taken and not all of it returned. */
export const refundable = (status) => ['paid', 'partially_refunded'].includes(status);

/**
 * Operational issues for the day: late arrivals, payment holds and (should the
 * schedule ever allow one) two active visits for one doctor at the same time.
 */
export function attentionItems(appointments, now) {
  const items = [];
  for (const a of appointments) {
    if (
      a.mode === 'in_clinic' &&
      a.status === 'confirmed' &&
      now > new Date(a.startsAt).getTime() + LATE_MINUTES * 60_000
    ) {
      items.push({
        key: `late-${a.id}`,
        a,
        tone: 'warning',
        title: `Ref ${a.reference} not checked in`,
        detail:
          a.endsAt && now >= new Date(a.endsAt).getTime()
            ? `${formatTime(a.startsAt)} with ${a.doctor?.professionalName ?? 'the doctor'}: the visit time has ended, so it can no longer be checked in. The doctor can record a no-show.`
            : `${formatTime(a.startsAt)} with ${a.doctor?.professionalName ?? 'the doctor'}: more than ${LATE_MINUTES} minutes after the start.`,
      });
    }
    if (a.status === 'pending_payment') {
      items.push({
        key: `hold-${a.id}`,
        a,
        tone: 'info',
        title: `Ref ${a.reference} awaiting payment`,
        detail: `${formatTime(a.startsAt)} with ${a.doctor?.professionalName ?? 'the doctor'}${
          a.holdExpiresAt ? `: held until ${formatTime(a.holdExpiresAt)}, then released.` : '.'
        }`,
      });
    }
  }
  const active = appointments.filter((a) => ACTIVE.includes(a.status));
  for (let i = 0; i < active.length; i += 1) {
    for (let j = i + 1; j < active.length; j += 1) {
      const [x, y] = [active[i], active[j]];
      if (
        x.doctorId === y.doctorId &&
        x.endsAt &&
        y.endsAt &&
        new Date(x.startsAt) < new Date(y.endsAt) &&
        new Date(y.startsAt) < new Date(x.endsAt)
      ) {
        items.push({
          key: `clash-${x.id}-${y.id}`,
          a: x,
          tone: 'error',
          title: `${x.doctor?.professionalName ?? 'A doctor'} is double-booked`,
          detail: `Ref ${x.reference} and Ref ${y.reference} overlap at ${formatTime(x.startsAt)}. Cancel one of them.`,
        });
      }
    }
  }
  return items;
}

/** Doctors with visits on the day, with counts by state. */
export function doctorsWorking(appointments) {
  const map = new Map();
  for (const a of appointments) {
    if (GONE.includes(a.status)) continue;
    const d = map.get(a.doctorId) ?? {
      id: a.doctorId,
      name: a.doctor?.professionalName ?? 'Doctor',
      specialization: a.doctor?.primarySpecialization,
      first: a.startsAt,
      last: a.endsAt ?? a.startsAt,
      total: 0,
      arrived: 0,
      done: 0,
    };
    d.total += 1;
    if (['checked_in', 'in_consultation'].includes(a.status)) d.arrived += 1;
    if (a.status === 'completed') d.done += 1;
    if (a.startsAt < d.first) d.first = a.startsAt;
    if ((a.endsAt ?? a.startsAt) > d.last) d.last = a.endsAt ?? a.startsAt;
    map.set(a.doctorId, d);
  }
  return [...map.values()].sort((x, y) => x.first.localeCompare(y.first));
}
