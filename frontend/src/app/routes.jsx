import { PERMISSIONS } from '@healthbridge/shared';
import { PublicLayout } from './layouts/PublicLayout.jsx';
import { AppLayout } from './layouts/AppLayout.jsx';
import { RouteError, NotFound } from './RouteError.jsx';
import { SECTIONS, UPCOMING_SECTIONS } from './navigation.js';
import { HomePage } from '../features/home/HomePage.jsx';
import { RoleHome } from '../features/home/RoleHome.jsx';
import { UpcomingSection } from '../features/home/UpcomingSection.jsx';
import { LoginPage } from '../features/auth/LoginPage.jsx';
import { RegisterPage } from '../features/auth/RegisterPage.jsx';
import { RequireAuth, RequirePermission } from '../features/auth/guards.jsx';
import { AccountPage } from '../features/account/AccountPage.jsx';
import { ProfilePage } from '../features/patients/ProfilePage.jsx';
import { MyDoctorsPage } from '../features/care/MyDoctorsPage.jsx';
import { DoctorProfilePage } from '../features/doctors/DoctorProfilePage.jsx';
import { DoctorPatientsPage } from '../features/doctors/DoctorPatientsPage.jsx';
import { VerificationQueuePage } from '../features/admin/VerificationQueuePage.jsx';
import { ClinicsAdminPage } from '../features/admin/ClinicsAdminPage.jsx';
import { ClinicPage } from '../features/clinics/ClinicPage.jsx';
import { AppointmentsPage } from '../features/appointments/AppointmentsPage.jsx';
import { BookAppointmentPage } from '../features/appointments/BookAppointmentPage.jsx';
import { PaymentPage } from '../features/appointments/PaymentPage.jsx';

const guarded = (permission, element) => (
  <RequirePermission permission={permission}>{element}</RequirePermission>
);

/** Implemented workspace sections: path → page, guarded by the section's permission. */
const PAGES = [
  [SECTIONS.patientProfile, <ProfilePage key="profile" />],
  [SECTIONS.doctors, <MyDoctorsPage key="doctors" />],
  [SECTIONS.doctorProfile, <DoctorProfilePage key="doctor-profile" />],
  [SECTIONS.patients, <DoctorPatientsPage key="patients" />],
  [SECTIONS.verification, <VerificationQueuePage key="verification" />],
  [SECTIONS.clinics, <ClinicsAdminPage key="clinics" />],
  [SECTIONS.clinic, <ClinicPage key="clinic" />],
  [SECTIONS.appointments, <AppointmentsPage key="appointments" />],
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
            path: 'appointments/:id/pay',
            element: guarded(PERMISSIONS.PAYMENTS_CREATE, <PaymentPage />),
          },
          ...PAGES.map(([section, element]) => ({
            path: section.path,
            element: guarded(section.permission, element),
          })),
          ...UPCOMING_SECTIONS.map((section) => ({
            path: section.path,
            element: guarded(section.permission, <UpcomingSection section={section} />),
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
