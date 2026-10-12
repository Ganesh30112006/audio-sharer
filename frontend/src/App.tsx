import { lazy } from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import HomePage from './pages/HomePage';

// Route-level code splitting: only the home page ships in the initial bundle.
const HostPage = lazy(() => import('./pages/HostPage'));
const ListenerPage = lazy(() => import('./pages/ListenerPage'));
const DirectOutputPage = lazy(() => import('./pages/DirectOutputPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const NotFoundPage = lazy(() => import('./pages/NotFoundPage'));

const router = createBrowserRouter([
  {
    element: <AppShell />,
    children: [
      { path: '/', element: <HomePage /> },
      { path: '/host/:code', element: <HostPage /> },
      { path: '/room/:code', element: <ListenerPage /> },
      { path: '/direct', element: <DirectOutputPage /> },
      { path: '/settings', element: <SettingsPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);

export default function App() {
  return <RouterProvider router={router} />;
}
