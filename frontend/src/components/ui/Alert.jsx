import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';

const tones = {
  info: { box: 'border-info/30 bg-info/5', icon: Info, iconClass: 'text-info' },
  success: { box: 'border-success/30 bg-success/5', icon: CheckCircle2, iconClass: 'text-success' },
  warning: {
    box: 'border-warning/40 bg-warning/5',
    icon: AlertTriangle,
    iconClass: 'text-warning',
  },
  error: { box: 'border-danger/40 bg-danger/5', icon: XCircle, iconClass: 'text-danger' },
  attention: {
    box: 'border-attention/40 bg-attention/5',
    icon: AlertTriangle,
    iconClass: 'text-attention',
  },
};
tones.danger = tones.error;

/**
 * Inline feedback: info, success, warning, error. The icon and the tone carry meaning
 * together (never colour alone). Errors are announced assertively, the rest politely.
 */
export function Alert({ tone = 'info', title, children, action, className = '' }) {
  const t = tones[tone] ?? tones.info;
  const Icon = t.icon;
  return (
    <div
      role={tone === 'error' || tone === 'danger' ? 'alert' : 'status'}
      className={`flex gap-3 rounded-xl border px-4 py-3 text-sm text-text ${t.box} ${className}`}
    >
      <Icon aria-hidden="true" className={`mt-0.5 h-4 w-4 shrink-0 ${t.iconClass}`} />
      <div className="min-w-0 flex-1">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className={title ? 'mt-1 text-text-muted' : ''}>{children}</div>}
        {action && <div className="mt-3">{action}</div>}
      </div>
    </div>
  );
}
