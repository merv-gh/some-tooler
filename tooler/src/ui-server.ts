import express from 'express';
import { trace } from './trace.js';
import type { TraceEvent } from './trace.js';

const UI_PORT = parseInt(process.env.UI_PORT || '7700');

// ═══════════════════════════════════════════════════════════════
// Runtime state — shared between API and SSE
// ═══════════════════════════════════════════════════════════════

interface TaskState {
  id: string;
  title: string;
  status: 'pending' | 'running' | 'done' | 'skipped';
  phase: string;
  reason?: string;
}

const runtime = {
  tasks: new Map<string, TaskState>(),
  currentTaskId: '',
  events: [] as TraceEvent[],
  abortController: null as AbortController | null,
};

// Track from trace events
trace.subscribe((e) => {
  runtime.events.push(e);
  switch (e.type) {
    case 'task_start':
      runtime.currentTaskId = e.taskId;
      runtime.tasks.set(e.taskId, { id: e.taskId, title: e.data.title, status: 'running', phase: '' });
      break;
    case 'task_done':
      const dt = runtime.tasks.get(e.taskId);
      if (dt) dt.status = 'done';
      break;
    case 'task_skip':
      const st = runtime.tasks.get(e.taskId);
      if (st) { st.status = 'skipped'; st.reason = e.data.reason; }
      break;
    case 'phase_enter':
      const pt = runtime.tasks.get(e.taskId);
      if (pt) pt.phase = e.data.phase;
      break;
  }
});

/** Expose abort controller for task stop */
export function setAbortController(ac: AbortController) {
  runtime.abortController = ac;
}

// ═══════════════════════════════════════════════════════════════
// Server
// ═══════════════════════════════════════════════════════════════

export function startUiServer(): void {
  const app = express();
  app.use(express.json());

  // ── SSE ──────────────────────────────────────────────────
  app.get('/api/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    // Send current state
    res.write(`data: ${JSON.stringify({ type: 'snapshot', tasks: Object.fromEntries(runtime.tasks), currentTaskId: runtime.currentTaskId })}\n\n`);

    const unsub = trace.subscribe((event: TraceEvent) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    req.on('close', unsub);
  });

  // ── API: task list ───────────────────────────────────────
  app.get('/api/tasks', (_req, res) => {
    res.json({ tasks: Object.fromEntries(runtime.tasks), currentTaskId: runtime.currentTaskId });
  });

  // ── API: task events ─────────────────────────────────────
  app.get('/api/tasks/:id/events', (req, res) => {
    const events = runtime.events.filter(e => e.taskId === req.params.id);
    res.json({ events });
  });

  // ── API: stop current task ───────────────────────────────
  app.post('/api/stop', (_req, res) => {
    if (runtime.abortController) {
      runtime.abortController.abort();
      res.json({ ok: true, message: 'Stop signal sent' });
    } else {
      res.json({ ok: false, message: 'No running task' });
    }
  });

  // ── API: state machine definition (for reactflow) ───────
  app.get('/api/machine', (_req, res) => {
    res.json(MACHINE_DEFINITION);
  });

  // ── Dashboard ────────────────────────────────────────────
  app.get('/', (_req, res) => {
    res.type('html').send(dashboardHtml());
  });

  app.listen(UI_PORT, '0.0.0.0', () => {
    console.log(`  [ui] Dashboard: http://localhost:${UI_PORT}`);
  });
}

// ═══════════════════════════════════════════════════════════════
// Machine definition — drives reactflow visualization
// ═══════════════════════════════════════════════════════════════

