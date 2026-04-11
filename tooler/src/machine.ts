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
  promptFixTestFromDiagnosis,
  promptFixEnv,
} from './prompts.js';
import { diagnoseTestFailure, type Diagnosis, type ErrorSource } from './diagnosis.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'fs';
import { dirname, join } from 'path';
import { trace } from './trace.js';

// ═══════════════════════════════════════════════════════════════
// Context
// ═══════════════════════════════════════════════════════════════

interface MachineContext {
  task: Task;
  config: ToolerConfig;
  phaseAttempts: Record<string, number>;
  totalAttempts: number;
  lastTestResult: any;
  lastModelOutput: string;
  lastGuardResults: GuardResult[];
  lastDiagnosis: Diagnosis | null;
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
      targetFile = (phase.includes('test') || phase.includes('Test')) ? task.testFile : task.sourceFile;
    }
    if (!targetFile) continue;
    const fullPath = join(appDir, targetFile);
    const dir = dirname(fullPath);

    const isNew = !existsSync(fullPath);
    let prevContent = '';
    if (!isNew) { try { prevContent = readFileSync(fullPath, 'utf-8'); } catch { /* */ } }

    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(fullPath, block.code, 'utf-8');

    const prevLines = prevContent ? prevContent.split('\n') : [];
    const newLines = block.code.split('\n');
    const added = newLines.filter(l => !prevLines.includes(l)).length;
    const removed = prevLines.filter(l => !newLines.includes(l)).length;

    let diff = '';
    if (!isNew && prevContent !== block.code) {
      diff = buildSimpleDiff(prevContent, block.code, targetFile);
    }

    trace.emit('code_apply', { file: targetFile, chars: block.code.length, isNew, added, removed, diff, content: isNew ? block.code : undefined });
    if (diff) trace.emit('file_diff', { file: targetFile, added, removed, diff });
    applied++;
  }
  return applied;
}

function buildSimpleDiff(prev: string, next: string, filename: string): string {
  const pLines = prev.split('\n');
  const nLines = next.split('\n');
  const lines: string[] = [`--- a/${filename}`, `+++ b/${filename}`];
  const maxLen = Math.max(pLines.length, nLines.length);
  for (let i = 0; i < maxLen; i++) {
    const pLine = pLines[i];
    const nLine = nLines[i];
    if (pLine === nLine) { lines.push(` ${pLine ?? ''}`); }
    else {
      if (pLine !== undefined) lines.push(`-${pLine}`);
      if (nLine !== undefined) lines.push(`+${nLine}`);
    }
  }
  if (lines.length > 100) return lines.slice(0, 80).join('\n') + `\n... (${lines.length - 80} more lines)`;
  return lines.join('\n');
}

