import { Link } from 'react-router';
import { Home, Lock } from 'lucide-react';
import { ButtonLink } from '../../components/ui/Button.jsx';
import { useAuth } from './authContext.js';
import { primaryRole } from '../../app/navigation.js';

/** Why a role cannot open a page, in the words of that role's job. */
const REASONS = {
  CLINIC_ADMIN: {
    eyebrow: 'Clinic operations only',
    text: 'Clinic administrators manage schedules, check-ins, payments and the clinic team. Medical records, notes, prescriptions and visit reasons are visible only to the patient and the doctors they choose to share them with, even within the clinic.',
    back: 'Back to clinic overview',
  },
  PLATFORM_ADMIN: {
    eyebrow: 'Administration only',
    text: 'Platform administrators manage accounts, clinics and doctor verification. They never receive access to patients’ medical records.',
    back: 'Back to overview',
  },
  SUPPORT: {
    eyebrow: 'Support only',
    text: 'Support can look up accounts to help people sign in. Appointment details and medical records stay with patients, their doctors and the clinic.',
    back: 'Back to overview',
  },
  DOCTOR: {
    eyebrow: 'Access restricted',
    text: 'This area is not part of the doctor workspace. Patient records open only from Patient Records, and only while the patient shares them with you.',
    back: 'Back to today',
  },
};
const DEFAULT = {
  eyebrow: 'Access restricted',
  text: 'Your account’s role doesn’t include this area. Medical records are only ever visible to the patient and the doctors they share them with. If you think this is a mistake, contact your clinic or HealthBridge support.',
  back: 'Go to your home page',
};

/** Unauthorized state: the user is signed in but their role does not allow this page. */
export function ForbiddenPage() {
  const { user } = useAuth();
  const reason = (user && REASONS[primaryRole(user.roles)]) ?? DEFAULT;
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <span
        aria-hidden="true"
        className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary-soft text-primary"
      >
        <Lock className="h-6 w-6" />
      </span>
      <p className="text-sm font-medium text-primary">{reason.eyebrow}</p>
      <h1 className="mt-2 text-2xl font-semibold text-text">You don’t have access to this page</h1>
      <p className="mt-3 text-text-muted">{reason.text}</p>
      <ButtonLink as={Link} to="/app" className="mt-8" icon={Home}>
        {reason.back}
      </ButtonLink>
    </div>
  );
}