const MACHINE_DEFINITION = {
  nodes: [
    { id: 'writeTest',         label: 'Write Test',       type: 'action',    x: 0,    y: 150 },
    { id: 'verifyRed',         label: 'Verify RED',       type: 'verify',    x: 250,  y: 150,
      guards: ['test-file-exists', 'test-compiles', 'test-runs', 'tests-fail', 'fails-on-assertion', 'test-sanity'] },
    { id: 'fixTestDiagnosed',  label: 'Fix Test',         type: 'diagnose',  x: 250,  y: 30 },
    { id: 'fixEnv',            label: 'Fix Env',          type: 'diagnose',  x: 500,  y: 30 },
    { id: 'implement',         label: 'Implement',        type: 'action',    x: 500,  y: 150 },
    { id: 'verifyGreen',       label: 'Verify GREEN',     type: 'verify',    x: 750,  y: 150,
      guards: ['source-file-exists', 'source-compiles', 'test-runs', 'tests-pass'] },
    { id: 'diagnose',          label: 'Diagnose',         type: 'diagnose',  x: 750,  y: 280,
      guards: ['diag:structural', 'diag:pattern', 'diag:heuristic', 'diag:model'] },
    { id: 'refactor',          label: 'Refactor',         type: 'action',    x: 1000, y: 150 },
    { id: 'verifyRefactor',    label: 'Verify Refactor',  type: 'verify',    x: 1250, y: 150,
      guards: ['source-compiles', 'test-compiles', 'all-tests-pass'] },
    { id: 'done',              label: 'DONE',             type: 'terminal',  x: 1500, y: 100 },
    { id: 'skipped',           label: 'SKIPPED',          type: 'terminal',  x: 1500, y: 200 },
  ],
  edges: [
    // Main flow
    { id: 'e1',  source: 'writeTest',        target: 'verifyRed',        label: 'code written' },
    { id: 'e2',  source: 'verifyRed',        target: 'implement',        label: 'RED ✓',          type: 'success' },
    { id: 'e5',  source: 'implement',        target: 'verifyGreen',      label: 'code written' },
    { id: 'e6',  source: 'verifyGreen',      target: 'refactor',         label: 'GREEN ✓',        type: 'success' },
    { id: 'e8',  source: 'refactor',         target: 'verifyRefactor',   label: 'code changed' },
    { id: 'e9',  source: 'refactor',         target: 'done',             label: 'no changes' },
    { id: 'e10', source: 'verifyRefactor',   target: 'done',             label: 'pass' },
    // Retry loops
    { id: 'e3',  source: 'verifyRed',        target: 'writeTest',        label: 'retry test',     type: 'retry' },
    { id: 'e7',  source: 'verifyGreen',      target: 'implement',        label: 'retry impl',     type: 'retry' },
    { id: 'e11', source: 'verifyRefactor',   target: 'done',             label: 'fail (accept)',  type: 'retry' },
    // Diagnosis routing
    { id: 'e20', source: 'verifyRed',        target: 'fixTestDiagnosed', label: 'test wrong',     type: 'diagnose' },
    { id: 'e21', source: 'verifyRed',        target: 'fixEnv',           label: 'env wrong',      type: 'diagnose' },
    { id: 'e22', source: 'verifyGreen',      target: 'fixTestDiagnosed', label: 'test wrong',     type: 'diagnose' },
    { id: 'e23', source: 'verifyGreen',      target: 'fixEnv',           label: 'env wrong',      type: 'diagnose' },
    { id: 'e24', source: 'fixTestDiagnosed', target: 'verifyRed',        label: 'recheck' },
    { id: 'e25', source: 'fixEnv',           target: 'verifyRed',        label: 'recheck' },
    { id: 'e26', source: 'fixEnv',           target: 'verifyGreen',      label: 'recheck' },
    // Skip path
    { id: 'e4',  source: 'verifyRed',        target: 'refactor',         label: 'already green',  type: 'skip' },
    // Terminal failures
    { id: 'e12', source: 'verifyRed',        target: 'skipped',          label: 'max retries',    type: 'fail' },
    { id: 'e13', source: 'verifyGreen',      target: 'skipped',          label: 'max retries',    type: 'fail' },
    { id: 'e14', source: 'writeTest',        target: 'skipped',          label: 'max retries',    type: 'fail' },
    { id: 'e15', source: 'implement',        target: 'skipped',          label: 'max retries',    type: 'fail' },
  ],
};

// ═══════════════════════════════════════════════════════════════
// Dashboard HTML
// ═══════════════════════════════════════════════════════════════

function dashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>TDD Tooler</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: { extend: {
        colors: {
          surface: { DEFAULT: '#0f1117', 2: '#161922', 3: '#1e2130' },
          accent: { DEFAULT: '#6366f1', dim: '#4f46e5' },
          ok: '#22c55e', fail: '#ef4444', warn: '#f59e0b', muted: '#6b7280',
        },
        fontFamily: { mono: ['JetBrains Mono','Fira Code','monospace'] },
      }}
    }
  </script>
  <style>
    * { scrollbar-width: thin; scrollbar-color: #374151 transparent; }
    .fade-in { animation: fadeIn 0.15s ease-out; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; } }
    @keyframes pulse-border { 0%,100% { border-color: rgba(99,102,241,0.3); } 50% { border-color: rgba(99,102,241,0.8); } }
    .node-active { animation: pulse-border 1.5s ease-in-out infinite; }
    pre { white-space: pre-wrap; word-break: break-word; }
    .diff-add { color: #22c55e; background: rgba(34,197,94,0.06); }
    .diff-rm  { color: #ef4444; background: rgba(239,68,68,0.06); }
    .tab-active { border-bottom: 2px solid #6366f1; color: #e5e7eb; }
    .tab-inactive { border-bottom: 2px solid transparent; color: #6b7280; }
    /* State graph canvas */
    #graph-canvas { position: relative; overflow-x: auto; }
    .graph-node { position: absolute; border-radius: 8px; padding: 8px 14px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; cursor: pointer; transition: all 0.2s; border: 2px solid transparent; }
    .graph-node.action { background: #1e293b; color: #93c5fd; border-color: #334155; }
    .graph-node.verify { background: #1a1a2e; color: #c4b5fd; border-color: #312e81; }
    .graph-node.terminal { background: #0f1117; color: #6b7280; border-color: #374151; font-size: 10px; }
    .graph-node.diagnose { background: #1a1510; color: #fbbf24; border-color: #78350f; }
    .graph-node.active { border-color: #6366f1; box-shadow: 0 0 20px rgba(99,102,241,0.3); }
    .graph-node.passed { border-color: #22c55e; }
    .graph-node.failed { border-color: #ef4444; }
    .guard-pill { display: inline-block; padding: 1px 6px; border-radius: 9999px; font-size: 9px; margin: 1px; }
    .guard-pill.pass { background: rgba(34,197,94,0.15); color: #22c55e; }
    .guard-pill.fail { background: rgba(239,68,68,0.15); color: #ef4444; }
    .guard-pill.pending { background: rgba(107,114,128,0.15); color: #6b7280; }
  </style>
</head>
<body class="bg-surface text-gray-200 font-mono text-sm min-h-screen flex flex-col">

<!-- Header -->
<header class="border-b border-gray-800 px-4 py-2 flex items-center justify-between sticky top-0 bg-surface/95 backdrop-blur z-50">
  <div class="flex items-center gap-3">
    <span class="text-base font-bold text-accent">⚡ TDD Tooler</span>
    <span id="status" class="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-gray-700 text-gray-300">connecting</span>
    <span class="text-[10px] text-muted">Tasks: <span id="taskCount" class="text-gray-300">0/0</span></span>
  </div>
  <div class="flex items-center gap-2">
    <button onclick="stopTask()" class="px-2 py-1 rounded text-[10px] bg-fail/20 text-fail hover:bg-fail/30 font-bold">⏹ STOP</button>
    <button onclick="toggleAutoScroll()" id="scrollBtn" class="px-2 py-1 rounded text-[10px] bg-surface-3 hover:bg-gray-700">⬇ scroll</button>
  </div>
</header>

<!-- Tabs -->
<div class="border-b border-gray-800 px-4 flex gap-4">
  <button onclick="switchTab('graph')" id="tab-graph" class="py-2 text-xs font-bold tab-active">State Machine</button>
  <button onclick="switchTab('tasks')" id="tab-tasks" class="py-2 text-xs font-bold tab-inactive">Tasks</button>
  <button onclick="switchTab('events')" id="tab-events" class="py-2 text-xs font-bold tab-inactive">Event Log</button>
</div>

<!-- Content -->
<div class="flex flex-1 overflow-hidden">

  <!-- Main panel -->
  <main class="flex-1 overflow-hidden flex flex-col">

    <!-- Tab: State Machine Graph -->
    <div id="panel-graph" class="flex-1 overflow-auto p-4">
      <div id="graph-canvas" class="relative" style="min-height: 350px; min-width: 1600px;">
        <svg id="graph-svg" class="absolute inset-0 w-full h-full" style="pointer-events:none;"></svg>
        <!-- Nodes rendered by JS -->
      </div>
      <!-- Guard detail below graph -->
      <div id="guard-detail" class="mt-4 hidden">
        <h3 class="text-xs font-bold text-muted uppercase mb-2">Guard Checks</h3>
        <div id="guard-pills" class="flex flex-wrap gap-1"></div>
      </div>
    </div>

    <!-- Tab: Tasks -->
    <div id="panel-tasks" class="flex-1 overflow-auto p-4 hidden">
      <div id="task-list" class="space-y-2"></div>
    </div>

    <!-- Tab: Events -->
    <div id="panel-events" class="flex-1 overflow-auto p-4 hidden">
      <div id="events" class="space-y-0.5"></div>
    </div>
  </main>

  <!-- Detail panel (right) -->
  <aside id="detailPanel" class="w-[500px] border-l border-gray-800 overflow-y-auto p-4 flex-shrink-0 hidden">
    <div class="flex items-center justify-between mb-3">
      <h2 class="text-xs font-bold text-muted uppercase">Detail</h2>
      <button onclick="closeDetail()" class="text-muted hover:text-gray-300 text-lg leading-none">&times;</button>
    </div>
    <div id="detailContent"></div>
  </aside>
</div>

<script>
// ═══════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════
const S = {
  events: [],
  tasks: {},
  currentTask: null,
  currentPhase: null,
  guardResults: {},   // nodeId -> [{name,ok,detail}]
  phaseHistory: [],   // which phases have been visited
  autoScroll: true,
  machineDef: null,
  completed: 0,
  total: 0,
};

// ═══════════════════════════════════════════════════════════════
// Tabs
// ═══════════════════════════════════════════════════════════════
function switchTab(tab) {
  ['graph','tasks','events'].forEach(t => {
    document.getElementById('panel-'+t).classList.toggle('hidden', t !== tab);
    document.getElementById('tab-'+t).className = 'py-2 text-xs font-bold ' + (t === tab ? 'tab-active' : 'tab-inactive');
  });
}

// ═══════════════════════════════════════════════════════════════
// SSE
// ═══════════════════════════════════════════════════════════════
function connect() {
  const es = new EventSource('/api/events');
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    if (ev.type === 'snapshot') {
      // Initial state
      Object.entries(ev.tasks||{}).forEach(([id,t]) => { S.tasks[id] = t; });
      S.currentTask = ev.currentTaskId;
      S.total = Object.keys(S.tasks).length;
      S.completed = Object.values(S.tasks).filter(t => t.status === 'done').length;
      updateUI();
      return;
    }
    handleEvent(ev);
  };
  es.onopen = () => {
    document.getElementById('status').textContent = 'live';
    document.getElementById('status').className = 'px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-ok/20 text-ok';
  };
  es.onerror = () => {
    document.getElementById('status').textContent = 'disconnected';
    document.getElementById('status').className = 'px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-fail/20 text-fail';
  };
}

function handleEvent(e) {
  S.events.push(e);

  switch (e.type) {
    case 'task_start':
      S.currentTask = e.taskId;
      S.tasks[e.taskId] = { id: e.taskId, title: e.data.title, status: 'running', phase: '' };
      S.total = Object.keys(S.tasks).length;
      S.guardResults = {};
      S.phaseHistory = [];
      break;
    case 'task_done':
      if (S.tasks[e.taskId]) S.tasks[e.taskId].status = 'done';
      S.completed = Object.values(S.tasks).filter(t => t.status === 'done').length;
      break;
    case 'task_skip':
      if (S.tasks[e.taskId]) { S.tasks[e.taskId].status = 'skipped'; S.tasks[e.taskId].reason = e.data.reason; }
      break;
    case 'phase_enter':
      S.currentPhase = e.data.phase;
      if (S.tasks[e.taskId]) S.tasks[e.taskId].phase = e.data.phase;
      S.phaseHistory.push(e.data.phase);
      break;
    case 'guard_result':
      if (!S.guardResults[S.currentPhase]) S.guardResults[S.currentPhase] = [];
      S.guardResults[S.currentPhase].push({ name: e.data.name, ok: e.data.ok, detail: e.data.detail });
      break;
  }

  updateUI();
  appendEventRow(e);
}

// ═══════════════════════════════════════════════════════════════
// UI Updates
// ═══════════════════════════════════════════════════════════════
function updateUI() {
  document.getElementById('taskCount').textContent = S.completed + '/' + S.total;
  renderGraph();
  renderTaskList();
}

// ═══════════════════════════════════════════════════════════════
// State Machine Graph
// ═══════════════════════════════════════════════════════════════
async function initGraph() {
  const res = await fetch('/api/machine');
  S.machineDef = await res.json();
  renderGraph();
}

function renderGraph() {
  if (!S.machineDef) return;
  const canvas = document.getElementById('graph-canvas');
  const svg = document.getElementById('graph-svg');

  // Clear non-svg children
  Array.from(canvas.children).forEach(c => { if (c !== svg) c.remove(); });
  svg.innerHTML = '';

  const { nodes, edges } = S.machineDef;
  const SCALE = 1;
  const PAD = 40;

  // Draw edges
  for (const edge of edges) {
    const src = nodes.find(n => n.id === edge.source);
    const tgt = nodes.find(n => n.id === edge.target);
    if (!src || !tgt) continue;

    const sx = src.x * SCALE + PAD + 60;
    const sy = src.y * SCALE + PAD + 18;
    const tx = tgt.x * SCALE + PAD;
    const ty = tgt.y * SCALE + PAD + 18;

    // Is this edge active?
    const isActiveEdge = S.phaseHistory.length > 1 && (() => {
      for (let i = 0; i < S.phaseHistory.length - 1; i++) {
        if (S.phaseHistory[i] === edge.source && S.phaseHistory[i+1] === edge.target) return true;
      }
      return false;
    })();

    const color = edge.type === 'success' ? '#22c55e' :
                  edge.type === 'retry' ? '#f59e0b' :
                  edge.type === 'fail' ? '#ef4444' :
                  edge.type === 'skip' ? '#6b7280' :
                  edge.type === 'diagnose' ? '#fbbf24' : '#374151';

    const opacity = isActiveEdge ? 0.9 : 0.3;

    // Bezier curve
    const mx = (sx + tx) / 2;
    const isSelfLoop = edge.source === edges.find(e2 => e2.target === edge.source)?.source;
    let path;
    if (tx < sx) {
      // Backward edge (retry) — arc above/below
      const arcY = sy < ty ? Math.min(sy, ty) - 50 : Math.max(sy, ty) + 50;
      path = 'M ' + sx + ' ' + sy + ' C ' + sx + ' ' + arcY + ', ' + tx + ' ' + arcY + ', ' + tx + ' ' + ty;
    } else {
      path = 'M ' + sx + ' ' + sy + ' C ' + mx + ' ' + sy + ', ' + mx + ' ' + ty + ', ' + tx + ' ' + ty;
    }

    const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    pathEl.setAttribute('d', path);
    pathEl.setAttribute('stroke', color);
    pathEl.setAttribute('stroke-width', isActiveEdge ? '2.5' : '1.5');
    pathEl.setAttribute('fill', 'none');
    pathEl.setAttribute('opacity', String(opacity));
    if (!isActiveEdge) pathEl.setAttribute('stroke-dasharray', '4 3');

    // Arrowhead
    const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
    const mid = 'arrow-' + edge.id;
    marker.setAttribute('id', mid);
    marker.setAttribute('markerWidth', '8');
    marker.setAttribute('markerHeight', '6');
    marker.setAttribute('refX', '8');
    marker.setAttribute('refY', '3');
    marker.setAttribute('orient', 'auto');
    marker.innerHTML = '<polygon points="0 0, 8 3, 0 6" fill="' + color + '" opacity="' + opacity + '"/>';

    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    defs.appendChild(marker);
    svg.appendChild(defs);
    pathEl.setAttribute('marker-end', 'url(#' + mid + ')');
    svg.appendChild(pathEl);

    // Edge label
    if (edge.label && isActiveEdge) {
      const labelEl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      labelEl.setAttribute('x', String(mx));
      labelEl.setAttribute('y', String(Math.min(sy, ty) - 8));
      labelEl.setAttribute('text-anchor', 'middle');
      labelEl.setAttribute('fill', color);
      labelEl.setAttribute('font-size', '9');
      labelEl.setAttribute('font-family', 'monospace');
      labelEl.textContent = edge.label;
      svg.appendChild(labelEl);
    }
  }

  // Draw nodes
  for (const node of nodes) {
    const el = document.createElement('div');
    const isActive = S.currentPhase === node.id;
    const wasVisited = S.phaseHistory.includes(node.id);
    const isDone = node.id === 'done' && Object.values(S.tasks).some(t => t.status === 'done' && t.id === S.currentTask);
    const isSkipped = node.id === 'skipped' && Object.values(S.tasks).some(t => t.status === 'skipped' && t.id === S.currentTask);

    let stateClass = node.type;
    if (isActive) stateClass += ' active node-active';
    else if (isDone || (wasVisited && !isActive)) stateClass += ' passed';
    else if (isSkipped) stateClass += ' failed';

    el.className = 'graph-node ' + stateClass;
    el.style.left = (node.x * SCALE + PAD) + 'px';
    el.style.top = (node.y * SCALE + PAD) + 'px';
    el.innerHTML = node.label;

    // Guard pills under verify nodes
    if (node.guards && node.guards.length > 0) {
      const guardDiv = document.createElement('div');
      guardDiv.className = 'mt-1 flex flex-wrap gap-0.5';
      const results = S.guardResults[node.id] || [];
      for (const g of node.guards) {
        const r = results.find(r => r.name === g);
        const cls = r ? (r.ok ? 'pass' : 'fail') : 'pending';
        const pill = document.createElement('span');
        pill.className = 'guard-pill ' + cls;
        pill.textContent = g.replace('check-','').replace('test-','t:').replace('source-','s:').replace('fails-on-','');
        pill.title = r ? r.detail : 'pending';
        pill.onclick = (ev) => { ev.stopPropagation(); showGuardDetail(g, r); };
        guardDiv.appendChild(pill);
      }
      el.appendChild(guardDiv);
    }

    el.onclick = () => showNodeDetail(node);
    canvas.appendChild(el);
  }
}

function showGuardDetail(name, result) {
  if (!result) return;
  showDetailPanel('Guard: ' + name, '<pre class="bg-surface-3 rounded p-3 text-xs border border-gray-800">' + esc(result.detail) + '</pre>');
}

function showNodeDetail(node) {
  let html = '<div class="space-y-3">';
  html += '<h3 class="font-bold text-accent">' + node.label + '</h3>';
  html += '<div class="text-xs text-muted">Type: ' + node.type + '</div>';
  if (node.guards) {
    html += '<h4 class="text-xs font-bold text-muted uppercase mt-3">Guards (in order)</h4>';
    html += '<ol class="list-decimal list-inside text-xs space-y-1">';
    const results = S.guardResults[node.id] || [];
    for (const g of node.guards) {
      const r = results.find(r => r.name === g);
      const icon = r ? (r.ok ? '✓' : '✗') : '○';
      const color = r ? (r.ok ? 'text-ok' : 'text-fail') : 'text-muted';
      html += '<li class="' + color + '">' + icon + ' ' + g;
      if (r && !r.ok) html += '<pre class="ml-4 text-[10px] text-fail/70 mt-0.5">' + esc(r.detail) + '</pre>';
      html += '</li>';
    }
    html += '</ol>';
  }
  // Show events for this phase
  const phaseEvents = S.events.filter(e => e.phase === node.id && e.taskId === S.currentTask);
  if (phaseEvents.length > 0) {
    html += '<h4 class="text-xs font-bold text-muted uppercase mt-3">Events (' + phaseEvents.length + ')</h4>';
    html += '<div class="space-y-1 max-h-[400px] overflow-y-auto">';
    for (const e of phaseEvents) {
      const { icon, summary } = fmtEvent(e);
      html += '<div class="text-[10px] text-gray-400 cursor-pointer hover:text-gray-200" onclick=\\'showEventDetail(' + S.events.indexOf(e) + ')\\'>' + icon + ' ' + esc(summary).slice(0,100) + '</div>';
    }
    html += '</div>';
  }
  html += '</div>';
  showDetailPanel('Node: ' + node.label, html);
}

// ═══════════════════════════════════════════════════════════════
// Task List
// ═══════════════════════════════════════════════════════════════
function renderTaskList() {
  const container = document.getElementById('task-list');
  container.innerHTML = '';

  for (const [id, t] of Object.entries(S.tasks)) {
    const el = document.createElement('div');
    const isCurrent = id === S.currentTask && t.status === 'running';
    const bg = isCurrent ? 'border-accent/40 bg-accent/5' : t.status === 'done' ? 'border-ok/20 bg-ok/5' : t.status === 'skipped' ? 'border-fail/20 bg-fail/5' : 'border-gray-800 bg-surface-2';

    const icon = t.status === 'done' ? '✅' : t.status === 'skipped' ? '⛔' : t.status === 'running' ? '🔄' : '○';

    el.className = 'border rounded-lg p-3 ' + bg;
    el.innerHTML =
      '<div class="flex items-center justify-between">' +
        '<div class="flex items-center gap-2">' +
          '<span>' + icon + '</span>' +
          '<span class="font-bold text-xs">' + id + '</span>' +
          '<span class="text-xs text-muted">' + esc(t.title || '') + '</span>' +
        '</div>' +
        '<div class="flex items-center gap-2">' +
          (isCurrent ? '<span class="px-2 py-0.5 rounded text-[9px] font-bold bg-accent/20 text-accent uppercase">' + (t.phase || '…') + '</span>' : '') +
          '<button onclick="viewTaskEvents(\\'' + id + '\\')" class="px-2 py-0.5 rounded text-[9px] bg-surface-3 hover:bg-gray-700 text-muted">events</button>' +
        '</div>' +
      '</div>' +
      (t.reason ? '<div class="text-[10px] text-fail/70 mt-1">' + esc(t.reason) + '</div>' : '');

    container.appendChild(el);
  }
}

function viewTaskEvents(taskId) {
  switchTab('events');
  const container = document.getElementById('events');
  container.innerHTML = '';
  const taskEvents = S.events.filter(e => e.taskId === taskId);
  for (const e of taskEvents) appendEventRow(e);
}

// ═══════════════════════════════════════════════════════════════
// Event Log
// ═══════════════════════════════════════════════════════════════
function appendEventRow(e) {
  const container = document.getElementById('events');
  const row = document.createElement('div');
  row.className = 'fade-in flex items-start gap-2 py-0.5 px-2 rounded hover:bg-surface-2 cursor-pointer';
  row.onclick = () => showEventDetail(S.events.indexOf(e));

  const time = e.ts.split('T')[1].split('.')[0];
  const { icon, color, summary } = fmtEvent(e);

  row.innerHTML =
    '<span class="text-muted text-[9px] w-14 flex-shrink-0 pt-0.5">' + time + '</span>' +
    '<span class="w-4 text-center flex-shrink-0">' + icon + '</span>' +
    '<span class="' + color + ' text-[10px] w-24 flex-shrink-0 truncate font-semibold">' + e.type + '</span>' +
    '<span class="text-[10px] text-gray-400 truncate flex-1">' + esc(summary) + '</span>';

  container.appendChild(row);
  if (S.autoScroll) {
    const panel = document.getElementById('panel-events');
    panel.scrollTop = panel.scrollHeight;
  }
}

function fmtEvent(e) {
  switch (e.type) {
    case 'task_start':       return { icon: '🚀', color: 'text-accent',  summary: e.data.title || e.taskId };
    case 'task_done':        return { icon: '✅', color: 'text-ok',      summary: e.taskId };
    case 'task_skip':        return { icon: '⛔', color: 'text-fail',    summary: e.data.reason || '' };
    case 'phase_enter':      return { icon: '▸',  color: 'text-accent',  summary: e.data.phase + ' [' + e.data.attempt + '/' + e.data.maxAttempts + ']' };
    case 'phase_exit':       return { icon: '◂',  color: 'text-muted',   summary: e.data.phase + ' → ' + e.data.nextPhase };
    case 'guard_result':     return { icon: e.data.ok ? '✓' : '✗', color: e.data.ok ? 'text-ok' : 'text-fail', summary: e.data.name + ': ' + (e.data.detail||'').split('\\n')[0] };
    case 'model_request':    return { icon: '→',  color: 'text-warn',    summary: e.data.promptType + ' (' + e.data.promptChars + 'ch)' };
    case 'model_done':       return { icon: '←',  color: 'text-warn',    summary: (e.data.outputChars||0) + 'ch ' + (e.data.codeBlocks||0) + 'blk' };
    case 'model_empty':      return { icon: '⚠',  color: 'text-fail',    summary: e.data.reason };
    case 'code_apply':       return { icon: '📝', color: 'text-ok',      summary: e.data.file + ' (' + e.data.chars + 'ch) ' + (e.data.isNew ? 'NEW' : 'UPD') };
    case 'test_result':      return { icon: e.data.passed ? '✓' : '✗', color: e.data.passed ? 'text-ok' : 'text-fail', summary: (e.data.passedTests||0) + '/' + (e.data.totalTests||0) + ' pass' };
    case 'test_error_detail':return { icon: '🔍', color: 'text-fail',    summary: (e.data.details||[])[0] || '' };
    case 'file_diff':        return { icon: '±',  color: 'text-muted',   summary: e.data.file + ' +' + e.data.added + ' -' + e.data.removed };
    case 'retry':            return { icon: '↩',  color: 'text-warn',    summary: e.data.phase + ': ' + e.data.reason };
    case 'error':            return { icon: '❌', color: 'text-fail',    summary: e.data.message };
    default:                 return { icon: '·',  color: 'text-muted',   summary: JSON.stringify(e.data).slice(0,80) };
  }
}

// ═══════════════════════════════════════════════════════════════
// Detail Panel
// ═══════════════════════════════════════════════════════════════
function showEventDetail(idx) {
  const e = S.events[idx];
  if (!e) return;

  let html = '<div class="space-y-3">';
  html += '<div class="flex items-center gap-2"><span class="px-2 py-0.5 rounded text-[10px] font-bold bg-accent/20 text-accent">' + e.type + '</span><span class="text-[10px] text-muted">' + e.ts + '</span></div>';
  html += '<div class="text-[10px] text-muted">Task: ' + e.taskId + ' | Phase: ' + (e.phase||'-') + '</div>';

  switch (e.type) {
    case 'model_request':
      html += sec('Prompt (' + e.data.promptType + ')', '<pre class="bg-surface-3 rounded p-3 text-[10px] max-h-[500px] overflow-y-auto border border-gray-800">' + esc(e.data.prompt||'') + '</pre>');
      break;
    case 'model_done':
      html += sec('Output', '<pre class="bg-surface-3 rounded p-3 text-[10px] max-h-[500px] overflow-y-auto border border-gray-800">' + highlightCode(e.data.output||'') + '</pre>');
      if (e.data.thinking) html += sec('🧠 Thinking', '<pre class="bg-surface-3 rounded p-3 text-[10px] max-h-[200px] overflow-y-auto border border-warn/20 text-warn/60">' + esc(e.data.thinking) + '</pre>');
      break;
    case 'code_apply':
      html += sec('File: ' + e.data.file, e.data.diff
        ? '<pre class="bg-surface-3 rounded p-3 text-[10px] max-h-[500px] overflow-y-auto border border-gray-800">' + renderDiff(e.data.diff) + '</pre>'
        : '<pre class="bg-surface-3 rounded p-3 text-[10px] max-h-[500px] overflow-y-auto border border-gray-800">' + esc(e.data.content||'(update)') + '</pre>'
      );
      break;
    case 'test_result':
      html += sec('Test Output', '<pre class="bg-surface-3 rounded p-3 text-[10px] max-h-[500px] overflow-y-auto border border-gray-800">' + esc(e.data.output||'') + '</pre>');
      break;
    case 'test_error_detail':
      html += sec('Error Details', '<pre class="bg-surface-3 rounded p-3 text-[10px] max-h-[500px] overflow-y-auto border border-fail/20 text-fail/80">' + esc((e.data.details||[]).join('\\n')) + '</pre>');
      break;
    case 'guard_result':
      html += sec('Guard: ' + e.data.name, '<pre class="bg-surface-3 rounded p-3 text-[10px] border border-gray-800">' + esc(e.data.detail||'') + '</pre>');
      break;
    default:
      html += sec('Data', '<pre class="bg-surface-3 rounded p-3 text-[10px] max-h-[500px] overflow-y-auto border border-gray-800">' + esc(JSON.stringify(e.data,null,2)) + '</pre>');
  }
  html += '</div>';
  showDetailPanel(e.type, html);
}

function showDetailPanel(title, html) {
  document.getElementById('detailPanel').classList.remove('hidden');
  document.getElementById('detailContent').innerHTML = html;
}
function closeDetail() { document.getElementById('detailPanel').classList.add('hidden'); }

function sec(title, content) {
  return '<h4 class="text-[10px] font-bold text-muted uppercase mt-3">' + title + '</h4>' + content;
}

// ═══════════════════════════════════════════════════════════════
// Actions
// ═══════════════════════════════════════════════════════════════
async function stopTask() {
  const res = await fetch('/api/stop', { method: 'POST' });
  const data = await res.json();
  if (!data.ok) alert(data.message);
}

function toggleAutoScroll() {
  S.autoScroll = !S.autoScroll;
  document.getElementById('scrollBtn').textContent = S.autoScroll ? '⬇ scroll' : '⏸ paused';
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════
function esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function highlightCode(s) { return esc(s).replace(/\`\`\`(\\S*)/g, '<span class="text-accent font-bold">\`\`\`$1</span>'); }
function renderDiff(d) {
  return (d||'').split('\\n').map(l => {
    if (l.startsWith('+') && !l.startsWith('+++')) return '<span class="diff-add">' + esc(l) + '</span>';
    if (l.startsWith('-') && !l.startsWith('---')) return '<span class="diff-rm">' + esc(l) + '</span>';
    return esc(l);
  }).join('\\n');
}

// ═══════════════════════════════════════════════════════════════
// Init
// ═══════════════════════════════════════════════════════════════
connect();
initGraph();
</script>
</body>
</html>`;
}
