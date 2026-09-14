#!/bin/sh
set -e

# 确保数据目录存在且 nodejs 用户可写（volume 挂载可能覆盖容器内权限）
# /app/audio 为 M8 Canonical Audio Local backend 独立持久目录（与 /app/data 解耦）
mkdir -p /app/data /app/audio
chown nodejs:nodejs /app/data /app/audio

echo "[startup] Running database migrations..."
su-exec nodejs node node_modules/prisma/build/index.js migrate deploy

echo "[startup] Migrations complete. Starting server..."
exec su-exec nodejs node server.js
