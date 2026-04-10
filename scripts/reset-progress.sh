#!/bin/bash
# Reset progress to re-run all tasks from scratch
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
rm -f "$ROOT_DIR/logs/progress.json"
echo "Progress reset. Next run will start from TASK-01."
