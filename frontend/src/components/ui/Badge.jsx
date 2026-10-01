const tones = {
  neutral: 'bg-surface-muted text-text-muted',
  success: 'bg-success/10 text-success',
  warning: 'bg-warning/10 text-warning',
  danger: 'bg-danger/10 text-danger',
  primary: 'bg-primary-soft text-primary',
};

const STATUS_TONES = {
  active: 'success',
  verified: 'success',
  invited: 'primary',
  pending: 'warning',
  under_review: 'warning',
  paused: 'neutral',
  draft: 'neutral',
  unverified: 'neutral',
  rejected: 'danger',
  suspended: 'danger',
  ended: 'neutral',
};

const label = (status) => status.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

export function Badge({ tone = 'neutral', children }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

/** Status badge with a consistent colour per lifecycle state. */
export function StatusBadge({ status }) {
  return <Badge tone={STATUS_TONES[status] ?? 'neutral'}>{label(status)}</Badge>;
}
