import { DateTime, IANAZone } from 'luxon';
import { BOOKING_HORIZON_DAYS } from '@healthbridge/shared';

/**
 * Calendar facts for the care assistant, resolved by the backend in the person's own time
 * zone (M13.1). The model only says "tomorrow" or "evening"; the backend decides which
 * day and which hours that means, so no date arithmetic is left to the model.
 */

export const DEFAULT_ZONE = 'Asia/Kolkata';

/** Local hours [from, to) of each time window, in minutes after midnight. */
export const TIME_WINDOWS = Object.freeze({
  morning: [6 * 60, 12 * 60],
  afternoon: [12 * 60, 17 * 60],
  evening: [17 * 60, 22 * 60],
});

export const safeZone = (timeZone) => (IANAZone.isValidZone(timeZone) ? timeZone : DEFAULT_ZONE);

/** `{ today, tomorrow, weekdays, horizon }` as ISO dates for the AI step context. */
export function calendarContext(timeZone, now = new Date()) {
  const zone = safeZone(timeZone);
  const today = DateTime.fromJSDate(now, { zone }).setLocale('en').startOf('day');
  const weekdays = {};
  for (let i = 0; i < 7; i += 1) {
    const day = today.plus({ days: i });
    weekdays[day.toFormat('cccc').toLowerCase()] ??= day.toISODate();
  }
  return {
    today: today.toISODate(),
    tomorrow: today.plus({ days: 1 }).toISODate(),
    weekdays,
    horizon: today.plus({ days: BOOKING_HORIZON_DAYS }).toISODate(),
  };
}

/**
 * The slot query range for a day (or the next week) and a filter keeping slots that start
 * on that local day and inside the time window.
 */
export function slotQuery({ date, timeWindow }, timeZone, now = new Date()) {
  const zone = safeZone(timeZone);
  const today = DateTime.fromJSDate(now, { zone }).startOf('day');
  const day = date ? DateTime.fromISO(date, { zone }) : null;
  const first = day ?? today;
  const last = day ?? today.plus({ days: 6 });
  const window = timeWindow ? TIME_WINDOWS[timeWindow] : null;
  return {
    // One extra day either side: slot generation works in the doctor's own zone.
    from: first.minus({ days: 1 }).toISODate(),
    to: last.plus({ days: 1 }).toISODate(),
    keep(slot) {
      const local = DateTime.fromISO(slot.startsAt, { zone });
      if (local < first || local >= last.plus({ days: 1 })) return false;
      if (!window) return true;
      const minutes = local.hour * 60 + local.minute;
      return minutes >= window[0] && minutes < window[1];
    },
  };
}
