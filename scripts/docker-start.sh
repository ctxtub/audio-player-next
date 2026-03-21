#!/bin/sh
set -e

echo "[startup] Running database migrations..."
node node_modules/prisma/build/index.js migrate deploy

echo "[startup] Migrations complete. Starting server..."
exec node server.js
