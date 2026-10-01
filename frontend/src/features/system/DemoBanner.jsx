import { useApiMeta } from './useApiMeta.js';

/** Persistent notice whenever the platform runs on synthetic demo data. */
export function DemoBanner() {
  const { data } = useApiMeta();
  if (!data?.demoMode) return null;
  return (
    <div className="border-b border-border bg-primary-soft px-4 py-2 text-center text-sm text-text-muted">
      <strong className="font-medium text-text">Demo environment.</strong> All patients, doctors and
      medical records shown are synthetic. Do not enter real health information.
    </div>
  );
}
