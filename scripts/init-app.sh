#!/bin/bash
set -e

# If app already has package.json, skip init
if [ -f "/workspace/app/package.json" ]; then
  echo "App already initialized. Installing deps..."
  cd /workspace/app
  npm install
  exit 0
fi

echo "=== Initializing app with shadcn template ==="
cd /workspace

# Create vite react-ts project
npx --yes create-vite@latest app-tmp --template react-ts
cp -r app-tmp/* app-tmp/.* app/ 2>/dev/null || true
rm -rf app-tmp

cd /workspace/app
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

# Create __tests__ dir
mkdir -p src/__tests__ src/components src/lib

echo "=== App initialized ==="
