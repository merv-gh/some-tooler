import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, basename } from 'path';

// ═══════════════════════════════════════════════════════════════
// Recipe system — reusable code transformations
// ═══════════════════════════════════════════════════════════════

export interface Recipe {
  id: string;
  name: string;
  description: string;
  category: 'scaffold' | 'transform' | 'fix' | 'refactor';
  /** Parameters the recipe accepts */
  params: Array<{ name: string; description: string; required?: boolean; default?: string }>;
  /** Execute the recipe */
  run: (appDir: string, params: Record<string, string>) => RecipeResult;
}

export interface RecipeResult {
  ok: boolean;
  filesCreated: string[];
  filesModified: string[];
  output: string;
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
    run: (appDir, p) => {
      const source = p.source;
      const name = p.name || basename(source, '.ts').replace(/\.tsx?$/, '');
      const testDir = source.includes('/') ? source.replace(/\/[^/]+$/, '/__tests__') : '__tests__';
      const testFile = join(testDir, basename(source).replace(/\.tsx?$/, '.test.ts'));
      const testPath = join(appDir, testFile);
      const importPath = '../' + basename(source, '.ts').replace(/\.tsx$/, '');

      if (existsSync(testPath)) {
        return { ok: false, filesCreated: [], filesModified: [], output: `Test file already exists: ${testFile}` };
      }

      mkdirSync(join(appDir, testDir), { recursive: true });

      const content = `import { describe, it, expect } from 'vitest';
// import { } from '${importPath}';

describe('${name}', () => {
  it('should exist', () => {
    expect(true).toBe(true);
  });

  it.todo('add real tests here');
});
`;
      writeFileSync(testPath, content, 'utf-8');
      return { ok: true, filesCreated: [testFile], filesModified: [], output: `Created ${testFile}` };
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
    run: (appDir, p) => {
      const name = p.name;
      const dir = p.dir || 'src/components';
      const compDir = join(dir, name);
      const compFile = join(compDir, `${name}.tsx`);
      const testFile = join(compDir, `${name}.test.tsx`);
      const indexFile = join(compDir, 'index.ts');

      mkdirSync(join(appDir, compDir), { recursive: true });

      const compContent = `interface ${name}Props {
  className?: string;
}

export function ${name}({ className }: ${name}Props) {
  return (
    <div className={className}>
      <h2>${name}</h2>
    </div>
  );
}
`;

      const testContent = `import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ${name} } from './${name}';

describe('${name}', () => {
  it('renders', () => {
    render(<${name} />);
    expect(screen.getByText('${name}')).toBeTruthy();
  });
});
`;

      const indexContent = `export { ${name} } from './${name}';\nexport type { ${name}Props } from './${name}';\n`;

      const created: string[] = [];
      writeFileSync(join(appDir, compFile), compContent, 'utf-8'); created.push(compFile);
      writeFileSync(join(appDir, testFile), testContent, 'utf-8'); created.push(testFile);
      writeFileSync(join(appDir, indexFile), indexContent, 'utf-8'); created.push(indexFile);

      return { ok: true, filesCreated: created, filesModified: [], output: `Created component ${name} with test` };
    },
  },

