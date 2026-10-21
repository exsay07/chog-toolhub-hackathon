import { lazy, Suspense, useEffect, useRef } from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { AuthProvider, useAuth } from './lib/auth';
import { SettingsProvider } from './lib/settings';
import { NotifyProvider } from './lib/notify';
import { DesktopOnly } from './components/DesktopOnly';
import { Shell } from './components/Shell';
import { Gate } from './pages/Gate';
import { SkeletonRows } from './components/ui';
import { ConfirmHost } from './components/Confirm';

// Route-level code splitting: each section is its own chunk.
/** Background automations, after sign-in only (keeps the trading engine off the sign-in page). */
const Runners = lazy(() => import('./lib/Runners'));
const Welcome = lazy(() => import('./pages/Welcome'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Terminal = lazy(() => import('./pages/Terminal'));
const Sniper = lazy(() => import('./pages/Sniper'));
const Tracker = lazy(() => import('./pages/Tracker'));
const NftSniper = lazy(() => import('./pages/NftSniper'));
const TopCollections = lazy(() => import('./pages/TopCollections'));
const MintTracker = lazy(() => import('./pages/MintTracker'));
const Perps = lazy(() => import('./pages/Perps'));
const Portfolio = lazy(() => import('./pages/Portfolio'));
const Settings = lazy(() => import('./pages/Settings'));

const router = createBrowserRouter([
  {
    path: '/',
    element: <Shell />,
    children: [
      { index: true, element: <Welcome /> },
      { path: 'dashboard', element: <Dashboard /> },
      { path: 'terminal', element: <Terminal /> },
      { path: 'terminal/pulse', element: <Terminal /> },
      { path: 'terminal/watchlist', element: <Terminal /> },
      { path: 'terminal/:network/:token', element: <Terminal /> },
      { path: 'sniper', element: <Sniper /> },
      { path: 'tracker', element: <Tracker /> },
      { path: 'nft', element: <NftSniper /> },
      { path: 'nft/top', element: <TopCollections /> },
      { path: 'nft/mints', element: <MintTracker /> },
      { path: 'perps', element: <Perps /> },
      { path: 'portfolio', element: <Portfolio /> },
      { path: 'settings', element: <Settings /> },
      { path: '*', element: <Welcome /> },
    ],
  },
]);

function Authed() {
  const { me, loading } = useAuth();
  // Signing out (button, or the server revoking the session) leaves the app: reset the address to "/"
  // so the sign-in page doesn't keep showing the section you were in. A link opened while signed out
  // keeps its path, so it opens that section after sign-in.
  const wasIn = useRef(false);
  useEffect(() => {
    if (me) wasIn.current = true;
    else if (wasIn.current && !loading) {
      wasIn.current = false;
      void router.navigate('/', { replace: true });
    }
  }, [me, loading]);
  if (loading) return <SkeletonRows rows={8} />;
  return (
    <SettingsProvider authed={!!me}>
      {me ? (
        <NotifyProvider>
          <Suspense fallback={null}>
            <Runners />
          </Suspense>
          <RouterProvider router={router} />
          <ConfirmHost />
        </NotifyProvider>
      ) : (
        <Gate />
      )}
    </SettingsProvider>
  );
}

export function App() {
  return (
    <DesktopOnly>
      <AuthProvider>
        <Authed />
      </AuthProvider>
    </DesktopOnly>
  );
}
