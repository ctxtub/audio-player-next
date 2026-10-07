import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { FlatCompat } from '@eslint/eslintrc';

/**
 * 当前配置文件的绝对路径。
 */
const __filename = fileURLToPath(import.meta.url);
/**
 * 当前配置文件所在目录。
 */
const __dirname = dirname(__filename);

/**
 * 兼容旧版 ESLint 配置的适配器。
 */
const compat = new FlatCompat({
  baseDirectory: __dirname,
});

/**
 * 项目使用的扁平化 ESLint 配置数组。
 */
const eslintConfig = [
  {
    ignores: [
      '.next/**',
      '.e2e-results/**',
      '.e2e-runtime/**',
      '.agent-runs/**',
      'lib/generated/**',
      'next-env.d.ts',
      'node_modules/**',
    ],
  },
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    files: ['tests/system/browser/harness/fixtures.ts'],
    rules: {
      // Playwright fixture 的第二个参数名为 use，并非 React Hook。
      'react-hooks/rules-of-hooks': 'off',
    },
  },
];

export default eslintConfig;
