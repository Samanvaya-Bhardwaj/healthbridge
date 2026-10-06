import { Link } from 'react-router';
import {
  BadgeCheck,
  CalendarCheck,
  FileSignature,
  FlaskConical,
  HeartPulse,
  ShieldCheck,
  Stethoscope,
  UserRound,
  Video,
} from 'lucide-react';

const principles = [
  {
    icon: Stethoscope,
    title: 'Your doctor, online first',
    body: 'Consult the local doctor you already trust. They decide whether online care is enough or a clinic visit is needed.',
  },
  {
    icon: HeartPulse,
    title: 'Continuity of care',
    body: 'Consultations, prescriptions, reports and follow-ups stay connected in one longitudinal health record.',
  },
  {
    icon: ShieldCheck,
    title: 'You control access',
    body: 'Doctors see your records only with your consent. Every access is recorded, and you can revoke consent at any time.',
  },
];

const journey = [
  [Video, 'Online consultation', 'With your own doctor'],
  [FileSignature, 'Prescription signed', 'Ready to download'],
  [FlaskConical, 'Lab report verified', 'Checked by your doctor'],
  [CalendarCheck, 'Follow-up check-in', 'How are you feeling?'],
];

/** The idea of HealthBridge in one picture: you and your doctor, joined by your record. */
function ContinuityIllustration() {
  return (
    <div
      aria-hidden="true"
      className="relative min-w-0 rounded-3xl border border-border bg-surface-raised p-5 shadow-card sm:p-8"
    >
      <div className="flex items-center justify-between gap-2 sm:gap-4">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-surface-muted text-text-muted">
            <UserRound className="h-5 w-5" />
          </span>
          <span className="text-sm font-medium text-text">You</span>
        </div>
        <svg
          viewBox="0 0 120 40"
          className="h-10 min-w-0 flex-1 text-primary"
          preserveAspectRatio="none"
        >
          <path
            d="M4 34 C 34 2, 86 2, 116 34"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeDasharray="4 5"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        <div className="flex items-center gap-3">
          <span className="text-right text-sm font-medium text-text">
            Your doctor
            <span className="flex items-center justify-end gap-1 text-xs font-normal text-primary">
              <BadgeCheck className="h-3.5 w-3.5" />
              Verified
            </span>
          </span>
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-primary-soft text-primary">
            <Stethoscope className="h-5 w-5" />
          </span>
        </div>
      </div>
      <ol className="relative mt-8 space-y-4 pl-9">
        <span className="absolute bottom-3 left-3 top-3 w-px bg-border" />
        {journey.map(([Icon, title, detail]) => (
          <li key={title} className="relative">
            <span className="absolute -left-9 top-0.5 flex h-6 w-6 items-center justify-center rounded-full bg-primary-soft text-primary ring-4 ring-surface-raised">
              <Icon className="h-3.5 w-3.5" />
            </span>
            <span className="block text-sm font-medium text-text">{title}</span>
            <span className="block text-sm text-text-muted">{detail}</span>
          </li>
        ))}
      </ol>
      <p className="mt-6 inline-flex items-center gap-1.5 rounded-full bg-primary-soft px-3 py-1 text-xs font-medium text-primary">
        <ShieldCheck className="h-3.5 w-3.5" />
        Shared only with your consent
      </p>
    </div>
  );
}

export function HomePage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6 sm:py-20">
      <div className="grid grid-cols-1 items-center gap-12 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.1em] text-primary">
            Healthcare continuity
          </p>
          <h1 className="mt-4 text-4xl font-semibold leading-[1.1] tracking-tight text-text sm:text-[3.25rem]">
            Consult your trusted local doctor first.
            <span className="block text-primary">Visit only when necessary.</span>
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-text-muted">
            A continuous, secure relationship with the doctors who already know you, with your
            medical history organised and shared only with your consent.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              to="/register"
              className="rounded-full bg-primary px-6 py-3 text-sm font-medium text-primary-contrast hover:bg-primary-hover"
            >
              Get started
            </Link>
            <Link
              to="/login"
              className="rounded-full border border-border bg-surface-raised px-6 py-3 text-sm font-medium text-text hover:border-primary/40"
            >
              I already have an account
            </Link>
          </div>
        </div>
        <ContinuityIllustration />
      </div>

      <ul
        className="mt-20 grid grid-cols-1 gap-10 border-t border-border pt-12 sm:grid-cols-3"
        aria-label="Our principles"
      >
        {principles.map((p) => (
          <li key={p.title}>
            <p.icon aria-hidden="true" className="h-6 w-6 text-primary" />
            <h2 className="mt-4 text-base font-semibold text-text">{p.title}</h2>
            <p className="mt-2 text-sm leading-relaxed text-text-muted">{p.body}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
