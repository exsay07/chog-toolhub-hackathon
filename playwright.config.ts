import { defineConfig, devices } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Well-known public Hardhat/Anvil test account #0. TEST ONLY — never fund it.
export const TEST_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

// Separate ports from the default dev server (8787/5173) so tests never collide with it.
const API_PORT = process.env.E2E_API_PORT ?? '18787';
const WEB_PORT = process.env.E2E_WEB_PORT ?? '15173';
const WEB = `http://localhost:${WEB_PORT}`;

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: WEB,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
  ],
  webServer: [
    {
      command: 'npx tsx apps/server/src/index.ts',
      url: `http://127.0.0.1:${API_PORT}/healthz`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        NODE_ENV: 'development',
        PORT: API_PORT,
        APP_ORIGIN: WEB,
        PGLITE_DIR: join(tmpdir(), `chog-e2e-${Date.now()}`),
        // DEV-ONLY gate bypass for the test wallet (refused by config in production).
        NFT_GATE_DEV_ALLOWLIST: TEST_ADDRESS,
        LOG_LEVEL: 'warn',
        TRACKER_ENABLED: 'false',
        MINTS_ENABLED: 'false',
        DISCOVER_WARM: 'false',
        OPENSEA_API_KEY: '',
        OPENSEA_AUTO_KEY: 'false',
        // Reviewer pass, exercised by the judge-access test.
        JUDGE_ACCESS_CODE: 'e2e-judge-code-123456',
      },
    },
    {
      // E2E_PROD=1 runs the suite against the production build (code splitting, minification).
      command: process.env.E2E_PROD
        ? `npm run build -w @chog/web && npm exec -w @chog/web -- vite preview --port ${WEB_PORT} --strictPort`
        : 'npm run dev -w @chog/web',
      url: WEB,
      reuseExistingServer: false,
      timeout: 180_000,
      stdout: 'pipe',
      env: { API_PORT, WEB_PORT },
    },
  ],
});
