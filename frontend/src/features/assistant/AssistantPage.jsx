import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  CalendarDays,
  CalendarPlus,
  FileText,
  Pill,
  RotateCcw,
  Send,
  Sparkles,
  Stethoscope,
} from 'lucide-react';
import { ASSISTANT_MAX_MESSAGE } from '@healthbridge/shared';
import { assistantApi } from '../../lib/domainApi.js';
import { useSafeMutation } from '../../lib/useSafeMutation.js';
import { authErrorMessage, isConnectionProblem } from '../auth/errorMessages.js';
import { Alert } from '../../components/ui/Alert.jsx';
import { Badge } from '../../components/ui/Badge.jsx';
import { Button, ButtonLink } from '../../components/ui/Button.jsx';
import { Card } from '../../components/ui/Card.jsx';
import { TextAreaField } from '../../components/ui/Fields.jsx';
import { PersonIdentity } from '../../components/ui/Identity.jsx';
import { LoadingState } from '../../components/ui/EmptyState.jsx';
import { PageHeader } from '../../components/ui/Typography.jsx';
import { PatientSelect } from '../records/PatientSelect.jsx';
import { usePatientChoice } from '../records/usePatientChoice.js';
import { MODE_LABELS, formatFee } from '../appointments/format.js';

const QUICK_ACTIONS = [
  [Stethoscope, 'Find a doctor', 'I would like to find a doctor'],
  [CalendarPlus, 'Book an appointment', 'I want to book an appointment'],
  [CalendarDays, 'Reschedule an appointment', 'I need to reschedule my appointment'],
  [FileText, 'Ask about my records', 'I have a question about my lab results'],
  [Pill, 'View medications', 'What medicines do I need to take?'],
];

const LINKS = {
  my_doctors: ['/app/doctors', 'Open My Doctors'],
  appointments: ['/app/appointments', 'Open Appointments'],
  records: ['/app/records', 'Open Health Records'],
  prescriptions: ['/app/prescriptions', 'Open Prescriptions'],
};

const SESSION_ENDED = new Set([
  'assistant_session_ended',
  'assistant_session_changed',
  'assistant_turn_limit',
]);

const day = (iso) =>
  new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }).format(
    new Date(`${iso}T00:00:00`),
  );
const time = (iso) =>
  new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit' }).format(new Date(iso));

/** "What I understood": the structured state, so the person can see and correct it. */
function Understood({ understood }) {
  const c = understood?.criteria ?? {};
  const parts = [
    c.specialty,
    c.consultationMode && MODE_LABELS[c.consultationMode],
    c.date && day(c.date),
    c.timeWindow && c.timeWindow[0].toUpperCase() + c.timeWindow.slice(1),
    c.language && `Speaks ${c.language}`,
    c.doctorName && `Dr. ${c.doctorName}`,
  ].filter(Boolean);
  if (!parts.length) return null;
  return (
    <p className="mt-2 text-xs text-text-muted">
      <span className="font-medium text-text">What I understood:</span> {parts.join(' · ')}. Not
      right? Just say what to change.
    </p>
  );
}

function DoctorCard({ card, patientId, actingFor }) {
  const d = card.doctor;
  const detail = [
    d.primarySpecialization,
    d.yearsOfExperience ? `${d.yearsOfExperience} yrs experience` : null,
    d.languages?.length ? `Speaks ${d.languages.join(', ')}` : null,
    d.clinics?.[0]
      ? `${d.clinics[0].name}${d.clinics[0].city ? `, ${d.clinics[0].city}` : ''}`
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const team = actingFor === 'dependent' ? 'their' : 'your';
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-border bg-surface-raised p-3">
      <div className="min-w-0 flex-1">
        <PersonIdentity name={d.professionalName} verified detail={detail} />
        <p className="mt-2">
          {card.careStatus === 'active' ? (
            <Badge tone="success">In {team} care team</Badge>
          ) : card.careStatus === 'pending' ? (
            <Badge tone="warning">Request sent</Badge>
          ) : (
            <Badge>Not in {team} care team yet</Badge>
          )}
        </p>
      </div>
      {card.careStatus === 'active' ? (
        <ButtonLink
          as={Link}
          size="sm"
          variant="secondary"
          to={`/app/appointments/book?doctorId=${d.id}&patientId=${patientId}`}
        >
          Book with {d.professionalName}
        </ButtonLink>
      ) : (
        <ButtonLink
          as={Link}
          size="sm"
          variant="subtle"
          to={actingFor === 'dependent' ? `/app/doctors?patientId=${patientId}` : '/app/doctors'}
        >
          View in My Doctors
        </ButtonLink>
      )}
    </li>
  );
}

