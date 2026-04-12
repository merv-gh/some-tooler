import { execSync, spawn, type ChildProcess } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { ToolerConfig } from './types.js';
import { TestRunner } from './test-runner.js';
import { OllamaClient } from './ollama.js';
import { ScriptManager } from './project-scripts.js';
import { createGuards, runVerifyChain } from './guards.js';
import { SYSTEM_PROMPT } from './prompts.js';
import { trace } from './trace.js';
import { RecipeRegistry } from './recipes.js';
import { loadSkills, buildSkillPrompt, type SkillDef } from './skills.js';

// ═══════════════════════════════════════════════════════════════
// Tool registry — every action the control panel can invoke
// ═══════════════════════════════════════════════════════════════

export interface ToolDef {
  id: string;
  name: string;
  category: 'test' | 'build' | 'guard' | 'model' | 'shell' | 'recipe' | 'project' | 'skill';
  description: string;
  /** Parameters the tool accepts */
  params?: Array<{ name: string; type: 'string' | 'boolean'; required?: boolean; placeholder?: string }>;
}

export interface ToolResult {
  ok: boolean;
  output: string;
  data?: any;
  duration: number;
}

export class ToolRegistry {
  private config: ToolerConfig;
  private runner: TestRunner;
  private ollama: OllamaClient;
  private scripts: ScriptManager;
  private devProcess: ChildProcess | null = null;
  private recipes: RecipeRegistry;
  private skills: SkillDef[];

  constructor(config: ToolerConfig) {
    this.config = config;
    this.runner = new TestRunner(config);
    this.ollama = new OllamaClient(config);
    this.scripts = new ScriptManager(config.appDir);
    this.recipes = new RecipeRegistry();
    // Load skills from project-level and workspace-level .claude/skills/
    this.skills = loadSkills([
      config.appDir,
      config.workspaceDir,
      join(config.workspaceDir, '..'),  // tooler root (where .claude/ lives)
    ]);
    if (this.skills.length > 0) {
      console.log(`  [tools] Loaded ${this.skills.length} skill(s): ${this.skills.map(s => s.name).join(', ')}`);
    }
  }

  /** Get recipe registry (for UI listing) */
  getRecipes(): RecipeRegistry {
    return this.recipes;
  }

  /** Get loaded skills */
  getSkills(): SkillDef[] {
    return this.skills;
  }

