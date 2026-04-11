import type { TestResult, TestFailure, ToolerConfig } from './types.js';
import { ScriptManager } from './project-scripts.js';
import { trace } from './trace.js';

export class TestRunner {
  private scripts: ScriptManager;
  private appDir: string;

  constructor(config: ToolerConfig) {
    this.appDir = config.appDir;
    this.scripts = new ScriptManager(config.appDir);
  }

  getScriptManager(): ScriptManager {
    return this.scripts;
  }

  runUnit(testFile?: string): TestResult {
    const result = this.scripts.run('test', testFile);
    return this.toTestResult(result.ok, result.output);
  }

  runAll(): TestResult {
    const result = this.scripts.run('testAll');
    return this.toTestResult(result.ok, result.output);
  }

  runE2e(testFile?: string): TestResult {
    const result = this.scripts.run('e2e', testFile);
    return this.toTestResult(result.ok, result.output);
  }

  checkCompiles(file: string): { ok: boolean; error: string } {
    const result = this.scripts.run('compile', file);
    return {
      ok: result.ok,
      error: result.ok ? '' : this.truncate(result.output, 500),
    };
  }

  private toTestResult(passed: boolean, output: string): TestResult {
    const parsed = this.parseOutput(output);
    const result: TestResult = {
      passed,
      ...parsed,
      output: this.truncate(output, 3000),
    };

    trace.emit('test_result', {
      passed: result.passed,
      totalTests: result.totalTests,
      passedTests: result.passedTests,
      failedTests: result.failedTests,
      output: result.output,
    });

    if (!passed) {
      const details = this.extractErrorDetails(output);
      if (details.length > 0) {
        trace.emit('test_error_detail', { details });
      }
    }

    return result;
  }

  private extractErrorDetails(output: string): string[] {
    const details: string[] = [];
    const lines = output.split('\n');

    // Vitest/Jest assertion blocks
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.match(/^\s*[×✗✕]\s+/) || line.match(/FAIL\s/)) {
        const testName = line.replace(/^\s*[×✗✕]\s+/, '').replace(/FAIL\s+/, '').trim();
        const context: string[] = [testName];
        for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
          const cl = lines[j];
          if (cl.match(/^\s*[×✗✕✓✔]\s+/) || cl.match(/^\s*$/)) break;
          context.push(cl.trim());
        }
        details.push(context.join('\n'));
      }
    }

    // Expected/Received
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('Expected') && i + 1 < lines.length && lines[i + 1].includes('Received')) {
        details.push(lines[i].trim() + '\n' + lines[i + 1].trim());
      }
    }

    // Error types with stack
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.match(/(TypeError|ReferenceError|SyntaxError|Error):/)) {
        const errMsg = line.trim();
        let location = '';
        for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
          const stackMatch = lines[j].match(/at\s+.*\((.+:\d+:\d+)\)/);
          if (stackMatch) { location = stackMatch[1]; break; }
          const directMatch = lines[j].match(/(src\/\S+:\d+:\d+)/);
          if (directMatch) { location = directMatch[1]; break; }
        }
        details.push(location ? `${errMsg} @ ${location}` : errMsg);
      }
    }

    // Module resolution
    for (const line of lines) {
      if (line.includes('Cannot find module') || line.includes('Module not found') || line.includes('Failed to resolve import')) {
        details.push(line.trim());
      }
    }

    // Not defined / not a function
    for (const line of lines) {
      if (line.includes('is not defined') || line.includes('is not a function')) {
        details.push(line.trim());
      }
    }

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
