import type { Config } from 'tailwindcss';
import {
  tailwindPlugins,
  tailwindThemeExtension,
} from './styles/themeTokens';

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
    extend: tailwindThemeExtension,
  },
  plugins: [...tailwindPlugins],
};

export default config;
