import { execSync } from 'child_process';
import type { TestResult, TestFailure, ToolerConfig } from './types.js';

export class TestRunner {
  private appDir: string;
  private unitCmd: string;
  private e2eCmd: string;

  constructor(config: ToolerConfig) {
    this.appDir = config.appDir;
    this.unitCmd = config.unitTestCommand;
    this.e2eCmd = config.testCommand;
  }

  /** Run vitest on specific test file */
  runUnit(testFile?: string): TestResult {
    const cmd = testFile
      ? `${this.unitCmd} --run ${testFile}`
      : `${this.unitCmd} --run`;
    return this.exec(cmd);
  }

  /** Run full test suite */
  runAll(): TestResult {
    return this.exec(`${this.unitCmd} --run`);
  }

  /** Run playwright e2e */
  runE2e(testFile?: string): TestResult {
    const cmd = testFile ? `${this.e2eCmd} ${testFile}` : this.e2eCmd;
    return this.exec(cmd);
  }

  /**
   * Fast compile check using esbuild (falls back to tsc).
   * esbuild is 10-100x faster than tsc for single-file checks.
   */
  checkCompiles(file: string): { ok: boolean; error: string } {
    // Try esbuild first (fast path)
    try {
      execSync(
        `npx esbuild ${file} --bundle --platform=browser --jsx=automatic --outfile=/dev/null --external:react --external:react-dom --external:vitest --external:@testing-library/*`,
        { cwd: this.appDir, encoding: 'utf-8', timeout: 15_000, stdio: ['pipe', 'pipe', 'pipe'] }
      );
      return { ok: true, error: '' };
    } catch (esbuildErr: any) {
      const esbuildOutput = (esbuildErr.stderr || '') + (esbuildErr.stdout || '');
      // If esbuild found real errors, return them
      if (esbuildOutput.includes('error')) {
        return { ok: false, error: this.truncate(esbuildOutput, 500) };
      }
    }

    // Fallback: tsc (slower but more accurate)
    try {
      execSync(`npx tsc --noEmit --skipLibCheck ${file}`, {
        cwd: this.appDir,
        encoding: 'utf-8',
        timeout: 30_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { ok: true, error: '' };
    } catch (e: any) {
      return { ok: false, error: this.truncate((e.stdout || '') + (e.stderr || ''), 500) };
    }
  }

  private exec(cmd: string): TestResult {
    let output = '';
    let passed = false;
    try {
      output = execSync(cmd, {
        cwd: this.appDir,
        encoding: 'utf-8',
        timeout: 90_000,
        env: { ...process.env, FORCE_COLOR: '0', CI: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      passed = true;
    } catch (e: any) {
      output = (e.stdout || '') + '\n' + (e.stderr || '');
      passed = false;
    }

    const parsed = this.parseOutput(output);
    return {
      passed,
      ...parsed,
      output: this.truncate(output, 2000),
    };
  }

  private parseOutput(output: string): {
    totalTests: number;
    failedTests: number;
    passedTests: number;
    errorSummary: string;
    failures: TestFailure[];
  } {
    // Vitest output patterns
    const totalMatch = output.match(/Tests\s+(\d+)\s/);
    const failedMatch = output.match(/(\d+)\s+failed/);
    const passedMatch = output.match(/(\d+)\s+passed/);

    const total = totalMatch ? parseInt(totalMatch[1]) : 0;
    const failed = failedMatch ? parseInt(failedMatch[1]) : 0;
    const passedCount = passedMatch ? parseInt(passedMatch[1]) : 0;

    // Parse individual failures
    const failures: TestFailure[] = [];
    const failRegex = /FAIL\s+(.+?)[\n\r][\s\S]*?Expected[:\s]+(.+?)[\n\r][\s\S]*?Received[:\s]+(.+?)[\n\r]/g;
    let fm;
    while ((fm = failRegex.exec(output)) !== null) {
      failures.push({
        testName: fm[1]?.trim() || '',
        expected: fm[2]?.trim() || '',
        received: fm[3]?.trim() || '',
        line: fm[0]?.trim() || '',
      });
    }

    // Error summary — key lines for model feedback
    const errorLines = output
      .split('\n')
      .filter(l =>
        l.includes('Error') ||
        l.includes('FAIL') ||
        l.includes('expect(') ||
        l.includes('Expected') ||
        l.includes('Received') ||
        l.includes('TypeError') ||
        l.includes('Cannot find') ||
        l.includes('not defined') ||
        l.includes('not a function') ||
        l.includes('Module not found')
      )
      .slice(0, 15);

    return {
      totalTests: total || (failed + passedCount),
      failedTests: failed,
      passedTests: passedCount,
      errorSummary: errorLines.join('\n'),
      failures,
    };
  }

  private truncate(s: string, max: number): string {
    if (s.length <= max) return s;
    const half = Math.floor(max / 2);
    return s.slice(0, half) + '\n...[truncated]...\n' + s.slice(-half);
  }
}
