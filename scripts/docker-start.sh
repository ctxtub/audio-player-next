#!/bin/sh
set -e

# 确保数据目录存在且 nodejs 用户可写（volume 挂载可能覆盖容器内权限）
mkdir -p /app/data
chown nodejs:nodejs /app/data

echo "[startup] Running database migrations..."
su-exec nodejs node node_modules/prisma/build/index.js migrate deploy

echo "[startup] Migrations complete. Starting server..."
exec su-exec nodejs node server.js