function toStateCtx(ctx: MachineContext, phase: string): StateContext {
  return {
    task: ctx.task, phase: phase as any, attempt: 0,
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
  const entry = JSON.stringify({ taskId: task.id, title: task.title, success, reason, history, timestamp: new Date().toISOString() }) + '\n';
  appendFileSync(join(config.logDir, 'results.jsonl'), entry, 'utf-8');
}

// ═══════════════════════════════════════════════════════════════
// Machine runner
// ═══════════════════════════════════════════════════════════════

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
    task, config,
    phaseAttempts: {},
    totalAttempts: 0,
    lastTestResult: null,
    lastModelOutput: '',
    lastGuardResults: [],
    lastDiagnosis: null,
    existingCode: loadExistingCode(task, config.appDir),
    history: [],
    failReason: '',
  };

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
    trace.emit('phase_enter', { phase: p, attempt: (ctx.phaseAttempts[p] || 0) + 1, maxAttempts: config.maxAttemptsPerPhase });
  }

  function exitPhase(nextPhase: string, reason?: string) {
    trace.emit('phase_exit', { phase, nextPhase, reason });
  }

  /** Generate prompt + call model + apply code. Returns applied count. */
  async function callModel(prompt: string, promptType: string, applyPhase: string): Promise<number> {
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

    const applied = applyCode(response.content, task, config.appDir, applyPhase);
    if (applied === 0) throw new Error('No code blocks produced');
    refresh();
    return applied;
  }

  /**
   * Diagnose a test failure and route to the right fix.
   * Returns the next phase to enter.
   */
  async function diagnoseAndRoute(currentPhase: string): Promise<string> {
    if (!ctx.lastTestResult) return currentPhase;

    const sctx = toStateCtx(ctx, phase);
    const diagnosis = await diagnoseTestFailure(ctx.lastTestResult, sctx, config, ollama);
    ctx.lastDiagnosis = diagnosis;

    trace.emit('guard_result', {
      name: 'diagnosis',
      ok: false,
      detail: `source:${diagnosis.source} confidence:${diagnosis.confidence} action:${diagnosis.action}\n${diagnosis.reason}\n${diagnosis.details.join('\n')}`,
    });

    switch (diagnosis.action) {
      case 'fix_test':
        return 'fixTestDiagnosed';
      case 'fix_impl':
        return 'implement';
      case 'fix_env':
        return 'fixEnv';
      case 'ask_model':
      default:
        // Low confidence — fall back to what we were doing
        return currentPhase;
    }
  }

  // ── State loop ─────────────────────────────────────────────
  enterPhase('writeTest');

  while (phase !== 'done' && phase !== 'skipped') {

    switch (phase) {

      // ── WRITE TEST ───────────────────────────────────────
      case 'writeTest': {
        try {
          const sctx = toStateCtx(ctx, phase);
          const isRetry = (ctx.phaseAttempts['writeTest'] || 0) > 0;
          const sanityFail = ctx.lastGuardResults.find(r => r.name === 'test-sanity' && !r.ok);

          let prompt: string;
          let promptType: string;
          if (sanityFail) { prompt = promptFixInsaneTest(sctx, sanityFail.detail); promptType = 'fixInsaneTest'; }
          else if (isRetry) { prompt = promptFixTest(sctx); promptType = 'fixTest'; }
          else { prompt = promptWriteTest(sctx); promptType = 'writeTest'; }

          await callModel(prompt, promptType, 'writeTest');
          record('wrote test');
          exitPhase('verifyRed');
          enterPhase('verifyRed');
        } catch (err: any) {
          trace.emit('error', { message: err.message, phase: 'writeTest' });
          bumpPhase('writeTest');
          record(`error: ${err.message}`);
          if (!canRetry('writeTest')) { ctx.failReason = `writeTest failed: ${err.message}`; exitPhase('skipped'); phase = 'skipped'; }
          else { trace.emit('retry', { phase: 'writeTest', reason: err.message }); enterPhase('writeTest'); }
        }
        break;
      }

      // ── VERIFY RED ───────────────────────────────────────
      case 'verifyRed': {
        const sctx = toStateCtx(ctx, phase);
        const result = await runVerifyChain(g.chains.verifyRedChain, sctx);
        ctx.lastGuardResults = result.results;
        ctx.lastTestResult = sctx.lastTestResult;
        for (const gr of result.results) trace.emit('guard_result', { name: gr.name, ok: gr.ok, detail: gr.detail });
        record(`verifyRed: ${result.allPassed ? 'PASS' : `FAIL@${result.failedAt}`}`);

        if (result.allPassed) {
          exitPhase('implement', 'RED confirmed');
          ctx.phaseAttempts['writeTest'] = 0;
          enterPhase('implement');
        } else if (result.failedAt === 'tests-fail') {
          exitPhase('refactor', 'tests already pass');
          enterPhase('refactor');
        } else {
          // ── DIAGNOSIS: why did verify-red fail? ──────────
          // If tests ran but failed for wrong reasons, diagnose
          if (ctx.lastTestResult && result.failedAt !== 'test-file-exists') {
            const nextPhase = await diagnoseAndRoute('writeTest');
            bumpPhase('writeTest');
            if (canRetry('writeTest')) {
              trace.emit('retry', { phase: nextPhase, reason: `verifyRed failed at ${result.failedAt}, diagnosed: ${ctx.lastDiagnosis?.source}` });
              enterPhase(nextPhase);
            } else { ctx.failReason = `verifyRed: ${result.failedAt}`; exitPhase('skipped'); phase = 'skipped'; }
          } else {
            bumpPhase('writeTest');
            if (canRetry('writeTest')) { enterPhase('writeTest'); }
            else { ctx.failReason = `verifyRed: ${result.failedAt}`; exitPhase('skipped'); phase = 'skipped'; }
          }
        }
        break;
      }

      // ── FIX TEST (diagnosis-driven) ──────────────────────
      case 'fixTestDiagnosed': {
        try {
          const sctx = toStateCtx(ctx, phase);
          const prompt = ctx.lastDiagnosis
            ? promptFixTestFromDiagnosis(sctx, ctx.lastDiagnosis)
            : promptFixTest(sctx);
          await callModel(prompt, 'fixTestDiagnosed', 'writeTest');
          record('fixed test (diagnosed)');
          exitPhase('verifyRed');
          enterPhase('verifyRed');
        } catch (err: any) {
          trace.emit('error', { message: err.message, phase: 'fixTestDiagnosed' });
          bumpPhase('writeTest');
          record(`error: ${err.message}`);
          if (canRetry('writeTest')) { enterPhase('writeTest'); }
          else { ctx.failReason = `fixTestDiagnosed: ${err.message}`; phase = 'skipped'; }
        }
        break;
      }

      // ── FIX ENV (diagnosis-driven) ───────────────────────
      case 'fixEnv': {
        try {
          const sctx = toStateCtx(ctx, phase);
          const prompt = ctx.lastDiagnosis
            ? promptFixEnv(sctx, ctx.lastDiagnosis)
            : promptFixTest(sctx);
          await callModel(prompt, 'fixEnv', 'env');
          record('fixed env');
          // Go back to whatever verification was running
          const returnPhase = ctx.history.find(h => h.phase === 'verifyGreen') ? 'verifyGreen' : 'verifyRed';
          exitPhase(returnPhase);
          enterPhase(returnPhase);
        } catch (err: any) {
          trace.emit('error', { message: err.message, phase: 'fixEnv' });
          bumpPhase('fixEnv');
          record(`error: ${err.message}`);
          if (canRetry('fixEnv')) { enterPhase('fixEnv'); }
          else { ctx.failReason = `fixEnv: ${err.message}`; phase = 'skipped'; }
        }
        break;
      }

      // ── IMPLEMENT ────────────────────────────────────────
      case 'implement': {
        try {
          const sctx = toStateCtx(ctx, phase);
          const isRetry = (ctx.phaseAttempts['implement'] || 0) > 0;
          const prompt = isRetry ? promptFixImplementation(sctx) : promptImplement(sctx);
          await callModel(prompt, isRetry ? 'fixImpl' : 'implement', 'implement');
          record('wrote implementation');
          exitPhase('verifyGreen');
          enterPhase('verifyGreen');
        } catch (err: any) {
          trace.emit('error', { message: err.message, phase: 'implement' });
          bumpPhase('implement');
          record(`error: ${err.message}`);
          if (!canRetry('implement')) { ctx.failReason = `implement: ${err.message}`; exitPhase('skipped'); phase = 'skipped'; }
          else { trace.emit('retry', { phase: 'implement', reason: err.message }); enterPhase('implement'); }
        }
        break;
      }

      // ── VERIFY GREEN ─────────────────────────────────────
      case 'verifyGreen': {
        const sctx = toStateCtx(ctx, phase);
        const result = await runVerifyChain(g.chains.verifyGreenChain, sctx);
        ctx.lastGuardResults = result.results;
        ctx.lastTestResult = sctx.lastTestResult;
        for (const gr of result.results) trace.emit('guard_result', { name: gr.name, ok: gr.ok, detail: gr.detail });
        record(`verifyGreen: ${result.allPassed ? 'PASS' : `FAIL@${result.failedAt}`}`);

        if (result.allPassed) {
          exitPhase('refactor', 'GREEN confirmed');
          ctx.phaseAttempts['implement'] = 0;
          enterPhase('refactor');
        } else {
          // ── DIAGNOSIS: why are tests still failing? ──────
          if (ctx.lastTestResult) {
            const nextPhase = await diagnoseAndRoute('implement');

            // If diagnosis says test is wrong, route there
            if (nextPhase === 'fixTestDiagnosed' || nextPhase === 'fixEnv') {
              bumpPhase('implement');
              if (canRetry('implement')) {
                trace.emit('retry', { phase: nextPhase, reason: `verifyGreen failed, diagnosed: ${ctx.lastDiagnosis?.source}` });
                enterPhase(nextPhase);
              } else { ctx.failReason = `verifyGreen: diagnosed ${ctx.lastDiagnosis?.source}`; exitPhase('skipped'); phase = 'skipped'; }
            } else {
              // Normal: implementation needs fixing
              bumpPhase('implement');
              if (canRetry('implement')) {
                trace.emit('retry', { phase: 'implement', reason: `verifyGreen: ${result.failedAt}` });
                enterPhase('implement');
              } else { ctx.failReason = `verifyGreen: ${result.failedAt}`; exitPhase('skipped'); phase = 'skipped'; }
            }
          } else {
            bumpPhase('implement');
            if (canRetry('implement')) { enterPhase('implement'); }
            else { ctx.failReason = `verifyGreen: ${result.failedAt}`; exitPhase('skipped'); phase = 'skipped'; }
          }
        }
        break;
      }

      // ── REFACTOR ─────────────────────────────────────────
      case 'refactor': {
        try {
          const sctx = toStateCtx(ctx, phase);
          const prompt = promptRefactor(sctx);
          trace.emit('model_request', { promptType: 'refactor', promptChars: prompt.length, prompt });

          const response = await ollama.generate(prompt, SYSTEM_PROMPT);
          ctx.lastModelOutput = response.content;
          trace.emit('model_done', { outputChars: response.content.length, output: response.content });

          if (response.content.includes('NO_REFACTOR_NEEDED')) {
            record('no refactor'); exitPhase('done'); phase = 'done';
          } else {
            const applied = applyCode(response.content, task, config.appDir, 'refactor');
            if (applied === 0) { record('empty refactor'); exitPhase('done'); phase = 'done'; }
            else { refresh(); record('wrote refactor'); exitPhase('verifyRefactor'); enterPhase('verifyRefactor'); }
          }
        } catch (err: any) {
          trace.emit('error', { message: err.message, phase: 'refactor' });
          record(`refactor error: ${err.message}`);
          exitPhase('done'); phase = 'done';
        }
        break;
      }

      // ── VERIFY REFACTOR ──────────────────────────────────
      case 'verifyRefactor': {
        const sctx = toStateCtx(ctx, phase);
        const result = await runVerifyChain(g.chains.verifyRefactorChain, sctx);
        for (const gr of result.results) trace.emit('guard_result', { name: gr.name, ok: gr.ok, detail: gr.detail });
        record(`verifyRefactor: ${result.allPassed ? 'PASS' : `FAIL@${result.failedAt}`}`);
        exitPhase('done', result.allPassed ? 'verified' : 'broken, accept pre-refactor');
        phase = 'done';
        break;
      }

      // ── UNKNOWN PHASE (safety) ───────────────────────────
      default: {
        trace.emit('error', { message: `Unknown phase: ${phase}`, phase });
        ctx.failReason = `Unknown phase: ${phase}`;
        phase = 'skipped';
        break;
      }
    }
  }

  // ── Terminal ─────────────────────────────────────────────
  const success = phase === 'done';
  if (success) trace.emit('task_done', { taskId: task.id });
  else trace.emit('task_skip', { taskId: task.id, reason: ctx.failReason });
  logResult(config, task, success, success ? undefined : ctx.failReason, ctx.history);

  return { success, skipped: !success, reason: success ? undefined : ctx.failReason };
}
