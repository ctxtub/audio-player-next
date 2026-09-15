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
  webpack: (config, { isServer, nextRuntime }) => {
    config.module.rules.push({
      test: /\.svg$/i,
      issuer: { and: [/\.[jt]sx?$/] },
      use: ['@svgr/webpack'],
    });

    // M8-05-04 production closure：根 instrumentation hook 在 middleware 存在时
    // 会被 edge 编译器亦编译一份；启动清理链含 node: 内建（prisma / local backend），
    // edge 侧永不执行（hook 内 NEXT_RUNTIME === 'nodejs' 守卫），此处仅对 edge 编译
    // 将该链标为 external，避免 edge 打包追踪整条 server 链；nodejs server 侧不受影响，
    // 正常打包并在启动时执行有界清理。
    if (isServer && nextRuntime === 'edge') {
      const prevExternals = Array.isArray(config.externals)
        ? config.externals
        : config.externals
          ? [config.externals]
          : [];
      config.externals = [
        ...prevExternals,
        (
          { request }: { request?: string },
          callback: (err?: Error | null, result?: string) => void,
        ) => {
          if (
            request === './lib/server/audioStorageStartup' ||
            request === '@/lib/server/audioStorageStartup'
          ) {
            callback(null, `commonjs ${request}`);
            return;
          }
          callback();
        },
      ];
    }

    return config;
  },
};

export default nextConfig;
