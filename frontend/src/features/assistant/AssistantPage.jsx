import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  CalendarDays,
  CalendarPlus,
  ClipboardCheck,
  FileText,
  Pill,
  RotateCcw,
  Send,
  Sparkles,
  Stethoscope,
  HelpCircle,
} from 'lucide-react';
import { ASSISTANT_MAX_MESSAGE } from '@healthbridge/shared';
import { assistantApi } from '../../lib/domainApi.js';
import { authErrorMessage, isConnectionProblem } from '../auth/errorMessages.js';
import { Alert } from '../../components/ui/Alert.jsx';
import { Badge, StatusBadge } from '../../components/ui/Badge.jsx';
import { Button, ButtonLink } from '../../components/ui/Button.jsx';
import { Card } from '../../components/ui/Card.jsx';
import { TextAreaField } from '../../components/ui/Fields.jsx';
import { PersonIdentity } from '../../components/ui/Identity.jsx';
import { LoadingState } from '../../components/ui/EmptyState.jsx';
import { PageHeader } from '../../components/ui/Typography.jsx';
import { PatientSelect } from '../records/PatientSelect.jsx';
import { usePatientChoice } from '../records/usePatientChoice.js';
import { MODE_LABELS, formatDateTime, formatFee, formatFullDate } from '../appointments/format.js';
import { whySuggested } from '../care/recommendationText.js';
import { BookingCard } from './AssistantBooking.jsx';
import { HealthInfoCard } from './HealthInfoCard.jsx';
import { Sentences } from '../records/AiAssist.jsx';

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
  privacy: ['/app/privacy', 'Open Privacy & Access'],
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

/** While a reply is coming; a local model on a laptop can take up to a minute. */
function Thinking() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 8_000);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div>
      <LoadingState label="The assistant is looking this up" rows={1} />
      {slow && (
        <p className="mt-2 text-xs text-text-muted" role="status">
          Still working… a local AI model can take up to a minute.
        </p>
      )}
    </div>
  );
}

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

function DoctorCard({ card, patientId, actingFor, latest, onSelect }) {
  const d = card.doctor;
  const why = whySuggested(d);
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
        {why && <p className="mt-1 text-sm text-text-muted">Why suggested: {why}</p>}
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
      <div className="flex flex-col items-end gap-2">
        <Button
          type="button"
          size="sm"
          disabled={!latest}
          onClick={() =>
            onSelect(`Book with ${d.professionalName}`, { kind: 'doctor', doctorId: d.id })
          }
        >
          Book
        </Button>
        <ButtonLink
          as={Link}
          size="sm"
          variant="subtle"
          to={actingFor === 'dependent' ? `/app/doctors?patientId=${patientId}` : '/app/doctors'}
        >
          View in My Doctors
        </ButtonLink>
      </div>
    </li>
  );
}

