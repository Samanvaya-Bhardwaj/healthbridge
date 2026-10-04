import { useQuery } from '@tanstack/react-query';
import { consentsApi } from '../../lib/domainApi.js';
import { formatFee } from '../appointments/format.js';

/**
 * Helpers for the doctor's workspace. Everything is derived from data the doctor already
 * receives; nothing here widens what a doctor can see.
 */

export const ageFrom = (dob, now = Date.now()) => {
  if (!dob) return null;
  const birth = new Date(dob);
  const today = new Date(now);
  let age = today.getFullYear() - birth.getFullYear();
  if (today < new Date(today.getFullYear(), birth.getMonth(), birth.getDate())) age -= 1;
  return age;
};

/** Active consents this doctor holds, by patient (records shared with them right now). */
export function useSharedRecords() {
  const received = useQuery({
    queryKey: ['consents', 'received'],
    queryFn: consentsApi.received,
    staleTime: 30_000,
  });
  const byPatient = new Map();
  for (const c of received.data ?? []) {
    if (c.status !== 'active') continue;
    const prev = byPatient.get(c.patientId);
    // Prefer a consent that covers documents, then the one lasting longest.
    const better =
      !prev ||
      (coversDocuments(c) && !coversDocuments(prev)) ||
      (coversDocuments(c) === coversDocuments(prev) &&
        new Date(c.expiresAt) > new Date(prev.expiresAt));
    if (better) byPatient.set(c.patientId, c);
  }
  return { ...received, byPatient };
}

/** True when a consent lets the doctor open documents (and so prepare an AI brief). */
export const coversDocuments = (consent) => Boolean(consent?.scopes?.includes('medical_documents'));

/**
 * Payment wording for the doctor, from the appointment alone: a fee-bearing appointment
 * is confirmed only after the provider's verified payment, so "confirmed" means paid.
 */
export function paymentLabel(a) {
  if (!a.feePaise) return 'No fee';
  if (a.status === 'pending_payment') return `Awaiting payment · ${formatFee(a.feePaise)}`;
  if (['cancelled', 'expired'].includes(a.status)) return null;
  return `Paid · ${formatFee(a.feePaise)}`;
}

export const ACTIVE = ['pending_payment', 'confirmed', 'checked_in', 'in_consultation'];
export const OPEN_ROOM = ['confirmed', 'checked_in', 'in_consultation', 'completed'];

/** The waiting room for an online appointment is open from 15 minutes before the start. */
export const waitingWindowOpen = (a, now) =>
  a.mode === 'online' &&
  ['confirmed', 'in_consultation'].includes(a.status) &&
  now >= new Date(a.startsAt).getTime() - 15 * 60_000 &&
  now < new Date(a.endsAt).getTime() + 60 * 60_000;
