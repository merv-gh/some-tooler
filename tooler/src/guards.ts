import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { GuardResult, GuardCheck, VerifyChain, StateContext, CodeBlock, ToolerConfig } from './types.js';
import { TestRunner } from './test-runner.js';

// ═══════════════════════════════════════════════════════════════
// GUARD CHECKS — reusable, composable verification steps
// ═══════════════════════════════════════════════════════════════

export function createGuards(config: ToolerConfig, runner: TestRunner) {

  // ── File System Guards ───────────────────────────────────

  const checkTestFileExists: GuardCheck = {
    name: 'test-file-exists',
    run: (ctx) => {
      const fullPath = join(config.appDir, ctx.task.testFile);
      const exists = existsSync(fullPath);
      return {
        ok: exists,
        name: 'test-file-exists',
        detail: exists
          ? `✓ ${ctx.task.testFile} exists`
          : `✗ ${ctx.task.testFile} not found`,
      };
    },
  };

  const checkSourceFileExists: GuardCheck = {
    name: 'source-file-exists',
    run: (ctx) => {
      const fullPath = join(config.appDir, ctx.task.sourceFile);
      const exists = existsSync(fullPath);
      return {
        ok: exists,
        name: 'source-file-exists',
        detail: exists
          ? `✓ ${ctx.task.sourceFile} exists`
          : `✗ ${ctx.task.sourceFile} not found`,
      };
    },
  };

  // ── Compilation Guards ───────────────────────────────────

  const checkTestCompiles: GuardCheck = {
    name: 'test-compiles',
    run: (ctx) => {
      const result = runner.checkCompiles(ctx.task.testFile);
      return {
        ok: result.ok,
        name: 'test-compiles',
        detail: result.ok
          ? `✓ ${ctx.task.testFile} compiles`
          : `✗ Compile error:\n${result.error.slice(0, 500)}`,
      };
    },
  };

  const checkSourceCompiles: GuardCheck = {
    name: 'source-compiles',
    run: (ctx) => {
      const result = runner.checkCompiles(ctx.task.sourceFile);
      return {
        ok: result.ok,
        name: 'source-compiles',
        detail: result.ok
          ? `✓ ${ctx.task.sourceFile} compiles`
          : `✗ Compile error:\n${result.error.slice(0, 500)}`,
      };
    },
  };

  // ── Test Execution Guards ────────────────────────────────

  const checkTestRuns: GuardCheck = {
    name: 'test-runs',
    run: (ctx) => {
      const result = runner.runUnit(ctx.task.testFile);
      ctx.lastTestResult = result;
      const hasTests = result.totalTests > 0;
      return {
        ok: hasTests,
        name: 'test-runs',
        detail: hasTests
          ? `✓ Found ${result.totalTests} test(s)`
          : `✗ No tests detected. Runner output:\n${result.output.slice(0, 300)}`,
      };
    },
  };

  const checkTestsFail: GuardCheck = {
    name: 'tests-fail',
    run: (ctx) => {
      // Must have run checkTestRuns first (populates lastTestResult)
      const r = ctx.lastTestResult;
      if (!r) return { ok: false, name: 'tests-fail', detail: '✗ No test result available' };
      return {
        ok: !r.passed && r.failedTests > 0,
        name: 'tests-fail',
        detail: r.passed
          ? `✗ Tests already pass (expected RED)`
          : `✓ ${r.failedTests} test(s) failing`,
      };
    },
  };

  const checkTestsPass: GuardCheck = {
    name: 'tests-pass',
    run: (ctx) => {
      const r = ctx.lastTestResult;
      if (!r) return { ok: false, name: 'tests-pass', detail: '✗ No test result available' };
      return {
        ok: r.passed,
        name: 'tests-pass',
        detail: r.passed
          ? `✓ All ${r.totalTests} test(s) pass`
          : `✗ ${r.failedTests} of ${r.totalTests} failing:\n${r.errorSummary.slice(0, 500)}`,
      };
    },
  };

  // ── Assertion Quality Guards ─────────────────────────────

  const checkFailsOnAssertion: GuardCheck = {
    name: 'fails-on-assertion',
    run: (ctx) => {
      const r = ctx.lastTestResult;
      if (!r) return { ok: false, name: 'fails-on-assertion', detail: '✗ No test result' };

      const output = r.output;

      // BAD: import/syntax/reference errors — not assertion failures
      const compileErrors = [
        'Cannot find module',
        'SyntaxError',
        'TypeError: Cannot read',
        'ReferenceError',
        'Module not found',
        'Failed to resolve import',
      ];
      const hasCompileError = compileErrors.some(e => output.includes(e));

      // GOOD: assertion-based failures
      const assertionPatterns = [
        'AssertionError',
        'expect(',
        'Expected',
        'Received',
        'toEqual',
        'toBe',
        'toContain',
        'toHaveLength',
        'toBeTruthy',
        'toBeFalsy',
        'toThrow',
        'toHaveBeenCalled',
        'is not a function',   // implementation missing = ok
        'is not defined',      // implementation missing = ok
      ];
      const hasAssertionFail = assertionPatterns.some(p => output.includes(p));

      if (hasCompileError && !hasAssertionFail) {
        return {
          ok: false,
          name: 'fails-on-assertion',
          detail: `✗ Failing on COMPILE error, not assertion. Need stub source file.\n${r.errorSummary.slice(0, 300)}`,
        };
      }

      return {
        ok: true,
        name: 'fails-on-assertion',
        detail: hasAssertionFail
          ? `✓ Failing on assertion (proper RED)`
          : `✓ Failing (likely missing implementation)`,
      };
    },
  };

  // ── Test Sanity Guard (THE KEY ONE) ──────────────────────
  // Detects tests that can NEVER become green:
  //   expect(x).not.toBe(x)
  //   expect(true).toBe(false)
  //   expect("foo").not.toContain("foo")

  const checkTestSanity: GuardCheck = {
    name: 'test-sanity',
    run: (ctx) => {
      const testPath = join(config.appDir, ctx.task.testFile);
      if (!existsSync(testPath)) {
        return { ok: false, name: 'test-sanity', detail: '✗ Test file missing' };
      }

      const code = readFileSync(testPath, 'utf-8');
      const issues = detectInsaneTests(code);

      if (issues.length > 0) {
        return {
          ok: false,
          name: 'test-sanity',
          detail: `✗ UNFIXABLE test(s) detected:\n${issues.map(i => `  - ${i}`).join('\n')}\nThese tests can never pass with any correct implementation.`,
        };
      }

      return {
        ok: true,
        name: 'test-sanity',
        detail: '✓ All tests are logically satisfiable',
      };
    },
  };

  // ── All-Tests-Still-Pass Guard (for refactor) ────────────

  const checkAllTestsPass: GuardCheck = {
    name: 'all-tests-pass',
    run: (ctx) => {
      const result = runner.runAll();
      ctx.lastTestResult = result;
      return {
        ok: result.passed,
        name: 'all-tests-pass',
        detail: result.passed
          ? `✓ Full suite: ${result.totalTests} pass`
          : `✗ Regression: ${result.failedTests} of ${result.totalTests} failing:\n${result.errorSummary.slice(0, 500)}`,
      };
    },
  };

  // ── Test Framework API Guard ──────────────────────────────
  // Catches wrong matchers BEFORE tests run (faster than diagnosis)

  const checkTestAPI: GuardCheck = {
    name: 'test-api-valid',
    run: (ctx) => {
      const testPath = join(config.appDir, ctx.task.testFile);
      if (!existsSync(testPath)) {
        return { ok: true, name: 'test-api-valid', detail: '○ test file not found, skipping' };
      }
      const code = readFileSync(testPath, 'utf-8');
      const { checkTestFrameworkAPI } = require('./tools.js');
      const issues = checkTestFrameworkAPI(code);
      if (issues.length > 0) {
        return {
          ok: false,
          name: 'test-api-valid',
          detail: `✗ Wrong testing API:\n${issues.join('\n')}\nThese matchers don't exist in vitest.`,
        };
      }
      return { ok: true, name: 'test-api-valid', detail: '✓ Test API usage correct (vitest compatible)' };
    },
  };

  // ── Model Output Guards ──────────────────────────────────

  const checkModelOutputHasCode: GuardCheck = {
    name: 'model-output-has-code',
    run: (ctx) => {
      const hasCodeBlock = /```[\s\S]*?```/.test(ctx.lastModelOutput);
      return {
        ok: hasCodeBlock,
        name: 'model-output-has-code',
        detail: hasCodeBlock
          ? '✓ Model produced code block(s)'
          : '✗ No code blocks in model output',
      };
    },
  };

  const checkModelOutputNotEmpty: GuardCheck = {
    name: 'model-output-not-empty',
    run: (ctx) => {
      const ok = ctx.lastModelOutput.trim().length > 20;
      return {
        ok,
        name: 'model-output-not-empty',
        detail: ok ? '✓ Model produced output' : '✗ Model output empty/too short',
      };
    },
  };

  // ═══════════════════════════════════════════════════════════
  // VERIFICATION CHAINS — ordered sequences of guards
  // ═══════════════════════════════════════════════════════════

  const verifyRedChain: VerifyChain = {
    name: 'VERIFY_RED',
    checks: [
      checkTestFileExists,
      checkTestAPI,           // catches wrong matchers BEFORE running
      checkTestCompiles,
      checkTestRuns,
      checkTestsFail,
      checkFailsOnAssertion,
      checkTestSanity,
    ],
  };

  const verifyGreenChain: VerifyChain = {
    name: 'VERIFY_GREEN',
    checks: [
      checkSourceFileExists,
      checkSourceCompiles,
      checkTestRuns,
      checkTestsPass,
    ],
  };

  const verifyRefactorChain: VerifyChain = {
    name: 'VERIFY_REFACTOR',
    checks: [
      checkSourceCompiles,
      checkTestCompiles,
      checkAllTestsPass,
    ],
  };

  const modelOutputChain: VerifyChain = {
    name: 'MODEL_OUTPUT',
    checks: [
      checkModelOutputNotEmpty,
      checkModelOutputHasCode,
    ],
  };

  return {
    // Individual checks (for custom composition)
    checks: {
      checkTestFileExists,
      checkSourceFileExists,
      checkTestCompiles,
      checkSourceCompiles,
      checkTestRuns,
      checkTestsFail,
      checkTestsPass,
      checkFailsOnAssertion,
      checkTestSanity,
      checkTestAPI,
      checkAllTestsPass,
      checkModelOutputHasCode,
      checkModelOutputNotEmpty,
    },
    // Pre-built chains
    chains: {
      verifyRedChain,
      verifyGreenChain,
      verifyRefactorChain,
      modelOutputChain,
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// TEST SANITY ANALYSIS
// ═══════════════════════════════════════════════════════════════

/**
 * Detect tests that are logically impossible to satisfy.
 *
 * Patterns detected:
 * 1. expect(literal).not.toBe(same_literal)
 * 2. expect(true).toBe(false) / expect(false).toBe(true)
 * 3. expect("str").not.toContain("str")
 * 4. expect(x).not.toBe(x) where x is same variable
 * 5. Tautological negations: expect(anything).not.toBeDefined() on a literal
 */
export function detectInsaneTests(code: string): string[] {
  const issues: string[] = [];
  const lines = code.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const lineNum = i + 1;

    // Pattern 1: expect("x").not.toBe("x") or expect(123).not.toBe(123)
    const notToBeMatch = line.match(/expect\(([^)]+)\)\.not\.toBe\(([^)]+)\)/);
    if (notToBeMatch) {
      const [, a, b] = notToBeMatch;
      if (normalize(a) === normalize(b)) {
        issues.push(`L${lineNum}: expect(${a}).not.toBe(${b}) — always fails, same value`);
      }
    }

    // Pattern 2: expect("x").not.toEqual("x")
    const notToEqualMatch = line.match(/expect\(([^)]+)\)\.not\.toEqual\(([^)]+)\)/);
    if (notToEqualMatch) {
      const [, a, b] = notToEqualMatch;
      if (normalize(a) === normalize(b)) {
        issues.push(`L${lineNum}: expect(${a}).not.toEqual(${b}) — always fails, same value`);
      }
    }

    // Pattern 3: expect(true).toBe(false) or vice versa
    const boolFlipMatch = line.match(/expect\((true|false)\)\.toBe\((true|false)\)/);
    if (boolFlipMatch) {
      const [, a, b] = boolFlipMatch;
      if (a !== b) {
        issues.push(`L${lineNum}: expect(${a}).toBe(${b}) — boolean contradiction`);
      }
    }

    // Pattern 4: expect("str").not.toContain("str") where inner is substring
    const notContainMatch = line.match(/expect\(["']([^"']+)["']\)\.not\.toContain\(["']([^"']+)["']\)/);
    if (notContainMatch) {
      const [, str, sub] = notContainMatch;
      if (str.includes(sub)) {
        issues.push(`L${lineNum}: expect("${str}").not.toContain("${sub}") — string contains substring`);
      }
    }

    // Pattern 5: Hardcoded value tested against itself via variable
    // e.g., const x = "foo"; expect(x).not.toBe("foo")
    // (limited: single-line const + expect in nearby lines)
    const constMatch = line.match(/(?:const|let)\s+(\w+)\s*=\s*([^;]+)/);
    if (constMatch) {
      const [, varName, value] = constMatch;
      // Look ahead 5 lines for not.toBe with same value
      for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
        const ahead = lines[j].trim();
        const varNotMatch = ahead.match(new RegExp(`expect\\(${varName}\\)\\.not\\.toBe\\((.+?)\\)`));
        if (varNotMatch && normalize(varNotMatch[1]) === normalize(value.trim())) {
          issues.push(`L${j + 1}: expect(${varName}).not.toBe(${varNotMatch[1]}) — ${varName} is defined as ${value.trim()} on L${lineNum}`);
        }
      }
    }

    // Pattern 6: expect(x.prop).not.toBe(x.prop) — same property access
    const propNotMatch = line.match(/expect\((\w+\.\w+(?:\.\w+)*)\)\.not\.toBe\((\w+\.\w+(?:\.\w+)*)\)/);
    if (propNotMatch) {
      const [, a, b] = propNotMatch;
      if (a === b) {
        issues.push(`L${lineNum}: expect(${a}).not.toBe(${b}) — same property, always fails`);
      }
    }
  }

  return issues;
}

/** Normalize a value string for comparison (trim quotes, whitespace) */
function normalize(s: string): string {
  return s.trim().replace(/^["'`]|["'`]$/g, '').trim();
}

/**
 * Run a verification chain. Stops at first failure.
 * Returns all results (passed + the first failure if any).
 */
export async function runVerifyChain(chain: VerifyChain, ctx: StateContext): Promise<{
  allPassed: boolean;
  results: GuardResult[];
  failedAt?: string;
}> {
  const results: GuardResult[] = [];

  for (const check of chain.checks) {
    const result = await check.run(ctx);
    results.push(result);
    console.log(`    [${chain.name}] ${result.name}: ${result.ok ? '✓' : '✗'} ${result.detail.split('\n')[0]}`);

    if (!result.ok) {
      return { allPassed: false, results, failedAt: check.name };
    }
  }

  return { allPassed: true, results };
}
