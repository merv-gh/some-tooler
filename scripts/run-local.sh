#!/bin/bash
# Run tooler locally without Docker
# Prerequisites: ollama running, node 20+
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

export OLLAMA_URL="${OLLAMA_URL:-http://localhost:11434}"
export OLLAMA_MODEL="${OLLAMA_MODEL:-qwen3.5}"
export APP_DIR="${APP_DIR:-$ROOT_DIR/app}"
export PLAN_FILE="${PLAN_FILE:-$ROOT_DIR/plan/plan.md}"
export MAX_PHASE_ATTEMPTS="${MAX_PHASE_ATTEMPTS:-3}"
export MAX_TASK_ATTEMPTS="${MAX_TASK_ATTEMPTS:-15}"

echo "=== TDD Tooler — Local Mode ==="
echo "Model:  $OLLAMA_MODEL"
echo "Ollama: $OLLAMA_URL"
echo "App:    $APP_DIR"
echo "Plan:   $PLAN_FILE"
echo ""

# Init app if needed
if [ ! -f "$APP_DIR/package.json" ]; then
  echo "Initializing app..."
  bash "$SCRIPT_DIR/init-app.sh"
fi

# Install tooler deps
cd "$ROOT_DIR/tooler"
npm install --silent

# Run
echo ""
echo "Starting TDD loop..."
echo "Logs: $ROOT_DIR/logs/"
echo ""

exec npx tsx src/index.ts 2>&1 | tee "$ROOT_DIR/logs/tooler-$(date +%Y%m%d-%H%M%S).log"
