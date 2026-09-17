# syntax=docker/dockerfile:1.6

FROM node:22-alpine AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN apk add --no-cache libc6-compat \
  && corepack enable \
  && corepack prepare yarn@1.22.22 --activate

FROM base AS deps
ENV NODE_ENV=development
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

FROM base AS builder
ENV NODE_ENV=production
# canonical enable gate（构建期变量，供 Next 构建内联
# NEXT_PUBLIC_CANONICAL_AUDIO_ENABLED；缺省空 = fail-closed，生产默认关闭。
# 开启方式：docker build --build-arg NEXT_PUBLIC_CANONICAL_AUDIO_ENABLED=1，
# 源码默认不得改（canonicalFlag.ts strict '1' 才开）。）
ARG NEXT_PUBLIC_CANONICAL_AUDIO_ENABLED=""
ENV NEXT_PUBLIC_CANONICAL_AUDIO_ENABLED=${NEXT_PUBLIC_CANONICAL_AUDIO_ENABLED}
# 单轨音频已为正式默认路径（第二段），无需构建期开关；已退役的单轨 build 变量不再声明。
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# 构建阶段提供占位 DATABASE_URL，避免服务端模块校验报错；实际连接在运行时由环境变量注入
RUN DATABASE_URL="file:./placeholder.db" npx prisma generate && DATABASE_URL="file:./placeholder.db" yarn build

# 生产依赖精简：重新安装仅 production 依赖，确保 prisma CLI 的完整依赖树
FROM base AS prod-deps
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# canonical enable gate（运行时变量；缺省空 = fail-closed，生产默认关闭。
# server 兼容可保留 CANONICAL_AUDIO_ENABLED=1，但不能替代 client build flag；
# 浏览器 provider 的 production rollout 必须在 build 时设置 NEXT_PUBLIC_CANONICAL_AUDIO_ENABLED=1，
# 运行时变量单独不足以开启生产播放。语义见 lib/audio/canonicalFlag.ts，源码默认不得改。）
ENV CANONICAL_AUDIO_ENABLED=""
# 单轨音频已为正式默认路径（第二段）；已退役的单轨运行时门不再声明、不再读取。
RUN apk add --no-cache libc6-compat su-exec \
  && addgroup -g 1001 nodejs \
  && adduser -D -G nodejs nodejs

# Next.js standalone 产物
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

# Prisma 运行时：生成的客户端 + 迁移文件
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder /app/lib/generated ./lib/generated

# 用 prod-deps 的完整 node_modules 覆盖 standalone 的不完整依赖，保证 prisma migrate deploy 所需的完整依赖树
COPY --from=prod-deps /app/node_modules ./node_modules

# 启动脚本
COPY --from=builder /app/scripts/docker-start.sh ./scripts/docker-start.sh
RUN chmod +x ./scripts/docker-start.sh

# 数据持久化目录（映射宿主机 volume）
# /app/data → SQLite；/app/audio → Canonical Audio（Local backend 独立 volume，
# 与数据库解耦，禁止落入 /app/data/audio，见 spec §2.1/§3.1）
RUN mkdir -p /app/data /app/audio && chown -R nodejs:nodejs /app/data /app/audio /app/scripts

# 以 root 启动 entrypoint，由脚本内部 chown + su-exec 降权运行
EXPOSE 3000
CMD ["./scripts/docker-start.sh"]
