#!/bin/bash
set -e

cd "$(dirname "$0")/.."

echo "==> Installing dependencies..."
npm install

echo "==> Building all packages..."
npm run build --workspaces

echo "==> Generating DB migrations..."
cd packages/db && npx drizzle-kit generate && cd ../..

echo "==> Building runner container image..."
bash scripts/build-runner.sh

echo "==> Creating logs directory..."
mkdir -p logs data

echo "==> Setup complete!"
echo ""
echo "Next steps:"
echo "  1. Copy .env.example to .env and fill in your secrets"
echo "  2. Run 'make start' to start in foreground"
echo "  3. Run 'make install' to register as launchd service"
