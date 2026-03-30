import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E 测试配置。
 * 默认使用 iPhone 14 设备模拟（mobile-first），自动启动 Next.js 开发服务器。
 */
export default defineConfig({
  testDir: './specs',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI
    ? [['html', { open: 'never' }], ['github']]
    : [['html', { open: 'on-failure' }]],
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    ...devices['iPhone 14'],
  },
  projects: [
    // Chromium + 移动端 viewport（使用本地已安装的 headless shell）
    {
      name: 'mobile-chrome',
      use: {
        ...devices['Pixel 5'],
        launchOptions: {
          executablePath: '/root/.cache/ms-playwright/chromium_headless_shell-1194/chrome-linux/headless_shell',
        },
      },
    },
    // WebKit + iPhone viewport（需单独安装 WebKit）
    { name: 'mobile-safari', use: { ...devices['iPhone 14 Pro Max'] } },
  ],
  webServer: {
    command: 'yarn dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
