import { DateTime, Interval } from 'luxon';

/**
 * Slot computation (ADR-0019): slots are derived on demand from weekly availability
 * rules, minus time off, minus busy time. Pure function — no I/O — so it is exhaustively
 * unit-tested. Rules are wall-clock times in the rule's IANA timezone; all results are UTC.
 *
 * @typedef {{ id: string, mode: 'online'|'in_clinic', clinic_id: string|null, weekday: number,
 *   start_time: string, end_time: string, slot_minutes: number, timezone: string,
 *   valid_from: string|Date, valid_until: string|Date|null, fee_paise: number }} Rule
 * @typedef {{ starts_at: Date, ends_at: Date }} Range
 * @typedef {{ startsAt: string, endsAt: string, mode: string, clinicId: string|null, ruleId: string, feePaise: number }} Slot
 */

const toDateString = (value) =>
  value instanceof Date ? DateTime.fromJSDate(value, { zone: 'utc' }).toISODate() : value;

const hhmm = (time) => time.slice(0, 5);

/** Wall-clock occurrences of one rule on one calendar date (in the rule's zone). */
function ruleSlotsOnDate(rule, isoDate) {
  const zone = rule.timezone;
  const day = DateTime.fromISO(isoDate, { zone });
  if (!day.isValid || day.weekday !== rule.weekday) return [];
  if (isoDate < toDateString(rule.valid_from)) return [];
  if (rule.valid_until && isoDate > toDateString(rule.valid_until)) return [];

  const windowStart = DateTime.fromISO(`${isoDate}T${hhmm(rule.start_time)}`, { zone });
  const windowEnd = DateTime.fromISO(`${isoDate}T${hhmm(rule.end_time)}`, { zone });
  const slots = [];
  for (
    let start = windowStart;
    start.plus({ minutes: rule.slot_minutes }) <= windowEnd;
    start = start.plus({ minutes: rule.slot_minutes })
  ) {
    slots.push({ start, end: start.plus({ minutes: rule.slot_minutes }) });
  }
  return slots;
}

const overlaps = (aStart, aEnd, b) =>
  aStart < DateTime.fromJSDate(new Date(b.ends_at)) &&
  DateTime.fromJSDate(new Date(b.starts_at)) < aEnd;

/**
 * @param {{ rules: Rule[], exceptions: Range[], busy: Range[], from: string, to: string,
 *   now: Date, leadMinutes: number, horizonDays: number, mode?: string, clinicId?: string }} input
 * @returns {Slot[]} sorted by start
 */
export function generateSlots({
  rules,
  exceptions,
  busy,
  from,
  to,
  now,
  leadMinutes,
  horizonDays,
  mode,
  clinicId,
}) {
  const earliest = DateTime.fromJSDate(now).plus({ minutes: leadMinutes });
  const latest = DateTime.fromJSDate(now).plus({ days: horizonDays });
  const days = Interval.fromDateTimes(
    DateTime.fromISO(from, { zone: 'utc' }).minus({ days: 1 }),
    DateTime.fromISO(to, { zone: 'utc' }).plus({ days: 2 }),
  )
    .splitBy({ days: 1 })
    .map((i) => i.start.toISODate());

  const result = new Map();
  for (const rule of rules) {
    if (mode && rule.mode !== mode) continue;
    if (clinicId && rule.clinic_id !== clinicId) continue;
    for (const isoDate of days) {
      // Only dates inside the requested range, evaluated in the rule's own zone.
      if (isoDate < from || isoDate > to) continue;
      for (const { start, end } of ruleSlotsOnDate(rule, isoDate)) {
        if (start < earliest || start > latest) continue;
        if (exceptions.some((e) => overlaps(start, end, e))) continue;
        if (busy.some((b) => overlaps(start, end, b))) continue;
        const startsAt = start.toUTC().toISO({ suppressMilliseconds: true });
        result.set(`${startsAt}|${rule.mode}`, {
          startsAt,
          endsAt: end.toUTC().toISO({ suppressMilliseconds: true }),
          mode: rule.mode,
          clinicId: rule.clinic_id ?? null,
          ruleId: rule.id,
          feePaise: rule.fee_paise,
        });
      }
    }
  }
  return [...result.values()].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

/**
 * Finds the slot matching a requested start (and mode/clinic), honouring every rule
 * that `generateSlots` applies. Returns null when the start is not a bookable slot.
 */
export function findSlot(input, { startsAt, mode, clinicId }) {
  const start = DateTime.fromISO(startsAt).toUTC();
  if (!start.isValid) return null;
  const isoUtc = start.toISO({ suppressMilliseconds: true });
  // Search the UTC date and its neighbours (rules in any zone).
  const from = start.minus({ days: 1 }).toISODate();
  const to = start.plus({ days: 1 }).toISODate();
  return (
    generateSlots({ ...input, from, to, mode, clinicId }).find(
      (s) => s.startsAt === isoUtc && s.mode === mode && (!clinicId || s.clinicId === clinicId),
    ) ?? null
  );
}

/** True if two weekly rules can produce overlapping time on the same day. */
export function rulesOverlap(a, b) {
  if (a.weekday !== b.weekday) return false;
  const aUntil = toDateString(a.valid_until) ?? '9999-12-31';
  const bUntil = toDateString(b.valid_until) ?? '9999-12-31';
  if (toDateString(a.valid_from) > bUntil || toDateString(b.valid_from) > aUntil) return false;
  return hhmm(a.start_time) < hhmm(b.end_time) && hhmm(b.start_time) < hhmm(a.end_time);
}
