import type { Config } from 'tailwindcss';

/**
 * Tailwind CSS 配置，扫描应用源码并扩展主题变量映射。
 */
const config: Config = {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './stores/**/*.{ts,tsx}',
    './utils/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        background: 'var(--background)',
        foreground: 'var(--foreground)',
        primary: 'var(--primary)',
        secondary: 'var(--secondary)',
        success: 'var(--success)',
        error: 'var(--error)',
      },
      boxShadow: {
        floating: '0 8px 16px var(--shadow-color)',
        panel: '0 10px 24px color-mix(in srgb, var(--primary) 22%, rgba(0, 0, 0, 0.35))',
      },
      borderRadius: {
        xl: '16px',
      },
    },
  },
  plugins: [],
};

export default config;
