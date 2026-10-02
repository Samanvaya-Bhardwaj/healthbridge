/** Chooses whose records to show (self or a managed dependent). */
export function PatientSelect({ choices, value, onChange }) {
  if (choices.length < 2) return null;
  return (
    <label className="flex items-center gap-2 text-sm text-text-muted">
      Records of
      <select
        className="min-h-11 rounded-lg border border-border bg-surface px-3 text-text"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
      >
        {choices.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label}
          </option>
        ))}
      </select>
    </label>
  );
}
