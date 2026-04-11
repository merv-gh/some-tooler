import type { StateContext } from './types.js';

// ═══════════════════════════════════════════════════════════════
// SYSTEM PROMPT — shared across all phases
// ═══════════════════════════════════════════════════════════════

export const SYSTEM_PROMPT = `/no_think
You are a precise coding assistant. You write TypeScript/React code.

RULES:
1. Output ONLY code blocks. No explanations, no reasoning, no thinking.
2. Each code block MUST have the filename as the language tag:
   \`\`\`src/components/Foo.tsx
3. Write minimal, working code. No placeholders or TODOs.
4. Use existing imports and patterns from provided context.
5. Do NOT modify files you weren't asked to modify.
6. Do NOT wrap your response in <think> tags. Output code directly.

CRITICAL TEST RULES:
- Tests must be SATISFIABLE — a correct implementation must be able to make them pass.
- NEVER write expect(value).not.toBe(same_value) — that can never pass.
- NEVER write expect(true).toBe(false) — that's a contradiction.
- Tests should assert BEHAVIOR, not hardcoded identity.
- RED means: test compiles, runs, fails because implementation is missing/incomplete.
- RED does NOT mean: test has syntax errors, import failures, or logical contradictions.`;

// ═══════════════════════════════════════════════════════════════
// WRITE TEST (RED phase)
// ═══════════════════════════════════════════════════════════════

export function promptWriteTest(ctx: StateContext): string {
  const { task } = ctx;
  return `TASK: ${task.title}
${task.description}

TEST FILE: ${task.testFile}
SOURCE FILE: ${task.sourceFile}

WHAT TO TEST:
${task.testHint}

${formatExistingCode(ctx)}

Write a vitest test file for \`${task.testFile}\`.

Requirements:
- Import from the source file: \`${task.sourceFile}\`
- Use describe/it/expect from vitest
- Tests must be SATISFIABLE — a correct implementation CAN make them pass
- Each test should assert behavior: input → expected output
- Do NOT use .not.toBe() with the same value on both sides
- The tests should fail NOW because the implementation is missing/incomplete
- Include at least 2 distinct test cases

Output the complete test file as a single code block tagged with the filename.
If you need a stub source file so imports resolve, output that too (with minimal exports).`;
}

// ═══════════════════════════════════════════════════════════════
// FIX TEST (failed VERIFY_RED)
// ═══════════════════════════════════════════════════════════════

export function promptFixTest(ctx: StateContext): string {
  const { task, lastGuardResults } = ctx;
  const failedChecks = lastGuardResults
    .filter(r => !r.ok)
    .map(r => `[${r.name}] ${r.detail}`)
    .join('\n');

  return `The test file failed verification. Fix it.

TASK: ${task.title}
TEST FILE: ${task.testFile}
SOURCE FILE: ${task.sourceFile}

FAILED CHECKS:
${failedChecks}

${formatExistingCode(ctx)}

Fix the test file so that:
1. It compiles without errors
2. Imports resolve (create stub source file with minimal exports if needed)
3. It runs and finds test cases
4. Tests fail on ASSERTION (not compile/import error)
5. Tests are SATISFIABLE — a correct implementation can make them pass

Output fixed file(s) as code blocks tagged with filenames.`;
}

// ═══════════════════════════════════════════════════════════════
// FIX INSANE TEST (failed test-sanity guard)
// ═══════════════════════════════════════════════════════════════

export function promptFixInsaneTest(ctx: StateContext, sanityDetail: string): string {
  const { task } = ctx;

  return `CRITICAL: The test file contains LOGICALLY IMPOSSIBLE assertions that can never pass.

TASK: ${task.title}
TEST FILE: ${task.testFile}

DETECTED ISSUES:
${sanityDetail}

${formatExistingCode(ctx)}

These patterns are WRONG:
- expect(x).not.toBe(x) → always fails, no implementation can fix it
- expect(true).toBe(false) → boolean contradiction
- expect("str").not.toContain("str") → string contains itself

REWRITE the test to assert BEHAVIOR instead:
- Test that a function returns expected output for given input
- Test that a component renders expected content
- Test that data structures have expected properties
- Use .toBe(), .toEqual(), .toContain() POSITIVELY

The test should still FAIL because the implementation is missing, but it must be
POSSIBLE to make it pass with a correct implementation.

Output the complete rewritten test file as a code block tagged with the filename.`;
}

// ═══════════════════════════════════════════════════════════════
// IMPLEMENT (GREEN phase)
// ═══════════════════════════════════════════════════════════════

export function promptImplement(ctx: StateContext): string {
  const { task, lastTestResult } = ctx;

  return `TASK: ${task.title}
${task.description}

IMPLEMENTATION GUIDANCE:
${task.implementHint}

SOURCE FILE: ${task.sourceFile}
TEST FILE: ${task.testFile}

FAILING TESTS:
${lastTestResult?.errorSummary || 'Tests are failing'}

FULL TEST OUTPUT (truncated):
${lastTestResult?.output?.slice(0, 1500) || 'No output'}

${formatExistingCode(ctx)}

Write the MINIMAL implementation in \`${task.sourceFile}\` to make all tests pass.
- Do NOT change the test file
- Export everything the test imports
- Handle edge cases the tests check
- Use TypeScript strict types

Output the implementation as a code block tagged with the filename.
If other files need changes, include those too.`;
}

