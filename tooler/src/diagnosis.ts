import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { StateContext, ToolerConfig, TestResult } from './types.js';
import { OllamaClient } from './ollama.js';
import { trace } from './trace.js';

// ═══════════════════════════════════════════════════════════════
// Error source classification
//
// When a test fails, we need to know WHY before deciding what to fix.
// Three possible sources:
//   ENV  — environment/tooling problem (missing dep, wrong config, bad import path)
//   TEST — test is incorrect (wrong assertion, bad chai property, wrong API usage)
//   IMPL — implementation is wrong (logic bug, missing export, incomplete)
//
// Strategy: programmatic classification first (fast, no model call).
// Model fallback only when programmatic can't determine.
// ═══════════════════════════════════════════════════════════════

export type ErrorSource = 'env' | 'test' | 'impl' | 'unknown';

export interface Diagnosis {
  source: ErrorSource;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  details: string[];
  /** Suggested action */
  action: 'fix_test' | 'fix_impl' | 'fix_env' | 'ask_model';
}

// ═══════════════════════════════════════════════════════════════
// Programmatic patterns — fast, no model call
// ═══════════════════════════════════════════════════════════════

interface ErrorPattern {
  source: ErrorSource;
  /** Regex or string to match in test output */
  match: RegExp | string;
  /** Human-readable reason */
  reason: string;
  /** Confidence level */
  confidence: 'high' | 'medium';
}

const PATTERNS: ErrorPattern[] = [

  // ── ENV patterns (missing deps, config, tooling) ─────────

  { source: 'env', match: /Cannot find module ['"]([^'"]+)['"]/,
    reason: 'Missing module: $1', confidence: 'high' },

  { source: 'env', match: /Module not found/,
    reason: 'Module not found — missing dependency or bad path', confidence: 'high' },

  { source: 'env', match: /Failed to resolve import ['"]([^'"]+)['"]/,
    reason: 'Failed to resolve import: $1', confidence: 'high' },

  { source: 'env', match: /ENOENT.*no such file/,
    reason: 'File not found on disk', confidence: 'high' },

  { source: 'env', match: /Cannot find package/,
    reason: 'Package not installed', confidence: 'high' },

  { source: 'env', match: /SyntaxError: Cannot use import statement/,
    reason: 'ESM/CJS mismatch — config issue', confidence: 'high' },

  { source: 'env', match: /ERR_MODULE_NOT_FOUND/,
    reason: 'Node module resolution failure', confidence: 'high' },

  // ── TEST patterns (test code is wrong) ───────────────────

  { source: 'test', match: /Invalid Chai property/,
    reason: 'Test uses invalid assertion method (wrong testing library API)', confidence: 'high' },

  { source: 'test', match: /is not a function/,
    reason: 'Test calls non-existent function — likely wrong API', confidence: 'medium' },

  { source: 'test', match: /toBeNumber is not a function/,
    reason: 'Test uses jest-extended matcher without installing it', confidence: 'high' },

  { source: 'test', match: /toBeArray is not a function/,
    reason: 'Test uses jest-extended matcher without installing it', confidence: 'high' },

  { source: 'test', match: /toBeString is not a function/,
    reason: 'Test uses jest-extended matcher without installing it', confidence: 'high' },

  { source: 'test', match: /toHaveBeenCalledWith is not a function/,
    reason: 'Test uses mock matcher on non-mock', confidence: 'high' },

  { source: 'test', match: /Property '(\w+)' does not exist on type/,
    reason: 'Test references non-existent property: $1', confidence: 'medium' },

  { source: 'test', match: /TypeError: (\w+) is not a constructor/,
    reason: 'Test tries to construct non-constructor: $1', confidence: 'medium' },

  { source: 'test', match: /toMatchSnapshot/,
    reason: 'Test uses snapshot but no snapshot exists yet', confidence: 'medium' },

  { source: 'test', match: /render is not a function/,
    reason: 'Test imports render incorrectly from testing-library', confidence: 'high' },

  { source: 'test', match: /TestingLibraryElementError/,
    reason: 'Test queries DOM element that doesnt exist — likely wrong query', confidence: 'medium' },

  { source: 'test', match: /Unable to find.*role/,
    reason: 'Test queries ARIA role that component doesnt have', confidence: 'medium' },

  // ── IMPL patterns (implementation is wrong) ──────────────

  { source: 'impl', match: /Expected.*Received/,
    reason: 'Assertion mismatch — implementation returns wrong value', confidence: 'medium' },

  { source: 'impl', match: /expected .+ to equal .+/,
    reason: 'Value mismatch — implementation logic wrong', confidence: 'medium' },

  { source: 'impl', match: /expected .+ to be .+/,
    reason: 'Value mismatch — implementation returns wrong result', confidence: 'medium' },

  { source: 'impl', match: /expected .+ to contain .+/,
    reason: 'Missing content — implementation incomplete', confidence: 'medium' },

  { source: 'impl', match: /expected .+ to have length .+/,
    reason: 'Wrong collection size — implementation incomplete', confidence: 'medium' },

  { source: 'impl', match: /is not exported from/,
    reason: 'Missing export from implementation', confidence: 'high' },

  { source: 'impl', match: /does not provide an export named/,
    reason: 'Missing named export', confidence: 'high' },
];

