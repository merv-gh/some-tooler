import { execSync } from 'child_process';
import type { TestResult, ToolerConfig } from './types.js';

export class TestRunner {
  private appDir: string;
  private unitCmd: string;
  private e2eCmd: string;

  constructor(config: ToolerConfig) {
    this.appDir = config.appDir;
    this.unitCmd = config.unitTestCommand;
    this.e2eCmd = config.testCommand;
  }

  /** Run vitest unit tests, return structured result */
  runUnit(testFile?: string): TestResult {
    const cmd = testFile
      ? `${this.unitCmd} --run ${testFile}`
      : `${this.unitCmd} --run`;
    return this.exec(cmd);
  }

  /** Run all tests */
  runAll(): TestResult {
    return this.exec(`${this.unitCmd} --run`);
  }

  /** Run playwright e2e tests */
  runE2e(testFile?: string): TestResult {
    const cmd = testFile
      ? `${this.e2eCmd} ${testFile}`
      : this.e2eCmd;
    return this.exec(cmd);
  }

  /** Check if a specific test file compiles (TypeScript check) */
  checkCompiles(file: string): { ok: boolean; error: string } {
    try {
      execSync(`npx tsc --noEmit ${file}`, {
        cwd: this.appDir,
        encoding: 'utf-8',
        timeout: 30_000,
      });
      return { ok: true, error: '' };
    } catch (e: any) {
      return { ok: false, error: e.stdout || e.message };
    }
  }

  private exec(cmd: string): TestResult {
    let output = '';
    let passed = false;
    try {
      output = execSync(cmd, {
        cwd: this.appDir,
        encoding: 'utf-8',
        timeout: 60_000,
        env: { ...process.env, FORCE_COLOR: '0', CI: '1' },
      });
      passed = true;
    } catch (e: any) {
      output = (e.stdout || '') + '\n' + (e.stderr || '');
      passed = false;
    }

    return {
      passed,
      ...this.parseOutput(output),
      output: this.truncate(output, 2000),
    };
  }

  private parseOutput(output: string): {
    totalTests: number;
    failedTests: number;
    newTestsAdded: boolean;
    errorSummary: string;
  } {
    // Vitest output parsing
    const totalMatch = output.match(/Tests\s+(\d+)\s/);
    const failedMatch = output.match(/(\d+)\s+failed/);
    const passedMatch = output.match(/(\d+)\s+passed/);

    const total = totalMatch ? parseInt(totalMatch[1]) : 0;
    const failed = failedMatch ? parseInt(failedMatch[1]) : 0;

    // Extract error lines for feedback
    const errorLines = output
      .split('\n')
      .filter(l =>
        l.includes('Error') ||
        l.includes('FAIL') ||
        l.includes('AssertionError') ||
        l.includes('expect(') ||
        l.includes('TypeError') ||
        l.includes('Cannot find') ||
        l.includes('not defined')
      )
      .slice(0, 10);

    return {
      totalTests: total,
      failedTests: failed,
      newTestsAdded: total > 0,
      errorSummary: errorLines.join('\n'),
    };
  }

  private truncate(s: string, max: number): string {
    if (s.length <= max) return s;
    const half = Math.floor(max / 2);
    return s.slice(0, half) + '\n...[truncated]...\n' + s.slice(-half);
  }
}
