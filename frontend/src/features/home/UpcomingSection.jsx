import { EmptyState } from '../../components/ui/EmptyState.jsx';

/** Placeholder for navigation sections whose features land in a later milestone. */
export function UpcomingSection({ section }) {
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-text">{section.label}</h1>
      <p className="mt-2 text-text-muted">{section.description}</p>
      <div className="mt-10">
        <EmptyState title="Coming in an upcoming release">
          This area is planned for milestone {section.milestone}. Nothing here yet uses real health
          information.
        </EmptyState>
      </div>
    </div>
  );
}
