import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/vt323/400.css';
import './styles.css';
import { App } from './App';
import { installPolish, installTooltips } from './lib/polish';
import { installSmoothScroll } from './lib/smoothScroll';
import { ApiError } from './lib/api';

const qc = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      refetchOnWindowFocus: false,
      retry: (n, e) => !(e instanceof ApiError && e.status >= 400 && e.status < 500) && n < 2,
    },
  },
});

// Frontend error reporting: console only, scrubbed — no third-party telemetry.
window.addEventListener('unhandledrejection', (e) => {
  const msg = String((e.reason as Error)?.message ?? e.reason).replace(/0x[0-9a-fA-F]{64}/g, '0x[redacted]');
  console.warn('[chog] unhandled:', msg);
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);

installPolish();
installTooltips();
installSmoothScroll();
