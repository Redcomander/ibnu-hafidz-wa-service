#!/usr/bin/env bash
set -euo pipefail

export PATH=/opt/cpanel/ea-nodejs22/bin:$PATH

cd "$(dirname "$0")/../.."

if [ ! -f .env ]; then
  cp .env.example .env
fi

npm ci --omit=dev || npm install --omit=dev

if npx pm2 list | grep -q "wa-service"; then
  npx pm2 restart wa-service
else
  npx pm2 start server.js --name wa-service
fi

npx pm2 save
curl -fsS http://localhost:3001/health
