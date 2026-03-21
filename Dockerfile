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
RUN yarn build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN apk add --no-cache libc6-compat \
  && addgroup -g 1001 nodejs \
  && adduser -D -G nodejs nodejs

# Next.js standalone 产物
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

# Prisma 迁移所需文件
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder /app/node_modules/.prisma/client ./node_modules/.prisma/client
COPY --from=builder /app/node_modules/@prisma/adapter-libsql ./node_modules/@prisma/adapter-libsql
COPY --from=builder /app/node_modules/@prisma/client ./node_modules/@prisma/client
COPY --from=builder /app/node_modules/@prisma/client-runtime-utils ./node_modules/@prisma/client-runtime-utils
COPY --from=builder /app/node_modules/@prisma/config ./node_modules/@prisma/config
COPY --from=builder /app/node_modules/@prisma/debug ./node_modules/@prisma/debug
COPY --from=builder /app/node_modules/@prisma/driver-adapter-utils ./node_modules/@prisma/driver-adapter-utils
COPY --from=builder /app/node_modules/@prisma/engines ./node_modules/@prisma/engines
COPY --from=builder /app/node_modules/@prisma/engines-version ./node_modules/@prisma/engines-version
COPY --from=builder /app/node_modules/@prisma/get-platform ./node_modules/@prisma/get-platform
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder /app/lib/generated ./lib/generated

# 启动脚本
COPY --from=builder /app/scripts/docker-start.sh ./scripts/docker-start.sh
RUN chmod +x ./scripts/docker-start.sh

# 数据持久化目录（映射宿主机 volume）
RUN mkdir -p /app/data && chown -R nodejs:nodejs /app/data /app/scripts

USER nodejs
EXPOSE 3000
CMD ["./scripts/docker-start.sh"]
