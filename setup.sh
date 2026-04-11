#!/bin/bash
# Run once before first `docker compose up`
# Creates dirs with your user ownership so Docker doesn't make them as root
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Creating directories..."
mkdir -p "$SCRIPT_DIR/app" "$SCRIPT_DIR/logs"

echo "Fixing ownership to current user ($(id -u):$(id -g))..."
sudo chown -R "$(id -u):$(id -g)" "$SCRIPT_DIR/app" "$SCRIPT_DIR/logs" 2>/dev/null || true

echo "Done. Run: docker compose up"
