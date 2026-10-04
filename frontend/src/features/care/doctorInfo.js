import { useQuery } from '@tanstack/react-query';
import { Building2, Video } from 'lucide-react';
import { doctorsApi, schedulingApi } from '../../lib/domainApi.js';
import { formatFee, localDate } from '../appointments/format.js';

/** How far ahead availability is summarised (matches the booking page). */
export const AVAILABILITY_DAYS = 14;

/** The doctor's public (verified) profile. Null when the doctor is no longer listed. */
export function useDoctorProfile(doctorId, { enabled = true } = {}) {
  return useQuery({
    queryKey: ['doctor', doctorId],
    queryFn: () => doctorsApi.publicProfile(doctorId),
    enabled: Boolean(doctorId) && enabled,
    retry: false,
    staleTime: 5 * 60_000,
  });
}

/** Bookable times in the next two weeks, every mode (the server computes them). */
export function useDoctorSlots(doctorId, { enabled = true } = {}) {
  return useQuery({
    queryKey: ['slots', doctorId, 'all'],
    queryFn: () =>
      schedulingApi.slots(doctorId, { from: localDate(0), to: localDate(AVAILABILITY_DAYS) }),
    enabled: Boolean(doctorId) && enabled,
    retry: false,
    staleTime: 60_000,
  });
}

/**
 * Per consultation mode: the next free time, how many times are free, and the fee (or
 * fee range). Derived only from the slots the server offers.
 */
export function summariseSlots(slots = []) {
  const byMode = new Map();
  for (const slot of slots) {
    const entry = byMode.get(slot.mode) ?? {
      mode: slot.mode,
      next: slot,
      count: 0,
      minFee: slot.feePaise,
      maxFee: slot.feePaise,
    };
    entry.count += 1;
    if (slot.startsAt < entry.next.startsAt) entry.next = slot;
    entry.minFee = Math.min(entry.minFee, slot.feePaise);
    entry.maxFee = Math.max(entry.maxFee, slot.feePaise);
    byMode.set(slot.mode, entry);
  }
  return ['online', 'in_clinic'].map((m) => byMode.get(m)).filter(Boolean);
}

export const feeText = ({ minFee, maxFee }) =>
  minFee === maxFee
    ? formatFee(minFee)
    : `${minFee ? formatFee(minFee) : 'Free'} – ${formatFee(maxFee)} (depends on the time)`;

export const MODE_ICONS = { online: Video, in_clinic: Building2 };
export const MODE_DESCRIPTIONS = {
  online: 'Video call from home',
  in_clinic: 'Visit at the clinic',
};