function Slots({ slots, latest, onSelect }) {
  const first = slots[0];
  const days = new Set(slots.map((s) => s.startsAt.slice(0, 10)));
  const label = (s) =>
    days.size > 1 ? `${day(s.startsAt.slice(0, 10))}, ${time(s.startsAt)}` : time(s.startsAt);
  return (
    <div className="rounded-xl border border-dashed border-ai/40 bg-ai-soft/30 p-3">
      <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-text">
        Free times with {first.doctorName}
        <Badge tone="ai">Suggested · not booked</Badge>
      </p>
      <ul className="mt-2 flex flex-wrap gap-2">
        {slots.map((s) => (
          <li key={s.startsAt}>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={!latest}
              aria-label={`${label(s)}, ${MODE_LABELS[s.mode] ?? ''}: choose this time`}
              onClick={() =>
                onSelect(`${day(s.startsAt.slice(0, 10))}, ${time(s.startsAt)}`, {
                  kind: 'slot',
                  doctorId: s.doctorId,
                  startsAt: s.startsAt,
                })
              }
            >
              {label(s)}
            </Button>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-text-muted">
        {MODE_LABELS[first.mode]}
        {first.feePaise !== null ? ` · ${formatFee(first.feePaise)}` : ''}. Choose a time and I’ll
        show the booking for you to confirm; nothing is booked before that.
      </p>
    </div>
  );
}

/** Step 10: facts the backend read from the record; labelled apart from AI suggestions. */
function FromRecords({ children, label }) {
  return (
    <section aria-label={label} className="mt-3 rounded-xl border border-border bg-surface p-3">
      <p className="mb-2">
        <Badge tone="neutral" icon={ClipboardCheck}>
          From your records
        </Badge>
      </p>
      {children}
    </section>
  );
}

function AppointmentCards({ cards }) {
  return (
    <FromRecords label="Upcoming appointments">
      <ul className="space-y-2">
        {cards.map((a) => (
          <li
            key={a.appointmentId}
            className="flex flex-wrap items-center justify-between gap-2 text-sm text-text"
          >
            <span>
              <span className="font-medium">{a.doctorName ?? 'Your doctor'}</span>
              {' · '}
              {formatDateTime(a.startsAt)}
              {' · '}
              {MODE_LABELS[a.mode] ?? a.mode} <StatusBadge status={a.status} />
            </span>
            <ButtonLink
              as={Link}
              to={`/app/appointments/${a.appointmentId}`}
              size="sm"
              variant="secondary"
            >
              Open appointment
            </ButtonLink>
          </li>
        ))}
      </ul>
    </FromRecords>
  );
}

function MedicationCards({ cards }) {
  return (
    <FromRecords label="Medicines on your recent prescriptions">
      {cards.map((p) => (
        <div key={p.prescriptionId} className="mt-2 first:mt-0">
          <p className="text-xs text-text-muted">
            Signed by {p.doctorName ?? 'your doctor'} on {formatFullDate(p.signedAt)}
          </p>
          <ol className="mt-1 space-y-1 text-sm text-text">
            {p.items.map((i, n) => (
              <li key={n} className="flex gap-2">
                <Pill aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-text-subtle" />
                <span>
                  <span className="font-medium">
                    {i.drugName}
                    {i.strength && ` ${i.strength}`}
                    {i.form && ` (${i.form})`}
                  </span>{' '}
                  — {i.dose}, {i.frequency}, {i.route}, for {i.duration}
                  {i.instructions && (
                    <span className="block text-text-muted">{i.instructions}</span>
                  )}
                </span>
              </li>
            ))}
          </ol>
        </div>
      ))}
      <p className="mt-2 text-xs text-text-muted">
        Exactly as your doctor signed it. Ask your doctor before changing or stopping a medicine.
      </p>
    </FromRecords>
  );
}

function AssistantReply({ turn, patientId, sessionId, actingFor, onChoose, onSelect, latest }) {
  const { reply, understood, degraded } = turn;
  const choices = reply.cards.filter((c) => c.type === 'choice');
  const doctors = reply.cards.filter((c) => c.type === 'doctor');
  const slots = reply.cards.filter((c) => c.type === 'slot');
  const links = reply.cards.filter((c) => c.type === 'link' && LINKS[c.target]);
  const appointments = reply.cards.filter((c) => c.type === 'appointment');
  const medications = reply.cards.filter((c) => c.type === 'medication');
  const bookings = reply.cards.filter((c) => c.type === 'booking');
  const answers = reply.cards.filter((c) => c.type === 'record_answer');
  const healthInfo = reply.cards.filter((c) => c.type === 'health_info');
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
        {reply.kind === 'clarify' || reply.kind === 'confirm' ? (
          <Badge tone="ai" icon={HelpCircle}>
            Question
          </Badge>
        ) : (
          <Badge tone="ai" icon={Sparkles}>
            AI suggestion
          </Badge>
        )}
      </p>
      <p className="text-sm text-text">{reply.message}</p>
      {choices.length > 0 && (
        // Step 6: tap an answer, or type your own. Only the latest question can be answered.
        <div role="group" aria-label="Choose an answer" className="mt-3 flex flex-wrap gap-2">
          {choices.map((c) => (
            <Button
              key={c.value}
              type="button"
              size="sm"
              variant="secondary"
              disabled={!latest}
              onClick={() => onChoose(c.value)}
            >
              {c.value}
            </Button>
          ))}
        </div>
      )}
      {healthInfo.map((c) => (
        <HealthInfoCard key={c.title} card={c} actingFor={actingFor} />
      ))}
      <Understood understood={understood} />
      {doctors.length > 0 && (
        <ul className="mt-3 space-y-2">
          {doctors.map((c) => (
            <DoctorCard
              key={c.doctor.id}
              card={c}
              patientId={patientId}
              actingFor={actingFor}
              latest={latest}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
      {slots.length > 0 && (
        <div className="mt-3">
          <Slots slots={slots} latest={latest} onSelect={onSelect} />
        </div>
      )}
      {answers.map((c, i) => (
        <section
          key={i}
          aria-label="Answer from your documents"
          className="mt-3 rounded-xl border border-ai/25 bg-ai-soft/40 p-3"
        >
          <p className="mb-2">
            <Badge tone="ai" icon={Sparkles}>
              AI summary of your documents · with sources
            </Badge>
          </p>
          <Sentences sentences={c.sentences} />
        </section>
      ))}
      {bookings.map((c) => (
        <BookingCard
          key={c.actionId}
          card={c}
          sessionId={sessionId}
          actingFor={actingFor}
          latest={latest}
          onAskAgain={() =>
            onSelect(`Other times with ${c.doctor.professionalName}`, {
              kind: 'doctor',
              doctorId: c.doctor.id,
            })
          }
        />
      ))}
      {appointments.length > 0 && <AppointmentCards cards={appointments} />}
      {medications.length > 0 && <MedicationCards cards={medications} />}
      {linkButtons}
    </div>
  );
}

/** The HealthBridge Assistant: workflow help in plain words; never medical advice. */
export function AssistantPage() {
  const { choices, patientId, setPatientId, isPending, missingProfile } = usePatientChoice();
  // Everything about one conversation belongs to one server session: its turns and the
  // version the next message must carry. Keyed by the session ID, so a new session (another
  // patient, or "Start over") can never inherit a previous one's turns or version, and a
  // late reply for an earlier session is dropped instead of landing in the new one.
  const [conversation, setConversation] = useState(null); // { sessionId, version, turns }
  const [text, setText] = useState('');
  const [restartKey, setRestartKey] = useState(0);
  // Double-submit guard for the current session only (cleared when a fresh one starts).
  const inFlight = useRef(null);
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

  const current = session.data && conversation?.sessionId === session.data.id ? conversation : null;
  const turns = current?.turns ?? [];

  const send = useMutation({
    mutationFn: ({ sessionId, text: message, version, select }) =>
      assistantApi.send(sessionId, { text: message, version, select }),
    onSuccess: (result, { sessionId }) => {
      setConversation((c) =>
        c?.sessionId === sessionId
          ? {
              ...c,
              version: result.session.version,
              turns: [...c.turns, { id: crypto.randomUUID(), role: 'assistant', ...result }],
            }
          : c,
      );
    },
  });

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [turns.length, send.isPending]);

  /** Ends the current session and starts a fresh one; nothing of it carries over. */
  const startFresh = () => {
    if (session.data) assistantApi.end(session.data.id).catch(() => {});
    setConversation(null);
    setText('');
    inFlight.current = null;
    send.reset();
    setRestartKey((k) => k + 1);
  };

  const submit = (message, select) => {
    const clean = message.trim();
    if (!clean || !session.data) return;
    const sessionId = session.data.id;
    if (inFlight.current === sessionId) return;
    inFlight.current = sessionId;
    // The first message of a session uses the version that session was created with.
    const version = current?.version ?? session.data.version;
    setConversation({
      sessionId,
      version,
      turns: [...turns, { id: crypto.randomUUID(), role: 'user', text: clean }],
    });
    setText('');
    send.mutate(
      { sessionId, text: clean, version, ...(select ? { select } : {}) },
      {
        onSettled: () => {
          if (inFlight.current === sessionId) inFlight.current = null;
        },
      },
    );
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
            <Button variant="ghost" size="sm" icon={RotateCcw} onClick={startFresh}>
              Start over
            </Button>
          )
        }
      />
      <PatientSelect
        choices={choices}
        value={patientId}
        onChange={(id) => {
          if (id === patientId) return;
          // A different patient gets a brand-new session: the previous one is ended and
          // none of its turns, draft, error or version is reused.
          startFresh();
          setPatientId(id);
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
                      sessionId={session.data.id}
                      latest={t.id === turns.at(-1)?.id && !send.isPending}
                      onChoose={submit}
                      onSelect={submit}
                    />
                  </li>
                ),
              )}
              {send.isPending && (
                <li>
                  <Thinking />
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
                  <Button size="sm" variant="secondary" icon={RotateCcw} onClick={startFresh}>
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
