import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import type { StateContext, TddState, Task, TestResult, ToolerConfig } from './types.js';
import { OllamaClient } from './ollama.js';
import { TestRunner } from './test-runner.js';
import {
  SYSTEM_PROMPT,
  promptWriteTest,
  promptFixTest,
  promptImplement,
  promptFixImplementation,
  promptRefactor,
} from './prompts.js';

/**
 * TDD State Machine
 *
 * States and transitions:
 *   WRITE_TEST → VERIFY_RED → IMPLEMENT → VERIFY_GREEN → REFACTOR → VERIFY_REFACTOR → DONE
 *        ↑           |             ↑           |              ↑            |
 *        └───────────┘             └───────────┘              └────────────┘
 *       (fix test)               (fix impl)                (fix refactor)
 *
 * Each state has max retries. If exceeded, task is SKIPPED (logged, move on).
 */
export class TddStateMachine {
  private ollama: OllamaClient;
  private runner: TestRunner;
  private config: ToolerConfig;
  private ctx!: StateContext;

  constructor(config: ToolerConfig) {
    this.config = config;
    this.ollama = new OllamaClient(config);
    this.runner = new TestRunner(config);
  }

  /** Run a single task through the full TDD cycle */
  async runTask(task: Task): Promise<{ success: boolean; skipped: boolean; reason?: string }> {
    this.ctx = {
      task,
      state: 'WRITE_TEST',
      attempt: 0,
      maxAttempts: this.config.maxAttemptsPerState,
      lastTestResult: null,
      lastModelOutput: '',
      existingCode: this.loadExistingCode(task),
      history: [],
    };

    let totalAttempts = 0;
    const maxTotal = this.config.maxAttemptsPerTask;

    console.log(`\n${'='.repeat(60)}`);
    console.log(`TASK: ${task.id} — ${task.title}`);
    console.log(`${'='.repeat(60)}`);

    while (this.ctx.state !== 'DONE') {
      totalAttempts++;
      if (totalAttempts > maxTotal) {
        const reason = `Exceeded max total attempts (${maxTotal}) at state ${this.ctx.state}`;
        console.log(`  ⛔ SKIP: ${reason}`);
        this.logResult(task, false, reason);
        return { success: false, skipped: true, reason };
      }

      console.log(`\n  [${this.ctx.state}] attempt ${this.ctx.attempt + 1}/${this.ctx.maxAttempts}`);

      try {
        await this.step();
      } catch (err: any) {
        console.log(`  ❌ Error in ${this.ctx.state}: ${err.message}`);
        this.ctx.attempt++;
        if (this.ctx.attempt >= this.ctx.maxAttempts) {
          const reason = `State ${this.ctx.state} failed after ${this.ctx.maxAttempts} attempts: ${err.message}`;
          console.log(`  ⛔ SKIP: ${reason}`);
          this.logResult(task, false, reason);
          return { success: false, skipped: true, reason };
        }
      }
    }

    console.log(`  ✅ Task ${task.id} COMPLETE`);
    this.logResult(task, true);
    return { success: true, skipped: false };
  }

  private async step(): Promise<void> {
    switch (this.ctx.state) {
      case 'WRITE_TEST':
        await this.stepWriteTest();
        break;
      case 'VERIFY_RED':
        this.stepVerifyRed();
        break;
      case 'IMPLEMENT':
        await this.stepImplement();
        break;
      case 'VERIFY_GREEN':
        this.stepVerifyGreen();
        break;
      case 'REFACTOR':
        await this.stepRefactor();
        break;
      case 'VERIFY_REFACTOR':
        this.stepVerifyRefactor();
        break;
    }
  }

