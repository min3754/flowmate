#!/bin/bash
set -e

cd "$(dirname "$0")/.."

echo "==> Building shared package..."
npx tsc -p packages/shared/tsconfig.json

echo "==> Building runner package..."
npx tsc -p packages/runner/tsconfig.json

echo "==> Building mcp package..."
npx tsc -p packages/mcp/tsconfig.json

CMD="${CONTAINER_CMD:-podman}"
echo "==> Building container image ($CMD)..."
$CMD build -t flowmate-runner:latest -f packages/runner/Dockerfile .

echo "==> Done. Image: flowmate-runner:latest"
