import { useState } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router/dom';
import { ErrorBoundary } from './ErrorBoundary.jsx';
import { createQueryClient } from '../lib/queryClient.js';
import { AuthProvider } from '../features/auth/AuthProvider.jsx';

/** @param {{ router: ReturnType<typeof import('react-router').createBrowserRouter>, queryClient?: import('@tanstack/react-query').QueryClient }} props */
export function App({ router, queryClient }) {
  const [client] = useState(() => queryClient ?? createQueryClient());
  return (
    <ErrorBoundary>
      <QueryClientProvider client={client}>
        <AuthProvider>
          <RouterProvider router={router} />
        </AuthProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
