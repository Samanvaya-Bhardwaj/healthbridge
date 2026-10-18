import { Link } from 'react-router';
import {
  BadgeCheck,
  CalendarCheck,
  CalendarClock,
  FileSignature,
  FlaskConical,
  HeartPulse,
  Plus,
  ShieldCheck,
  Stethoscope,
  UserRound,
  Video,
} from 'lucide-react';
import { ButtonLink } from '../../components/ui/Button.jsx';
import { Eyebrow } from '../../components/ui/Typography.jsx';

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

const facts = [
  ['Online first', 'Consult from home; visit when your doctor says so'],
  ['Your consent', 'Doctors see records only while you allow it'],
  ['Every access', 'Recorded in your access log'],
  ['112 · 108', 'Emergency guidance, always one tap away'],
];

const steps = [
  [
    'Create your health profile',
    'Your name, date of birth and contact details. It takes a few minutes.',
  ],
  ['Add your doctor', 'Find your family doctor among verified doctors and send a request.'],
  [
    'Consult online',
    'Book a time, pay if the visit has a fee, and join the video call from the app.',
  ],
  ['Stay on track', 'Prescriptions, reports and follow-up check-ins stay in one place.'],
];

const faqs = [
  [
    'Who can see my medical records?',
    'Only the doctors you give consent to, for as long as you allow. Every access is recorded in your access log, and you can revoke consent at any time in Privacy & Access.',
  ],
  [
    'What should I do in an emergency?',
    'Don’t wait for an online consultation. Call 112 or 108, or go to the nearest emergency department.',
  ],
  [
    'Are the doctors verified?',
    'Doctors appear on HealthBridge only after their registration has been checked. Their profile shows a “Verified doctor” mark.',
  ],
  [
    'How do appointments and payments work?',
    'Each doctor sets their fee, shown before you book. A paid time is held briefly while you pay securely; the confirmation email includes a calendar invitation.',
  ],
  [
    'Does the assistant replace my doctor?',
    'No. The assistant helps you find a doctor, book a time and find your way around. It never diagnoses or prescribes, and it tells you when to see a doctor.',
  ],
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
      className="relative min-w-0 rounded-[1.75rem] border border-border bg-surface-raised p-5 shadow-raised sm:p-7"
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
          className="h-10 min-w-0 flex-1 text-accent"
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
      <ol className="relative mt-7 space-y-4 pl-9">
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
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-primary-soft px-3 py-1 text-xs font-medium text-primary">
          <ShieldCheck className="h-3.5 w-3.5" />
          Shared only with your consent
        </span>
        <span className="flex items-center gap-1.5 font-mono text-[0.6875rem] uppercase tracking-[0.08em] text-text-subtle">
          <span className="h-1.5 w-1.5 rounded-full bg-success" />
          Your record
        </span>
      </div>
    </div>
  );
}

/** A numbered section opening: a hairline, the mono label and its number, then the title. */
function SectionIntro({ index, label, title, id, children }) {
  return (
    <div className="border-t border-border pt-5">
      <div className="flex items-center justify-between font-mono text-[0.6875rem] uppercase tracking-[0.1em] text-text-subtle">
        <span>
          <span aria-hidden="true">// </span>
          {label}
        </span>
        <span aria-hidden="true">[ {String(index).padStart(2, '0')} ]</span>
      </div>
      <div className="mt-8 grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] lg:items-end">
        <h2
          id={id}
          className="text-3xl font-medium leading-[1.1] tracking-[-0.025em] text-text sm:text-[2.5rem]"
        >
          {title}
        </h2>
        {children && (
          <p className="max-w-md leading-relaxed text-text-muted lg:justify-self-end">{children}</p>
        )}
      </div>
    </div>
  );
}

