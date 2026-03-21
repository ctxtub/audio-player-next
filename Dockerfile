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
RUN mkdir -p /app/data && chown -R nodejs:nodejs /app/data /app/scripts

# 以 root 启动 entrypoint，由脚本内部 chown + su-exec 降权运行
EXPOSE 3000
CMD ["./scripts/docker-start.sh"]
