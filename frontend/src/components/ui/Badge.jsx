import {
  AlertTriangle,
  BadgeCheck,
  CheckCircle2,
  CircleDot,
  Clock,
  Eye,
  OctagonAlert,
  Timer,
  XCircle,
} from 'lucide-react';

const tones = {
  neutral: 'bg-surface-muted text-text-muted',
  success: 'bg-success/10 text-success',
  warning: 'bg-warning/10 text-warning',
  danger: 'bg-danger/10 text-danger',
  primary: 'bg-primary-soft text-primary',
  info: 'bg-info/10 text-info',
  attention: 'bg-attention/10 text-attention',
  ai: 'bg-ai-soft text-ai',
};

export function Badge({ tone = 'neutral', icon: Icon, children }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${tones[tone] ?? tones.neutral}`}
    >
      {Icon && <Icon aria-hidden="true" className="h-3.5 w-3.5" />}
      {children}
    </span>
  );
}

/**
 * Healthcare status vocabulary. Every lifecycle state in HealthBridge maps to one
 * category, and each category has one tone and one icon everywhere. The badge keeps the
 * specific label ("Pending payment", "Urgent"); the icon and tone say what kind of state
 * it is, so it never relies on colour alone.
 */
const STATUS_CATEGORIES = Object.freeze({
  confirmed: { tone: 'success', icon: CheckCircle2 },
  pending: { tone: 'warning', icon: Clock },
  attention: { tone: 'attention', icon: AlertTriangle },
  error: { tone: 'danger', icon: OctagonAlert },
  inProgress: { tone: 'primary', icon: CircleDot },
  completed: { tone: 'neutral', icon: CheckCircle2 },
  cancelled: { tone: 'neutral', icon: XCircle },
  verified: { tone: 'primary', icon: BadgeCheck },
  review: { tone: 'warning', icon: Eye },
  expired: { tone: 'neutral', icon: Timer },
});

const STATUS = {
  // Confirmed / active
  confirmed: ['confirmed', 'Confirmed'],
  active: ['confirmed', 'Active'],
  paid: ['confirmed', 'Paid'],
  available: ['confirmed', 'Available'],
  signed: ['confirmed', 'Signed'],
  processed: ['confirmed', 'Processed'],
  // Pending
  pending: ['pending', 'Pending'],
  pending_payment: ['pending', 'Pending payment'],
  pending_upload: ['pending', 'Uploading'],
  quarantined: ['pending', 'Processing'],
  scanning: ['pending', 'Processing'],
  invited: ['pending', 'Invited'],
  scheduled: ['pending', 'Scheduled'],
  awaiting_response: ['pending', 'Awaiting answer'],
  authorized: ['pending', 'Authorised'],
  processing: ['pending', 'Processing'],
  draft: ['pending', 'Draft'],
  // Requires attention
  needs_attention: ['attention', 'Needs attention'],
  urgent: ['error', 'Urgent'],
  failed: ['error', 'Failed'],
  rejected: ['error', 'Rejected'],
  no_show: ['attention', 'No-show'],
  open: ['attention', 'Open'],
  disabled: ['error', 'Disabled'],
  suspended: ['error', 'Suspended'],
  // In progress
  checked_in: ['inProgress', 'Checked in'],
  in_consultation: ['inProgress', 'In consultation'],
  live: ['inProgress', 'Live'],
  // Completed
  completed: ['completed', 'Completed'],
  closed: ['completed', 'Closed'],
  resolved: ['completed', 'Resolved'],
  retried: ['completed', 'Retried'],
  refunded: ['completed', 'Refunded'],
  partially_refunded: ['completed', 'Partly refunded'],
  responded: ['review', 'Answered'],
  // Cancelled / ended
  cancelled: ['cancelled', 'Cancelled'],
  declined: ['cancelled', 'Declined'],
  withdrawn: ['cancelled', 'Withdrawn'],
  revoked: ['cancelled', 'Revoked'],
  ended: ['cancelled', 'Ended'],
  retired: ['cancelled', 'Retired'],
  superseded: ['cancelled', 'Replaced'],
  paused: ['cancelled', 'Paused'],
  // Verified / review / expired
  verified: ['verified', 'Verified'],
  under_review: ['review', 'Under review'],
  unverified: ['review', 'Not verified'],
  expired: ['expired', 'Expired'],
};

const fallbackLabel = (status) =>
  String(status)
    .replace(/_/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase());

/** Status badge from the healthcare vocabulary. Unknown states render as neutral text. */
export function StatusBadge({ status, label }) {
  const [category, text] = STATUS[status] ?? [null, fallbackLabel(status)];
  const c = STATUS_CATEGORIES[category] ?? { tone: 'neutral' };
  return (
    <Badge tone={c.tone} icon={c.icon}>
      {label ?? text}
    </Badge>
  );
}
