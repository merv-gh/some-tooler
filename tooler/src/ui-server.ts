import express from 'express';
import { join } from 'path';
import { trace } from './trace.js';
import type { TraceEvent } from './trace.js';

const UI_PORT = parseInt(process.env.UI_PORT || '7700');

export function startUiServer(): void {
  const app = express();

  // ── SSE endpoint ─────────────────────────────────────────
  app.get('/api/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    res.write(`data: ${JSON.stringify({ type: 'connected', ts: new Date().toISOString() })}\n\n`);

    const unsubscribe = trace.subscribe((event: TraceEvent) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });

    req.on('close', () => {
      unsubscribe();
    });
  });

  // ── Dashboard HTML ───────────────────────────────────────
  app.get('/', (_req, res) => {
    res.type('html').send(dashboardHtml());
  });

  app.listen(UI_PORT, '0.0.0.0', () => {
    console.log(`  [ui] Dashboard: http://localhost:${UI_PORT}`);
  });
}

// ═══════════════════════════════════════════════════════════════
// Dashboard HTML — single-file, Tailwind CDN, dark theme
// ═══════════════════════════════════════════════════════════════

function dashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>TDD Tooler Dashboard</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          colors: {
            surface: { DEFAULT: '#0f1117', 2: '#161922', 3: '#1e2130' },
            accent: { DEFAULT: '#6366f1', dim: '#4f46e5' },
            ok: '#22c55e',
            fail: '#ef4444',
            warn: '#f59e0b',
            muted: '#6b7280',
          },
          fontFamily: { mono: ['JetBrains Mono', 'Fira Code', 'monospace'] },
        }
      }
    }
  </script>
  <style>
    * { scrollbar-width: thin; scrollbar-color: #374151 transparent; }
    .fade-in { animation: fadeIn 0.2s ease-out; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
    .phase-badge { @apply px-2 py-0.5 rounded text-xs font-bold uppercase tracking-wider; }
    pre { white-space: pre-wrap; word-break: break-word; }
    .diff-add { color: #22c55e; background: rgba(34,197,94,0.08); }
    .diff-rm  { color: #ef4444; background: rgba(239,68,68,0.08); }
  </style>
</head>
<body class="bg-surface text-gray-200 font-mono text-sm min-h-screen">

  <!-- Header -->
  <header class="border-b border-gray-800 px-6 py-3 flex items-center justify-between sticky top-0 bg-surface/95 backdrop-blur z-50">
    <div class="flex items-center gap-3">
      <span class="text-lg font-bold text-accent">⚡ TDD Tooler</span>
      <span id="status" class="phase-badge bg-gray-700 text-gray-300">connecting…</span>
    </div>
    <div class="flex items-center gap-4 text-xs text-muted">
      <span>Tasks: <span id="taskCount" class="text-gray-300">0/0</span></span>
      <span>Events: <span id="eventCount" class="text-gray-300">0</span></span>
      <button onclick="toggleAutoScroll()" id="scrollBtn" class="px-2 py-1 rounded bg-surface-3 hover:bg-gray-700">⬇ auto-scroll</button>
    </div>
  </header>

  <div class="flex h-[calc(100vh-49px)]">

    <!-- Left: Task list -->
    <aside id="taskList" class="w-64 border-r border-gray-800 overflow-y-auto p-3 flex-shrink-0">
      <h2 class="text-xs font-bold text-muted uppercase tracking-wider mb-2">Tasks</h2>
      <div id="tasks" class="space-y-1"></div>
    </aside>

    <!-- Center: Event stream -->
    <main class="flex-1 overflow-y-auto p-4" id="eventStream">
      <div id="events" class="space-y-1"></div>
    </main>

    <!-- Right: Detail panel -->
    <aside id="detailPanel" class="w-[480px] border-l border-gray-800 overflow-y-auto p-4 flex-shrink-0 hidden">
      <div class="flex items-center justify-between mb-3">
        <h2 class="text-xs font-bold text-muted uppercase tracking-wider">Detail</h2>
        <button onclick="closeDetail()" class="text-muted hover:text-gray-300 text-lg leading-none">&times;</button>
      </div>
      <div id="detailContent"></div>
    </aside>
  </div>

<script>
// ── State ──────────────────────────────────────────────────
const state = {
  events: [],
  tasks: {},
  currentTask: null,
  currentPhase: null,
  autoScroll: true,
  completed: 0,
  total: 0,
  eventCount: 0,
};

// ── SSE Connection ─────────────────────────────────────────
function connect() {
  const es = new EventSource('/api/events');
  es.onmessage = (e) => {
    const event = JSON.parse(e.data);
    if (event.type === 'connected') {
      document.getElementById('status').textContent = 'live';
      document.getElementById('status').className = 'phase-badge bg-ok/20 text-ok';
      return;
    }
    handleEvent(event);
  };
  es.onerror = () => {
    document.getElementById('status').textContent = 'disconnected';
    document.getElementById('status').className = 'phase-badge bg-fail/20 text-fail';
    setTimeout(connect, 3000);
  };
}

// ── Event Handler ──────────────────────────────────────────
function handleEvent(e) {
  state.events.push(e);
  state.eventCount++;
  document.getElementById('eventCount').textContent = state.eventCount;

  switch (e.type) {
    case 'task_start':
      state.currentTask = e.taskId;
      state.tasks[e.taskId] = { status: 'running', title: e.data.title, phases: [] };
      state.total = Math.max(state.total, Object.keys(state.tasks).length);
      updateTaskList();
      break;

    case 'task_done':
      if (state.tasks[e.taskId]) state.tasks[e.taskId].status = 'done';
      state.completed++;
      updateTaskList();
      break;

    case 'task_skip':
      if (state.tasks[e.taskId]) {
        state.tasks[e.taskId].status = 'skipped';
        state.tasks[e.taskId].reason = e.data.reason;
      }
      updateTaskList();
      break;

    case 'phase_enter':
      state.currentPhase = e.data.phase;
      if (state.tasks[e.taskId]) {
        state.tasks[e.taskId].phases.push(e.data.phase);
      }
      break;
  }

  document.getElementById('taskCount').textContent = state.completed + '/' + state.total;
  appendEventRow(e);
}

// ── Task List ──────────────────────────────────────────────
function updateTaskList() {
  const container = document.getElementById('tasks');
  container.innerHTML = '';
  for (const [id, t] of Object.entries(state.tasks)) {
    const icon = t.status === 'done' ? '✅' : t.status === 'skipped' ? '⛔' : '🔄';
    const bg = t.status === 'running' ? 'bg-accent/10 border-accent/30' : 'bg-surface-3 border-transparent';
    const el = document.createElement('div');
    el.className = 'p-2 rounded border cursor-pointer hover:bg-surface-3 ' + bg;
    el.innerHTML = '<div class="flex items-center gap-2">' +
      '<span>' + icon + '</span>' +
      '<span class="truncate text-xs">' + id + '</span>' +
      '</div>' +
      '<div class="text-xs text-muted truncate mt-0.5">' + (t.title || '') + '</div>';
    el.onclick = () => filterByTask(id);
    container.appendChild(el);
  }
}

// ── Event Row ──────────────────────────────────────────────
function appendEventRow(e) {
  const container = document.getElementById('events');
  const row = document.createElement('div');
  row.className = 'fade-in flex items-start gap-2 py-1 px-2 rounded hover:bg-surface-2 cursor-pointer group';
  row.onclick = () => showDetail(e);

  const time = e.ts.split('T')[1].split('.')[0];
  const { icon, color, summary } = formatEvent(e);

  row.innerHTML =
    '<span class="text-muted text-[10px] w-16 flex-shrink-0 pt-0.5">' + time + '</span>' +
    '<span class="w-5 text-center flex-shrink-0">' + icon + '</span>' +
    '<span class="' + color + ' text-xs w-28 flex-shrink-0 truncate font-semibold">' + e.type + '</span>' +
    '<span class="text-xs text-gray-400 truncate flex-1">' + escHtml(summary) + '</span>';

  container.appendChild(row);

  if (state.autoScroll) {
    document.getElementById('eventStream').scrollTop = document.getElementById('eventStream').scrollHeight;
  }
}

function formatEvent(e) {
  switch (e.type) {
    case 'task_start':    return { icon: '🚀', color: 'text-accent', summary: e.data.title || e.taskId };
    case 'task_done':     return { icon: '✅', color: 'text-ok', summary: e.taskId };
    case 'task_skip':     return { icon: '⛔', color: 'text-fail', summary: e.data.reason || '' };
    case 'phase_enter':   return { icon: '▸', color: 'text-accent', summary: e.data.phase + ' [' + e.data.attempt + '/' + e.data.maxAttempts + ']' };
    case 'phase_exit':    return { icon: '◂', color: 'text-muted', summary: e.data.phase + ' → ' + e.data.nextPhase };
    case 'guard_result':  return { icon: e.data.ok ? '✓' : '✗', color: e.data.ok ? 'text-ok' : 'text-fail', summary: e.data.name + ': ' + (e.data.detail || '').split('\\n')[0] };
    case 'model_request': return { icon: '→', color: 'text-warn', summary: e.data.promptType + ' (' + e.data.promptChars + 'ch)' };
    case 'model_done':    return { icon: '←', color: 'text-warn', summary: e.data.outputChars + 'ch ' + e.data.codeBlocks + 'blk ' + e.data.elapsed + 's' };
    case 'model_thinking':return { icon: '🧠', color: 'text-warn', summary: e.data.thinkingChars + ' chars thinking' };
    case 'model_empty':   return { icon: '⚠', color: 'text-fail', summary: e.data.reason };
    case 'code_apply':    return { icon: '📝', color: 'text-ok', summary: e.data.file + ' (' + e.data.chars + 'ch) ' + (e.data.isNew ? 'NEW' : 'UPD') };
    case 'test_result':   return { icon: e.data.passed ? '✓' : '✗', color: e.data.passed ? 'text-ok' : 'text-fail', summary: e.data.passedTests + '/' + e.data.totalTests + ' pass' };
    case 'test_error_detail': return { icon: '🔍', color: 'text-fail', summary: (e.data.details || [])[0] || '' };
    case 'file_diff':     return { icon: '±', color: 'text-muted', summary: e.data.file + ' +' + e.data.added + ' -' + e.data.removed };
    case 'retry':         return { icon: '↩', color: 'text-warn', summary: e.data.phase + ': ' + e.data.reason };
    case 'error':         return { icon: '❌', color: 'text-fail', summary: e.data.message };
    default:              return { icon: '·', color: 'text-muted', summary: JSON.stringify(e.data).slice(0, 120) };
  }
}

// ── Detail Panel ───────────────────────────────────────────
function showDetail(e) {
  const panel = document.getElementById('detailPanel');
  const content = document.getElementById('detailContent');
  panel.classList.remove('hidden');

  let html = '<div class="space-y-3">';
  html += '<div class="flex items-center gap-2">';
  html += '<span class="phase-badge ' + phaseBadgeColor(e.type) + '">' + e.type + '</span>';
  html += '<span class="text-muted text-xs">' + e.ts + '</span>';
  html += '</div>';
  html += '<div class="text-xs text-muted">Task: ' + e.taskId + ' | Phase: ' + (e.phase || '-') + '</div>';

  // Render data based on type
  switch (e.type) {
    case 'model_request':
      html += '<h3 class="text-xs font-bold text-muted uppercase mt-4">Prompt</h3>';
      html += '<pre class="bg-surface-3 rounded p-3 text-xs max-h-[600px] overflow-y-auto border border-gray-800">' + escHtml(e.data.prompt || '') + '</pre>';
      break;

    case 'model_done':
      html += '<h3 class="text-xs font-bold text-muted uppercase mt-4">Output</h3>';
      html += '<pre class="bg-surface-3 rounded p-3 text-xs max-h-[600px] overflow-y-auto border border-gray-800">' + highlightCode(e.data.output || '') + '</pre>';
      if (e.data.thinking) {
        html += '<h3 class="text-xs font-bold text-warn uppercase mt-4">🧠 Thinking</h3>';
        html += '<pre class="bg-surface-3 rounded p-3 text-xs max-h-[300px] overflow-y-auto border border-warn/20 text-warn/70">' + escHtml(e.data.thinking || '') + '</pre>';
      }
      break;

    case 'code_apply':
      html += '<h3 class="text-xs font-bold text-muted uppercase mt-4">File: ' + escHtml(e.data.file) + '</h3>';
      if (e.data.diff) {
        html += '<pre class="bg-surface-3 rounded p-3 text-xs max-h-[600px] overflow-y-auto border border-gray-800">' + renderDiff(e.data.diff) + '</pre>';
      }
      if (e.data.content) {
        html += '<pre class="bg-surface-3 rounded p-3 text-xs max-h-[600px] overflow-y-auto border border-gray-800">' + escHtml(e.data.content) + '</pre>';
      }
      break;

    case 'test_result':
      html += '<h3 class="text-xs font-bold text-muted uppercase mt-4">Test Output</h3>';
      html += '<pre class="bg-surface-3 rounded p-3 text-xs max-h-[600px] overflow-y-auto border border-gray-800">' + escHtml(e.data.output || '') + '</pre>';
      break;

    case 'test_error_detail':
      html += '<h3 class="text-xs font-bold text-fail uppercase mt-4">Error Details</h3>';
      html += '<pre class="bg-surface-3 rounded p-3 text-xs max-h-[600px] overflow-y-auto border border-fail/20 text-fail/80">' + escHtml((e.data.details || []).join('\\n')) + '</pre>';
      break;

    case 'guard_result':
      html += '<h3 class="text-xs font-bold text-muted uppercase mt-4">Guard: ' + escHtml(e.data.name) + '</h3>';
      html += '<pre class="bg-surface-3 rounded p-3 text-xs border border-gray-800">' + escHtml(e.data.detail || '') + '</pre>';
      break;

    default:
      html += '<h3 class="text-xs font-bold text-muted uppercase mt-4">Data</h3>';
      html += '<pre class="bg-surface-3 rounded p-3 text-xs max-h-[600px] overflow-y-auto border border-gray-800">' + escHtml(JSON.stringify(e.data, null, 2)) + '</pre>';
  }

  html += '</div>';
  content.innerHTML = html;
}

function closeDetail() {
  document.getElementById('detailPanel').classList.add('hidden');
}

function filterByTask(taskId) {
  const container = document.getElementById('events');
  container.innerHTML = '';
  for (const e of state.events) {
    if (e.taskId === taskId) appendEventRow(e);
  }
}

// ── Helpers ────────────────────────────────────────────────
function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function highlightCode(s) {
  return escHtml(s).replace(/\`\`\`(\\S*)/g, '<span class="text-accent font-bold">\`\`\`$1</span>');
}

function renderDiff(diff) {
  return diff.split('\\n').map(line => {
    if (line.startsWith('+') && !line.startsWith('+++')) return '<span class="diff-add">' + escHtml(line) + '</span>';
    if (line.startsWith('-') && !line.startsWith('---')) return '<span class="diff-rm">' + escHtml(line) + '</span>';
    return escHtml(line);
  }).join('\\n');
}

function phaseBadgeColor(type) {
  if (type.includes('ok') || type.includes('done')) return 'bg-ok/20 text-ok';
  if (type.includes('fail') || type.includes('error') || type.includes('skip')) return 'bg-fail/20 text-fail';
  if (type.includes('model')) return 'bg-warn/20 text-warn';
  return 'bg-accent/20 text-accent';
}

let autoScroll = true;
function toggleAutoScroll() {
  autoScroll = !autoScroll;
  state.autoScroll = autoScroll;
  document.getElementById('scrollBtn').textContent = autoScroll ? '⬇ auto-scroll' : '⏸ paused';
}

// ── Init ───────────────────────────────────────────────────
connect();
</script>
</body>
</html>`;
}
