/** Display helpers: times are shown in the viewer's own timezone. */

export const formatDateTime = (iso) =>
  new Intl.DateTimeFormat('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));

export const formatTime = (iso) =>
  new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit' }).format(new Date(iso));

export const formatDay = (iso) =>
  new Intl.DateTimeFormat('en-IN', { weekday: 'long', day: 'numeric', month: 'long' }).format(
    new Date(iso),
  );

export const formatFee = (paise) =>
  paise
    ? new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(paise / 100)
    : 'No fee';

export const MODE_LABELS = { online: 'Online', in_clinic: 'In clinic' };

/** Local calendar date (YYYY-MM-DD) offset by `days` from today. */
export function localDate(days = 0) {
  const d = new Date(Date.now() + days * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Groups items with a `startsAt` by local calendar day. */
export function groupByDay(items, key = 'startsAt') {
  const groups = new Map();
  for (const item of items) {
    const day = new Date(item[key]).toDateString();
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push(item);
  }
  return [...groups.entries()];
}

/** A calendar date (YYYY-MM-DD) as a long local date, without time-zone shifts. */
export const formatDateOnly = (isoDate) => formatDay(`${String(isoDate).slice(0, 10)}T00:00:00`);
