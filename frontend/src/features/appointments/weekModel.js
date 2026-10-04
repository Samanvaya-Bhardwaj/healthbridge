import { MODE_LABELS, formatFee, formatTime } from './format.js';

/** Week model for the doctor's schedule: what is available, booked, blocked or off. */

export const DAY_MS = 86_400_000;
export const WEEKDAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** ISO weekday 1–7 (Monday = 1) of a local date. */
export const isoWeekday = (d) => ((d.getDay() + 6) % 7) + 1;
export const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
export const localIso = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const minutesOfDay = (date) => date.getHours() * 60 + date.getMinutes();

/** The rules that apply on a given local date (weekday and validity period). */
export const rulesOn = (rules, day) =>
  rules.filter(
    (r) =>
      r.weekday === isoWeekday(day) &&
      r.validFrom <= localIso(day) &&
      (!r.validUntil || r.validUntil >= localIso(day)),
  );

/** Part of a [start, end) instant range that falls on `day`, in minutes of that day. */
function clip(startIso, endIso, day) {
  const dayStart = new Date(day);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart.getTime() + DAY_MS);
  const s = new Date(Math.max(new Date(startIso), dayStart));
  const e = new Date(Math.min(new Date(endIso), dayEnd));
  if (e <= s) return null;
  return [minutesOfDay(s), e.getTime() === dayEnd.getTime() ? 24 * 60 : minutesOfDay(e)];
}

export const KIND_STYLES = {
  available: 'border border-primary/30 bg-primary-soft text-primary',
  booked: 'border border-primary bg-primary text-primary-contrast',
  blocked: 'border border-warning/60 bg-warning/15 text-text',
  timeOff:
    'border border-border bg-[repeating-linear-gradient(135deg,var(--hb-surface-muted)_0_6px,transparent_6px_12px)] text-text-muted',
};

/** Everything that happens on one day, as blocks with minutes from midnight. */
export function dayBlocks(day, { rules, appointments, timeOff }) {
  const blocks = [];
  for (const r of rulesOn(rules, day)) {
    blocks.push({
      kind: 'available',
      key: `r-${r.id}`,
      start: toMin(r.startTime),
      end: toMin(r.endTime),
      label: `${MODE_LABELS[r.mode]} ${r.startTime}–${r.endTime}`,
      detail: `${r.slotMinutes} min · ${formatFee(r.feePaise)}`,
      mode: r.mode,
    });
  }
  for (const t of timeOff) {
    const span = clip(t.startsAt, t.endsAt, day);
    if (span)
      blocks.push({
        kind: 'timeOff',
        key: `t-${t.id}`,
        start: span[0],
        end: span[1],
        label: 'Time off',
        detail: t.reasonCode.replace('_', ' '),
      });
  }
  for (const a of appointments) {
    if (['cancelled', 'expired', 'no_show'].includes(a.status)) continue;
    const span = clip(a.startsAt, a.endsAt, day);
    if (!span) continue;
    blocks.push({
      kind: a.status === 'pending_payment' ? 'blocked' : 'booked',
      key: `a-${a.id}`,
      start: span[0],
      end: span[1],
      label: `${formatTime(a.startsAt)} ${a.patient?.fullName ?? `Ref ${a.reference}`}`,
      detail: a.status === 'pending_payment' ? 'Held · awaiting payment' : MODE_LABELS[a.mode],
      mode: a.mode,
      to: `/app/appointments/${a.id}/consultation`,
    });
  }
  return blocks;
}

/**
 * Existing rules a draft would overlap. Mirrors the server's check (same weekday,
 * overlapping validity and times, any mode): a doctor cannot be in two places at once.
 */
export function overlappingRules(rules, draft) {
  return rules.filter((r) => {
    if (r.weekday !== draft.weekday) return false;
    const rUntil = r.validUntil ?? '9999-12-31';
    const dUntil = draft.validUntil || '9999-12-31';
    if (r.validFrom > dUntil || draft.validFrom > rUntil) return false;
    return toMin(r.startTime) < toMin(draft.endTime) && toMin(draft.startTime) < toMin(r.endTime);
  });
}
