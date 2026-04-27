#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/sovereign-home/apps/home-source"
REPO_URL="https://github.com/eforbell/homeSource.git"
BRANCH="${1:-main}"

echo "==> Deploying Home Source (branch: $BRANCH)"

if [ ! -d "$APP_DIR/.git" ]; then
  echo "==> Cloning..."
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
else
  echo "==> Pulling latest..."
  cd "$APP_DIR"
  git fetch origin
  git checkout "$BRANCH"
  git reset --hard "origin/$BRANCH"
fi

cd "$APP_DIR"

echo "==> Installing dependencies..."
npm ci --omit=dev

echo "==> Running migrations..."
node db/migrate.js

echo "==> Restarting service..."
sudo systemctl restart home-source

echo "==> Done. Checking health..."
sleep 2
curl -sf http://localhost:3008/api/health && echo " OK" || echo " FAILED"
