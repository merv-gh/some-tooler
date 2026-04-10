#!/bin/bash
# Watch the latest log file
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LATEST=$(ls -t "$ROOT_DIR/logs"/tooler-*.log 2>/dev/null | head -1)
if [ -z "$LATEST" ]; then
  echo "No log files found. Start the tooler first."
  exit 1
fi
echo "Watching: $LATEST"
tail -f "$LATEST"
