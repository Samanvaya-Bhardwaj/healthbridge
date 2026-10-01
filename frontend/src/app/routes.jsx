import { PublicLayout } from './layouts/PublicLayout.jsx';
import { AppLayout } from './layouts/AppLayout.jsx';
import { RouteError, NotFound } from './RouteError.jsx';
import { ALL_SECTIONS } from './navigation.js';
import { HomePage } from '../features/home/HomePage.jsx';
import { RoleHome } from '../features/home/RoleHome.jsx';
import { UpcomingSection } from '../features/home/UpcomingSection.jsx';
import { LoginPage } from '../features/auth/LoginPage.jsx';
import { RegisterPage } from '../features/auth/RegisterPage.jsx';
import { RequireAuth, RequirePermission } from '../features/auth/guards.jsx';
import { AccountPage } from '../features/account/AccountPage.jsx';
import { PERMISSIONS } from '@healthbridge/shared';

/**
 * Route tree. Public pages, then the authenticated /app workspace. Each workspace
 * section is guarded by the permission the server will also enforce.
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
          {
            path: 'account',
            element: (
              <RequirePermission permission={PERMISSIONS.ACCOUNT_READ}>
                <AccountPage />
              </RequirePermission>
            ),
          },
          ...ALL_SECTIONS.map((section) => ({
            path: section.path,
            element: (
              <RequirePermission permission={section.permission}>
                <UpcomingSection section={section} />
              </RequirePermission>
            ),
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
