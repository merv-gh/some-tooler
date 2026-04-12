import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, basename } from 'path';
import type { ToolRegistry, ToolResult } from './tools.js';

// ═══════════════════════════════════════════════════════════════
// Recipe system — composable actions using tools + direct code
//
// Recipes can:
//   1. Call any tool from ToolRegistry (guards, tests, model, shell)
//   2. Do direct file operations (scaffold, patch)
//   3. Chain multiple steps with early-exit on failure
//   4. Use ast-grep when available, fallback otherwise
// ═══════════════════════════════════════════════════════════════

export interface RecipeStep {
  /** Human-readable step label */
  label: string;
  /** Execute this step. Return result. */
  run: (ctx: RecipeContext) => Promise<RecipeStepResult> | RecipeStepResult;
}

export interface RecipeStepResult {
  ok: boolean;
  output: string;
  filesCreated?: string[];
  filesModified?: string[];
}

export interface Recipe {
  id: string;
  name: string;
  description: string;
  category: 'scaffold' | 'transform' | 'fix' | 'refactor' | 'workflow';
  params: Array<{ name: string; description: string; required?: boolean; default?: string }>;
  /** Ordered steps — stops at first failure */
  steps: (params: Record<string, string>) => RecipeStep[];
}

export interface RecipeResult {
  ok: boolean;
  filesCreated: string[];
  filesModified: string[];
  output: string;
  stepResults: Array<{ label: string; ok: boolean; output: string }>;
}

/** Context passed to each recipe step */
export interface RecipeContext {
  appDir: string;
  params: Record<string, string>;
  tools: ToolRegistry;
  /** Results from previous steps (for chaining) */
  prevResults: RecipeStepResult[];
}

// ═══════════════════════════════════════════════════════════════
// Step helpers — make recipe definitions concise
// ═══════════════════════════════════════════════════════════════

/** Create a step that calls a tool from the registry */
export function toolStep(label: string, toolId: string, paramsFn?: (ctx: RecipeContext) => Record<string, string>): RecipeStep {
  return {
    label,
    run: async (ctx) => {
      const p = paramsFn ? paramsFn(ctx) : ctx.params;
      const result = await ctx.tools.exec(toolId, p);
      return { ok: result.ok, output: result.output };
    },
  };
}

/** Create a step that writes a file */
export function writeStep(label: string, pathFn: (ctx: RecipeContext) => string, contentFn: (ctx: RecipeContext) => string): RecipeStep {
  return {
    label,
    run: (ctx) => {
      const relPath = pathFn(ctx);
      const fullPath = join(ctx.appDir, relPath);
      const dir = fullPath.replace(/\/[^/]+$/, '');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const existed = existsSync(fullPath);
      writeFileSync(fullPath, contentFn(ctx), 'utf-8');
      return {
        ok: true,
        output: `${existed ? 'Updated' : 'Created'} ${relPath}`,
        filesCreated: existed ? [] : [relPath],
        filesModified: existed ? [relPath] : [],
      };
    },
  };
}

