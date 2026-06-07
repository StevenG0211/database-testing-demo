import { defineConfig } from '@playwright/test';

const appUrl = process.env.BASE_URL ?? 'http://localhost:3000';
const databaseUrl = process.env.DATABASE_URL ?? 'postgres://demo:demo@localhost:55432/demo';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  reporter: [['list']],
  use: {
    baseURL: appUrl,
  },
  webServer: {
    command: 'npm run app',
    url: `${appUrl}/health`,
    reuseExistingServer: !process.env.CI,
    env: {
      DATABASE_URL: databaseUrl,
      PORT: '3000',
    },
    timeout: 60_000,
  },
});
