import { defineConfig } from '@playwright/test';

// Порт можно переопределить, если 5173 занят другим проектом: иначе
// reuseExistingServer молча подхватит чужой сервер.
const PORT = Number(process.env.E2E_PORT ?? 5173);

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: './artifacts/playwright',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { outputFolder: 'artifacts/playwright-report', open: 'never' }]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    browserName: 'chromium',
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    viewport: { width: 1440, height: 900 },
    reducedMotion: 'reduce',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    launchOptions: { args: ['--enable-unsafe-swiftshader'] },
  },
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    // Таблица лидеров в тестах ходит на несуществующий адрес, а запросы к нему
    // перехватываются page.route — настоящая таблица не затрагивается.
    env: { VITE_SUPABASE_URL: 'https://leaderboard.test', VITE_SUPABASE_KEY: 'test-publishable-key' },
  },
});
