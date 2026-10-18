import { Link } from 'react-router';
import { ArrowUpRight, LifeBuoy } from 'lucide-react';
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
              className="group flex h-full items-start gap-3 rounded-card border border-border bg-surface-raised p-4 transition-[border-color,box-shadow] hover:border-primary/40 hover:shadow-raised focus-visible:outline-offset-4"
            >
              {Icon && (
                <span
                  aria-hidden="true"
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary"
                >
                  <Icon className="h-5 w-5" />
                </span>
              )}
              <span className="min-w-0 flex-1">
                <span className="block font-medium text-text">{item.label}</span>
                <span className="mt-0.5 block text-sm leading-relaxed text-text-muted">
                  {item.description}
                </span>
              </span>
              <ArrowUpRight
                aria-hidden="true"
                className="h-4 w-4 shrink-0 text-text-subtle transition-colors group-hover:text-primary"
              />
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
  // "Dr Nikhil Rao" → "Nikhil": a title is not a first name.
  const words = user.fullName.trim().split(/\s+/);
  const firstName =
    (words.length > 1 && /^(dr|prof|mr|mrs|ms|miss)\.?$/i.test(words[0]) ? words[1] : words[0]) ??
    user.fullName;
  if (role === 'DOCTOR') return <DoctorToday firstName={firstName} />;
  if (role === 'CLINIC_ADMIN')
    return <ClinicOverview clinicId={adminClinicIds(user)[0]} firstName={firstName} />;
  if (role === 'PLATFORM_ADMIN') return <AdminOverview firstName={firstName} />;
  if (role === 'SUPPORT') return <SupportHome user={user} firstName={firstName} />;
  return <PatientHome firstName={firstName} />;
}
