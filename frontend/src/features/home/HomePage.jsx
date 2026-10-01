import { Card } from '../../components/ui/Card.jsx';

const principles = [
  {
    title: 'Your doctor, online first',
    body: 'Consult the local doctor you already trust. They decide whether online care is enough or a clinic visit is needed.',
  },
  {
    title: 'Continuity of care',
    body: 'Consultations, prescriptions, reports and follow-ups stay connected in one longitudinal health record.',
  },
  {
    title: 'You control access',
    body: 'Doctors see your records only with your consent. Every access is recorded, and you can revoke consent at any time.',
  },
];

export function HomePage() {
  return (
    <div className="mx-auto max-w-6xl px-6 py-16 sm:py-24">
      <div className="max-w-2xl">
        <p className="text-sm font-medium text-primary">HealthBridge</p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight text-text sm:text-5xl">
          Consult your trusted local doctor first.
          <span className="block text-text-muted">Visit only when necessary.</span>
        </h1>
        <p className="mt-6 text-lg leading-relaxed text-text-muted">
          A continuous, secure relationship with the doctors who already know you, with your medical
          history organised and shared only with your consent.
        </p>
      </div>

      <ul className="mt-16 grid gap-6 sm:grid-cols-3" aria-label="Our principles">
        {principles.map((p) => (
          <li key={p.title}>
            <Card as="article" className="h-full">
              <h2 className="text-base font-semibold text-text">{p.title}</h2>
              <p className="mt-2 text-sm leading-relaxed text-text-muted">{p.body}</p>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}
