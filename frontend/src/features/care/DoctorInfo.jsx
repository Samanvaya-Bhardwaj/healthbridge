import { BadgeCheck, Building2, CalendarClock, GraduationCap, Languages } from 'lucide-react';
import { MODE_LABELS, formatDateTime } from '../appointments/format.js';
import { AVAILABILITY_DAYS, MODE_ICONS, feeText, summariseSlots } from './doctorInfo.js';

/** "Who is this doctor, and why trust the profile?" — only what the doctor's profile holds. */
export function DoctorCredentials({ doctor }) {
  if (!doctor) return null;
  const verified = doctor.verified ?? doctor.verificationStatus === 'verified';
  const specialities = [doctor.primarySpecialization, ...(doctor.additionalSpecializations ?? [])];
  return (
    <dl className="grid gap-3 text-sm sm:grid-cols-2">
      <div className="sm:col-span-2">
        <dt className="sr-only">Verification</dt>
        <dd
          className={`flex items-start gap-2 rounded-lg px-3 py-2 ${
            verified ? 'bg-primary-soft text-primary' : 'bg-surface-muted text-text-muted'
          }`}
        >
          <BadgeCheck aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            <span className="font-medium">
              {verified
                ? 'Registration verified by HealthBridge.'
                : 'Registration not verified yet.'}
            </span>{' '}
            <span className="text-text">
              {doctor.registrationCouncil} · Reg. no. {doctor.registrationNumber}
            </span>
          </span>
        </dd>
      </div>
      <div>
        <dt className="text-xs font-semibold uppercase tracking-wide text-text-subtle">
          Speciality
        </dt>
        <dd className="mt-0.5 text-text">{specialities.join(', ')}</dd>
      </div>
      <div>
        <dt className="text-xs font-semibold uppercase tracking-wide text-text-subtle">
          Experience
        </dt>
        <dd className="mt-0.5 text-text">
          {doctor.yearsOfExperience} year{doctor.yearsOfExperience === 1 ? '' : 's'}
        </dd>
      </div>
      {doctor.qualifications?.length > 0 && (
        <div>
          <dt className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-text-subtle">
            <GraduationCap aria-hidden="true" className="h-3.5 w-3.5" />
            Qualifications
          </dt>
          <dd className="mt-0.5 text-text">
            <ul>
              {doctor.qualifications.map((q) => (
                <li key={`${q.degree}-${q.year}`}>
                  {q.degree}, {q.institution} ({q.year})
                </li>
              ))}
            </ul>
          </dd>
        </div>
      )}
      {doctor.languages?.length > 0 && (
        <div>
          <dt className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-text-subtle">
            <Languages aria-hidden="true" className="h-3.5 w-3.5" />
            Speaks
          </dt>
          <dd className="mt-0.5 text-text">{doctor.languages.join(', ')}</dd>
        </div>
      )}
      {doctor.clinics?.length > 0 && (
        <div>
          <dt className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-text-subtle">
            <Building2 aria-hidden="true" className="h-3.5 w-3.5" />
            Clinic
          </dt>
          <dd className="mt-0.5 text-text">
            {doctor.clinics.map((c) => `${c.name}${c.city ? `, ${c.city}` : ''}`).join(' · ')}
          </dd>
        </div>
      )}
      {doctor.bio && (
        <div className="sm:col-span-2">
          <dt className="text-xs font-semibold uppercase tracking-wide text-text-subtle">About</dt>
          <dd className="mt-0.5 leading-relaxed text-text">{doctor.bio}</dd>
        </div>
      )}
    </dl>
  );
}

/** "When can I consult them?" — modes, fee and the next free time per mode. */
export function AvailabilitySummary({ slots, compact = false }) {
  if (slots.isPending) {
    return <p className="text-sm text-text-muted">Checking available times…</p>;
  }
  if (slots.isError) {
    return (
      <p className="text-sm text-text-muted">Available times can’t be shown for this doctor now.</p>
    );
  }
  const modes = summariseSlots(slots.data);
  if (!modes.length) {
    return (
      <p className="flex items-center gap-2 text-sm text-text-muted">
        <CalendarClock aria-hidden="true" className="h-4 w-4 shrink-0" />
        No free times in the next {AVAILABILITY_DAYS} days.
      </p>
    );
  }
  return (
    <ul className={`grid gap-2 ${compact ? '' : 'sm:grid-cols-2'}`}>
      {modes.map((m) => {
        const Icon = MODE_ICONS[m.mode];
        return (
          <li
            key={m.mode}
            className="flex items-start gap-2.5 rounded-lg border border-border px-3 py-2 text-sm"
          >
            <Icon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <span className="min-w-0">
              <span className="block font-medium text-text">
                {MODE_LABELS[m.mode]} · {feeText(m)}
              </span>
              <span className="block text-text-muted">
                Next free: {formatDateTime(m.next.startsAt)}
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