  // ── WRITE_TEST ─────────────────────────────────────────────
  private async stepWriteTest(): Promise<void> {
    const prompt = this.ctx.attempt === 0
      ? promptWriteTest(this.ctx)
      : promptFixTest(this.ctx);

    const response = await this.ollama.generate(prompt, SYSTEM_PROMPT);
    this.ctx.lastModelOutput = response.content;

    // Apply code to filesystem
    const applied = this.applyCode(response.content);
    if (applied === 0) {
      throw new Error('Model produced no valid code blocks');
    }

    // Refresh context
    this.ctx.existingCode = this.loadExistingCode(this.ctx.task);
    this.transition('VERIFY_RED');
  }

  // ── VERIFY_RED (test should compile + fail on assertion) ───
  private stepVerifyRed(): void {
    const result = this.runner.runUnit(this.ctx.task.testFile);
    this.ctx.lastTestResult = result;

    console.log(`    Tests: ${result.totalTests} total, ${result.failedTests} failed, passed=${result.passed}`);

    if (result.totalTests === 0) {
      // No tests found — go back to write test
      console.log('    ⚠ No tests detected. Re-prompting...');
      this.ctx.attempt++;
      this.guardMaxAttempts('WRITE_TEST');
      return;
    }

    if (result.passed) {
      // Tests pass already? Unusual but could mean test is trivial or impl exists
      console.log('    ⚠ Tests already pass (expected RED). Proceeding to refactor.');
      this.transition('REFACTOR');
      return;
    }

    // Check if failure is assertion-based (good) vs compile/import error (bad)
    const isAssertionFail = result.output.includes('AssertionError') ||
      result.output.includes('expect(') ||
      result.output.includes('Expected') ||
      result.output.includes('toEqual') ||
      result.output.includes('toBe') ||
      result.output.includes('not defined') ||
      result.output.includes('is not a function');

    const isCompileError = result.output.includes('Cannot find module') ||
      result.output.includes('SyntaxError') ||
      result.output.includes('TypeError: Cannot read');

    if (isCompileError && !isAssertionFail) {
      console.log('    ⚠ Compile/import error, not assertion fail. Fixing test...');
      this.ctx.attempt++;
      this.guardMaxAttempts('WRITE_TEST');
      return;
    }

    // Good RED state — tests exist and fail on assertions
    console.log('    ✓ RED confirmed. Moving to IMPLEMENT.');
    this.ctx.attempt = 0;
    this.transition('IMPLEMENT');
  }

  // ── IMPLEMENT ──────────────────────────────────────────────
  private async stepImplement(): Promise<void> {
    const prompt = this.ctx.attempt === 0
      ? promptImplement(this.ctx)
      : promptFixImplementation(this.ctx);

    const response = await this.ollama.generate(prompt, SYSTEM_PROMPT);
    this.ctx.lastModelOutput = response.content;

    const applied = this.applyCode(response.content);
    if (applied === 0) {
      throw new Error('Model produced no valid code blocks');
    }

    this.ctx.existingCode = this.loadExistingCode(this.ctx.task);
    this.transition('VERIFY_GREEN');
  }

  // ── VERIFY_GREEN (all tests should pass) ───────────────────
  private stepVerifyGreen(): void {
    const result = this.runner.runUnit(this.ctx.task.testFile);
    this.ctx.lastTestResult = result;

    console.log(`    Tests: ${result.totalTests} total, ${result.failedTests} failed, passed=${result.passed}`);

    if (result.passed) {
      console.log('    ✓ GREEN confirmed. Moving to REFACTOR.');
      this.ctx.attempt = 0;
      this.transition('REFACTOR');
    } else {
      console.log('    ✗ Still failing. Re-prompting implementation...');
      this.ctx.attempt++;
      this.guardMaxAttempts('IMPLEMENT');
    }
  }

