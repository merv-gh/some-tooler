import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { ToolerConfig } from './types.js';
import { parsePlan } from './plan-parser.js';
import { runTaskWithMachine } from './machine.js';
import { OllamaClient } from './ollama.js';
import { trace } from './trace.js';
import { startUiServer } from './ui-server.js';
import { Workspace } from './workspace.js';

// ── Config ───────────────────────────────────────────────────
const workspaceDir = process.env.WORKSPACE_DIR || process.env.APP_DIR || join(process.cwd(), '..', 'workspace');
// If APP_DIR is set explicitly (legacy), use it; otherwise first project in workspace or 'default'
const appDir = process.env.APP_DIR || join(workspaceDir, 'default');

const config: ToolerConfig = {
  ollamaUrl: process.env.OLLAMA_URL || 'http://localhost:11434',
  model: process.env.OLLAMA_MODEL || 'qwen3.5',
  workspaceDir,
  appDir,
  planFile: process.env.PLAN_FILE || join(process.cwd(), '..', 'plan', 'plan.md'),
  maxAttemptsPerPhase: parseInt(process.env.MAX_PHASE_ATTEMPTS || '3'),
  maxAttemptsPerTask: parseInt(process.env.MAX_TASK_ATTEMPTS || '15'),
  logDir: join(process.cwd(), '..', 'logs'),
};

// ── Progress persistence (resume-safe) ───────────────────────
const STATE_FILE = join(config.logDir, 'progress.json');

interface Progress {
  completedTasks: string[];
  skippedTasks: string[];
  startedAt: string;
  lastUpdated: string;
}

function loadProgress(): Progress {
  if (existsSync(STATE_FILE)) {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  }
  return {
    completedTasks: [],
    skippedTasks: [],
    startedAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
  };
}

function saveProgress(p: Progress): void {
  if (!existsSync(config.logDir)) mkdirSync(config.logDir, { recursive: true });
  p.lastUpdated = new Date().toISOString();
  writeFileSync(STATE_FILE, JSON.stringify(p, null, 2));
}

// ── Main ─────────────────────────────────────────────────────
async function main() {
  // Ensure workspace + default project exist with working scripts
  const ws = new Workspace(config.workspaceDir);
  if (!ws.exists('default') && !process.env.APP_DIR) {
    ws.createEmpty('default');
    console.log('✓ Created default project in workspace');
  }

  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  TDD TOOLER — XState Guardrailed Agent Loop     ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  Model:  ${config.model.padEnd(39)}║`);
  console.log(`║  Ollama: ${config.ollamaUrl.padEnd(39)}║`);
  console.log(`║  Work:   ${config.workspaceDir.slice(-38).padEnd(39)}║`);
  console.log(`║  App:    ${config.appDir.slice(-38).padEnd(39)}║`);
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');

  // Configure trace + start UI
  trace.configure(config.logDir);
  startUiServer(config);

  // Connectivity check
  const client = new OllamaClient(config);
  if (!await client.isAvailable()) {
    console.error('❌ Ollama not reachable at', config.ollamaUrl);
    console.error('   Start ollama or set OLLAMA_URL');
    process.exit(1);
  }
  console.log('✓ Ollama connected');

  // Load plan
  const plan = parsePlan(config.planFile);
  const progress = loadProgress();
  console.log(`✓ Progress: ${progress.completedTasks.length} done, ${progress.skippedTasks.length} skipped\n`);

  // On re-run: clear skipped tasks so they get retried
  if (progress.skippedTasks.length > 0) {
    console.log(`♻  Clearing ${progress.skippedTasks.length} previously skipped tasks for retry`);
    progress.skippedTasks = [];
    saveProgress(progress);
  }

  let completed = 0;
  let skipped = 0;

  for (const task of plan.tasks) {
    if (progress.completedTasks.includes(task.id)) {
      console.log(`⏭  ${task.id} — already done`);
      completed++;
      continue;
    }

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`TASK: ${task.id} — ${task.title}`);
    console.log(`${'═'.repeat(60)}`);

    const result = await runTaskWithMachine(config, task);

    if (result.success) {
      progress.completedTasks.push(task.id);
      completed++;
    } else {
      // Don't persist skip — will retry on next run
      skipped++;
      console.log(`  ↪ Will retry ${task.id} on next run`);
    }

    saveProgress(progress);
    await sleep(1500);
  }

  // Summary
  console.log('\n' + '═'.repeat(60));
  console.log(`DONE — ${completed}/${plan.tasks.length} completed, ${skipped} skipped`);
  console.log(`Logs: ${config.logDir}/results.jsonl`);
  console.log('═'.repeat(60));
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
