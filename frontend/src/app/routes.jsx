import { PERMISSIONS } from '@healthbridge/shared';
import { PublicLayout } from './layouts/PublicLayout.jsx';
import { AppLayout } from './layouts/AppLayout.jsx';
import { RouteError, NotFound } from './RouteError.jsx';
import { SECTIONS } from './navigation.js';
import { HomePage } from '../features/home/HomePage.jsx';
import { RoleHome } from '../features/home/RoleHome.jsx';
import { LoginPage } from '../features/auth/LoginPage.jsx';
import { RegisterPage } from '../features/auth/RegisterPage.jsx';
import {
  ForgotPasswordPage,
  ResetPasswordPage,
  VerifyEmailPage,
} from '../features/auth/AccountRecoveryPages.jsx';
import { RequireAuth, RequirePermission } from '../features/auth/guards.jsx';
import { AccountPage } from '../features/account/AccountPage.jsx';
import { ProfilePage } from '../features/patients/ProfilePage.jsx';
import { MyDoctorsPage } from '../features/care/MyDoctorsPage.jsx';
import { DoctorProfilePage } from '../features/doctors/DoctorProfilePage.jsx';
import { DoctorPatientsPage } from '../features/doctors/DoctorPatientsPage.jsx';
import { VerificationQueuePage } from '../features/admin/VerificationQueuePage.jsx';
import { ClinicsAdminPage } from '../features/admin/ClinicsAdminPage.jsx';
import { UsersAdminPage } from '../features/admin/UsersAdminPage.jsx';
import { AuditLogPage } from '../features/admin/AuditLogPage.jsx';
import { OperationsPage } from '../features/admin/OperationsPage.jsx';
import { PrescriptionsPage } from '../features/consultations/PrescriptionsPage.jsx';
import { ClinicPage } from '../features/clinics/ClinicPage.jsx';
import { AppointmentsPage } from '../features/appointments/AppointmentsPage.jsx';
import { BookAppointmentPage } from '../features/appointments/BookAppointmentPage.jsx';
import { PaymentPage } from '../features/appointments/PaymentPage.jsx';
import { RecordsPage } from '../features/records/RecordsPage.jsx';
import { PrivacyPage } from '../features/records/PrivacyPage.jsx';
import { TimelinePage } from '../features/records/TimelinePage.jsx';
import { BriefPage } from '../features/records/AiAssist.jsx';
import { ConsultationPage } from '../features/consultations/ConsultationPage.jsx';
import { FollowUpsPage } from '../features/followups/FollowUpsPage.jsx';
import { InboxPage } from '../features/notifications/Inbox.jsx';
import { AssistantPage } from '../features/assistant/AssistantPage.jsx';
import {
  DoctorRecordsPage,
  DoctorPatientRecordsPage,
} from '../features/records/DoctorRecordsPage.jsx';

const guarded = (permission, element) => (
  <RequirePermission permission={permission}>{element}</RequirePermission>
);

/** Implemented workspace sections: path → page, guarded by the section's permission. */
const PAGES = [
  [SECTIONS.patientProfile, <ProfilePage key="profile" />],
  [SECTIONS.doctors, <MyDoctorsPage key="doctors" />],
  [SECTIONS.assistant, <AssistantPage key="assistant" />],
  [SECTIONS.doctorProfile, <DoctorProfilePage key="doctor-profile" />],
  [SECTIONS.patients, <DoctorPatientsPage key="patients" />],
  [SECTIONS.verification, <VerificationQueuePage key="verification" />],
  [SECTIONS.clinics, <ClinicsAdminPage key="clinics" />],
  [SECTIONS.clinic, <ClinicPage key="clinic" />],
  [SECTIONS.appointments, <AppointmentsPage key="appointments" />],
  [SECTIONS.records, <RecordsPage key="records" />],
  [SECTIONS.privacy, <PrivacyPage key="privacy" />],
  [SECTIONS.timeline, <TimelinePage key="timeline" />],
  [SECTIONS.medicalRecords, <DoctorRecordsPage key="medical-records" />],
  [SECTIONS.followUps, <FollowUpsPage key="follow-ups" />],
  [SECTIONS.notifications, <InboxPage key="notifications" />],
  [SECTIONS.users, <UsersAdminPage key="users" />],
  [SECTIONS.audit, <AuditLogPage key="audit" />],
  [SECTIONS.operations, <OperationsPage key="operations" />],
  [SECTIONS.prescriptions, <PrescriptionsPage key="prescriptions" />],
];

/**
 * Route tree. Public pages, then the authenticated /app workspace. Each workspace
 * section is guarded by the permission the server also enforces.
 */
export const routes = [
  {
    element: <PublicLayout />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'login', element: <LoginPage /> },
      { path: 'register', element: <RegisterPage /> },
      { path: 'forgot-password', element: <ForgotPasswordPage /> },
      { path: 'reset-password', element: <ResetPasswordPage /> },
      { path: 'verify-email', element: <VerifyEmailPage /> },
    ],
  },
  {
    path: 'app',
    element: <RequireAuth />,
    errorElement: <RouteError />,
    children: [
      {
        element: <AppLayout />,
        children: [
          { index: true, element: <RoleHome /> },
          { path: 'account', element: guarded(PERMISSIONS.ACCOUNT_READ, <AccountPage />) },
          {
            path: 'appointments/book',
            element: guarded(PERMISSIONS.APPOINTMENTS_MANAGE, <BookAppointmentPage />),
          },
          {
            path: 'appointments/:id/consultation',
            element: guarded(PERMISSIONS.APPOINTMENTS_READ, <ConsultationPage />),
          },
          {
            path: 'appointments/:id',
            element: guarded(PERMISSIONS.APPOINTMENTS_READ, <ConsultationPage />),
          },
          {
            path: 'appointments/:id/brief',
            element: guarded(PERMISSIONS.AI_ASSIST_USE, <BriefPage />),
          },
          {
            path: 'medical-records/:patientId',
            element: guarded(PERMISSIONS.MEDICAL_RECORDS_READ, <DoctorPatientRecordsPage />),
          },
          {
            path: 'appointments/:id/pay',
            element: guarded(PERMISSIONS.PAYMENTS_CREATE, <PaymentPage />),
          },
          ...PAGES.map(([section, element]) => ({
            path: section.path,
            element: guarded(section.permission, element),
          })),
          { path: '*', element: <NotFound /> },
        ],
      },
    ],
  },
  {
    element: <PublicLayout />,
    children: [{ path: '*', element: <NotFound /> }],
  },
];