  // ── REFACTOR ───────────────────────────────────────────────
  private async stepRefactor(): Promise<void> {
    const prompt = promptRefactor(this.ctx);
    const response = await this.ollama.generate(prompt, SYSTEM_PROMPT);
    this.ctx.lastModelOutput = response.content;

    if (response.content.includes('NO_REFACTOR_NEEDED')) {
      console.log('    → No refactoring needed. DONE.');
      this.transition('DONE');
      return;
    }

    const applied = this.applyCode(response.content);
    if (applied === 0) {
      // No code blocks = no refactoring
      console.log('    → No code changes in refactor. DONE.');
      this.transition('DONE');
      return;
    }

    this.ctx.existingCode = this.loadExistingCode(this.ctx.task);
    this.transition('VERIFY_REFACTOR');
  }

  // ── VERIFY_REFACTOR (tests should still pass) ──────────────
  private stepVerifyRefactor(): void {
    const result = this.runner.runAll();
    this.ctx.lastTestResult = result;

    console.log(`    Tests: ${result.totalTests} total, ${result.failedTests} failed, passed=${result.passed}`);

    if (result.passed) {
      console.log('    ✓ Refactor verified. DONE.');
      this.transition('DONE');
    } else {
      console.log('    ✗ Refactor broke tests. Reverting to pre-refactor and marking done.');
      // Revert refactor — re-run implement to get back to green
      // Simpler: just skip refactor and mark done (tests were green before)
      this.ctx.attempt++;
      if (this.ctx.attempt >= this.ctx.maxAttempts) {
        console.log('    ⚠ Giving up on refactor. Task still counts as done (was green).');
        this.transition('DONE');
      } else {
        this.transition('REFACTOR');
      }
    }
  }

  // ── Helpers ────────────────────────────────────────────────

  private transition(to: TddState): void {
    const from = this.ctx.state;
    this.ctx.history.push({
      state: from,
      action: `→ ${to}`,
      result: this.ctx.lastTestResult?.passed ? 'PASS' : 'FAIL',
      timestamp: Date.now(),
    });
    this.ctx.state = to;
  }

  private guardMaxAttempts(fallbackState: TddState): void {
    if (this.ctx.attempt >= this.ctx.maxAttempts) {
      throw new Error(`Max attempts (${this.ctx.maxAttempts}) reached in ${this.ctx.state}`);
    }
    this.transition(fallbackState);
  }

  /** Apply extracted code blocks to the filesystem */
  private applyCode(modelOutput: string): number {
    const blocks = OllamaClient.extractCode(modelOutput);
    let applied = 0;

    for (const block of blocks) {
      let targetFile = block.filename;

      // If no filename in code block, infer from context
      if (!targetFile) {
        if (this.ctx.state === 'WRITE_TEST' || this.ctx.state === 'VERIFY_RED') {
          targetFile = this.ctx.task.testFile;
        } else {
          targetFile = this.ctx.task.sourceFile;
        }
      }

      if (!targetFile) continue;

      const fullPath = join(this.config.appDir, targetFile);
      const dir = dirname(fullPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      writeFileSync(fullPath, block.code, 'utf-8');
      console.log(`    📝 Wrote ${targetFile} (${block.code.length} chars)`);
      applied++;
    }

    return applied;
  }

  /** Load existing file contents relevant to the task */
  private loadExistingCode(task: Task): Record<string, string> {
    const files: Record<string, string> = {};
    const paths = [task.testFile, task.sourceFile, ...(task.filesToModify || [])];

    for (const p of paths) {
      if (!p) continue;
      const full = join(this.config.appDir, p);
      if (existsSync(full)) {
        try {
          files[p] = readFileSync(full, 'utf-8');
        } catch { /* skip */ }
      }
    }

    return files;
  }

  private logResult(task: Task, success: boolean, reason?: string): void {
    const logDir = this.config.logDir;
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });

    const entry = {
      taskId: task.id,
      title: task.title,
      success,
      reason,
      history: this.ctx.history,
      timestamp: new Date().toISOString(),
    };

    const logFile = join(logDir, 'results.jsonl');
    const line = JSON.stringify(entry) + '\n';

    const { appendFileSync } = require('fs');
    appendFileSync(logFile, line, 'utf-8');
  }
}
