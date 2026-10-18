import { AlertTriangle, BookOpen, Sparkles } from 'lucide-react';
import { Badge } from '../../components/ui/Badge.jsx';

const SECTION_LABELS = {
  overview: 'Overview',
  'often linked with': 'Often linked with',
  'what may help': 'What may help',
  'see a doctor if': 'See a doctor if',
};

function List({ title, items }) {
  return (
    <div className="mt-3">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-text-muted">{title}</h4>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-text">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * ADR-0040: general information from HealthBridge's health library for a concern the
 * person described. The lists are the library's own words; only the summary is written by
 * the AI, from those lists, and it is labelled as such. Never a diagnosis.
 */
export function HealthInfoCard({ card, actingFor }) {
  const theirs = actingFor === 'dependent' ? 'their' : 'your';
  const reviewed = card.review.status === 'approved';
  return (
    <section
      aria-label={`General information: ${card.title}`}
      className="mt-3 rounded-xl border border-border bg-surface p-3"
    >
      <p className="mb-2">
        <Badge icon={BookOpen}>General health information · not a diagnosis</Badge>
      </p>
      <h3 className="text-sm font-semibold text-text">{card.title}</h3>
      <p className="mt-1 text-sm text-text-muted">{card.overview}</p>
      {card.summary.length > 0 && (
        <div className="mt-3 rounded-lg border border-ai/25 bg-ai-soft/40 p-2">
          <p className="mb-1">
            <Badge tone="ai" icon={Sparkles}>
              AI summary for {theirs} message
            </Badge>
          </p>
          <ul className="space-y-1">
            {card.summary.map((s) => (
              <li key={s.text} className="text-sm text-text">
                {s.text}{' '}
                {[...new Set(s.citations.map((c) => c.section))].map((section) => (
                  <span
                    key={section}
                    className="ml-1 inline-flex rounded bg-surface-muted px-1.5 py-0.5 text-xs text-text-muted"
                  >
                    {SECTION_LABELS[section] ?? section}
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </div>
      )}
      <List title="Often linked with" items={card.linkedWith} />
      <List title="What may help" items={card.mayHelp} />
      <List title="See a doctor if" items={card.seeDoctorIf} />
      {card.urgentIf.length > 0 && (
        <div role="note" className="mt-3 rounded-lg border border-danger/30 bg-danger/5 p-2">
          <h4 className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-danger">
            <AlertTriangle aria-hidden="true" className="h-3.5 w-3.5" />
            Get urgent help (call 112) if
          </h4>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-text">
            {card.urgentIf.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}
      <p className="mt-3 text-xs text-text-muted">
        I’m an AI assistant, not a doctor. This is general information, not a diagnosis: please see
        a doctor about {theirs} symptoms, especially if they last or get worse.
      </p>
      <p className="mt-1 text-xs text-text-muted">
        {reviewed
          ? `HealthBridge health library, reviewed by ${card.review.reviewedBy} on ${card.review.reviewedOn}.`
          : 'HealthBridge health library: draft for testing, not yet reviewed by a clinician.'}
      </p>
    </section>
  );
}
