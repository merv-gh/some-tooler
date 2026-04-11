import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { trace } from './trace.js';

// ═══════════════════════════════════════════════════════════════
// Project scripts — decoupled from tooler internals
//
// .scripts/ folder in project root:
//   test.sh       — run unit tests (accepts optional file arg)
//   test-all.sh   — run full test suite
//   compile.sh    — fast compile check (accepts file arg)
//   lint.sh       — run linter
//   e2e.sh        — run e2e tests
//   setup.sh      — project init/install
//
// Tooler checks for these. If missing, uses defaults or
// asks model to generate them based on project structure.
// ═══════════════════════════════════════════════════════════════

export interface ProjectScripts {
  test: string;       // run unit test (append file path)
  testAll: string;    // run full suite
  compile: string;    // compile check (append file path)
  lint: string;       // lint
  e2e: string;        // e2e tests
  setup: string;      // project init
}

export interface ScriptResult {
  ok: boolean;
  output: string;
  exitCode: number;
}

const SCRIPT_NAMES: Array<{ key: keyof ProjectScripts; file: string; description: string }> = [
  { key: 'test',    file: 'test.sh',     description: 'Run unit tests on a specific file (file path passed as $1)' },
  { key: 'testAll', file: 'test-all.sh', description: 'Run the full test suite' },
  { key: 'compile', file: 'compile.sh',  description: 'Fast compile/type check on a specific file ($1)' },
  { key: 'lint',    file: 'lint.sh',     description: 'Run linter on the project' },
  { key: 'e2e',     file: 'e2e.sh',      description: 'Run end-to-end tests' },
  { key: 'setup',   file: 'setup.sh',    description: 'Install dependencies and set up the project' },
];

// ═══════════════════════════════════════════════════════════════
// Defaults per project type
// ═══════════════════════════════════════════════════════════════

interface ProjectDefaults {
  detect: (appDir: string) => boolean;
  scripts: ProjectScripts;
}

const DEFAULTS: ProjectDefaults[] = [
  // Vite + Vitest + React (current default)
  {
    detect: (d) => existsSync(join(d, 'vite.config.ts')) || existsSync(join(d, 'vitest.config.ts')),
    scripts: {
      test:    'npx vitest --run',
      testAll: 'npx vitest --run',
      compile: 'npx esbuild --bundle --platform=browser --jsx=automatic --outfile=/dev/null --external:react --external:react-dom --external:vitest --external:@testing-library/*',
      lint:    'npx eslint src/ --ext .ts,.tsx 2>/dev/null || true',
      e2e:     'npx playwright test',
      setup:   'npm install',
    },
  },
  // Next.js
  {
    detect: (d) => existsSync(join(d, 'next.config.js')) || existsSync(join(d, 'next.config.mjs')) || existsSync(join(d, 'next.config.ts')),
    scripts: {
      test:    'npx jest',
      testAll: 'npx jest',
      compile: 'npx tsc --noEmit --skipLibCheck',
      lint:    'npx next lint',
      e2e:     'npx playwright test',
      setup:   'npm install',
    },
  },
  // Python + pytest
  {
    detect: (d) => existsSync(join(d, 'pyproject.toml')) || existsSync(join(d, 'setup.py')),
    scripts: {
      test:    'python -m pytest -x',
      testAll: 'python -m pytest',
      compile: 'python -m py_compile',
      lint:    'python -m ruff check . 2>/dev/null || python -m flake8 .',
      e2e:     'python -m pytest tests/e2e/',
      setup:   'pip install -e ".[dev]" 2>/dev/null || pip install -r requirements.txt',
    },
  },
  // Go
  {
    detect: (d) => existsSync(join(d, 'go.mod')),
    scripts: {
      test:    'go test',
      testAll: 'go test ./...',
      compile: 'go build',
      lint:    'golangci-lint run 2>/dev/null || go vet ./...',
      e2e:     'go test -tags=e2e ./...',
      setup:   'go mod download',
    },
  },
  // Rust
  {
    detect: (d) => existsSync(join(d, 'Cargo.toml')),
    scripts: {
      test:    'cargo test',
      testAll: 'cargo test',
      compile: 'cargo check',
      lint:    'cargo clippy',
      e2e:     'cargo test --test e2e',
      setup:   'cargo build',
    },
  },
  // Generic Node.js fallback
  {
    detect: (d) => existsSync(join(d, 'package.json')),
    scripts: {
      test:    'npm test --',
      testAll: 'npm test',
      compile: 'npx tsc --noEmit --skipLibCheck',
      lint:    'npm run lint 2>/dev/null || true',
      e2e:     'npm run e2e 2>/dev/null || npx playwright test',
      setup:   'npm install',
    },
  },
];

// ═══════════════════════════════════════════════════════════════
// Script manager
// ═══════════════════════════════════════════════════════════════

export class ScriptManager {
  private appDir: string;
  private scriptsDir: string;
  private scripts: ProjectScripts;

  constructor(appDir: string) {
    this.appDir = appDir;
    this.scriptsDir = join(appDir, '.scripts');
    this.scripts = this.resolve();
  }

  /** Get resolved scripts */
  getScripts(): ProjectScripts {
    return this.scripts;
  }

