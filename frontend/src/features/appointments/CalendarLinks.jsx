import { useState } from 'react';
import { CalendarPlus, Download } from 'lucide-react';
import { schedulingApi } from '../../lib/domainApi.js';
import { Button } from '../../components/ui/Button.jsx';
import { authErrorMessage } from '../auth/errorMessages.js';
import { calendarText, googleCalendarUrl, outlookCalendarUrl } from './calendarLinks.js';

/**
 * Add a booked appointment to a calendar: Google, Outlook, or an .ics file for any
 * calendar app. The confirmation email already carries an invitation; this is for anyone
 * who wants it elsewhere. The links open the calendar site with the details filled in.
 */
export function CalendarLinks({ appointment: a, compact: small = false }) {
  const [error, setError] = useState(null);
  const download = async () => {
    setError(null);
    try {
      const ics = await schedulingApi.calendarFile(a.id);
      const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `healthbridge-${calendarText(a).reference}.ics`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(authErrorMessage(err));
    }
  };
  const size = small ? 'sm' : 'md';
  return (
    <div>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Add to calendar">
        <a
          className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-sm font-medium text-text hover:bg-surface-muted"
          href={googleCalendarUrl(a)}
          target="_blank"
          rel="noopener noreferrer"
        >
          <CalendarPlus aria-hidden="true" className="h-4 w-4" />
          Google Calendar
        </a>
        <a
          className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-sm font-medium text-text hover:bg-surface-muted"
          href={outlookCalendarUrl(a)}
          target="_blank"
          rel="noopener noreferrer"
        >
          <CalendarPlus aria-hidden="true" className="h-4 w-4" />
          Outlook
        </a>
        <Button type="button" variant="secondary" size={size} icon={Download} onClick={download}>
          Download .ics
        </Button>
      </div>
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
    </div>
  );
}
