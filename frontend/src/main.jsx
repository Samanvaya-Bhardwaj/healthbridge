import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter } from 'react-router';
import { App } from './app/App.jsx';
import { routes } from './app/routes.jsx';
import { installGlobalErrorReporting } from './lib/errorReporting.js';
import './styles/index.css';

installGlobalErrorReporting();
const router = createBrowserRouter(routes);

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App router={router} />
  </StrictMode>,
);