function Slots({ slots }) {
  const first = slots[0];
  return (
    <div className="rounded-xl border border-dashed border-ai/40 bg-ai-soft/30 p-3">
      <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-text">
        Free times with {first.doctorName}
        <Badge tone="ai">Suggested · not booked</Badge>
      </p>
      <ul className="mt-2 flex flex-wrap gap-2">
        {slots.map((s) => (
          <li key={s.startsAt}>
            {s.bookable ? (
              <ButtonLink
                as={Link}
                size="sm"
                variant="secondary"
                to={`/app/appointments/book?doctorId=${s.doctorId}&patientId=${s.patientId}&mode=${s.mode}`}
                aria-label={`${time(s.startsAt)}, ${MODE_LABELS[s.mode] ?? ''}, continue to booking`}
              >
                {time(s.startsAt)}
              </ButtonLink>
            ) : (
              <span className="inline-flex min-h-9 items-center rounded-full border border-border px-3 text-sm text-text-muted">
                {time(s.startsAt)}
              </span>
            )}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-text-muted">
        {MODE_LABELS[first.mode]}
        {first.feePaise !== null ? ` · ${formatFee(first.feePaise)}` : ''}.{' '}
        {first.bookable
          ? 'Choose a time to continue on the booking page; nothing is booked until you confirm there.'
          : 'Send a care request to this doctor in My Doctors first; you can book once they accept.'}
      </p>
    </div>
  );
}

function AssistantReply({ turn, patientId, actingFor }) {
  const { reply, understood, degraded } = turn;
  const doctors = reply.cards.filter((c) => c.type === 'doctor');
  const slots = reply.cards.filter((c) => c.type === 'slot');
  const links = reply.cards.filter((c) => c.type === 'link' && LINKS[c.target]);
  const linkButtons = links.length > 0 && (
    <div className="mt-3 flex flex-wrap gap-2">
      {links.map((c) => (
        <ButtonLink key={c.target} as={Link} to={LINKS[c.target][0]} size="sm" variant="secondary">
          {LINKS[c.target][1]}
        </ButtonLink>
      ))}
    </div>
  );
  if (reply.kind === 'emergency') {
    return (
      <Alert tone="error" title="This might be an emergency">
        {reply.message}
        <a href="tel:112" className="mt-2 block font-semibold text-danger underline">
          Call 112
        </a>
      </Alert>
    );
  }
  if (degraded || reply.kind === 'fallback') {
    return (
      <Alert tone="warning" title="I couldn’t help with that just now" action={linkButtons}>
        {reply.message}
      </Alert>
    );
  }
  return (
    <div className="rounded-2xl border border-ai/25 bg-surface-raised p-4">
      <p className="mb-2">
        <Badge tone="ai" icon={Sparkles}>
          AI suggestion
        </Badge>
      </p>
      <p className="text-sm text-text">{reply.message}</p>
      <Understood understood={understood} />
      {doctors.length > 0 && (
        <ul className="mt-3 space-y-2">
          {doctors.map((c) => (
            <DoctorCard key={c.doctor.id} card={c} patientId={patientId} actingFor={actingFor} />
          ))}
        </ul>
      )}
      {slots.length > 0 && (
        <div className="mt-3">
          <Slots slots={slots} />
        </div>
      )}
      {linkButtons}
    </div>
  );
}

/** The HealthBridge Assistant: workflow help in plain words; never medical advice. */
export function AssistantPage() {
  const { choices, patientId, setPatientId, isPending, missingProfile } = usePatientChoice();
  const [turns, setTurns] = useState([]);
  const [text, setText] = useState('');
  const [version, setVersion] = useState(null);
  const [restartKey, setRestartKey] = useState(0);
  const endRef = useRef(null);

  const session = useQuery({
    queryKey: ['assistant-session', patientId, restartKey],
    queryFn: () => assistantApi.start(patientId),
    enabled: Boolean(patientId),
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const send = useSafeMutation({
    mutationFn: (message) =>
      assistantApi.send(session.data.id, {
        text: message,
        version: version ?? session.data.version,
      }),
    onSuccess: (result) => {
      setVersion(result.session.version);
      setTurns((list) => [...list, { id: crypto.randomUUID(), role: 'assistant', ...result }]);
    },
  });

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [turns.length, send.isPending]);

  const restart = () => {
    if (session.data) assistantApi.end(session.data.id).catch(() => {});
    setTurns([]);
    setVersion(null);
    send.reset();
    setRestartKey((k) => k + 1);
  };

  const submit = (message) => {
    const clean = message.trim();
    if (!clean || !session.data || send.isPending) return;
    setTurns((list) => [...list, { id: crypto.randomUUID(), role: 'user', text: clean }]);
    setText('');
    send.mutate(clean);
  };

  const actingFor = session.data?.actingFor ?? 'self';
  const ended = SESSION_ENDED.has(send.error?.code);

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Sparkles}
        eyebrow="AI assistance"
        title="HealthBridge Assistant"
        description="Tell me what you need help with, in your own words. I can find a doctor and free times. I don’t diagnose or give medical advice: your doctor decides about your care."
        actions={
          turns.length > 0 && (
            <Button variant="ghost" size="sm" icon={RotateCcw} onClick={restart}>
              Start over
            </Button>
          )
        }
      />
      <PatientSelect
        choices={choices}
        value={patientId}
        onChange={(id) => {
          setPatientId(id);
          setTurns([]);
          send.reset();
        }}
      />
      {missingProfile && (
        <Alert tone="info" title="Create your health profile first">
          The assistant helps with your care once your health profile exists.{' '}
          <Link to="/app/profile" className="font-medium text-primary underline">
            Create profile
          </Link>
        </Alert>
      )}
      {(isPending || session.isPending) && !missingProfile && (
        <LoadingState label="Starting the assistant" rows={2} />
      )}
      {session.isError && (
        <Alert
          tone={isConnectionProblem(session.error) ? 'warning' : 'error'}
          title="The assistant isn’t available right now"
          action={
            <ButtonLink as={Link} to="/app/doctors" size="sm" variant="secondary">
              Find a doctor in My Doctors
            </ButtonLink>
          }
        >
          {authErrorMessage(session.error)}
        </Alert>
      )}

      {session.data && (
        <Card as="section" aria-label="Conversation with the assistant">
          {turns.length === 0 ? (
            <div>
              <p className="text-sm text-text">
                Hello! What can I help {actingFor === 'dependent' ? 'them' : 'you'} with?
              </p>
              <ul className="mt-4 flex flex-wrap gap-2" aria-label="Suggestions">
                {QUICK_ACTIONS.map(([Icon, label, prompt]) => (
                  <li key={label}>
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={Icon}
                      onClick={() => submit(prompt)}
                    >
                      {label}
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <ol className="space-y-4" aria-live="polite" aria-label="Messages">
              {turns.map((t) =>
                t.role === 'user' ? (
                  <li key={t.id} className="flex justify-end">
                    <p className="max-w-[85%] rounded-2xl rounded-br-md bg-primary-soft px-4 py-2 text-sm text-text">
                      <span className="sr-only">You said: </span>
                      {t.text}
                    </p>
                  </li>
                ) : (
                  <li key={t.id}>
                    <AssistantReply
                      turn={t}
                      patientId={session.data.patientId}
                      actingFor={actingFor}
                    />
                  </li>
                ),
              )}
              {send.isPending && (
                <li>
                  <LoadingState label="The assistant is looking this up" rows={1} />
                </li>
              )}
            </ol>
          )}
          <div ref={endRef} />

          {send.isError && (
            <Alert
              tone={ended ? 'info' : 'error'}
              className="mt-4"
              action={
                ended && (
                  <Button size="sm" variant="secondary" icon={RotateCcw} onClick={restart}>
                    Start a new conversation
                  </Button>
                )
              }
            >
              {authErrorMessage(send.error)}
            </Alert>
          )}

          <form
            className="mt-5 border-t border-border pt-4"
            onSubmit={(e) => {
              e.preventDefault();
              submit(text);
            }}
          >
            <TextAreaField
              label="Your message"
              hint="For example: “A skin doctor tomorrow evening who speaks Hindi.”"
              value={text}
              rows={2}
              maxLength={ASSISTANT_MAX_MESSAGE}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submit(text);
                }
              }}
              disabled={ended}
            />
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-text-muted">
                Your messages aren’t saved. The assistant keeps only what it needs to help, such as
                the kind of doctor and the day, for 24 hours.
              </p>
              <Button
                type="submit"
                icon={Send}
                loading={send.isPending}
                disabled={!text.trim() || ended}
              >
                Send
              </Button>
            </div>
          </form>
        </Card>
      )}

      <p className="flex items-start gap-2 rounded-xl border border-attention/40 bg-attention/5 px-4 py-3 text-sm text-text">
        <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-attention" />
        In a medical emergency, call 112 or 108, or go to the nearest emergency department. Don’t
        wait for the assistant or an online consultation.
      </p>
    </div>
  );
}
