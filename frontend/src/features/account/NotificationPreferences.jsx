import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { NOTIFICATION_CATEGORIES } from '@healthbridge/shared';
import { inboxApi } from '../../lib/domainApi.js';
import { authErrorMessage } from '../auth/errorMessages.js';
import { Card } from '../../components/ui/Card.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { CheckboxField } from '../../components/ui/Fields.jsx';
import { Skeleton } from '../../components/ui/Skeleton.jsx';
import { useSafeMutation } from '../../lib/useSafeMutation.js';

const LABELS = {
  appointments: ['Appointments', 'Booked, moved or cancelled'],
  payments: ['Payments', 'Confirmed, failed or refunded'],
  reminders: ['Reminders', 'Before an appointment'],
  documents: ['Documents and prescriptions', 'When something new is ready'],
  follow_ups: ['Follow-ups', 'Check-ins your doctor asked for'],
};

/**
 * Step 8: which notifications also arrive by email or text message. The bell in the app
 * always shows all of them, and safety messages are always sent.
 */
export function NotificationPreferences() {
  const queryClient = useQueryClient();
  const prefs = useQuery({
    queryKey: ['notification-preferences'],
    queryFn: inboxApi.preferences,
  });
  const [draft, setDraft] = useState(null);
  const [message, setMessage] = useState(null);
  const current = draft ?? prefs.data;
  const save = useSafeMutation({
    mutationFn: (value) => inboxApi.updatePreferences(value),
    onSuccess: (saved) => {
      queryClient.setQueryData(['notification-preferences'], saved);
      setDraft(null);
      setMessage({ tone: 'success', text: 'Saved.' });
    },
    onError: (error) => setMessage({ tone: 'error', text: authErrorMessage(error) }),
  });

  return (
    <Card>
      <h2 className="text-base font-semibold text-text">Notifications</h2>
      <p className="mt-1 text-sm text-text-muted">
        Choose what also comes by email or text message. Everything always appears under the bell in
        the app. Emergency guidance, urgent follow-ups and payments that hold a booking are always
        sent.
      </p>
      {prefs.isPending && <Skeleton className="mt-4 h-24" />}
      {prefs.isError && (
        <Alert tone="error" className="mt-4">
          {authErrorMessage(prefs.error)}
        </Alert>
      )}
      {current && (
        <form
          className="mt-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            setMessage(null);
            save.mutate(current);
          }}
        >
          <fieldset className="space-y-3">
            <legend className="text-sm font-medium text-text">By email</legend>
            {NOTIFICATION_CATEGORIES.map((c) => (
              <CheckboxField
                key={c}
                label={LABELS[c][0]}
                description={LABELS[c][1]}
                checked={current.email[c]}
                onChange={(e) =>
                  setDraft({ ...current, email: { ...current.email, [c]: e.target.checked } })
                }
              />
            ))}
          </fieldset>
          <CheckboxField
            label="Text messages"
            description="Short reminders and booking updates, when a phone number is on your profile"
            checked={current.sms}
            onChange={(e) => setDraft({ ...current, sms: e.target.checked })}
          />
          {message && <Alert tone={message.tone}>{message.text}</Alert>}
          <Button type="submit" variant="secondary" disabled={!draft || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save notification settings'}
          </Button>
        </form>
      )}
    </Card>
  );
}
