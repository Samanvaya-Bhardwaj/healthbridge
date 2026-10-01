import { PublicLayout } from './layouts/PublicLayout.jsx';
import { RouteError, NotFound } from './RouteError.jsx';
import { HomePage } from '../features/home/HomePage.jsx';

/**
 * Route tree. Role-specific layouts (patient, doctor, clinic admin, platform admin)
 * and their guards are added with authentication in M1.
 */
export const routes = [
  {
    element: <PublicLayout />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <HomePage /> },
      { path: '*', element: <NotFound /> },
    ],
  },
];