  /** All available tools */
  listTools(): ToolDef[] {
    return [
      // ── Test tools ──────────────────────────────────────
      { id: 'test.run', name: 'Run Tests', category: 'test',
        description: 'Run unit tests (optionally on specific file)',
        params: [{ name: 'file', type: 'string', placeholder: 'src/__tests__/foo.test.ts' }] },
      { id: 'test.all', name: 'Run All Tests', category: 'test',
        description: 'Run the full test suite' },
      { id: 'test.e2e', name: 'Run E2E Tests', category: 'test',
        description: 'Run Playwright e2e tests',
        params: [{ name: 'file', type: 'string', placeholder: 'tests/foo.spec.ts' }] },

      // ── Build tools ─────────────────────────────────────
      { id: 'build.compile', name: 'Compile Check', category: 'build',
        description: 'Fast compile check on a file',
        params: [{ name: 'file', type: 'string', required: true, placeholder: 'src/App.tsx' }] },
      { id: 'build.lint', name: 'Lint', category: 'build',
        description: 'Run linter' },
      { id: 'build.dev', name: 'Dev Server', category: 'build',
        description: 'Start/stop dev server (npm run dev)' },
      { id: 'build.init', name: 'Init Frontend', category: 'build',
        description: 'Initialize frontend project (vite + shadcn + vitest)' },

      // ── Guard tools ─────────────────────────────────────
      { id: 'guard.verify-red', name: 'Verify RED', category: 'guard',
        description: 'Run full VERIFY_RED guard chain',
        params: [{ name: 'testFile', type: 'string', required: true }] },
      { id: 'guard.verify-green', name: 'Verify GREEN', category: 'guard',
        description: 'Run full VERIFY_GREEN guard chain',
        params: [{ name: 'testFile', type: 'string', required: true }, { name: 'sourceFile', type: 'string', required: true }] },
      { id: 'guard.test-sanity', name: 'Test Sanity', category: 'guard',
        description: 'Check test file for unsatisfiable assertions',
        params: [{ name: 'file', type: 'string', required: true }] },
      { id: 'guard.test-api', name: 'Test API Check', category: 'guard',
        description: 'Check test file uses correct testing framework API',
        params: [{ name: 'file', type: 'string', required: true }] },
      { id: 'guard.diagnose', name: 'Diagnose Failure', category: 'guard',
        description: 'Diagnose test failure (env/test/impl)',
        params: [{ name: 'testFile', type: 'string', required: true }] },

      // ── Model tools ─────────────────────────────────────
      { id: 'model.chat', name: 'Chat', category: 'model',
        description: 'Send prompt to model',
        params: [{ name: 'prompt', type: 'string', required: true, placeholder: 'Write a function that...' }] },
      { id: 'model.status', name: 'Model Status', category: 'model',
        description: 'Check ollama connectivity and model info' },

      // ── Shell tools ─────────────────────────────────────
      { id: 'shell.exec', name: 'Run Command', category: 'shell',
        description: 'Execute shell command in project dir',
        params: [{ name: 'cmd', type: 'string', required: true, placeholder: 'ls -la src/' }] },
      { id: 'shell.ast-grep', name: 'AST Grep', category: 'shell',
        description: 'Search/replace code patterns with ast-grep',
        params: [
          { name: 'pattern', type: 'string', required: true, placeholder: 'expect($A).not.toBe($A)' },
          { name: 'lang', type: 'string', placeholder: 'tsx' },
        ] },
      { id: 'shell.screenshot', name: 'Screenshot', category: 'shell',
        description: 'Take browser screenshot of running app' },

      // ── Project tools ───────────────────────────────────
      { id: 'project.setup', name: 'Setup', category: 'project',
        description: 'Run project setup/install' },
      { id: 'project.scripts', name: 'Show Scripts', category: 'project',
        description: 'Show resolved project scripts' },
    ];
  }

  /** Execute a tool by id */
  async exec(toolId: string, params: Record<string, string> = {}): Promise<ToolResult> {
    const start = Date.now();
    trace.emit('phase_enter', { phase: `tool:${toolId}`, attempt: 1, maxAttempts: 1 });

    try {
      const result = await this._exec(toolId, params);
      const duration = Date.now() - start;
      trace.emit('guard_result', { name: `tool:${toolId}`, ok: result.ok, detail: result.output.slice(0, 200) });
      return { ...result, duration };
    } catch (err: any) {
      const duration = Date.now() - start;
      trace.emit('error', { message: err.message, phase: `tool:${toolId}` });
      return { ok: false, output: err.message, duration };
    }
  }

