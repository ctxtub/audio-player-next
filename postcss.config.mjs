import tailwindcss from '@tailwindcss/postcss';
import autoprefixer from 'autoprefixer';

/**
 * PostCSS 配置，挂载 Tailwind 4 官方插件与 Autoprefixer。
 */
export default {
  plugins: [tailwindcss, autoprefixer],
};
