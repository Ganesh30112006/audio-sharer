import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

/**
 * Browser-level tests against the real stack: Vite dev server, FastAPI and a
 * LiveKit SFU. Start LiveKit first (see README "End-to-end tests"); the API and
 * frontend are started here when not already running.
 */
const localChromium = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const executablePath =
  process.env.PW_CHROMIUM_PATH ?? (existsSync(localChromium) ? localChromium : undefined);
const python = process.env.E2E_PYTHON ?? 'python3';

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
    launchOptions: {
      executablePath,
      args: [
        '--autoplay-policy=no-user-gesture-required',
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
      ],
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: `${python} -m uvicorn app.main:app --port 8000`,
      cwd: '../backend',
      url: 'http://127.0.0.1:8000/api/health',
      reuseExistingServer: true,
      env: { RATE_LIMIT_CREATE_PER_MINUTE: '1000', RATE_LIMIT_TOKEN_PER_MINUTE: '1000' },
    },
    {
      // Production build: measurements must not include React dev-mode overhead.
      command:
        'E2E_HARNESS=1 npx vite build && npx vite preview --host 127.0.0.1 --port 5173 --strictPort',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: true,
    },
  ],
});
