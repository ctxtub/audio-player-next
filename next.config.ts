import type { NextConfig } from 'next';

/**
 * Next.js 配置，启用独立输出与 SVG 处理。
 */
const nextConfig: NextConfig = {
  output: 'standalone',
  images: {
    /** 图片优化缓存时长：31 天（秒） */
    minimumCacheTTL: 2678400,
  },
  experimental: {
    turbo: {
      rules: {
        '*.svg': {
          loaders: ['@svgr/webpack'],
          as: '*.js',
        },
      },
    },
  },
  webpack: (config) => {
    config.module.rules.push({
      test: /\.svg$/i,
      issuer: { and: [/\.[jt]sx?$/] },
      use: ['@svgr/webpack'],
    });

    return config;
  },
};

export default nextConfig;