export function HomePage() {
  return (
    <div className="pb-4">
      {/* Hero */}
      <div className="px-3 pt-4 sm:px-6">
        <section className="mx-auto max-w-6xl overflow-hidden rounded-[2rem] bg-hero px-5 py-12 sm:px-12 sm:py-16 lg:py-20">
          <div className="grid grid-cols-1 items-center gap-12 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
            <div className="min-w-0">
              <Eyebrow>Healthcare continuity</Eyebrow>
              <h1 className="mt-5 text-[2.5rem] font-medium leading-[1.05] tracking-[-0.03em] text-text sm:text-[3.5rem]">
                Consult your trusted local doctor first.
                <span className="block text-primary">Visit only when necessary.</span>
              </h1>
              <p className="mt-6 max-w-xl text-lg leading-relaxed text-text-muted">
                A continuous, secure relationship with the doctors who already know you, with your
                medical history organised and shared only with your consent.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <ButtonLink as={Link} to="/register" arrow className="pl-6">
                  Get started
                </ButtonLink>
                <ButtonLink as={Link} to="/login" variant="secondary">
                  I already have an account
                </ButtonLink>
              </div>
            </div>
            <ContinuityIllustration />
          </div>
        </section>
      </div>

      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        {/* Facts */}
        <dl className="mt-10 grid grid-cols-2 gap-y-8 lg:grid-cols-4">
          {facts.map(([value, label], i) => (
            <div
              key={value}
              className={`min-w-0 border-border px-4 sm:px-6 ${i % 2 ? 'border-l' : ''} ${
                i === 2 ? 'lg:border-l' : ''
              }`}
            >
              <dt className="text-2xl font-medium tracking-[-0.02em] text-text sm:text-[1.75rem]">
                {value}
              </dt>
              <dd className="mt-2 font-mono text-[0.6875rem] uppercase leading-relaxed tracking-[0.08em] text-text-subtle">
                {label}
              </dd>
            </div>
          ))}
        </dl>

        {/* How it works */}
        <section aria-labelledby="how-heading" className="mt-20">
          <SectionIntro
            index={1}
            label="How it works"
            title="From sign-up to your first consultation"
            id="how-heading"
          >
            Four steps, one clear action at a time. You can stop and come back whenever you like.
          </SectionIntro>
          <ol className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {steps.map(([title, body], i) => (
              <li
                key={title}
                className="rounded-card border border-border bg-surface-raised p-5 shadow-card"
              >
                <span className="flex items-center gap-2 font-mono text-sm text-primary">
                  <span aria-hidden="true" className="h-2 w-2 rounded-sm bg-accent" />
                  {String(i + 1).padStart(2, '0')}
                </span>
                <h3 className="mt-6 text-lg font-medium tracking-[-0.01em] text-text">{title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-text-muted">{body}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* Principles */}
        <section aria-labelledby="principles-heading" className="mt-20">
          <SectionIntro
            index={2}
            label="What we stand for"
            title="Care that stays connected"
            id="principles-heading"
          />
          <ul
            className="mt-10 grid grid-cols-1 gap-4 lg:grid-cols-3 lg:grid-rows-2"
            aria-label="Our principles"
          >
            {principles.map((p, i) => (
              <li
                key={p.title}
                className={
                  i === 0
                    ? 'flex flex-col justify-between rounded-card bg-band p-7 text-white lg:row-span-2'
                    : 'rounded-card border border-border bg-surface-raised p-6 shadow-card lg:col-span-2'
                }
              >
                <span
                  aria-hidden="true"
                  className={`flex h-11 w-11 items-center justify-center rounded-2xl ${
                    i === 0 ? 'bg-white/15 text-white' : 'bg-primary-soft text-primary'
                  }`}
                >
                  <p.icon className="h-5 w-5" />
                </span>
                <div className={i === 0 ? 'mt-16' : 'mt-5'}>
                  <h3
                    className={`font-medium tracking-[-0.01em] ${
                      i === 0 ? 'text-[1.75rem] leading-tight text-white' : 'text-lg text-text'
                    }`}
                  >
                    {p.title}
                  </h3>
                  <p
                    className={`mt-2 leading-relaxed ${i === 0 ? 'text-white/90' : 'text-sm text-text-muted'}`}
                  >
                    {p.body}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </section>

        {/* Doctors and clinics */}
        <section
          aria-labelledby="doctors-heading"
          className="mt-20 grid grid-cols-1 gap-8 rounded-[2rem] border border-border bg-surface-raised p-7 shadow-card sm:p-10 lg:grid-cols-2"
        >
          <div>
            <Eyebrow>For doctors and clinics</Eyebrow>
            <h2
              id="doctors-heading"
              className="mt-4 text-3xl font-medium leading-[1.1] tracking-[-0.025em] text-text"
            >
              Keep caring for your patients between visits
            </h2>
            <p className="mt-4 max-w-md leading-relaxed text-text-muted">
              Create an account and apply as a doctor. Once your registration is verified, your
              patients can find you, book your online and clinic times and share their records with
              you.
            </p>
            <div className="mt-6">
              <ButtonLink as={Link} to="/register" variant="secondary" arrow>
                Apply as a doctor
              </ButtonLink>
            </div>
          </div>
          <ul className="space-y-3 self-center">
            {[
              [
                BadgeCheck,
                'Verified before you are listed',
                'Patients see the “Verified doctor” mark.',
              ],
              [
                CalendarClock,
                'Your schedule, your clinics',
                'Online and in-clinic times, fees and closures.',
              ],
              [
                FileSignature,
                'Signed, versioned records',
                'Notes and prescriptions are signed and never overwritten.',
              ],
            ].map(([Icon, title, text]) => (
              <li key={title} className="flex items-start gap-4 rounded-2xl bg-surface-muted p-4">
                <span
                  aria-hidden="true"
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-raised text-primary"
                >
                  <Icon className="h-5 w-5" />
                </span>
                <span>
                  <span className="block font-medium text-text">{title}</span>
                  <span className="block text-sm text-text-muted">{text}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>

        {/* Questions */}
        <section aria-labelledby="faq-heading" className="mt-20">
          <SectionIntro
            index={3}
            label="Questions"
            title="Good questions, honest answers"
            id="faq-heading"
          />
          <div className="mt-8 divide-y divide-border border-y border-border">
            {faqs.map(([question, answer]) => (
              <details key={question} className="group py-1">
                <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 rounded-xl py-3 text-lg text-text [&::-webkit-details-marker]:hidden">
                  {question}
                  <span
                    aria-hidden="true"
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border-strong text-text-muted transition-transform group-open:rotate-45 group-open:border-primary group-open:bg-primary group-open:text-primary-contrast"
                  >
                    <Plus className="h-4 w-4" />
                  </span>
                </summary>
                <p className="max-w-2xl pb-5 leading-relaxed text-text-muted">{answer}</p>
              </details>
            ))}
          </div>
        </section>

        {/* Call to action */}
        <section
          aria-labelledby="cta-heading"
          className="mt-20 overflow-hidden rounded-[2rem] bg-band px-7 py-12 text-white sm:px-12 sm:py-16"
        >
          <div className="grid grid-cols-1 items-end gap-8 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
            <h2
              id="cta-heading"
              className="text-[2.25rem] font-medium leading-[1.05] tracking-[-0.03em] sm:text-5xl"
            >
              Your doctor, a message away.
            </h2>
            <div>
              <p className="leading-relaxed text-white/90">
                Create your account, add the doctor you already trust and book your first online
                consultation.
              </p>
              <div className="mt-6 flex flex-wrap gap-3">
                <Link
                  to="/register"
                  className="inline-flex min-h-11 items-center gap-2 rounded-full bg-white px-5 text-sm font-medium text-[#075985] transition-colors hover:bg-[#e0f2fe]"
                >
                  Create your account
                </Link>
                <Link
                  to="/login"
                  className="inline-flex min-h-11 items-center gap-2 rounded-full border border-white/60 px-5 text-sm font-medium text-white transition-colors hover:bg-white/10"
                >
                  Sign in
                </Link>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
