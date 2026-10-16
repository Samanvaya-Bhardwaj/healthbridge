/**
 * iCalendar (RFC 5545) events for appointments: an invitation emailed to the patient side
 * (METHOD:REQUEST, or CANCEL when cancelled) and a download (METHOD:PUBLISH). One event per
 * booking chain: the UID is the original booking's ID, so a reschedule updates the same
 * calendar entry (a higher SEQUENCE) instead of adding a second one.
 *
 * The event holds only what the person already sees in the app: the doctor, the time, the
 * place or "online", the booking reference and a link. Never a reason, note or diagnosis.
 */

const CRLF = '\r\n';
const BS = String.fromCharCode(92); // backslash, built so no tool or editor mangles it

/** RFC 5545 TEXT escaping: backslash, semicolon, comma and newlines. */
export function escapeText(value) {
  return String(value ?? '')
    .split(BS)
    .join(BS + BS)
    .replace(/;/g, `${BS};`)
    .replace(/,/g, `${BS},`)
    .replace(/\r?\n/g, `${BS}n`);
}

/** Folds a content line at 75 octets (continuation lines start with a space). */
export function foldLine(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts = [];
  let start = 0;
  let limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // Never split a UTF-8 character: back up to a character boundary.
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
    parts.push(bytes.subarray(start, end).toString('utf8'));
    start = end;
    limit = 74; // the leading space counts
  }
  return parts.join(`${CRLF} `);
}

/** UTC date-time in iCalendar basic format, e.g. 20261020T050000Z. */
export const icsTime = (date) =>
  new Date(date)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');

/**
 * @param {{ method: 'REQUEST'|'CANCEL'|'PUBLISH', uid: string, sequence: number,
 *   startsAt: Date|string, endsAt: Date|string, summary: string, description: string,
 *   location: string, url?: string|null, organizer?: { email: string, name?: string }|null,
 *   attendee?: { email: string, name?: string }|null, stamp?: Date, alarmMinutes?: number }} event
 * @returns {string} the calendar object, CRLF line endings
 */
export function buildIcs(event) {
  const cancelled = event.method === 'CANCEL';
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//HealthBridge//Appointments//EN',
    'CALSCALE:GREGORIAN',
    `METHOD:${event.method}`,
    'BEGIN:VEVENT',
    `UID:${event.uid}`,
    `SEQUENCE:${event.sequence}`,
    `DTSTAMP:${icsTime(event.stamp ?? new Date())}`,
    `DTSTART:${icsTime(event.startsAt)}`,
    `DTEND:${icsTime(event.endsAt)}`,
    `SUMMARY:${escapeText(event.summary)}`,
    `DESCRIPTION:${escapeText(event.description)}`,
    `LOCATION:${escapeText(event.location)}`,
    ...(event.url ? [`URL:${event.url}`] : []),
    `STATUS:${cancelled ? 'CANCELLED' : 'CONFIRMED'}`,
    'TRANSP:OPAQUE',
    ...(event.organizer
      ? [
          `ORGANIZER;CN=${escapeText(event.organizer.name ?? 'HealthBridge')}:mailto:${event.organizer.email}`,
        ]
      : []),
    ...(event.attendee
      ? [
          `ATTENDEE;CN=${escapeText(event.attendee.name ?? event.attendee.email)};ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=FALSE:mailto:${event.attendee.email}`,
        ]
      : []),
    ...(!cancelled && event.alarmMinutes
      ? [
          'BEGIN:VALARM',
          'ACTION:DISPLAY',
          `DESCRIPTION:${escapeText(event.summary)}`,
          `TRIGGER:-PT${event.alarmMinutes}M`,
          'END:VALARM',
        ]
      : []),
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(foldLine).join(CRLF) + CRLF;
}

/** The address part of a "Name <address>" mail header (or the value itself). */
export function mailAddress(from) {
  const match = /<([^>]+)>/.exec(String(from ?? ''));
  return (match ? match[1] : String(from ?? '')).trim() || 'no-reply@healthbridge.local';
}
