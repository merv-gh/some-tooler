import type { StateContext, Task, GuardResult, ToolerConfig } from './types.js';
import { createGuards, runVerifyChain } from './guards.js';
import { OllamaClient } from './ollama.js';
import { TestRunner } from './test-runner.js';
import {
  SYSTEM_PROMPT,
  promptWriteTest,
  promptFixTest,
  promptImplement,
  promptFixImplementation,
  promptRefactor,
  promptFixInsaneTest,
} from './prompts.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'fs';
import { dirname, join } from 'path';
import { trace } from './trace.js';

// ═══════════════════════════════════════════════════════════════
// Context
// ═══════════════════════════════════════════════════════════════

interface MachineContext {
  task: Task;
  config: ToolerConfig;
  attempt: number;
  phaseAttempts: Record<string, number>;
  totalAttempts: number;
  lastTestResult: any;
  lastModelOutput: string;
  lastGuardResults: GuardResult[];
  existingCode: Record<string, string>;
  history: Array<{ phase: string; action: string; timestamp: number }>;
  failReason: string;
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

function loadExistingCode(task: Task, appDir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const paths = [task.testFile, task.sourceFile, ...(task.filesToModify || [])];
  for (const p of paths) {
    if (!p) continue;
    const full = join(appDir, p);
    if (existsSync(full)) {
      try { files[p] = readFileSync(full, 'utf-8'); } catch { /* skip */ }
    }
  }
  return files;
}

function applyCode(modelOutput: string, task: Task, appDir: string, phase: string): number {
  const blocks = OllamaClient.extractCode(modelOutput);
  let applied = 0;
  for (const block of blocks) {
    let targetFile = block.filename;
    if (!targetFile) {
      targetFile = (phase === 'writeTest' || phase === 'fixTest') ? task.testFile : task.sourceFile;
    }
    if (!targetFile) continue;
    const fullPath = join(appDir, targetFile);
    const dir = dirname(fullPath);

    // Capture previous content for diff
    const isNew = !existsSync(fullPath);
    let prevContent = '';
    if (!isNew) {
      try { prevContent = readFileSync(fullPath, 'utf-8'); } catch { /* skip */ }
    }

    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(fullPath, block.code, 'utf-8');

    // Compute simple diff stats
    const prevLines = prevContent ? prevContent.split('\n') : [];
    const newLines = block.code.split('\n');
    const added = newLines.filter(l => !prevLines.includes(l)).length;
    const removed = prevLines.filter(l => !newLines.includes(l)).length;

    // Build unified-ish diff for UI
    let diff = '';
    if (!isNew && prevContent !== block.code) {
      diff = buildSimpleDiff(prevContent, block.code, targetFile);
    }

    trace.emit('code_apply', {
      file: targetFile,
      chars: block.code.length,
      isNew,
      added,
      removed,
      diff,
      content: isNew ? block.code : undefined,
    });

    if (diff) {
      trace.emit('file_diff', { file: targetFile, added, removed, diff });
    }

    applied++;
  }
  return applied;
}

function buildSimpleDiff(prev: string, next: string, filename: string): string {
  const pLines = prev.split('\n');
  const nLines = next.split('\n');
  const lines: string[] = [`--- a/${filename}`, `+++ b/${filename}`];

  // Simple line-by-line diff (not optimal, but readable)
  const maxLen = Math.max(pLines.length, nLines.length);
  for (let i = 0; i < maxLen; i++) {
    const pLine = pLines[i];
    const nLine = nLines[i];
    if (pLine === nLine) {
      lines.push(` ${pLine ?? ''}`);
    } else {
      if (pLine !== undefined) lines.push(`-${pLine}`);
      if (nLine !== undefined) lines.push(`+${nLine}`);
    }
  }
  // Truncate long diffs
  if (lines.length > 100) {
    return lines.slice(0, 80).join('\n') + `\n... (${lines.length - 80} more lines)`;
  }
  return lines.join('\n');
}

function toStateCtx(ctx: MachineContext): StateContext {
  return {
    task: ctx.task,
    phase: 'writeTest',
    attempt: ctx.attempt,
    phaseAttempts: ctx.phaseAttempts as any,
    lastTestResult: ctx.lastTestResult,
    lastModelOutput: ctx.lastModelOutput,
    lastGuardResults: ctx.lastGuardResults,
    existingCode: ctx.existingCode,
    history: ctx.history as any,
  };
}

function logResult(config: ToolerConfig, task: Task, success: boolean, reason?: string, history?: any[]) {
  if (!existsSync(config.logDir)) mkdirSync(config.logDir, { recursive: true });
  const entry = JSON.stringify({
    taskId: task.id, title: task.title, success, reason, history,
    timestamp: new Date().toISOString(),
  }) + '\n';
  appendFileSync(join(config.logDir, 'results.jsonl'), entry, 'utf-8');
}

// ═══════════════════════════════════════════════════════════════
// Machine runner
// ═══════════════════════════════════════════════════════════════

type Phase = 'writeTest' | 'verifyRed' | 'implement' | 'verifyGreen' | 'refactor' | 'verifyRefactor' | 'done' | 'skipped';

export async function runTaskWithMachine(
  config: ToolerConfig,
  task: Task
): Promise<{ success: boolean; skipped: boolean; reason?: string }> {

  const runner = new TestRunner(config);
  const ollama = new OllamaClient(config);
  const g = createGuards(config, runner);

  trace.setTask(task.id);
  trace.emit('task_start', { title: task.title, description: task.description });

  const ctx: MachineContext = {
    task,
    config,
    attempt: 0,
    phaseAttempts: {},
    totalAttempts: 0,
    lastTestResult: null,
    lastModelOutput: '',
    lastGuardResults: [],
    existingCode: loadExistingCode(task, config.appDir),
    history: [],
    failReason: '',
  };

  // Use `string` to prevent TS narrowing issues when enterPhase() reassigns
  let phase = 'writeTest' as string;

  function bumpPhase(p: string) {
    ctx.phaseAttempts[p] = (ctx.phaseAttempts[p] || 0) + 1;
    ctx.totalAttempts++;
  }

  function canRetry(p: string): boolean {
    return (ctx.phaseAttempts[p] || 0) < config.maxAttemptsPerPhase
      && ctx.totalAttempts < config.maxAttemptsPerTask;
  }

  function record(action: string) {
    ctx.history.push({ phase, action, timestamp: Date.now() });
  }

  function refresh() {
    ctx.existingCode = loadExistingCode(task, config.appDir);
  }

  function enterPhase(p: string) {
    phase = p;
    trace.setPhase(p);
    const attempt = (ctx.phaseAttempts[p] || 0) + 1;
    trace.emit('phase_enter', { phase: p, attempt, maxAttempts: config.maxAttemptsPerPhase });
  }

  function exitPhase(nextPhase: string, reason?: string) {
    trace.emit('phase_exit', { phase, nextPhase, reason });
  }

  // ── State loop ─────────────────────────────────────────────
  enterPhase('writeTest');

  while (phase !== 'done' && phase !== 'skipped') {

    switch (phase) {

      // ── WRITE TEST ───────────────────────────────────────
      case 'writeTest': {
        try {
          const sctx = toStateCtx(ctx);
          const isRetry = (ctx.phaseAttempts['writeTest'] || 0) > 0;
          const sanityFail = ctx.lastGuardResults.find(r => r.name === 'test-sanity' && !r.ok);

          let prompt: string;
          let promptType: string;
          if (sanityFail) {
            prompt = promptFixInsaneTest(sctx, sanityFail.detail);
            promptType = 'fixInsaneTest';
          } else if (isRetry) {
            prompt = promptFixTest(sctx);
            promptType = 'fixTest';
          } else {
            prompt = promptWriteTest(sctx);
            promptType = 'writeTest';
          }

          trace.emit('model_request', { promptType, promptChars: prompt.length, prompt });

          const response = await ollama.generate(prompt, SYSTEM_PROMPT);
          ctx.lastModelOutput = response.content;

          trace.emit('model_done', {
            outputChars: response.content.length,
            codeBlocks: (response.content.match(/```/g) || []).length / 2,
            elapsed: '?',
            finishReason: '?',
            output: response.content,
          });

          if (!response.content || response.content.trim().length < 10) {
            trace.emit('model_empty', { reason: 'Output too short', rawLength: response.content.length });
            throw new Error('Model output empty/too short');
          }

          const applied = applyCode(response.content, task, config.appDir, 'writeTest');
          if (applied === 0) throw new Error('No code blocks produced');

          refresh();
          record('wrote test');
          exitPhase('verifyRed');
          enterPhase('verifyRed');
        } catch (err: any) {
          trace.emit('error', { message: err.message, phase: 'writeTest' });
          bumpPhase('writeTest');
          record(`error: ${err.message}`);
          if (!canRetry('writeTest')) {
            ctx.failReason = `writeTest failed after ${ctx.phaseAttempts['writeTest']} attempts: ${err.message}`;
            exitPhase('skipped', ctx.failReason);
            phase = 'skipped';
          } else {
            trace.emit('retry', { phase: 'writeTest', reason: err.message, attempt: ctx.phaseAttempts['writeTest'] });
            enterPhase('writeTest');
          }
        }
        break;
      }

      // ── VERIFY RED ───────────────────────────────────────
      case 'verifyRed': {
        const sctx = toStateCtx(ctx);
        const result = await runVerifyChain(g.chains.verifyRedChain, sctx);
        ctx.lastGuardResults = result.results;
        ctx.lastTestResult = sctx.lastTestResult;

        // Emit each guard result for UI
        for (const gr of result.results) {
          trace.emit('guard_result', { name: gr.name, ok: gr.ok, detail: gr.detail });
        }

        record(`verifyRed: ${result.allPassed ? 'PASS' : `FAIL@${result.failedAt}`}`);

        if (result.allPassed) {
          exitPhase('implement', 'RED confirmed');
          ctx.phaseAttempts['writeTest'] = 0;
          enterPhase('implement');
        } else if (result.failedAt === 'tests-fail') {
          exitPhase('refactor', 'tests already pass');
          enterPhase('refactor');
        } else {
          bumpPhase('writeTest');
          if (canRetry('writeTest')) {
            trace.emit('retry', { phase: 'writeTest', reason: `verifyRed failed at ${result.failedAt}`, attempt: ctx.phaseAttempts['writeTest'] });
            enterPhase('writeTest');
          } else {
            ctx.failReason = `verifyRed failed at ${result.failedAt} after retries`;
            exitPhase('skipped', ctx.failReason);
            phase = 'skipped';
          }
        }
        break;
      }

      // ── IMPLEMENT ────────────────────────────────────────
      case 'implement': {
        try {
          const sctx = toStateCtx(ctx);
          const isRetry = (ctx.phaseAttempts['implement'] || 0) > 0;
          const prompt = isRetry ? promptFixImplementation(sctx) : promptImplement(sctx);
          const promptType = isRetry ? 'fixImplementation' : 'implement';

          trace.emit('model_request', { promptType, promptChars: prompt.length, prompt });

          const response = await ollama.generate(prompt, SYSTEM_PROMPT);
          ctx.lastModelOutput = response.content;

          trace.emit('model_done', {
            outputChars: response.content.length,
            codeBlocks: (response.content.match(/```/g) || []).length / 2,
            output: response.content,
          });

          if (!response.content || response.content.trim().length < 10) {
            trace.emit('model_empty', { reason: 'Output too short', rawLength: response.content.length });
            throw new Error('Model output empty/too short');
          }

          const applied = applyCode(response.content, task, config.appDir, 'implement');
          if (applied === 0) throw new Error('No code blocks produced');

          refresh();
          record('wrote implementation');
          exitPhase('verifyGreen');
          enterPhase('verifyGreen');
        } catch (err: any) {
          trace.emit('error', { message: err.message, phase: 'implement' });
          bumpPhase('implement');
          record(`error: ${err.message}`);
          if (!canRetry('implement')) {
            ctx.failReason = `implement failed after ${ctx.phaseAttempts['implement']} attempts: ${err.message}`;
            exitPhase('skipped', ctx.failReason);
            phase = 'skipped';
          } else {
            trace.emit('retry', { phase: 'implement', reason: err.message, attempt: ctx.phaseAttempts['implement'] });
            enterPhase('implement');
          }
        }
        break;
      }

      // ── VERIFY GREEN ─────────────────────────────────────
      case 'verifyGreen': {
        const sctx = toStateCtx(ctx);
        const result = await runVerifyChain(g.chains.verifyGreenChain, sctx);
        ctx.lastGuardResults = result.results;
        ctx.lastTestResult = sctx.lastTestResult;

        for (const gr of result.results) {
          trace.emit('guard_result', { name: gr.name, ok: gr.ok, detail: gr.detail });
        }

        record(`verifyGreen: ${result.allPassed ? 'PASS' : `FAIL@${result.failedAt}`}`);

        if (result.allPassed) {
          exitPhase('refactor', 'GREEN confirmed');
          ctx.phaseAttempts['implement'] = 0;
          enterPhase('refactor');
        } else {
          bumpPhase('implement');
          if (canRetry('implement')) {
            trace.emit('retry', { phase: 'implement', reason: `verifyGreen failed at ${result.failedAt}`, attempt: ctx.phaseAttempts['implement'] });
            enterPhase('implement');
          } else {
            ctx.failReason = `verifyGreen failed at ${result.failedAt} after retries`;
            exitPhase('skipped', ctx.failReason);
            phase = 'skipped';
          }
        }
        break;
      }

      // ── REFACTOR ─────────────────────────────────────────
      case 'refactor': {
        try {
          const sctx = toStateCtx(ctx);
          const prompt = promptRefactor(sctx);
          trace.emit('model_request', { promptType: 'refactor', promptChars: prompt.length, prompt });

          const response = await ollama.generate(prompt, SYSTEM_PROMPT);
          ctx.lastModelOutput = response.content;

          trace.emit('model_done', { outputChars: response.content.length, output: response.content });

          if (response.content.includes('NO_REFACTOR_NEEDED')) {
            record('no refactor');
            exitPhase('done', 'no refactor needed');
            phase = 'done';
          } else {
            const applied = applyCode(response.content, task, config.appDir, 'refactor');
            if (applied === 0) {
              record('empty refactor');
              exitPhase('done', 'no code in refactor');
              phase = 'done';
            } else {
              refresh();
              record('wrote refactor');
              exitPhase('verifyRefactor');
              enterPhase('verifyRefactor');
            }
          }
        } catch (err: any) {
          trace.emit('error', { message: err.message, phase: 'refactor' });
          record(`refactor error: ${err.message}`);
          exitPhase('done', 'refactor error, accepting pre-refactor');
          phase = 'done';
        }
        break;
      }

      // ── VERIFY REFACTOR ──────────────────────────────────
      case 'verifyRefactor': {
        const sctx = toStateCtx(ctx);
        const result = await runVerifyChain(g.chains.verifyRefactorChain, sctx);

        for (const gr of result.results) {
          trace.emit('guard_result', { name: gr.name, ok: gr.ok, detail: gr.detail });
        }

        record(`verifyRefactor: ${result.allPassed ? 'PASS' : `FAIL@${result.failedAt}`}`);
        exitPhase('done', result.allPassed ? 'refactor verified' : 'refactor broke tests, accepting pre-refactor');
        phase = 'done';
        break;
      }
    }
  }

  // ── Terminal ─────────────────────────────────────────────
  const success = phase === 'done';
  if (success) {
    trace.emit('task_done', { taskId: task.id });
  } else {
    trace.emit('task_skip', { taskId: task.id, reason: ctx.failReason });
  }
  logResult(config, task, success, success ? undefined : ctx.failReason, ctx.history);

  return { success, skipped: !success, reason: success ? undefined : ctx.failReason };
}
