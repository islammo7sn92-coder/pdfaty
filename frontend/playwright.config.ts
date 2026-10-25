import { defineConfig } from "@playwright/test";

// Starts the real backend (serving the built frontend) and runs browser tests against it.
const PORT = 8010;
export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    acceptDownloads: true,
    viewport: { width: 1400, height: 900 },
    trace: "retain-on-failure",
    ...(process.env.PW_CHROMIUM_PATH ? { launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH } } : {}),
  },
  webServer: {
    command: `python3 -m uvicorn app.main:app --host 127.0.0.1 --port ${PORT}`,
    cwd: "../backend",
    env: { PDFATY_STATIC_DIR: "../frontend/dist", PDFATY_RATE_LIMIT_PER_MIN: "1000", PDFATY_MAX_ACTIVE_JOBS_PER_IP: "20" },
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
