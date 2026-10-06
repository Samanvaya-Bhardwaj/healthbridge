import { Link } from 'react-router';
import { LifeBuoy } from 'lucide-react';
import { ROLE_LABELS } from '@healthbridge/shared';
import { useAuth } from '../auth/authContext.js';
import { navigationFor, primaryRole } from '../../app/navigation.js';
import { PageHeader } from '../../components/ui/Typography.jsx';
import { PatientHome } from './PatientHome.jsx';
import { DoctorToday } from './DoctorToday.jsx';
import { ClinicOverview } from '../clinics/ClinicOverview.jsx';
import { AdminOverview } from '../admin/AdminOverview.jsx';
import { adminClinicIds } from '../clinics/clinicWork.js';

/** Quick links to the role's sections, with the plain-language descriptions. */
function SectionLinks({ user, exclude = [] }) {
  const sections = navigationFor(user).filter(
    (item) => item.description && item.path && !exclude.includes(item.key),
  );
  if (!sections.length) return null;
  return (
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {sections.map((item) => {
        const Icon = item.icon;
        return (
          <li key={item.key}>
            <Link
              to={`/app/${item.path}`}
              className="group flex h-full items-start gap-3 rounded-2xl border border-border bg-surface-raised p-4 transition-colors hover:border-primary/40 focus-visible:outline-offset-4"
            >
              {Icon && (
                <span
                  aria-hidden="true"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary"
                >
                  <Icon className="h-5 w-5" />
                </span>
              )}
              <span className="min-w-0">
                <span className="block font-medium text-text">{item.label}</span>
                <span className="mt-0.5 block text-sm leading-relaxed text-text-muted">
                  {item.description}
                </span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

// ── Support ──────────────────────────────────────────────────────────

function SupportHome({ user, firstName }) {
  return (
    <div className="space-y-8">
      <PageHeader
        icon={LifeBuoy}
        eyebrow={ROLE_LABELS.SUPPORT}
        title={`Hello, ${firstName}`}
        description="Look up accounts to help people sign in and find their way. Support never sees medical records and cannot change accounts."
      />
      <SectionLinks user={user} />
    </div>
  );
}

/** Signed-in landing page, specific to the user's primary role. */
export function RoleHome() {
  const { user } = useAuth();
  const role = primaryRole(user.roles);
  const firstName = user.fullName.split(' ')[0];
  if (role === 'DOCTOR') return <DoctorToday firstName={firstName} />;
  if (role === 'CLINIC_ADMIN')
    return <ClinicOverview clinicId={adminClinicIds(user)[0]} firstName={firstName} />;
  if (role === 'PLATFORM_ADMIN') return <AdminOverview firstName={firstName} />;
  if (role === 'SUPPORT') return <SupportHome user={user} firstName={firstName} />;
  return <PatientHome firstName={firstName} />;
}
