import { setup, createActor, assign, fromPromise } from 'xstate';
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

// ═══════════════════════════════════════════════════════════════
// Context & Events
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
// Helpers (must be defined before machine uses them)
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
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(fullPath, block.code, 'utf-8');
    console.log(`    📝 Wrote ${targetFile} (${block.code.length} chars)`);
    applied++;
  }
  return applied;
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
// Machine runner — imperative loop using XState-style states
// (XState v5 setup().createMachine() has complex input typing;
//  we use the state pattern directly for robustness)
// ═══════════════════════════════════════════════════════════════

type Phase = 'writeTest' | 'verifyRed' | 'implement' | 'verifyGreen' | 'refactor' | 'verifyRefactor' | 'done' | 'skipped';

export async function runTaskWithMachine(
  config: ToolerConfig,
  task: Task
): Promise<{ success: boolean; skipped: boolean; reason?: string }> {

  const runner = new TestRunner(config);
  const ollama = new OllamaClient(config);
  const g = createGuards(config, runner);

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

  let phase: Phase = 'writeTest';

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

  // ── State loop ─────────────────────────────────────────────
  while (phase !== 'done' && phase !== 'skipped') {

    switch (phase) {

      // ── WRITE TEST ───────────────────────────────────────
      case 'writeTest': {
        console.log(`\n  ▸ WRITE_TEST [attempt ${(ctx.phaseAttempts['writeTest'] || 0) + 1}/${config.maxAttemptsPerPhase}]`);
        try {
          const sctx = toStateCtx(ctx);
          const isRetry = (ctx.phaseAttempts['writeTest'] || 0) > 0;
          const sanityFail = ctx.lastGuardResults.find(r => r.name === 'test-sanity' && !r.ok);

          let prompt: string;
          if (sanityFail) {
            prompt = promptFixInsaneTest(sctx, sanityFail.detail);
          } else if (isRetry) {
            prompt = promptFixTest(sctx);
          } else {
            prompt = promptWriteTest(sctx);
          }

          const response = await ollama.generate(prompt, SYSTEM_PROMPT);
          ctx.lastModelOutput = response.content;

          const applied = applyCode(response.content, task, config.appDir, 'writeTest');
          if (applied === 0) throw new Error('No code blocks produced');

          refresh();
          record('wrote test');
          phase = 'verifyRed';
        } catch (err: any) {
          console.log(`    ❌ ${err.message}`);
          bumpPhase('writeTest');
          record(`error: ${err.message}`);
          if (!canRetry('writeTest')) {
            ctx.failReason = `writeTest failed after ${ctx.phaseAttempts['writeTest']} attempts`;
            phase = 'skipped';
          }
        }
        break;
      }

      // ── VERIFY RED ───────────────────────────────────────
      case 'verifyRed': {
        console.log(`\n  ▸ VERIFY_RED`);
        const sctx = toStateCtx(ctx);
        const result = await runVerifyChain(g.chains.verifyRedChain, sctx);
        ctx.lastGuardResults = result.results;
        // Propagate test result from guard context
        ctx.lastTestResult = sctx.lastTestResult;
        record(`verifyRed: ${result.allPassed ? 'PASS' : `FAIL@${result.failedAt}`}`);

        if (result.allPassed) {
          console.log('    ✓ RED confirmed → IMPLEMENT');
          ctx.phaseAttempts['writeTest'] = 0;
          phase = 'implement';
        } else if (result.failedAt === 'tests-fail') {
          // Tests already pass — skip ahead
          console.log('    ⚠ Tests already pass → REFACTOR');
          phase = 'refactor';
        } else {
          bumpPhase('writeTest');
          if (canRetry('writeTest')) {
            console.log(`    ↩ Back to WRITE_TEST (fix: ${result.failedAt})`);
            phase = 'writeTest';
          } else {
            ctx.failReason = `verifyRed failed at ${result.failedAt} after retries`;
            phase = 'skipped';
          }
        }
        break;
      }

      // ── IMPLEMENT ────────────────────────────────────────
      case 'implement': {
        console.log(`\n  ▸ IMPLEMENT [attempt ${(ctx.phaseAttempts['implement'] || 0) + 1}/${config.maxAttemptsPerPhase}]`);
        try {
          const sctx = toStateCtx(ctx);
          const isRetry = (ctx.phaseAttempts['implement'] || 0) > 0;
          const prompt = isRetry ? promptFixImplementation(sctx) : promptImplement(sctx);

          const response = await ollama.generate(prompt, SYSTEM_PROMPT);
          ctx.lastModelOutput = response.content;

          const applied = applyCode(response.content, task, config.appDir, 'implement');
          if (applied === 0) throw new Error('No code blocks produced');

          refresh();
          record('wrote implementation');
          phase = 'verifyGreen';
        } catch (err: any) {
          console.log(`    ❌ ${err.message}`);
          bumpPhase('implement');
          record(`error: ${err.message}`);
          if (!canRetry('implement')) {
            ctx.failReason = `implement failed after ${ctx.phaseAttempts['implement']} attempts`;
            phase = 'skipped';
          }
        }
        break;
      }

      // ── VERIFY GREEN ─────────────────────────────────────
      case 'verifyGreen': {
        console.log(`\n  ▸ VERIFY_GREEN`);
        const sctx = toStateCtx(ctx);
        const result = await runVerifyChain(g.chains.verifyGreenChain, sctx);
        ctx.lastGuardResults = result.results;
        ctx.lastTestResult = sctx.lastTestResult;
        record(`verifyGreen: ${result.allPassed ? 'PASS' : `FAIL@${result.failedAt}`}`);

        if (result.allPassed) {
          console.log('    ✓ GREEN confirmed → REFACTOR');
          ctx.phaseAttempts['implement'] = 0;
          phase = 'refactor';
        } else {
          bumpPhase('implement');
          if (canRetry('implement')) {
            console.log(`    ↩ Back to IMPLEMENT (fix: ${result.failedAt})`);
            phase = 'implement';
          } else {
            ctx.failReason = `verifyGreen failed at ${result.failedAt} after retries`;
            phase = 'skipped';
          }
        }
        break;
      }

      // ── REFACTOR ─────────────────────────────────────────
      case 'refactor': {
        console.log(`\n  ▸ REFACTOR`);
        try {
          const sctx = toStateCtx(ctx);
          const response = await ollama.generate(promptRefactor(sctx), SYSTEM_PROMPT);
          ctx.lastModelOutput = response.content;

          if (response.content.includes('NO_REFACTOR_NEEDED')) {
            console.log('    → No refactor needed. DONE.');
            record('no refactor');
            phase = 'done';
          } else {
            const applied = applyCode(response.content, task, config.appDir, 'refactor');
            if (applied === 0) {
              console.log('    → No code in refactor output. DONE.');
              record('empty refactor');
              phase = 'done';
            } else {
              refresh();
              record('wrote refactor');
              phase = 'verifyRefactor';
            }
          }
        } catch (err: any) {
          console.log(`    ⚠ Refactor error: ${err.message}. Accepting pre-refactor state.`);
          record(`refactor error: ${err.message}`);
          phase = 'done';
        }
        break;
      }

      // ── VERIFY REFACTOR ──────────────────────────────────
      case 'verifyRefactor': {
        console.log(`\n  ▸ VERIFY_REFACTOR`);
        const sctx = toStateCtx(ctx);
        const result = await runVerifyChain(g.chains.verifyRefactorChain, sctx);
        record(`verifyRefactor: ${result.allPassed ? 'PASS' : `FAIL@${result.failedAt}`}`);

        if (result.allPassed) {
          console.log('    ✓ Refactor verified. DONE.');
        } else {
          console.log('    ⚠ Refactor broke tests. Accepting pre-refactor state.');
        }
        // Either way, task is done (was green before refactor)
        phase = 'done';
        break;
      }
    }
  }

  // ── Log & return ─────────────────────────────────────────
  const success = phase === 'done';
  if (success) {
    console.log(`\n  ✅ TASK ${task.id} COMPLETE`);
  } else {
    console.log(`\n  ⛔ TASK ${task.id} SKIPPED: ${ctx.failReason}`);
  }
  logResult(config, task, success, success ? undefined : ctx.failReason, ctx.history);

  return { success, skipped: !success, reason: success ? undefined : ctx.failReason };
}
