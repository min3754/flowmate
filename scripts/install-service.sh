#!/bin/bash
set -e

PLIST_SRC="config/launchd/com.flowmate.orchestrator.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/com.flowmate.orchestrator.plist"

cd "$(dirname "$0")/.."

if [ ! -f "$PLIST_SRC" ]; then
  echo "Error: $PLIST_SRC not found."
  echo "Copy from com.flowmate.orchestrator.example.plist and configure paths."
  exit 1
fi

# Create required directories
mkdir -p logs data

# Unload previous version if exists
launchctl bootout "gui/$(id -u)/com.flowmate.orchestrator" 2>/dev/null || true

# Copy and load
cp "$PLIST_SRC" "$PLIST_DEST"
launchctl bootstrap "gui/$(id -u)" "$PLIST_DEST"

echo "FlowMate service installed and started."
echo "Check status: make status"
echo "View logs: make logs"