  private async _exec(id: string, p: Record<string, string>): Promise<Omit<ToolResult, 'duration'>> {
    switch (id) {

      // ── Tests ──────────────────────────────────────────
      case 'test.run': {
        const r = this.runner.runUnit(p.file);
        return { ok: r.passed, output: r.output, data: { total: r.totalTests, failed: r.failedTests, passed: r.passedTests } };
      }
      case 'test.all': {
        const r = this.runner.runAll();
        return { ok: r.passed, output: r.output, data: { total: r.totalTests, failed: r.failedTests, passed: r.passedTests } };
      }
      case 'test.e2e': {
        const r = this.runner.runE2e(p.file);
        return { ok: r.passed, output: r.output };
      }

      // ── Build ──────────────────────────────────────────
      case 'build.compile': {
        const r = this.runner.checkCompiles(p.file);
        return { ok: r.ok, output: r.ok ? `✓ ${p.file} compiles` : r.error };
      }
      case 'build.lint': {
        const r = this.scripts.run('lint');
        return { ok: r.ok, output: r.output };
      }
      case 'build.dev': {
        return this.toggleDevServer();
      }
      case 'build.init': {
        const r = this.scripts.run('setup');
        return { ok: r.ok, output: r.output };
      }

      // ── Guards ─────────────────────────────────────────
      case 'guard.verify-red': {
        const g = createGuards(this.config, this.runner);
        const ctx = this.makeCtx(p.testFile, p.sourceFile || '');
        const r = await runVerifyChain(g.chains.verifyRedChain, ctx);
        return { ok: r.allPassed, output: r.results.map(r => `${r.ok ? '✓' : '✗'} ${r.name}: ${r.detail}`).join('\n'), data: r };
      }
      case 'guard.verify-green': {
        const g = createGuards(this.config, this.runner);
        const ctx = this.makeCtx(p.testFile, p.sourceFile);
        const r = await runVerifyChain(g.chains.verifyGreenChain, ctx);
        return { ok: r.allPassed, output: r.results.map(r => `${r.ok ? '✓' : '✗'} ${r.name}: ${r.detail}`).join('\n'), data: r };
      }
      case 'guard.test-sanity': {
        const { detectInsaneTests } = await import('./guards.js');
        const code = readFileSync(join(this.config.appDir, p.file), 'utf-8');
        const issues = detectInsaneTests(code);
        return { ok: issues.length === 0, output: issues.length === 0 ? '✓ All tests satisfiable' : `✗ Issues:\n${issues.join('\n')}` };
      }
      case 'guard.test-api': {
        const code = readFileSync(join(this.config.appDir, p.file), 'utf-8');
        const issues = checkTestFrameworkAPI(code);
        return { ok: issues.length === 0, output: issues.length === 0 ? '✓ Test API usage correct' : `✗ Wrong API:\n${issues.join('\n')}` };
      }
      case 'guard.diagnose': {
        const { diagnoseTestFailure } = await import('./diagnosis.js');
        const testResult = this.runner.runUnit(p.testFile);
        const ctx = this.makeCtx(p.testFile, '');
        const diag = await diagnoseTestFailure(testResult, ctx, this.config, this.ollama);
        return { ok: true, output: `Source: ${diag.source}\nConfidence: ${diag.confidence}\nReason: ${diag.reason}\nAction: ${diag.action}\nDetails:\n${diag.details.join('\n')}`, data: diag };
      }

      // ── Model ──────────────────────────────────────────
      case 'model.chat': {
        const r = await this.ollama.generate(p.prompt, SYSTEM_PROMPT);
        return { ok: true, output: r.content, data: { tokensUsed: r.tokensUsed } };
      }
      case 'model.status': {
        const ok = await this.ollama.isAvailable();
        if (!ok) return { ok: false, output: `✗ Ollama not reachable at ${this.config.ollamaUrl}` };
        try {
          const res = await fetch(`${this.config.ollamaUrl}/api/tags`);
          const data = await res.json() as any;
          const models = (data.models || []).map((m: any) => m.name).join(', ');
          return { ok: true, output: `✓ Connected\nModel: ${this.config.model}\nAvailable: ${models}` };
        } catch {
          return { ok: true, output: `✓ Connected\nModel: ${this.config.model}` };
        }
      }

      // ── Shell ──────────────────────────────────────────
      case 'shell.exec': {
        try {
          const out = execSync(p.cmd, { cwd: this.config.appDir, encoding: 'utf-8', timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'] });
          return { ok: true, output: out };
        } catch (e: any) {
          return { ok: false, output: (e.stdout || '') + '\n' + (e.stderr || '') };
        }
      }
      case 'shell.ast-grep': {
        const lang = p.lang || 'tsx';
        try {
          const out = execSync(`sg --pattern '${p.pattern.replace(/'/g, "\\'")}' --lang ${lang} .`, { cwd: this.config.appDir, encoding: 'utf-8', timeout: 15_000, stdio: ['pipe', 'pipe', 'pipe'] });
          return { ok: true, output: out || '(no matches)' };
        } catch (e: any) {
          const out = (e.stdout || '') + (e.stderr || '');
          if (out.includes('No match')) return { ok: true, output: '(no matches)' };
          return { ok: false, output: out };
        }
      }
      case 'shell.screenshot': {
        return this.takeScreenshot();
      }

      // ── Project ────────────────────────────────────────
      case 'project.setup': {
        const r = this.scripts.run('setup');
        return { ok: r.ok, output: r.output };
      }
      case 'project.scripts': {
        const info = this.scripts.getScriptInfo();
        return { ok: true, output: info.map(s => `${s.key}: [${s.source}] ${s.command}`).join('\n') };
      }

      default: {
        // Try recipe registry: recipe.<id>
        if (id.startsWith('recipe.')) {
          const recipeId = id.slice('recipe.'.length);
          const result = await this.recipes.run(recipeId, this.config.appDir, p, this);
          return {
            ok: result.ok,
            output: result.output,
            data: { filesCreated: result.filesCreated, filesModified: result.filesModified, stepResults: result.stepResults },
          };
        }
        // Try skill execution: skill.<name>
        if (id.startsWith('skill.')) {
          const skill = this.skills.find(s => s.id === id);
          if (!skill) return { ok: false, output: `Unknown skill: ${id}` };
          const prompt = buildSkillPrompt(skill, p.prompt || '');
          const r = await this.ollama.generate(prompt, SYSTEM_PROMPT);
          return { ok: true, output: r.content, data: { tokensUsed: r.tokensUsed, skill: skill.name } };
        }
        return { ok: false, output: `Unknown tool: ${id}` };
      }
    }
  }

  // ── Dev server ─────────────────────────────────────────
  private toggleDevServer(): Omit<ToolResult, 'duration'> {
    if (this.devProcess && !this.devProcess.killed) {
      this.devProcess.kill();
      this.devProcess = null;
      return { ok: true, output: 'Dev server stopped' };
    }
    this.devProcess = spawn('npm', ['run', 'dev'], {
      cwd: this.config.appDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });
    let startOutput = '';
    this.devProcess.stdout?.on('data', (d: Buffer) => { startOutput += d.toString(); });
    this.devProcess.stderr?.on('data', (d: Buffer) => { startOutput += d.toString(); });
    this.devProcess.on('error', (e) => { trace.emit('error', { message: `Dev server: ${e.message}`, phase: 'devServer' }); });
    return { ok: true, output: 'Dev server starting...\nRun screenshot tool to verify.' };
  }

  isDevRunning(): boolean {
    return this.devProcess !== null && !this.devProcess.killed;
  }

  // ── Screenshot ─────────────────────────────────────────
  private takeScreenshot(): Omit<ToolResult, 'duration'> {
    const screenshotPath = join(this.config.logDir, 'screenshot.png');
    try {
      execSync(
        `npx playwright screenshot --browser chromium http://localhost:5173 ${screenshotPath}`,
        { cwd: this.config.appDir, encoding: 'utf-8', timeout: 15_000, stdio: ['pipe', 'pipe', 'pipe'] }
      );
      return { ok: true, output: `Screenshot saved: ${screenshotPath}`, data: { path: screenshotPath } };
    } catch (e: any) {
      return { ok: false, output: `Screenshot failed: ${(e.stderr || e.message).slice(0, 300)}` };
    }
  }

  // ── Helpers ────────────────────────────────────────────
  private makeCtx(testFile: string, sourceFile: string): any {
    const existing: Record<string, string> = {};
    for (const f of [testFile, sourceFile]) {
      if (!f) continue;
      const full = join(this.config.appDir, f);
      if (existsSync(full)) existing[f] = readFileSync(full, 'utf-8');
    }
    return {
      task: { id: 'manual', title: 'Manual', description: '', testHint: '', implementHint: '', testFile, sourceFile },
      phase: 'manual', attempt: 0, phaseAttempts: {},
      lastTestResult: null, lastModelOutput: '', lastGuardResults: [],
      existingCode: existing, history: [],
    };
  }
}

// ═══════════════════════════════════════════════════════════════
// Test framework API checker — catches wrong matchers
// ═══════════════════════════════════════════════════════════════

export function checkTestFrameworkAPI(code: string): string[] {
  const issues: string[] = [];
  const lines = code.split('\n');

  const WRONG_MATCHERS: Array<{ pattern: RegExp; msg: string; fix: string }> = [
    { pattern: /\.toBeNumber\(\)/, msg: 'toBeNumber() not in vitest', fix: "expect(typeof x).toBe('number')" },
    { pattern: /\.toBeString\(\)/, msg: 'toBeString() not in vitest', fix: "expect(typeof x).toBe('string')" },
    { pattern: /\.toBeBoolean\(\)/, msg: 'toBeBoolean() not in vitest', fix: "expect(typeof x).toBe('boolean')" },
    { pattern: /\.toBeArray\(\)/, msg: 'toBeArray() not in vitest', fix: 'expect(Array.isArray(x)).toBe(true)' },
    { pattern: /\.toBeObject\(\)/, msg: 'toBeObject() not in vitest', fix: "expect(typeof x).toBe('object')" },
    { pattern: /\.toBeEmpty\(\)/, msg: 'toBeEmpty() not in vitest', fix: '.toHaveLength(0) or .toEqual({})' },
    { pattern: /\.toBeTrue\(\)/, msg: 'toBeTrue() not in vitest', fix: '.toBe(true)' },
    { pattern: /\.toBeFalse\(\)/, msg: 'toBeFalse() not in vitest', fix: '.toBe(false)' },
    { pattern: /\.toBeNil\(\)/, msg: 'toBeNil() not in vitest', fix: '.toBeNull() or .toBeUndefined()' },
    { pattern: /\.toSatisfy\(/, msg: 'toSatisfy() not in vitest', fix: 'use inline check or expect.extend' },
    { pattern: /\.toInclude\(/, msg: 'toInclude() not in vitest', fix: '.toContain()' },
    { pattern: /\.toIncludeAllMembers\(/, msg: 'jest-extended matcher', fix: 'use .toEqual(expect.arrayContaining(...))' },
    { pattern: /\.toContainKey\(/, msg: 'jest-extended matcher', fix: '.toHaveProperty(key)' },
    { pattern: /\.toContainKeys\(/, msg: 'jest-extended matcher', fix: 'multiple .toHaveProperty() calls' },
    { pattern: /\.toStartWith\(/, msg: 'jest-extended matcher', fix: 'expect(x.startsWith(y)).toBe(true)' },
    { pattern: /\.toEndWith\(/, msg: 'jest-extended matcher', fix: 'expect(x.endsWith(y)).toBe(true)' },
    { pattern: /\.toEqualCaseInsensitive\(/, msg: 'jest-extended matcher', fix: 'expect(x.toLowerCase()).toBe(y.toLowerCase())' },
    { pattern: /chai\.expect/, msg: 'chai import detected', fix: 'use vitest expect' },
    { pattern: /from ['"]chai['"]/, msg: 'chai import', fix: 'remove, use vitest' },
    { pattern: /\.to\.be\./, msg: 'chai-style assertion chain', fix: 'use vitest .toBe()' },
    { pattern: /\.to\.equal\(/, msg: 'chai-style .to.equal', fix: 'use .toEqual()' },
    { pattern: /\.to\.have\./, msg: 'chai-style .to.have', fix: 'use vitest matchers' },
    { pattern: /assert\.\w+\(/, msg: 'chai assert style', fix: 'use vitest expect' },
    { pattern: /\.should\./, msg: 'chai should style', fix: 'use vitest expect' },
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const m of WRONG_MATCHERS) {
      if (m.pattern.test(line)) {
        issues.push(`L${i + 1}: ${m.msg} → ${m.fix}`);
      }
    }
  }

  return issues;
}
