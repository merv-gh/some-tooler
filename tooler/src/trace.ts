import { existsSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';

// ═══════════════════════════════════════════════════════════════
// Trace event types
// ═══════════════════════════════════════════════════════════════

export type TraceEventType =
  | 'task_start'
  | 'task_done'
  | 'task_skip'
  | 'phase_enter'
  | 'phase_exit'
  | 'guard_run'
  | 'guard_result'
  | 'model_request'
  | 'model_stream'
  | 'model_done'
  | 'model_thinking'
  | 'model_empty'
  | 'code_apply'
  | 'test_run'
  | 'test_result'
  | 'test_error_detail'
  | 'file_diff'
  | 'retry'
  | 'error';

export interface TraceEvent {
  id: string;
  ts: string;
  type: TraceEventType;
  taskId: string;
  phase?: string;
  data: Record<string, any>;
}

// ═══════════════════════════════════════════════════════════════
// Trace Logger
// ═══════════════════════════════════════════════════════════════

type TraceListener = (event: TraceEvent) => void;

let _counter = 0;

class TraceLogger {
  private enabled: boolean;
  private logDir: string;
  private logFile: string;
  private listeners: TraceListener[] = [];
  private currentTaskId: string = '';
  private currentPhase: string = '';

  constructor() {
    this.enabled = process.env.TRACE !== '0';  // on by default
    this.logDir = process.env.LOG_DIR || join(process.cwd(), '..', 'logs');
    this.logFile = join(this.logDir, 'trace.jsonl');
  }

  configure(logDir: string) {
    this.logDir = logDir;
    this.logFile = join(logDir, 'trace.jsonl');
  }

  setTask(taskId: string) { this.currentTaskId = taskId; }
  setPhase(phase: string) { this.currentPhase = phase; }

  /** Subscribe to live events (for SSE) */
  subscribe(listener: TraceListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  /** Emit a trace event */
  emit(type: TraceEventType, data: Record<string, any> = {}) {
    if (!this.enabled) return;

    const event: TraceEvent = {
      id: `t${++_counter}`,
      ts: new Date().toISOString(),
      type,
      taskId: this.currentTaskId,
      phase: this.currentPhase,
      data,
    };

    // Console (compact)
    this.toConsole(event);

    // File (full)
    this.toFile(event);

    // Live listeners (SSE)
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* don't crash */ }
    }
  }

  private toConsole(e: TraceEvent) {
    const prefix = `  [trace] ${e.type}`;
    switch (e.type) {
      case 'task_start':
        console.log(`\n${prefix} ━━━ ${e.data.title} ━━━`);
        break;
      case 'task_done':
        console.log(`${prefix} ✅ ${e.taskId}`);
        break;
      case 'task_skip':
        console.log(`${prefix} ⛔ ${e.taskId}: ${e.data.reason}`);
        break;
      case 'phase_enter':
        console.log(`${prefix} ▸ ${e.data.phase} [attempt ${e.data.attempt}/${e.data.maxAttempts}]`);
        break;
      case 'guard_result':
        const icon = e.data.ok ? '✓' : '✗';
        console.log(`${prefix} ${icon} ${e.data.name}: ${e.data.detail?.split('\n')[0] || ''}`);
        break;
      case 'model_request':
        console.log(`${prefix} → prompt ${e.data.promptChars}ch (${e.data.promptType})`);
        break;
      case 'model_thinking':
        // already shown by streaming dots
        break;
      case 'model_done':
        console.log(`${prefix} ← ${e.data.outputChars}ch ${e.data.codeBlocks}blk ${e.data.elapsed}s reason:${e.data.finishReason}`);
        break;
      case 'model_empty':
        console.warn(`${prefix} ⚠ EMPTY OUTPUT — ${e.data.reason}`);
        break;
      case 'code_apply':
        console.log(`${prefix} 📝 ${e.data.file} (${e.data.chars}ch) ${e.data.isNew ? 'NEW' : 'UPDATE'}`);
        break;
      case 'test_result':
        const r = e.data;
        console.log(`${prefix} tests: ${r.passed ? '✓' : '✗'} ${r.passedTests}/${r.totalTests} pass, ${r.failedTests} fail`);
        break;
      case 'test_error_detail':
        console.log(`${prefix} ┌─ test error detail ──`);
        for (const line of (e.data.details as string[]).slice(0, 15)) {
          console.log(`${prefix} │ ${line}`);
        }
        console.log(`${prefix} └──────────────────────`);
        break;
      case 'file_diff':
        console.log(`${prefix} diff ${e.data.file}: +${e.data.added} -${e.data.removed}`);
        break;
      case 'retry':
        console.log(`${prefix} ↩ retry ${e.data.phase} (${e.data.reason})`);
        break;
      case 'error':
        console.error(`${prefix} ❌ ${e.data.message}`);
        break;
    }
  }

  private toFile(e: TraceEvent) {
    try {
      if (!existsSync(this.logDir)) mkdirSync(this.logDir, { recursive: true });
      appendFileSync(this.logFile, JSON.stringify(e) + '\n', 'utf-8');
    } catch { /* don't crash on log failure */ }
  }
}

/** Singleton trace logger */
export const trace = new TraceLogger();