  /** Get script info for UI/debugging */
  getScriptInfo(): Array<{ key: string; file: string; source: 'custom' | 'default'; command: string }> {
    return SCRIPT_NAMES.map(s => ({
      key: s.key,
      file: s.file,
      source: existsSync(join(this.scriptsDir, s.file)) ? 'custom' as const : 'default' as const,
      command: this.scripts[s.key],
    }));
  }

  /** Run a script by key, optionally with file arg */
  run(key: keyof ProjectScripts, fileArg?: string): ScriptResult {
    const cmd = fileArg ? `${this.scripts[key]} ${fileArg}` : this.scripts[key];
    trace.emit('test_run', { cmd, script: key, fileArg });
    return this.exec(cmd);
  }

  /** Check if custom scripts exist */
  hasCustomScripts(): boolean {
    return existsSync(this.scriptsDir);
  }

  /** Write default scripts to .scripts/ for user to customize */
  writeDefaults(): void {
    if (!existsSync(this.scriptsDir)) mkdirSync(this.scriptsDir, { recursive: true });

    for (const s of SCRIPT_NAMES) {
      const path = join(this.scriptsDir, s.file);
      if (existsSync(path)) continue;  // don't overwrite

      const content = `#!/bin/bash\n# ${s.description}\n# Customize this script for your project\nset -e\n\n${this.scripts[s.key]} "$@"\n`;
      writeFileSync(path, content, 'utf-8');
      chmodSync(path, 0o755);
    }

    trace.emit('code_apply', {
      file: '.scripts/',
      chars: 0,
      isNew: true,
      added: SCRIPT_NAMES.length,
      removed: 0,
    });
  }

  /**
   * Return prompt fragment for model to generate project scripts.
   * Used when project type not auto-detected.
   */
  static generatePrompt(appDir: string): string {
    const files = listProjectFiles(appDir);
    return `Analyze this project structure and create shell scripts for the .scripts/ folder.

PROJECT FILES:
${files.join('\n')}

Create these scripts (each as a separate code block tagged with filename):

${SCRIPT_NAMES.map(s => `\`.scripts/${s.file}\` — ${s.description}`).join('\n')}

Requirements:
- Each script starts with #!/bin/bash and set -e
- test.sh and compile.sh accept a file path as $1
- Use the project's existing tools (check package.json, Makefile, etc)
- Scripts must be executable and work from the project root`;
  }

  // ── Private ────────────────────────────────────────────────

  private resolve(): ProjectScripts {
    // Priority 1: custom .scripts/ folder
    if (existsSync(this.scriptsDir)) {
      const custom = this.loadCustomScripts();
      if (custom) {
        trace.emit('phase_enter', { phase: 'scripts', attempt: 1, maxAttempts: 1 });
        console.log('  [scripts] Using custom .scripts/ folder');
        return custom;
      }
    }

    // Priority 2: auto-detect project type
    for (const def of DEFAULTS) {
      if (def.detect(this.appDir)) {
        console.log('  [scripts] Auto-detected project type');
        return def.scripts;
      }
    }

    // Priority 3: bare minimum fallback
    console.warn('  [scripts] ⚠ No project type detected, using minimal fallback');
    return {
      test:    'echo "no test command configured"',
      testAll: 'echo "no test-all command configured"',
      compile: 'echo "no compile command configured"',
      lint:    'echo "no lint command configured"',
      e2e:     'echo "no e2e command configured"',
      setup:   'echo "no setup command configured"',
    };
  }

  private loadCustomScripts(): ProjectScripts | null {
    const scripts: Partial<ProjectScripts> = {};
    let found = 0;

    for (const s of SCRIPT_NAMES) {
      const path = join(this.scriptsDir, s.file);
      if (existsSync(path)) {
        scripts[s.key] = `bash ${path}`;
        found++;
      }
    }

    // Need at least test + compile
    if (scripts.test && scripts.compile) {
      return {
        test: scripts.test || 'echo "no test"',
        testAll: scripts.testAll || scripts.test || 'echo "no test-all"',
        compile: scripts.compile || 'echo "no compile"',
        lint: scripts.lint || 'echo "no lint"',
        e2e: scripts.e2e || 'echo "no e2e"',
        setup: scripts.setup || 'echo "no setup"',
      };
    }

    return null;
  }

  private exec(cmd: string): ScriptResult {
    try {
      const output = execSync(cmd, {
        cwd: this.appDir,
        encoding: 'utf-8',
        timeout: 90_000,
        env: { ...process.env, FORCE_COLOR: '0', CI: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { ok: true, output, exitCode: 0 };
    } catch (e: any) {
      return {
        ok: false,
        output: (e.stdout || '') + '\n' + (e.stderr || ''),
        exitCode: e.status ?? 1,
      };
    }
  }
}

function listProjectFiles(dir: string): string[] {
  try {
    const output = execSync(
      'find . -maxdepth 3 -type f -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*" | head -50',
      { cwd: dir, encoding: 'utf-8', timeout: 5000 }
    );
    return output.trim().split('\n').filter(Boolean);
  } catch {
    return ['(could not list files)'];
  }
}
