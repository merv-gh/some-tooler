#!/bin/bash
set -e

APP_DIR="${APP_DIR:-/workspace/app}"

# If app already has package.json, skip init
if [ -f "$APP_DIR/package.json" ]; then
  echo "App already initialized. Installing deps..."
  cd "$APP_DIR"
  npm install
  exit 0
fi

echo "=== Initializing app with vite react-ts ==="

cd "$APP_DIR"
npx --yes create-vite@latest . --template react-ts

npm install

# Install shadcn
npx --yes shadcn@latest init --yes --defaults 2>/dev/null || true

# Install test deps
npm install -D vitest @testing-library/react @testing-library/jest-dom @testing-library/user-event jsdom @vitejs/plugin-react

# Create vitest config
cat > vitest.config.ts << 'VITEST_EOF'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
VITEST_EOF

# Create test setup
cat > src/test-setup.ts << 'SETUP_EOF'
import '@testing-library/jest-dom/vitest'
SETUP_EOF

# Create dirs
mkdir -p src/__tests__ src/components src/lib

echo "=== App initialized ==="
