import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { ToolerConfig } from './types.js';
import { parsePlan } from './plan-parser.js';
import { TddStateMachine } from './state-machine.js';
import { OllamaClient } from './ollama.js';

// ── Config ───────────────────────────────────────────────────
const config: ToolerConfig = {
  ollamaUrl: process.env.OLLAMA_URL || 'http://localhost:11434',
  model: process.env.OLLAMA_MODEL || 'qwen3-coder',
  appDir: process.env.APP_DIR || join(process.cwd(), '..', 'app'),
  planFile: process.env.PLAN_FILE || join(process.cwd(), '..', 'plan', 'plan.md'),
  maxAttemptsPerState: parseInt(process.env.MAX_STATE_ATTEMPTS || '3'),
  maxAttemptsPerTask: parseInt(process.env.MAX_TASK_ATTEMPTS || '12'),
  testCommand: 'npx playwright test',
  unitTestCommand: 'npx vitest',
  logDir: join(process.cwd(), '..', 'logs'),
};

// ── State file for resuming ──────────────────────────────────
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

// ── Main Loop ────────────────────────────────────────────────
async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║       TDD TOOLER — Guardrailed Agent Loop   ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`Model:    ${config.model}`);
  console.log(`Ollama:   ${config.ollamaUrl}`);
  console.log(`App dir:  ${config.appDir}`);
  console.log(`Plan:     ${config.planFile}`);
  console.log('');

  // Check ollama
  const client = new OllamaClient(config);
  if (!await client.isAvailable()) {
    console.error('❌ Ollama not reachable at', config.ollamaUrl);
    console.error('   Start ollama or set OLLAMA_URL env var.');
    process.exit(1);
  }
  console.log('✓ Ollama connected\n');

  // Load plan
  const plan = parsePlan(config.planFile);

  // Load progress (for resume)
  const progress = loadProgress();
  console.log(`Progress: ${progress.completedTasks.length} completed, ${progress.skippedTasks.length} skipped\n`);

  const machine = new TddStateMachine(config);

  let completed = 0;
  let skipped = 0;
  let failed = 0;

  for (const task of plan.tasks) {
    // Skip already done
    if (progress.completedTasks.includes(task.id)) {
      console.log(`⏭ Skipping ${task.id} (already completed)`);
      completed++;
      continue;
    }
    if (progress.skippedTasks.includes(task.id)) {
      console.log(`⏭ Skipping ${task.id} (previously skipped/failed)`);
      skipped++;
      continue;
    }

    const result = await machine.runTask(task);

    if (result.success) {
      progress.completedTasks.push(task.id);
      completed++;
    } else if (result.skipped) {
      progress.skippedTasks.push(task.id);
      skipped++;
    } else {
      failed++;
    }

    saveProgress(progress);

    // Brief pause between tasks
    await sleep(2000);
  }

  // ── Summary ──────────────────────────────────────────────
  console.log('\n' + '═'.repeat(60));
  console.log('SUMMARY');
  console.log('═'.repeat(60));
  console.log(`Total tasks:  ${plan.tasks.length}`);
  console.log(`Completed:    ${completed}`);
  console.log(`Skipped:      ${skipped}`);
  console.log(`Failed:       ${failed}`);
  console.log(`Log:          ${config.logDir}/results.jsonl`);
  console.log(`Progress:     ${STATE_FILE}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
