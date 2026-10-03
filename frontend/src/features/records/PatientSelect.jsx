import { useId } from 'react';
import { UsersRound } from 'lucide-react';
import { controlClass } from '../../components/ui/fieldStyles.js';

/** Chooses whose records to show (self or a managed dependent). Hidden with one choice. */
export function PatientSelect({ choices, value, onChange }) {
  const id = useId();
  if (choices.length < 2) return null;
  return (
    <div className="min-w-56">
      <label htmlFor={id} className="flex items-center gap-1.5 text-sm font-medium text-text">
        <UsersRound aria-hidden="true" className="h-4 w-4 text-primary" />
        Showing records of
      </label>
      <select
        id={id}
        className={controlClass()}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
      >
        {choices.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label}
          </option>
        ))}
      </select>
    </div>
  );
}