/** Create a step that runs a shell command */
export function shellStep(label: string, cmdFn: (ctx: RecipeContext) => string, opts?: { timeout?: number }): RecipeStep {
  return {
    label,
    run: (ctx) => {
      try {
        const out = execSync(cmdFn(ctx), {
          cwd: ctx.appDir,
          encoding: 'utf-8',
          timeout: opts?.timeout || 30_000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        return { ok: true, output: out };
      } catch (e: any) {
        return { ok: false, output: (e.stdout || '') + '\n' + (e.stderr || '') };
      }
    },
  };
}

/** Create a step that checks a condition */
export function checkStep(label: string, checkFn: (ctx: RecipeContext) => { ok: boolean; output: string }): RecipeStep {
  return { label, run: checkFn };
}

// ═══════════════════════════════════════════════════════════════
// Built-in recipes
// ═══════════════════════════════════════════════════════════════

const builtinRecipes: Recipe[] = [

  // ── Scaffold: Add test file ─────────────────────────────
  {
    id: 'scaffold.test',
    name: 'Add Test File',
    description: 'Create a vitest test file for a source module',
    category: 'scaffold',
    params: [
      { name: 'source', description: 'Source file path (e.g. src/utils/math.ts)', required: true },
      { name: 'name', description: 'Test description', default: 'module' },
    ],
    steps: (p) => {
      const source = p.source;
      const name = p.name || basename(source, '.ts').replace(/\.tsx?$/, '');
      const testDir = source.includes('/') ? source.replace(/\/[^/]+$/, '/__tests__') : '__tests__';
      const testFile = join(testDir, basename(source).replace(/\.tsx?$/, '.test.ts'));
      const importPath = '../' + basename(source, '.ts').replace(/\.tsx$/, '');

      return [
        checkStep('Check test not exists', (ctx) => {
          const exists = existsSync(join(ctx.appDir, testFile));
          return { ok: !exists, output: exists ? `Already exists: ${testFile}` : 'OK' };
        }),
        writeStep('Create test file', () => testFile, () =>
          `import { describe, it, expect } from 'vitest';\n// import { } from '${importPath}';\n\ndescribe('${name}', () => {\n  it('should exist', () => {\n    expect(true).toBe(true);\n  });\n\n  it.todo('add real tests here');\n});\n`
        ),
      ];
    },
  },

  // ── Scaffold: Add React component ──────────────────────
  {
    id: 'scaffold.component',
    name: 'Add Component',
    description: 'Create a React component with test file',
    category: 'scaffold',
    params: [
      { name: 'name', description: 'Component name (PascalCase)', required: true },
      { name: 'dir', description: 'Directory', default: 'src/components' },
    ],
    steps: (p) => {
      const name = p.name;
      const dir = p.dir || 'src/components';
      const compDir = join(dir, name);

      return [
        writeStep('Create component', () => join(compDir, `${name}.tsx`), () =>
          `interface ${name}Props {\n  className?: string;\n}\n\nexport function ${name}({ className }: ${name}Props) {\n  return (\n    <div className={className}>\n      <h2>${name}</h2>\n    </div>\n  );\n}\n`
        ),
        writeStep('Create test', () => join(compDir, `${name}.test.tsx`), () =>
          `import { describe, it, expect } from 'vitest';\nimport { render, screen } from '@testing-library/react';\nimport { ${name} } from './${name}';\n\ndescribe('${name}', () => {\n  it('renders', () => {\n    render(<${name} />);\n    expect(screen.getByText('${name}')).toBeTruthy();\n  });\n});\n`
        ),
        writeStep('Create barrel', () => join(compDir, 'index.ts'), () =>
          `export { ${name} } from './${name}';\n`
        ),
      ];
    },
  },

  // ── Transform: Rename symbol ────────────────────────────
  {
    id: 'transform.rename',
    name: 'Rename Symbol',
    description: 'Rename a function/variable/type across codebase (ast-grep → text fallback)',
    category: 'transform',
    params: [
      { name: 'from', description: 'Current name', required: true },
      { name: 'to', description: 'New name', required: true },
      { name: 'lang', description: 'Language', default: 'tsx' },
    ],
    steps: (p) => [
      {
        label: 'Rename with ast-grep',
        run: (ctx) => {
          const from = ctx.params.from;
          const to = ctx.params.to;
          const lang = ctx.params.lang || 'tsx';
          try {
            const out = execSync(
              `sg --pattern '${from}' --rewrite '${to}' --lang ${lang} . --json 2>&1`,
              { cwd: ctx.appDir, encoding: 'utf-8', timeout: 15_000, stdio: ['pipe', 'pipe', 'pipe'] }
            );
            const matches = tryParseJson(out);
            const files = matches ? [...new Set(matches.map((m: any) => m.file))] : [];
            return { ok: true, filesModified: files as string[], output: `Renamed ${from} → ${to} in ${files.length} file(s)` };
          } catch (e: any) {
            const stderr = (e.stderr || '').toString();
            if (stderr.includes('command not found') || stderr.includes('not found')) {
              return fallbackRename(ctx.appDir, from, to);
            }
            const stdout = (e.stdout || '').toString();
            if (stdout.includes('No match') || !stdout.trim()) {
              return { ok: true, output: `No matches for ${from}` };
            }
            return { ok: false, output: `ast-grep error: ${stderr.slice(0, 300)}` };
          }
        },
      },
    ],
  },

  // ── Fix: Replace wrong test matchers ────────────────────
  {
    id: 'fix.test-matchers',
    name: 'Fix Test Matchers',
    description: 'Replace wrong test framework matchers with vitest equivalents',
    category: 'fix',
    params: [
      { name: 'file', description: 'Test file to fix', required: true },
    ],
    steps: (p) => [
      {
        label: 'Patch matchers',
        run: (ctx) => {
          const filePath = join(ctx.appDir, ctx.params.file);
          if (!existsSync(filePath)) return { ok: false, output: `File not found: ${ctx.params.file}` };

          let code = readFileSync(filePath, 'utf-8');
          const original = code;

          const replacements: Array<[RegExp, string]> = [
            [/\.toBeNumber\(\)/g, "/* toBeNumber */ .toBe(expect.any(Number))"],
            [/\.toBeString\(\)/g, "/* toBeString */ .toBe(expect.any(String))"],
            [/\.toBeBoolean\(\)/g, "/* toBeBoolean */ .toBe(expect.any(Boolean))"],
            [/\.toBeArray\(\)/g, "/* toBeArray */ .toEqual(expect.any(Array))"],
            [/\.toBeTrue\(\)/g, '.toBe(true)'],
            [/\.toBeFalse\(\)/g, '.toBe(false)'],
            [/\.toBeEmpty\(\)/g, '.toHaveLength(0)'],
            [/\.toInclude\(/g, '.toContain('],
            [/\.toStartWith\(([^)]+)\)/g, '/* toStartWith */ .toSatisfy((s: string) => s.startsWith($1))'],
            [/\.toEndWith\(([^)]+)\)/g, '/* toEndWith */ .toSatisfy((s: string) => s.endsWith($1))'],
            [/\.to\.equal\(/g, '.toEqual('],
            [/\.to\.be\./g, '.toBe('],
            [/\.to\.have\.length\(/g, '.toHaveLength('],
          ];

          let count = 0;
          for (const [pattern, replacement] of replacements) {
            const before = code;
            code = code.replace(pattern, replacement);
            if (code !== before) count++;
          }
          code = code.replace(/import\s+.*\s+from\s+['"]chai['"];?\n?/g, '');

          if (code === original) return { ok: true, output: 'No wrong matchers found' };
          writeFileSync(filePath, code, 'utf-8');
          return { ok: true, filesModified: [ctx.params.file], output: `Fixed ${count} matcher pattern(s)` };
        },
      },
      // After patching, verify with guard
      toolStep('Verify API', 'guard.test-api', (ctx) => ({ file: ctx.params.file })),
    ],
  },

  // ── Fix: Add missing vitest imports ─────────────────────
  {
    id: 'fix.imports',
    name: 'Fix Vitest Imports',
    description: 'Ensure test file has correct vitest imports',
    category: 'fix',
    params: [
      { name: 'file', description: 'Test file to fix', required: true },
    ],
    steps: (p) => [
      {
        label: 'Fix imports',
        run: (ctx) => {
          const filePath = join(ctx.appDir, ctx.params.file);
          if (!existsSync(filePath)) return { ok: false, output: `Not found: ${ctx.params.file}` };

          let code = readFileSync(filePath, 'utf-8');
          const original = code;

          const needs: string[] = [];
          if (/\bdescribe\b/.test(code)) needs.push('describe');
          if (/\bit\b\(/.test(code) || /\bit\.todo\b/.test(code)) needs.push('it');
          if (/\btest\b\(/.test(code)) needs.push('test');
          if (/\bexpect\b/.test(code)) needs.push('expect');
          if (/\bvi\b\./.test(code)) needs.push('vi');
          if (/\bbeforeEach\b/.test(code)) needs.push('beforeEach');
          if (/\bafterEach\b/.test(code)) needs.push('afterEach');
          if (/\bbeforeAll\b/.test(code)) needs.push('beforeAll');
          if (/\bafterAll\b/.test(code)) needs.push('afterAll');

          const hasImport = /import\s+\{[^}]*\}\s+from\s+['"]vitest['"]/.test(code);
          if (hasImport) {
            code = code.replace(/import\s+\{([^}]*)\}\s+from\s+['"]vitest['"]/, (_, existing) => {
              const current = existing.split(',').map((s: string) => s.trim()).filter(Boolean);
              const missing = needs.filter(n => !current.includes(n));
              if (missing.length === 0) return _;
              return `import { ${[...current, ...missing].join(', ')} } from 'vitest'`;
            });
          } else if (needs.length > 0) {
            code = `import { ${needs.join(', ')} } from 'vitest';\n` + code;
          }

          if (code === original) return { ok: true, output: 'Imports already correct' };
          writeFileSync(filePath, code, 'utf-8');
          return { ok: true, filesModified: [ctx.params.file], output: `Fixed vitest imports` };
        },
      },
    ],
  },

  // ── Transform: ast-grep rewrite ─────────────────────────
  {
    id: 'transform.ast-rewrite',
    name: 'AST Rewrite',
    description: 'Find and replace code pattern using ast-grep structural matching',
    category: 'transform',
    params: [
      { name: 'pattern', description: 'Pattern to find (ast-grep syntax)', required: true },
      { name: 'rewrite', description: 'Replacement pattern', required: true },
      { name: 'lang', description: 'Language', default: 'tsx' },
    ],
    steps: () => [
      toolStep('AST rewrite via shell', 'shell.ast-grep', (ctx) => ({
        pattern: ctx.params.pattern,
        lang: ctx.params.lang || 'tsx',
      })),
    ],
  },

  // ── Workflow: Full test-fix cycle ───────────────────────
  // Demonstrates composing tools: run test → diagnose → fix → re-test
  {
    id: 'workflow.test-fix',
    name: 'Test → Diagnose → Fix',
    description: 'Run tests, diagnose failures, apply automated fixes, re-test',
    category: 'workflow',
    params: [
      { name: 'file', description: 'Test file', required: true },
    ],
    steps: () => [
      toolStep('Run tests', 'test.run', (ctx) => ({ file: ctx.params.file })),
      // If tests pass, done. If fail, continue to diagnose.
      {
        label: 'Check if fix needed',
        run: (ctx) => {
          const prev = ctx.prevResults[0];
          if (prev?.ok) return { ok: true, output: 'Tests already pass — nothing to fix' };
          // Signal continue
          return { ok: true, output: 'Tests failing — proceeding to diagnose' };
        },
      },
      toolStep('Check test API', 'guard.test-api', (ctx) => ({ file: ctx.params.file })),
      toolStep('Check test sanity', 'guard.test-sanity', (ctx) => ({ file: ctx.params.file })),
      toolStep('Diagnose failure', 'guard.diagnose', (ctx) => ({ testFile: ctx.params.file })),
      // Re-run after diagnosis
      toolStep('Re-run tests', 'test.run', (ctx) => ({ file: ctx.params.file })),
    ],
  },

  // ── Workflow: Scaffold + verify ─────────────────────────
  {
    id: 'workflow.new-feature',
    name: 'New Feature Scaffold',
    description: 'Create source + test files, verify RED state, ready for implementation',
    category: 'workflow',
    params: [
      { name: 'name', description: 'Feature/module name', required: true },
      { name: 'dir', description: 'Source directory', default: 'src' },
    ],
    steps: (p) => {
      const name = p.name;
      const dir = p.dir || 'src';
      const sourceFile = join(dir, `${name}.ts`);
      const testDir = join(dir, '__tests__');
      const testFile = join(testDir, `${name}.test.ts`);

      return [
        writeStep('Create source stub', () => sourceFile, () =>
          `// ${name} — implementation goes here\n\nexport function ${name}() {\n  throw new Error('Not implemented');\n}\n`
        ),
        writeStep('Create test file', () => testFile, () =>
          `import { describe, it, expect } from 'vitest';\nimport { ${name} } from '../${name}';\n\ndescribe('${name}', () => {\n  it('should exist', () => {\n    expect(${name}).toBeDefined();\n  });\n\n  it('should work', () => {\n    // TODO: replace with real assertion\n    expect(() => ${name}()).toThrow('Not implemented');\n  });\n});\n`
        ),
        toolStep('Compile check', 'build.compile', () => ({ file: sourceFile })),
        toolStep('Run tests', 'test.run', () => ({ file: testFile })),
      ];
    },
  },

  // ── Workflow: Model-assisted fix ────────────────────────
  {
    id: 'workflow.model-fix',
    name: 'Ask Model to Fix',
    description: 'Send failing test output to model, get fix suggestion',
    category: 'workflow',
    params: [
      { name: 'file', description: 'Test or source file with issues', required: true },
      { name: 'instruction', description: 'What to fix', default: 'Fix the failing tests' },
    ],
    steps: () => [
      toolStep('Run tests first', 'test.run', (ctx) => ({ file: ctx.params.file })),
      {
        label: 'Ask model for fix',
        run: async (ctx) => {
          const testOutput = ctx.prevResults[0]?.output || '(no test output)';
          let fileContent = '';
          try { fileContent = readFileSync(join(ctx.appDir, ctx.params.file), 'utf-8'); } catch { /* */ }

          const prompt = `${ctx.params.instruction || 'Fix the failing tests'}

FILE: ${ctx.params.file}
\`\`\`
${fileContent.slice(0, 3000)}
\`\`\`

TEST OUTPUT:
\`\`\`
${testOutput.slice(0, 2000)}
\`\`\`

Respond with the corrected file in a code block.`;

          const result = await ctx.tools.exec('model.chat', { prompt });
          return { ok: result.ok, output: result.output.slice(0, 3000) };
        },
      },
    ],
  },

  // ── Project: Init + setup ──────────────────────────────
  {
    id: 'project.init-full',
    name: 'Full Project Init',
    description: 'Run setup, check model connectivity, run initial tests',
    category: 'workflow',
    params: [],
    steps: () => [
      toolStep('Setup project', 'project.setup'),
      toolStep('Check model', 'model.status'),
      toolStep('Show scripts', 'project.scripts'),
      toolStep('Run all tests', 'test.all'),
    ],
  },
];

// ═══════════════════════════════════════════════════════════════
// Recipe Registry
// ═══════════════════════════════════════════════════════════════

export class RecipeRegistry {
  private recipes: Map<string, Recipe> = new Map();

  constructor() {
    for (const r of builtinRecipes) {
      this.recipes.set(r.id, r);
    }
  }

  list(): Array<{ id: string; name: string; description: string; category: string; params: Recipe['params'] }> {
    return [...this.recipes.values()].map(r => ({
      id: r.id, name: r.name, description: r.description, category: r.category, params: r.params,
    }));
  }

  get(id: string): Recipe | undefined {
    return this.recipes.get(id);
  }

  /** Run a recipe — executes steps in order, stops on first failure */
  async run(id: string, appDir: string, params: Record<string, string>, tools: ToolRegistry): Promise<RecipeResult> {
    const recipe = this.recipes.get(id);
    if (!recipe) {
      return { ok: false, filesCreated: [], filesModified: [], output: `Unknown recipe: ${id}`, stepResults: [] };
    }

    // Validate + defaults
    for (const p of recipe.params) {
      if (p.required && !params[p.name]) {
        return { ok: false, filesCreated: [], filesModified: [], output: `Missing required param: ${p.name}`, stepResults: [] };
      }
      if (!params[p.name] && p.default) params[p.name] = p.default;
    }

    const steps = recipe.steps(params);
    const ctx: RecipeContext = { appDir, params, tools, prevResults: [] };
    const stepResults: RecipeResult['stepResults'] = [];
    const allCreated: string[] = [];
    const allModified: string[] = [];

    for (const step of steps) {
      const result = await step.run(ctx);
      ctx.prevResults.push(result);
      stepResults.push({ label: step.label, ok: result.ok, output: result.output });

      if (result.filesCreated) allCreated.push(...result.filesCreated);
      if (result.filesModified) allModified.push(...result.filesModified);

      if (!result.ok) {
        return {
          ok: false,
          filesCreated: allCreated,
          filesModified: allModified,
          output: `Failed at step "${step.label}": ${result.output}`,
          stepResults,
        };
      }
    }

    return {
      ok: true,
      filesCreated: allCreated,
      filesModified: allModified,
      output: stepResults.map(s => `${s.ok ? '✓' : '✗'} ${s.label}: ${s.output.split('\n')[0]}`).join('\n'),
      stepResults,
    };
  }

  /** Register a custom recipe */
  register(recipe: Recipe): void {
    this.recipes.set(recipe.id, recipe);
  }
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

function tryParseJson(s: string): any[] | null {
  try { return JSON.parse(s); } catch { return null; }
}

function fallbackRename(appDir: string, from: string, to: string): RecipeStepResult {
  try {
    const grepOut = execSync(
      `grep -rl '${from}' --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' . 2>/dev/null || true`,
      { cwd: appDir, encoding: 'utf-8', timeout: 10_000 }
    );
    const files = grepOut.trim().split('\n').filter(Boolean);
    if (files.length === 0) return { ok: true, output: `No matches for ${from}` };

    for (const file of files) {
      const fullPath = join(appDir, file);
      let content = readFileSync(fullPath, 'utf-8');
      const regex = new RegExp(`\\b${escapeRegex(from)}\\b`, 'g');
      content = content.replace(regex, to);
      writeFileSync(fullPath, content, 'utf-8');
    }
    return { ok: true, filesModified: files, output: `Renamed ${from} → ${to} in ${files.length} file(s) (text fallback)` };
  } catch (e: any) {
    return { ok: false, output: `Rename failed: ${e.message}` };
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
