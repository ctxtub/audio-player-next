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
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
];

export default eslintConfig;