  // ── Transform: Rename symbol ────────────────────────────
  {
    id: 'transform.rename',
    name: 'Rename Symbol',
    description: 'Rename a function/variable/type across codebase using ast-grep',
    category: 'transform',
    params: [
      { name: 'from', description: 'Current name', required: true },
      { name: 'to', description: 'New name', required: true },
      { name: 'lang', description: 'Language', default: 'tsx' },
    ],
    run: (appDir, p) => {
      const from = p.from;
      const to = p.to;
      const lang = p.lang || 'tsx';

      // Try ast-grep first
      try {
        const out = execSync(
          `sg --pattern '${from}' --rewrite '${to}' --lang ${lang} . --json`,
          { cwd: appDir, encoding: 'utf-8', timeout: 15_000, stdio: ['pipe', 'pipe', 'pipe'] }
        );
        const matches = tryParseJson(out);
        const files = matches ? [...new Set(matches.map((m: any) => m.file))] : [];
        return {
          ok: true,
          filesCreated: [],
          filesModified: files as string[],
          output: `Renamed ${from} → ${to} in ${files.length} file(s)\n${out.slice(0, 500)}`,
        };
      } catch (e: any) {
        // Fallback: simple text replace
        const stderr = (e.stderr || '').toString();
        if (stderr.includes('command not found') || stderr.includes('not found')) {
          return fallbackRename(appDir, from, to);
        }
        const stdout = (e.stdout || '').toString();
        if (stdout.includes('No match') || !stdout.trim()) {
          return { ok: true, filesCreated: [], filesModified: [], output: `No matches for ${from}` };
        }
        return { ok: false, filesCreated: [], filesModified: [], output: `ast-grep error: ${stderr.slice(0, 300)}` };
      }
    },
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
    run: (appDir, p) => {
      const filePath = join(appDir, p.file);
      if (!existsSync(filePath)) {
        return { ok: false, filesCreated: [], filesModified: [], output: `File not found: ${p.file}` };
      }

      let code = readFileSync(filePath, 'utf-8');
      const original = code;

      const replacements: Array<[RegExp, string]> = [
        [/\.toBeNumber\(\)/g, "/* was toBeNumber */ .toBe(expect.any(Number))"],
        [/\.toBeString\(\)/g, "/* was toBeString */ .toBe(expect.any(String))"],
        [/\.toBeBoolean\(\)/g, "/* was toBeBoolean */ .toBe(expect.any(Boolean))"],
        [/\.toBeArray\(\)/g, "/* was toBeArray */ .toEqual(expect.any(Array))"],
        [/\.toBeTrue\(\)/g, '.toBe(true)'],
        [/\.toBeFalse\(\)/g, '.toBe(false)'],
        [/\.toBeEmpty\(\)/g, '.toHaveLength(0)'],
        [/\.toInclude\(/g, '.toContain('],
        [/\.toStartWith\(([^)]+)\)/g, '/* was toStartWith */ .toSatisfy((s: string) => s.startsWith($1))'],
        [/\.toEndWith\(([^)]+)\)/g, '/* was toEndWith */ .toSatisfy((s: string) => s.endsWith($1))'],
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

      // Remove chai imports
      code = code.replace(/import\s+.*\s+from\s+['"]chai['"];?\n?/g, '');

      if (code === original) {
        return { ok: true, filesCreated: [], filesModified: [], output: 'No wrong matchers found' };
      }

      writeFileSync(filePath, code, 'utf-8');
      return { ok: true, filesCreated: [], filesModified: [p.file], output: `Fixed ${count} matcher pattern(s) in ${p.file}` };
    },
  },

  // ── Fix: Add missing imports ────────────────────────────
  {
    id: 'fix.imports',
    name: 'Fix Vitest Imports',
    description: 'Ensure test file has correct vitest imports',
    category: 'fix',
    params: [
      { name: 'file', description: 'Test file to fix', required: true },
    ],
    run: (appDir, p) => {
      const filePath = join(appDir, p.file);
      if (!existsSync(filePath)) {
        return { ok: false, filesCreated: [], filesModified: [], output: `File not found: ${p.file}` };
      }

      let code = readFileSync(filePath, 'utf-8');
      const original = code;

      // Detect what's used
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

      // Check existing import
      const hasVitestImport = /import\s+\{[^}]*\}\s+from\s+['"]vitest['"]/.test(code);

      if (hasVitestImport) {
        // Update existing import to include missing
        code = code.replace(
          /import\s+\{([^}]*)\}\s+from\s+['"]vitest['"]/,
          (_, existing) => {
            const current = existing.split(',').map((s: string) => s.trim()).filter(Boolean);
            const missing = needs.filter(n => !current.includes(n));
            if (missing.length === 0) return _;
            return `import { ${[...current, ...missing].join(', ')} } from 'vitest'`;
          }
        );
      } else if (needs.length > 0) {
        code = `import { ${needs.join(', ')} } from 'vitest';\n` + code;
      }

      if (code === original) {
        return { ok: true, filesCreated: [], filesModified: [], output: 'Imports already correct' };
      }

      writeFileSync(filePath, code, 'utf-8');
      return { ok: true, filesCreated: [], filesModified: [p.file], output: `Fixed vitest imports in ${p.file}` };
    },
  },

  // ── Refactor: Extract function (ast-grep) ──────────────
  {
    id: 'refactor.extract',
    name: 'Extract Function',
    description: 'Find inline patterns and suggest extraction (ast-grep search)',
    category: 'refactor',
    params: [
      { name: 'pattern', description: 'ast-grep pattern to find', required: true },
      { name: 'lang', description: 'Language', default: 'tsx' },
    ],
    run: (appDir, p) => {
      try {
        const out = execSync(
          `sg --pattern '${p.pattern.replace(/'/g, "\\'")}' --lang ${p.lang || 'tsx'} . --json`,
          { cwd: appDir, encoding: 'utf-8', timeout: 15_000, stdio: ['pipe', 'pipe', 'pipe'] }
        );
        const matches = tryParseJson(out);
        if (!matches || matches.length === 0) {
          return { ok: true, filesCreated: [], filesModified: [], output: 'No matches found' };
        }
        const summary = matches.map((m: any) => `  ${m.file}:${m.range?.start?.line || '?'} — ${(m.text || '').slice(0, 80)}`).join('\n');
        return {
          ok: true,
          filesCreated: [],
          filesModified: [],
          output: `Found ${matches.length} match(es):\n${summary}`,
          data: matches,
        } as any;
      } catch (e: any) {
        const out = (e.stdout || '') + (e.stderr || '');
        if (out.includes('No match') || !out.trim()) {
          return { ok: true, filesCreated: [], filesModified: [], output: 'No matches found' };
        }
        return { ok: false, filesCreated: [], filesModified: [], output: `Error: ${out.slice(0, 300)}` };
      }
    },
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
    run: (appDir, p) => {
      try {
        const out = execSync(
          `sg --pattern '${esc(p.pattern)}' --rewrite '${esc(p.rewrite)}' --lang ${p.lang || 'tsx'} .`,
          { cwd: appDir, encoding: 'utf-8', timeout: 15_000, stdio: ['pipe', 'pipe', 'pipe'] }
        );
        return { ok: true, filesCreated: [], filesModified: [], output: out || 'Rewrite applied' };
      } catch (e: any) {
        const out = (e.stdout || '') + (e.stderr || '');
        if (out.includes('No match')) {
          return { ok: true, filesCreated: [], filesModified: [], output: 'No matches to rewrite' };
        }
        return { ok: false, filesCreated: [], filesModified: [], output: `Error: ${out.slice(0, 300)}` };
      }
    },
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

  run(id: string, appDir: string, params: Record<string, string>): RecipeResult {
    const recipe = this.recipes.get(id);
    if (!recipe) {
      return { ok: false, filesCreated: [], filesModified: [], output: `Unknown recipe: ${id}` };
    }

    // Validate required params
    for (const p of recipe.params) {
      if (p.required && !params[p.name]) {
        return { ok: false, filesCreated: [], filesModified: [], output: `Missing required param: ${p.name}` };
      }
      // Apply defaults
      if (!params[p.name] && p.default) {
        params[p.name] = p.default;
      }
    }

    return recipe.run(appDir, params);
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

function esc(s: string): string {
  return s.replace(/'/g, "'\\''");
}

/** Fallback rename when ast-grep not available */
function fallbackRename(appDir: string, from: string, to: string): RecipeResult {
  try {
    // Use grep + sed
    const grepOut = execSync(
      `grep -rl '${from}' --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' . 2>/dev/null || true`,
      { cwd: appDir, encoding: 'utf-8', timeout: 10_000 }
    );
    const files = grepOut.trim().split('\n').filter(Boolean);
    if (files.length === 0) {
      return { ok: true, filesCreated: [], filesModified: [], output: `No matches for ${from}` };
    }

    for (const file of files) {
      const fullPath = join(appDir, file);
      let content = readFileSync(fullPath, 'utf-8');
      // Word-boundary rename to avoid partial matches
      const regex = new RegExp(`\\b${escapeRegex(from)}\\b`, 'g');
      content = content.replace(regex, to);
      writeFileSync(fullPath, content, 'utf-8');
    }

    return {
      ok: true,
      filesCreated: [],
      filesModified: files,
      output: `Renamed ${from} → ${to} in ${files.length} file(s) (text fallback, ast-grep not available)`,
    };
  } catch (e: any) {
    return { ok: false, filesCreated: [], filesModified: [], output: `Rename failed: ${e.message}` };
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
