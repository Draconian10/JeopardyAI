import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/live-fixture',
  timeout: 600000,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:3000',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? {
          executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
          args: [
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--disable-background-timer-throttling',
            '--disable-renderer-backgrounding',
          ],
        }
      : {},
  },
  webServer: {
    command: 'npm run dev -- --hostname 127.0.0.1',
    url: 'http://127.0.0.1:3000',
    reuseExistingServer: !process.env.CI,
    env: {
      NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'test-public-key',
    },
  },
});
