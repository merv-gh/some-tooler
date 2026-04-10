import type { StateContext, Task } from './types.js';

/** System prompt — keeps the model focused and structured */
export const SYSTEM_PROMPT = `You are a precise coding assistant. You write TypeScript/React code.

RULES:
1. Output ONLY code blocks. No explanations unless asked.
2. Each code block must have the filename as the language tag: \`\`\`src/components/Foo.tsx
3. Write minimal, working code. No placeholders or TODOs.
4. Use existing imports and patterns from provided context.
5. Do NOT modify files you weren't asked to modify.
6. If you need to create a new file, output a code block with the full path.`;

/** Prompt: write a failing test (RED phase) */
export function promptWriteTest(ctx: StateContext): string {
  const { task } = ctx;
  const existingFiles = formatExistingCode(ctx);

  return `TASK: ${task.title}
${task.description}

TEST FILE: ${task.testFile}
SOURCE FILE: ${task.sourceFile}

WHAT TO TEST:
${task.testHint}

${existingFiles}

Write a vitest test file for ${task.testFile}.
The test MUST:
- Import from the source file (which doesn't exist yet or is incomplete)
- Use describe/it/expect from vitest
- Test the behavior described above
- Be specific with assertions (not just "toBeDefined")
- The test SHOULD FAIL because the implementation doesn't exist yet

Output the complete test file as a single code block tagged with the filename.`;
}

/** Prompt: fix a test that doesn't compile or has wrong structure */
export function promptFixTest(ctx: StateContext): string {
  const { task, lastTestResult } = ctx;
  const existingFiles = formatExistingCode(ctx);

  return `The test file needs fixing. It should compile and run, but FAIL on assertions (not on import/syntax errors).

TASK: ${task.title}
TEST FILE: ${task.testFile}

CURRENT TEST ERROR:
${lastTestResult?.errorSummary || lastTestResult?.output || 'Unknown error'}

${existingFiles}

Fix the test so it:
1. Compiles without errors
2. Imports resolve correctly (create stub source file if needed)
3. Runs but FAILS on assertion (this is expected - RED phase)

Output the fixed file(s) as code blocks tagged with filenames.`;
}

/** Prompt: implement code to make tests pass (GREEN phase) */
export function promptImplement(ctx: StateContext): string {
  const { task, lastTestResult } = ctx;
  const existingFiles = formatExistingCode(ctx);

  return `TASK: ${task.title}
${task.description}

IMPLEMENTATION GUIDANCE:
${task.implementHint}

SOURCE FILE: ${task.sourceFile}
TEST FILE: ${task.testFile}

FAILING TESTS:
${lastTestResult?.errorSummary || 'Tests are failing'}

FULL TEST OUTPUT:
${lastTestResult?.output?.slice(0, 1500) || 'No output'}

${existingFiles}

Write the MINIMAL implementation in ${task.sourceFile} to make all tests pass.
- Do NOT change the test file
- Import/export correctly
- Handle edge cases mentioned in tests
- Use React/TypeScript best practices

Output the implementation file as a code block tagged with the filename.
If other files need changes, include those too.`;
}

/** Prompt: fix failing implementation */
export function promptFixImplementation(ctx: StateContext): string {
  const { task, lastTestResult } = ctx;
  const existingFiles = formatExistingCode(ctx);

  return `The implementation isn't passing tests yet.

TASK: ${task.title}
SOURCE FILE: ${task.sourceFile}

TEST FAILURES:
${lastTestResult?.errorSummary || 'Unknown failures'}

FULL OUTPUT:
${lastTestResult?.output?.slice(0, 1500) || 'No output'}

${existingFiles}

Fix ${task.sourceFile} to make all tests pass.
- Do NOT modify the test file
- Focus on the specific errors shown above
- Keep changes minimal

Output only the files that need changes, as code blocks tagged with filenames.`;
}

/** Prompt: refactor after green (REFACTOR phase) */
export function promptRefactor(ctx: StateContext): string {
  const { task } = ctx;
  const existingFiles = formatExistingCode(ctx);

  return `Tests are passing. Now refactor for quality.

TASK: ${task.title}
SOURCE FILE: ${task.sourceFile}
TEST FILE: ${task.testFile}

${existingFiles}

Refactor the implementation (and tests if needed):
- Extract constants, improve naming
- Remove duplication
- Improve types
- Keep tests passing

If no meaningful refactoring is needed, respond with exactly: NO_REFACTOR_NEEDED

Otherwise output the refactored files as code blocks tagged with filenames.`;
}

function formatExistingCode(ctx: StateContext): string {
  const entries = Object.entries(ctx.existingCode);
  if (entries.length === 0) return '';

  return 'EXISTING CODE:\n' + entries
    .map(([file, content]) => `\`\`\`${file}\n${content}\n\`\`\``)
    .join('\n\n');
}
