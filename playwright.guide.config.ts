import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

/**
 * Regenerates the onboarding-guide screenshots (apps/web/public/guide/*.png → webp). Starts its own
 * servers like the E2E suite (test wallet allowed, separate ports), but with live data feeds on so
 * Discover, Pulse and the Mint Tracker are filled.
 * Run: npx playwright test --config=playwright.guide.config.ts
 */
const servers = (Array.isArray(base.webServer) ? base.webServer : []).map((w, i) =>
  i === 0 ? { ...w, env: { ...w.env, MINTS_ENABLED: 'true', DISCOVER_WARM: 'true' } } : w,
);

export default defineConfig({
  testDir: 'scripts/guide-shots',
  timeout: 300_000,
  workers: 1,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: base.use?.baseURL,
    viewport: { width: 1440, height: 900 },
  },
  webServer: servers,
});