// ═══════════════════════════════════════════════════════════════
// Structural analysis (deeper than regex)
// ═══════════════════════════════════════════════════════════════

interface StructuralCheck {
  name: string;
  check: (output: string, ctx: StateContext, config: ToolerConfig) => Diagnosis | null;
}

const STRUCTURAL_CHECKS: StructuralCheck[] = [

  // Test file has syntax error
  {
    name: 'test-syntax-error',
    check: (output, ctx) => {
      const testFile = ctx.task.testFile;
      if (output.includes('SyntaxError') && output.includes(testFile)) {
        return {
          source: 'test', confidence: 'high',
          reason: `Syntax error in test file ${testFile}`,
          details: extractLinesContaining(output, 'SyntaxError'),
          action: 'fix_test',
        };
      }
      return null;
    },
  },

  // Source file has syntax error
  {
    name: 'source-syntax-error',
    check: (output, ctx) => {
      const srcFile = ctx.task.sourceFile;
      if (output.includes('SyntaxError') && output.includes(srcFile)) {
        return {
          source: 'impl', confidence: 'high',
          reason: `Syntax error in source file ${srcFile}`,
          details: extractLinesContaining(output, 'SyntaxError'),
          action: 'fix_impl',
        };
      }
      return null;
    },
  },

  // Test references API that doesn't exist in vitest
  {
    name: 'wrong-test-framework-api',
    check: (output, ctx, config) => {
      const testPath = join(config.appDir, ctx.task.testFile);
      if (!existsSync(testPath)) return null;
      const code = readFileSync(testPath, 'utf-8');

      // Common mistakes: using jest/chai API in vitest
      const wrongAPIs = [
        { pattern: /\.toBeNumber\(\)/, lib: 'jest-extended', fix: 'Use typeof check: expect(typeof x).toBe("number")' },
        { pattern: /\.toBeString\(\)/, lib: 'jest-extended', fix: 'Use typeof check: expect(typeof x).toBe("string")' },
        { pattern: /\.toBeArray\(\)/, lib: 'jest-extended', fix: 'Use Array.isArray: expect(Array.isArray(x)).toBe(true)' },
        { pattern: /\.toBeObject\(\)/, lib: 'jest-extended', fix: 'Use typeof: expect(typeof x).toBe("object")' },
        { pattern: /\.toBeEmpty\(\)/, lib: 'jest-extended', fix: 'Use .toHaveLength(0) or .toEqual({})' },
        { pattern: /\.toBeTrue\(\)/, lib: 'jest-extended', fix: 'Use .toBe(true)' },
        { pattern: /\.toBeFalse\(\)/, lib: 'jest-extended', fix: 'Use .toBe(false)' },
        { pattern: /\.toBeNil\(\)/, lib: 'jest-extended', fix: 'Use .toBeNull() or .toBeUndefined()' },
        { pattern: /\.toSatisfy\(/, lib: 'jest-extended', fix: 'Use custom expect.extend or inline check' },
        { pattern: /\.toInclude\(/, lib: 'jest-extended/chai', fix: 'Use .toContain()' },
        { pattern: /\.toHaveProperty\(.+,.+\)/, lib: 'jest (nested)', fix: 'Vitest supports this but check syntax' },
        { pattern: /chai\.expect/, lib: 'chai', fix: 'Use vitest expect' },
        { pattern: /assert\./, lib: 'chai assert', fix: 'Use vitest expect' },
        { pattern: /should\./, lib: 'chai should', fix: 'Use vitest expect' },
      ];

      const found = wrongAPIs.filter(api => api.pattern.test(code));
      if (found.length > 0) {
        return {
          source: 'test', confidence: 'high',
          reason: `Test uses wrong assertion API: ${found.map(f => f.lib).join(', ')}`,
          details: found.map(f => `${f.pattern.source} → ${f.fix}`),
          action: 'fix_test',
        };
      }
      return null;
    },
  },

  // All errors trace back to test file (stack analysis)
  {
    name: 'error-originates-in-test',
    check: (output, ctx) => {
      const testFile = ctx.task.testFile;
      const srcFile = ctx.task.sourceFile;
      const stackLines = output.split('\n').filter(l => l.match(/^\s+at\s/) || l.match(/\.(ts|tsx|js|jsx):\d+/));

      if (stackLines.length === 0) return null;

      const inTest = stackLines.filter(l => l.includes(testFile)).length;
      const inSrc = stackLines.filter(l => l.includes(srcFile)).length;

      // If ALL stack frames are in test file and none in source
      if (inTest > 0 && inSrc === 0) {
        return {
          source: 'test', confidence: 'medium',
          reason: 'All error stack frames originate in test file, none in source',
          details: stackLines.slice(0, 5),
          action: 'fix_test',
        };
      }

      return null;
    },
  },

  // Source file doesn't exist yet (expected during RED, not during GREEN)
  {
    name: 'source-missing',
    check: (output, ctx, config) => {
      const srcPath = join(config.appDir, ctx.task.sourceFile);
      if (!existsSync(srcPath) && ctx.phase !== 'writeTest' && ctx.phase !== 'verifyRed') {
        return {
          source: 'impl', confidence: 'high',
          reason: 'Source file does not exist',
          details: [`Expected: ${ctx.task.sourceFile}`],
          action: 'fix_impl',
        };
      }
      return null;
    },
  },
];

// ═══════════════════════════════════════════════════════════════
// Main diagnosis function
// ═══════════════════════════════════════════════════════════════

export async function diagnoseTestFailure(
  testResult: TestResult,
  ctx: StateContext,
  config: ToolerConfig,
  ollama?: OllamaClient,
): Promise<Diagnosis> {

  const output = testResult.output;

  trace.emit('phase_enter', { phase: 'diagnose', attempt: 1, maxAttempts: 1 });

  // ── Step 1: Structural checks (fast, high confidence) ────
  for (const check of STRUCTURAL_CHECKS) {
    const result = check.check(output, ctx, config);
    if (result) {
      trace.emit('guard_result', {
        name: `diag:${check.name}`,
        ok: true,
        detail: `${result.source} (${result.confidence}): ${result.reason}`,
      });
      return result;
    }
  }

  // ── Step 2: Pattern matching (fast, mixed confidence) ────
  for (const pattern of PATTERNS) {
    const match = typeof pattern.match === 'string'
      ? output.includes(pattern.match)
      : pattern.match.test(output);

    if (match) {
      let reason = pattern.reason;
      // Substitute capture groups
      if (pattern.match instanceof RegExp) {
        const m = output.match(pattern.match);
        if (m && m[1]) reason = reason.replace('$1', m[1]);
      }

      const diag: Diagnosis = {
        source: pattern.source,
        confidence: pattern.confidence,
        reason,
        details: extractLinesContaining(output, typeof pattern.match === 'string' ? pattern.match : pattern.match.source.slice(0, 30)),
        action: pattern.source === 'test' ? 'fix_test'
              : pattern.source === 'impl' ? 'fix_impl'
              : pattern.source === 'env' ? 'fix_env'
              : 'ask_model',
      };

      trace.emit('guard_result', {
        name: `diag:pattern:${pattern.reason.slice(0, 40)}`,
        ok: true,
        detail: `${diag.source} (${diag.confidence}): ${reason}`,
      });

      return diag;
    }
  }

  // ── Step 3: Heuristic scoring ────────────────────────────
  const scores = scoreHeuristic(output, ctx, config);
  if (scores.best.confidence !== 'low') {
    trace.emit('guard_result', {
      name: 'diag:heuristic',
      ok: true,
      detail: `${scores.best.source} (${scores.best.confidence}): ${scores.best.reason}`,
    });
    return scores.best;
  }

  // ── Step 4: Ask model (last resort, slow) ────────────────
  if (ollama) {
    trace.emit('model_request', {
      promptType: 'diagnose',
      promptChars: 0,
      prompt: '(diagnosis prompt)',
    });

    const diag = await askModelForDiagnosis(output, ctx, config, ollama);
    trace.emit('guard_result', {
      name: 'diag:model',
      ok: true,
      detail: `${diag.source} (${diag.confidence}): ${diag.reason}`,
    });
    return diag;
  }

  // ── Fallback ─────────────────────────────────────────────
  return {
    source: 'unknown',
    confidence: 'low',
    reason: 'Could not determine error source',
    details: extractLinesContaining(output, 'Error').slice(0, 5),
    action: 'ask_model',
  };
}

// ═══════════════════════════════════════════════════════════════
// Heuristic scoring
// ═══════════════════════════════════════════════════════════════

function scoreHeuristic(output: string, ctx: StateContext, config: ToolerConfig): {
  scores: Record<ErrorSource, number>;
  best: Diagnosis;
} {
  const scores: Record<ErrorSource, number> = { env: 0, test: 0, impl: 0, unknown: 0 };

  // ENV signals
  if (output.includes('EACCES')) scores.env += 3;
  if (output.includes('ENOENT')) scores.env += 2;
  if (output.includes('EPERM')) scores.env += 3;
  if (output.includes('command not found')) scores.env += 3;
  if (output.includes('Cannot find module')) scores.env += 2;

  // TEST signals
  if (output.includes('is not a function')) scores.test += 2;
  if (output.includes('Invalid') && output.includes('property')) scores.test += 3;
  if (output.includes('not a constructor')) scores.test += 2;
  if (output.match(/TypeError.*test/i)) scores.test += 1;

  // IMPL signals
  if (output.includes('Expected') && output.includes('Received')) scores.impl += 2;
  if (output.includes('toEqual') || output.includes('toBe')) scores.impl += 1;
  if (output.includes('not exported')) scores.impl += 2;
  if (output.includes('undefined') && output.includes('expected')) scores.impl += 1;

  // File-based: check if error lines reference test or source
  const testFile = ctx.task.testFile;
  const srcFile = ctx.task.sourceFile;
  const testMentions = (output.match(new RegExp(escapeRegex(testFile), 'g')) || []).length;
  const srcMentions = (output.match(new RegExp(escapeRegex(srcFile), 'g')) || []).length;

  if (testMentions > srcMentions + 2) scores.test += 1;
  if (srcMentions > testMentions + 2) scores.impl += 1;

  // Determine best
  const sorted = Object.entries(scores)
    .filter(([k]) => k !== 'unknown')
    .sort(([, a], [, b]) => b - a) as [ErrorSource, number][];

  const [bestSource, bestScore] = sorted[0] || ['unknown', 0];
  const [, secondScore] = sorted[1] || ['unknown', 0];

  const confidence = bestScore >= 4 ? 'high' as const
    : bestScore >= 2 && bestScore > secondScore ? 'medium' as const
    : 'low' as const;

  return {
    scores,
    best: {
      source: bestScore > 0 ? bestSource : 'unknown',
      confidence,
      reason: `Heuristic: ${bestSource} scored ${bestScore} (env:${scores.env} test:${scores.test} impl:${scores.impl})`,
      details: [],
      action: bestSource === 'test' ? 'fix_test'
            : bestSource === 'impl' ? 'fix_impl'
            : bestSource === 'env' ? 'fix_env'
            : 'ask_model',
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// Model-based diagnosis (last resort)
// ═══════════════════════════════════════════════════════════════

async function askModelForDiagnosis(
  output: string,
  ctx: StateContext,
  config: ToolerConfig,
  ollama: OllamaClient,
): Promise<Diagnosis> {

  const prompt = `/no_think
Analyze this test failure and classify the error source.

TEST FILE: ${ctx.task.testFile}
SOURCE FILE: ${ctx.task.sourceFile}

TEST OUTPUT:
${output.slice(0, 2000)}

EXISTING TEST CODE:
${ctx.existingCode[ctx.task.testFile]?.slice(0, 1500) || '(not available)'}

EXISTING SOURCE CODE:
${ctx.existingCode[ctx.task.sourceFile]?.slice(0, 1500) || '(not available)'}

Classify as exactly ONE of:
- ENV: environment problem (missing package, wrong config, bad import path, missing dependency)
- TEST: test code is wrong (wrong assertion API, bad test logic, using unavailable matcher)
- IMPL: implementation is wrong (logic bug, missing export, incomplete implementation)

Respond in this exact format:
SOURCE: ENV|TEST|IMPL
REASON: one line explanation
FIX: one line suggested fix`;

  const response = await ollama.generate(prompt, 'You classify test errors. Respond only in the requested format.');

  // Parse response
  const content = response.content;
  const sourceMatch = content.match(/SOURCE:\s*(ENV|TEST|IMPL)/i);
  const reasonMatch = content.match(/REASON:\s*(.+)/i);
  const fixMatch = content.match(/FIX:\s*(.+)/i);

  const source = sourceMatch
    ? sourceMatch[1].toLowerCase() as ErrorSource
    : 'unknown';

  return {
    source,
    confidence: 'medium',
    reason: reasonMatch?.[1]?.trim() || 'Model diagnosis',
    details: fixMatch ? [fixMatch[1].trim()] : [],
    action: source === 'test' ? 'fix_test'
          : source === 'impl' ? 'fix_impl'
          : source === 'env' ? 'fix_env'
          : 'ask_model',
  };
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

function extractLinesContaining(output: string, keyword: string): string[] {
  return output.split('\n')
    .filter(l => l.includes(keyword))
    .map(l => l.trim())
    .slice(0, 10);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
