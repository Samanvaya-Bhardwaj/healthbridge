/** 20261020T050000Z: the compact UTC form Google and Outlook links use. */
const compact = (iso) =>
  new Date(iso)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');

/** What the calendar entry says: the same wording as the emailed invitation. */
export function calendarText(a) {
  // Either appointment shape: the scheduling view (doctor, clinic) or the consultation view.
  const doctor = a.doctor?.professionalName ?? a.doctorName ?? 'your doctor';
  const clinic = a.clinic?.name ?? a.clinicName ?? null;
  const title =
    a.mode === 'online'
      ? `HealthBridge: online consultation with ${doctor}`
      : `HealthBridge: visit to ${doctor}${clinic ? ` at ${clinic}` : ''}`;
  const link = `${window.location.origin}/app/appointments/${a.id}`;
  const reference = a.reference ?? a.id.slice(-8).toUpperCase();
  return {
    title,
    reference,
    details: `Booking reference ${reference}. Open it in HealthBridge: ${link}`,
    location:
      a.mode === 'online' ? 'Online video consultation (HealthBridge)' : (clinic ?? 'Clinic'),
  };
}

export function googleCalendarUrl(a) {
  const t = calendarText(a);
  const q = new URLSearchParams({
    action: 'TEMPLATE',
    text: t.title,
    dates: `${compact(a.startsAt)}/${compact(a.endsAt)}`,
    details: t.details,
    location: t.location,
  });
  return `https://calendar.google.com/calendar/render?${q}`;
}

export function outlookCalendarUrl(a) {
  const t = calendarText(a);
  const q = new URLSearchParams({
    path: '/calendar/action/compose',
    rru: 'addevent',
    subject: t.title,
    startdt: new Date(a.startsAt).toISOString(),
    enddt: new Date(a.endsAt).toISOString(),
    body: t.details,
    location: t.location,
  });
  return `https://outlook.live.com/calendar/0/deeplink/compose?${q}`;
}