// ═══════════════════════════════════════════════════════════════
// FIX IMPLEMENTATION (failed VERIFY_GREEN)
// ═══════════════════════════════════════════════════════════════

export function promptFixImplementation(ctx: StateContext): string {
  const { task, lastTestResult, lastGuardResults } = ctx;
  const failedChecks = lastGuardResults
    .filter(r => !r.ok)
    .map(r => `[${r.name}] ${r.detail}`)
    .join('\n');

  return `Implementation isn't passing tests. Fix it.

TASK: ${task.title}
SOURCE FILE: ${task.sourceFile}

FAILED CHECKS:
${failedChecks}

TEST FAILURES:
${lastTestResult?.errorSummary || 'Unknown'}

FULL OUTPUT:
${lastTestResult?.output?.slice(0, 1500) || 'No output'}

${formatExistingCode(ctx)}

Fix \`${task.sourceFile}\` to make all tests pass.
- Do NOT modify the test file
- Focus on the specific errors above
- Keep changes minimal

Output only changed files as code blocks tagged with filenames.`;
}

// ═══════════════════════════════════════════════════════════════
// REFACTOR
// ═══════════════════════════════════════════════════════════════

export function promptRefactor(ctx: StateContext): string {
  const { task } = ctx;

  return `Tests are passing. Refactor for quality.

TASK: ${task.title}
SOURCE FILE: ${task.sourceFile}
TEST FILE: ${task.testFile}

${formatExistingCode(ctx)}

Refactor:
- Extract constants, improve naming
- Remove duplication
- Improve types (stricter, more descriptive)
- Keep ALL tests passing

If no meaningful refactoring needed, respond: NO_REFACTOR_NEEDED

Otherwise output refactored files as code blocks tagged with filenames.`;
}

// ═══════════════════════════════════════════════════════════════
// DIAGNOSIS-AWARE PROMPTS
// ═══════════════════════════════════════════════════════════════

import type { Diagnosis } from './diagnosis.js';

/** Fix test based on diagnosis (wrong API, bad assertion, etc) */
export function promptFixTestFromDiagnosis(ctx: StateContext, diagnosis: Diagnosis): string {
  const { task } = ctx;

  return `The test file has errors. Diagnosis: ${diagnosis.reason}

TASK: ${task.title}
TEST FILE: ${task.testFile}
SOURCE FILE: ${task.sourceFile}

ERROR SOURCE: TEST (the test code itself is wrong)
DIAGNOSIS: ${diagnosis.reason}
DETAILS:
${diagnosis.details.map(d => '- ' + d).join('\n')}

${formatExistingCode(ctx)}

Fix the test file:
- Use only vitest built-in matchers: toBe, toEqual, toContain, toHaveLength, toBeTruthy, toBeFalsy, toBeDefined, toBeUndefined, toBeNull, toThrow, toMatch, toHaveProperty, toBeGreaterThan, toBeLessThan
- Do NOT use jest-extended matchers (toBeNumber, toBeString, toBeArray, etc)
- Do NOT use chai-style assertions (assert., should., expect().to.be)
- Replace invalid matchers with vitest equivalents:
  * toBeNumber() → expect(typeof x).toBe('number')
  * toBeString() → expect(typeof x).toBe('string')
  * toBeArray() → expect(Array.isArray(x)).toBe(true)
  * toInclude() → toContain()
- Tests must still fail because implementation is incomplete (RED phase)

Output the fixed test file as a code block tagged with the filename.`;
}

/** Fix environment/config issue */
export function promptFixEnv(ctx: StateContext, diagnosis: Diagnosis): string {
  const { task } = ctx;

  return `There's an environment/configuration error preventing tests from running.

TASK: ${task.title}
TEST FILE: ${task.testFile}
SOURCE FILE: ${task.sourceFile}

ERROR: ${diagnosis.reason}
DETAILS:
${diagnosis.details.map(d => '- ' + d).join('\n')}

${formatExistingCode(ctx)}

Fix the environment issue:
- If a module is missing, add the import or create a stub file
- If a path is wrong, fix the import path
- If a config issue, fix the relevant config
- Do NOT change test logic or implementation logic

Output only the files that need changes as code blocks tagged with filenames.`;
}

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function formatExistingCode(ctx: StateContext): string {
  const entries = Object.entries(ctx.existingCode);
  if (entries.length === 0) return 'No existing code files yet.';

  return 'EXISTING CODE:\n' + entries
    .map(([file, content]) => `\`\`\`${file}\n${content}\n\`\`\``)
    .join('\n\n');
}
