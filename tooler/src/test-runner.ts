import { execSync } from 'child_process';
import type { TestResult, TestFailure, ToolerConfig } from './types.js';
import { trace } from './trace.js';

export class TestRunner {
  private appDir: string;
  private unitCmd: string;
  private e2eCmd: string;

  constructor(config: ToolerConfig) {
    this.appDir = config.appDir;
    this.unitCmd = config.unitTestCommand;
    this.e2eCmd = config.testCommand;
  }

  runUnit(testFile?: string): TestResult {
    const cmd = testFile
      ? `${this.unitCmd} --run ${testFile}`
      : `${this.unitCmd} --run`;
    return this.execAndTrace(cmd, testFile);
  }

  runAll(): TestResult {
    return this.execAndTrace(`${this.unitCmd} --run`);
  }

  runE2e(testFile?: string): TestResult {
    const cmd = testFile ? `${this.e2eCmd} ${testFile}` : this.e2eCmd;
    return this.execAndTrace(cmd, testFile);
  }

  checkCompiles(file: string): { ok: boolean; error: string } {
    try {
      execSync(
        `npx esbuild ${file} --bundle --platform=browser --jsx=automatic --outfile=/dev/null --external:react --external:react-dom --external:vitest --external:@testing-library/*`,
        { cwd: this.appDir, encoding: 'utf-8', timeout: 15_000, stdio: ['pipe', 'pipe', 'pipe'] }
      );
      return { ok: true, error: '' };
    } catch (esbuildErr: any) {
      const esbuildOutput = (esbuildErr.stderr || '') + (esbuildErr.stdout || '');
      if (esbuildOutput.includes('error')) {
        return { ok: false, error: this.truncate(esbuildOutput, 500) };
      }
    }
    try {
      execSync(`npx tsc --noEmit --skipLibCheck ${file}`, {
        cwd: this.appDir, encoding: 'utf-8', timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { ok: true, error: '' };
    } catch (e: any) {
      return { ok: false, error: this.truncate((e.stdout || '') + (e.stderr || ''), 500) };
    }
  }

  private execAndTrace(cmd: string, testFile?: string): TestResult {
    trace.emit('test_run', { cmd, testFile });

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
    const result: TestResult = {
      passed,
      ...parsed,
      output: this.truncate(output, 3000),
    };

    // ── Trace: test result ─────────────────────────────────
    trace.emit('test_result', {
      passed: result.passed,
      totalTests: result.totalTests,
      passedTests: result.passedTests,
      failedTests: result.failedTests,
      output: result.output,
    });

    // ── Trace: error details on failure ────────────────────
    if (!passed) {
      const details = this.extractErrorDetails(output);
      if (details.length > 0) {
        trace.emit('test_error_detail', { details });
      }
    }

    return result;
  }

  /**
   * Deep error extraction — pulls structured failure info from vitest output.
   * Returns array of human-readable error descriptions.
   */
  private extractErrorDetails(output: string): string[] {
    const details: string[] = [];
    const lines = output.split('\n');

    // ── Pattern 1: Vitest assertion blocks ─────────────────
    // "FAIL src/__tests__/foo.test.ts > describe > it"
    // "AssertionError: expected X to equal Y"
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Test name line
      if (line.match(/^\s*[×✗✕]\s+/) || line.match(/FAIL\s/)) {
        const testName = line.replace(/^\s*[×✗✕]\s+/, '').replace(/FAIL\s+/, '').trim();
        // Grab next lines for context (up to 8 lines or next test)
        const context: string[] = [testName];
        for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
          const cl = lines[j];
          if (cl.match(/^\s*[×✗✕✓✔]\s+/) || cl.match(/^\s*$/)) break;
          context.push(cl.trim());
        }
        details.push(context.join('\n'));
      }
    }

    // ── Pattern 2: "Expected" / "Received" blocks ──────────
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('Expected') && i + 1 < lines.length && lines[i + 1].includes('Received')) {
        details.push(
          lines[i].trim() + '\n' + lines[i + 1].trim()
        );
      }
    }

    // ── Pattern 3: Error/TypeError with stack line ─────────
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.match(/(TypeError|ReferenceError|SyntaxError|Error):/)) {
        const errMsg = line.trim();
        // Grab first stack frame with file:line
        let location = '';
        for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
          const stackMatch = lines[j].match(/at\s+.*\((.+:\d+:\d+)\)/);
          if (stackMatch) {
            location = stackMatch[1];
            break;
          }
          // Also catch "src/foo.ts:12:5" style
          const directMatch = lines[j].match(/(src\/\S+:\d+:\d+)/);
          if (directMatch) {
            location = directMatch[1];
            break;
          }
        }
        details.push(location ? `${errMsg} @ ${location}` : errMsg);
      }
    }

    // ── Pattern 4: Module resolution failures ──────────────
    for (const line of lines) {
      if (line.includes('Cannot find module') || line.includes('Module not found') || line.includes('Failed to resolve import')) {
        details.push(line.trim());
      }
    }

    // ── Pattern 5: "not defined" / "not a function" ────────
    for (const line of lines) {
      if (line.includes('is not defined') || line.includes('is not a function')) {
        details.push(line.trim());
      }
    }

    // Deduplicate
    return [...new Set(details)].slice(0, 20);
  }

  private parseOutput(output: string): {
    totalTests: number;
    failedTests: number;
    passedTests: number;
    errorSummary: string;
    failures: TestFailure[];
  } {
    const totalMatch = output.match(/Tests\s+(\d+)\s/);
    const failedMatch = output.match(/(\d+)\s+failed/);
    const passedMatch = output.match(/(\d+)\s+passed/);

    const total = totalMatch ? parseInt(totalMatch[1]) : 0;
    const failed = failedMatch ? parseInt(failedMatch[1]) : 0;
    const passedCount = passedMatch ? parseInt(passedMatch[1]) : 0;

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

    // Error summary — key lines for model
    const errorLines = output.split('\n')
      .filter(l =>
        l.includes('Error') || l.includes('FAIL') || l.includes('expect(') ||
        l.includes('Expected') || l.includes('Received') || l.includes('TypeError') ||
        l.includes('Cannot find') || l.includes('not defined') || l.includes('not a function') ||
        l.includes('Module not found') || l.includes('Failed to resolve')
      )
      .slice(0, 20);

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
