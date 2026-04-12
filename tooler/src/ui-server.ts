import express from 'express';
import { trace } from './trace.js';
import type { TraceEvent } from './trace.js';
import { ToolRegistry } from './tools.js';
import { Workspace } from './workspace.js';
import type { ToolerConfig } from './types.js';

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

export function startUiServer(config: ToolerConfig): void {
  const app = express();
  app.use(express.json());

  const tools = new ToolRegistry(config);
  const workspace = new Workspace(config.workspaceDir);

  // ── SSE ──────────────────────────────────────────────────
  app.get('/api/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(`data: ${JSON.stringify({ type: 'snapshot', tasks: Object.fromEntries(runtime.tasks), currentTaskId: runtime.currentTaskId })}\n\n`);
    const unsub = trace.subscribe((event: TraceEvent) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    req.on('close', unsub);
  });

  // ── API: tasks ──────────────────────────────────────────
  app.get('/api/tasks', (_req, res) => {
    res.json({ tasks: Object.fromEntries(runtime.tasks), currentTaskId: runtime.currentTaskId });
  });
  app.get('/api/tasks/:id/events', (req, res) => {
    const events = runtime.events.filter(e => e.taskId === req.params.id);
    res.json({ events });
  });

  // ── API: stop ───────────────────────────────────────────
  app.post('/api/stop', (_req, res) => {
    if (runtime.abortController) {
      runtime.abortController.abort();
      res.json({ ok: true, message: 'Stop signal sent' });
    } else {
      res.json({ ok: false, message: 'No running task' });
    }
  });

  // ── API: state machine def ──────────────────────────────
  app.get('/api/machine', (_req, res) => {
    res.json(MACHINE_DEFINITION);
  });

  // ── API: tools ──────────────────────────────────────────
  app.get('/api/tools', (_req, res) => {
    res.json({ tools: tools.listTools() });
  });

  app.post('/api/tools/:id', async (req, res) => {
    // tool IDs like "test.run" — dots are fine in Express params
    const result = await tools.exec(req.params.id, req.body || {});
    res.json(result);
  });

  // ── API: recipes ────────────────────────────────────────
  app.get('/api/recipes', (_req, res) => {
    res.json({ recipes: tools.getRecipes().list() });
  });

  // ── API: workspace ──────────────────────────────────────
  app.get('/api/projects', (_req, res) => {
    res.json({ projects: workspace.list() });
  });
  app.post('/api/projects', (req, res) => {
    const { id, plan } = req.body;
    if (!id) return res.status(400).json({ error: 'id required' });
    const p = plan ? workspace.createFromPlan(id, plan) : workspace.createEmpty(id);
    res.json({ project: p });
  });

  // ── Dashboard ───────────────────────────────────────────
  app.get('/', (_req, res) => {
    res.type('html').send(dashboardHtml());
  });

  app.listen(UI_PORT, '0.0.0.0', () => {
    console.log(`  [ui] Dashboard: http://localhost:${UI_PORT}`);
  });
}

// ═══════════════════════════════════════════════════════════════
// Machine definition
// ═══════════════════════════════════════════════════════════════

const MACHINE_DEFINITION = {
  nodes: [
    { id: 'writeTest',         label: 'Write Test',       type: 'action',    x: 0,    y: 150 },
    { id: 'verifyRed',         label: 'Verify RED',       type: 'verify',    x: 250,  y: 150,
      guards: ['test-file-exists', 'test-api-valid', 'test-compiles', 'test-runs', 'tests-fail', 'fails-on-assertion', 'test-sanity'] },
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
    { id: 'e1',  source: 'writeTest',        target: 'verifyRed',        label: 'code written' },
    { id: 'e2',  source: 'verifyRed',        target: 'implement',        label: 'RED ✓',          type: 'success' },
    { id: 'e5',  source: 'implement',        target: 'verifyGreen',      label: 'code written' },
    { id: 'e6',  source: 'verifyGreen',      target: 'refactor',         label: 'GREEN ✓',        type: 'success' },
    { id: 'e8',  source: 'refactor',         target: 'verifyRefactor',   label: 'code changed' },
    { id: 'e9',  source: 'refactor',         target: 'done',             label: 'no changes' },
    { id: 'e10', source: 'verifyRefactor',   target: 'done',             label: 'pass' },
    { id: 'e3',  source: 'verifyRed',        target: 'writeTest',        label: 'retry test',     type: 'retry' },
    { id: 'e7',  source: 'verifyGreen',      target: 'implement',        label: 'retry impl',     type: 'retry' },
    { id: 'e11', source: 'verifyRefactor',   target: 'done',             label: 'fail (accept)',  type: 'retry' },
    { id: 'e20', source: 'verifyRed',        target: 'fixTestDiagnosed', label: 'test wrong',     type: 'diagnose' },
    { id: 'e21', source: 'verifyRed',        target: 'fixEnv',           label: 'env wrong',      type: 'diagnose' },
    { id: 'e22', source: 'verifyGreen',      target: 'fixTestDiagnosed', label: 'test wrong',     type: 'diagnose' },
    { id: 'e23', source: 'verifyGreen',      target: 'fixEnv',           label: 'env wrong',      type: 'diagnose' },
    { id: 'e24', source: 'fixTestDiagnosed', target: 'verifyRed',        label: 'recheck' },
    { id: 'e25', source: 'fixEnv',           target: 'verifyRed',        label: 'recheck' },
    { id: 'e26', source: 'fixEnv',           target: 'verifyGreen',      label: 'recheck' },
    { id: 'e4',  source: 'verifyRed',        target: 'refactor',         label: 'already green',  type: 'skip' },
    { id: 'e12', source: 'verifyRed',        target: 'skipped',          label: 'max retries',    type: 'fail' },
    { id: 'e13', source: 'verifyGreen',      target: 'skipped',          label: 'max retries',    type: 'fail' },
    { id: 'e14', source: 'writeTest',        target: 'skipped',          label: 'max retries',    type: 'fail' },
    { id: 'e15', source: 'implement',        target: 'skipped',          label: 'max retries',    type: 'fail' },
  ],
};

// ═══════════════════════════════════════════════════════════════
// Dashboard HTML — 3-panel layout
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
    .tool-card { transition: all 0.15s; }
    .tool-card:hover { border-color: #6366f1; background: rgba(99,102,241,0.05); }
    .tool-running { opacity: 0.6; pointer-events: none; }
    .cat-badge { font-size: 9px; padding: 1px 6px; border-radius: 9999px; font-weight: 700; text-transform: uppercase; }
    .cat-test { background: rgba(34,197,94,0.15); color: #22c55e; }
    .cat-build { background: rgba(59,130,246,0.15); color: #60a5fa; }
    .cat-guard { background: rgba(168,85,247,0.15); color: #c084fc; }
    .cat-model { background: rgba(245,158,11,0.15); color: #fbbf24; }
    .cat-shell { background: rgba(107,114,128,0.15); color: #9ca3af; }
    .cat-recipe { background: rgba(236,72,153,0.15); color: #f472b6; }
    .cat-project { background: rgba(20,184,166,0.15); color: #2dd4bf; }
  </style>
</head>
<body class="bg-surface text-gray-200 font-mono text-sm h-screen flex flex-col overflow-hidden">

<!-- Header -->
<header class="border-b border-gray-800 px-4 py-2 flex items-center justify-between flex-shrink-0 bg-surface/95 backdrop-blur z-50">
  <div class="flex items-center gap-3">
    <span class="text-base font-bold text-accent">⚡ TDD Tooler</span>
    <span id="status" class="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-gray-700 text-gray-300">connecting</span>
    <span class="text-[10px] text-muted">Tasks: <span id="taskCount" class="text-gray-300">0/0</span></span>
  </div>
  <div class="flex items-center gap-2">
    <button onclick="stopTask()" class="px-2 py-1 rounded text-[10px] bg-fail/20 text-fail hover:bg-fail/30 font-bold">⏹ STOP</button>
  </div>
</header>

<!-- 3-panel layout -->
<div class="flex flex-1 overflow-hidden">

  <!-- ═══ LEFT PANEL: Projects ═══ -->
  <aside id="leftPanel" class="w-[220px] border-r border-gray-800 flex flex-col flex-shrink-0 bg-surface-2">
    <div class="px-3 py-2 border-b border-gray-800 flex items-center justify-between">
      <span class="text-[10px] font-bold text-muted uppercase">Projects</span>
      <button onclick="showNewProject()" class="text-accent hover:text-white text-lg leading-none" title="New project">+</button>
    </div>
    <!-- New project input (hidden) -->
    <div id="newProjectRow" class="px-3 py-2 border-b border-gray-800 hidden">
      <input id="newProjectId" type="text" placeholder="project-name" class="w-full bg-surface-3 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 focus:border-accent outline-none">
      <div class="flex gap-1 mt-1">
        <button onclick="createProject()" class="flex-1 text-[9px] bg-accent/20 text-accent rounded py-0.5 hover:bg-accent/30">Create</button>
        <button onclick="hideNewProject()" class="flex-1 text-[9px] bg-surface-3 text-muted rounded py-0.5 hover:bg-gray-700">Cancel</button>
      </div>
    </div>
    <div id="projectList" class="flex-1 overflow-y-auto"></div>
    <!-- Task list for active project -->
    <div class="border-t border-gray-800">
      <div class="px-3 py-2 flex items-center justify-between">
        <span class="text-[10px] font-bold text-muted uppercase">Tasks</span>
      </div>
      <div id="taskListSidebar" class="max-h-[250px] overflow-y-auto px-1 pb-2"></div>
    </div>
  </aside>

  <!-- ═══ CENTER PANEL: Control Panel + Chat ═══ -->
  <main class="flex-1 flex flex-col overflow-hidden">
    <!-- Center tabs -->
    <div class="border-b border-gray-800 px-4 flex gap-4 flex-shrink-0">
      <button onclick="switchCenterTab('control')" id="ctab-control" class="py-2 text-xs font-bold tab-active">Control Panel</button>
      <button onclick="switchCenterTab('graph')" id="ctab-graph" class="py-2 text-xs font-bold tab-inactive">State Machine</button>
      <button onclick="switchCenterTab('chat')" id="ctab-chat" class="py-2 text-xs font-bold tab-inactive">Chat</button>
    </div>

    <!-- Tab: Control Panel -->
    <div id="cpanel-control" class="flex-1 overflow-y-auto p-4">
      <!-- Tool filter -->
      <div class="flex items-center gap-2 mb-3 flex-wrap">
        <span class="text-[10px] text-muted font-bold uppercase">Filter:</span>
        <button onclick="filterTools('all')" data-filter="all" class="cat-badge bg-surface-3 text-gray-300 tool-filter active">All</button>
        <button onclick="filterTools('test')" data-filter="test" class="cat-badge cat-test tool-filter">Test</button>
        <button onclick="filterTools('build')" data-filter="build" class="cat-badge cat-build tool-filter">Build</button>
        <button onclick="filterTools('guard')" data-filter="guard" class="cat-badge cat-guard tool-filter">Guard</button>
        <button onclick="filterTools('model')" data-filter="model" class="cat-badge cat-model tool-filter">Model</button>
        <button onclick="filterTools('shell')" data-filter="shell" class="cat-badge cat-shell tool-filter">Shell</button>
        <button onclick="filterTools('project')" data-filter="project" class="cat-badge cat-project tool-filter">Project</button>
        <button onclick="filterTools('recipe')" data-filter="recipe" class="cat-badge cat-recipe tool-filter">Recipe</button>
      </div>
      <!-- Tools grid -->
      <div id="toolsGrid" class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3"></div>
      <!-- Tool result -->
      <div id="toolResult" class="mt-4 hidden">
        <div class="flex items-center justify-between mb-2">
          <h3 class="text-xs font-bold text-muted uppercase">Result</h3>
          <div class="flex items-center gap-2">
            <span id="toolResultStatus" class="cat-badge"></span>
            <span id="toolResultTime" class="text-[9px] text-muted"></span>
            <button onclick="hideToolResult()" class="text-muted hover:text-gray-300 text-lg leading-none">&times;</button>
          </div>
        </div>
        <pre id="toolResultOutput" class="bg-surface-3 rounded p-3 text-[10px] max-h-[400px] overflow-y-auto border border-gray-800"></pre>
      </div>
    </div>

    <!-- Tab: State Machine Graph -->
    <div id="cpanel-graph" class="flex-1 overflow-auto p-4 hidden">
      <div id="graph-canvas" class="relative" style="min-height: 350px; min-width: 1600px;">
        <svg id="graph-svg" class="absolute inset-0 w-full h-full" style="pointer-events:none;"></svg>
      </div>
    </div>

    <!-- Tab: Chat -->
    <div id="cpanel-chat" class="flex-1 flex flex-col hidden">
      <div id="chatMessages" class="flex-1 overflow-y-auto p-4 space-y-3"></div>
      <div class="border-t border-gray-800 p-3 flex gap-2">
        <input id="chatInput" type="text" placeholder="Ask the model anything..." class="flex-1 bg-surface-3 border border-gray-700 rounded px-3 py-2 text-xs text-gray-200 focus:border-accent outline-none" onkeydown="if(event.key==='Enter')sendChat()">
        <button onclick="sendChat()" class="px-4 py-2 rounded text-xs bg-accent hover:bg-accent-dim text-white font-bold">Send</button>
      </div>
    </div>
  </main>

  <!-- ═══ RIGHT PANEL: Logs ═══ -->
  <aside id="rightPanel" class="w-[380px] border-l border-gray-800 flex flex-col flex-shrink-0">
    <div class="border-b border-gray-800 px-3 py-2 flex items-center justify-between">
      <span class="text-[10px] font-bold text-muted uppercase">Event Log</span>
      <div class="flex items-center gap-2">
        <button onclick="clearEvents()" class="text-[9px] text-muted hover:text-gray-300">Clear</button>
        <button onclick="toggleAutoScroll()" id="scrollBtn" class="text-[9px] text-muted hover:text-gray-300">⬇ auto</button>
      </div>
    </div>
    <div id="events" class="flex-1 overflow-y-auto p-2 space-y-0.5"></div>
    <!-- Detail expand area -->
    <div id="eventDetail" class="border-t border-gray-800 max-h-[300px] overflow-y-auto p-3 hidden">
      <div class="flex items-center justify-between mb-2">
        <span class="text-[10px] font-bold text-muted uppercase">Detail</span>
        <button onclick="closeEventDetail()" class="text-muted hover:text-gray-300">&times;</button>
      </div>
      <div id="eventDetailContent"></div>
    </div>
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
  guardResults: {},
  phaseHistory: [],
  autoScroll: true,
  machineDef: null,
  completed: 0,
  total: 0,
  tools: [],
  toolFilter: 'all',
  projects: [],
  activeProject: null,
};

// ═══════════════════════════════════════════════════════════════
// Center Tabs
// ═══════════════════════════════════════════════════════════════
function switchCenterTab(tab) {
  ['control','graph','chat'].forEach(t => {
    document.getElementById('cpanel-'+t).classList.toggle('hidden', t !== tab);
    document.getElementById('ctab-'+t).className = 'py-2 text-xs font-bold ' + (t === tab ? 'tab-active' : 'tab-inactive');
  });
  if (tab === 'graph' && S.machineDef) renderGraph();
}

// ═══════════════════════════════════════════════════════════════
// SSE
// ═══════════════════════════════════════════════════════════════
function connect() {
  const es = new EventSource('/api/events');
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    if (ev.type === 'snapshot') {
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
  renderTaskSidebar();
  renderGraph();
}

// ═══════════════════════════════════════════════════════════════
// Projects Panel
// ═══════════════════════════════════════════════════════════════
async function loadProjects() {
  try {
    const res = await fetch('/api/projects');
    const data = await res.json();
    S.projects = data.projects || [];
    renderProjects();
  } catch { /* offline */ }
}

function renderProjects() {
  const c = document.getElementById('projectList');
  c.innerHTML = '';
  if (S.projects.length === 0) {
    c.innerHTML = '<div class="px-3 py-4 text-[10px] text-muted text-center">No projects yet</div>';
    return;
  }
  for (const p of S.projects) {
    const isActive = S.activeProject === p.id;
    const el = document.createElement('div');
    el.className = 'px-3 py-2 cursor-pointer hover:bg-surface-3 flex items-center gap-2 ' + (isActive ? 'bg-accent/10 border-l-2 border-accent' : '');
    const icon = p.hasplan ? '📋' : '📁';
    const progress = p.tasksTotal > 0 ? ' (' + p.tasksDone + '/' + p.tasksTotal + ')' : '';
    el.innerHTML = '<span>' + icon + '</span><div class="flex-1 min-w-0"><div class="text-xs font-bold truncate">' + esc(p.name) + '</div><div class="text-[9px] text-muted truncate">' + p.id + progress + '</div></div>';
    el.onclick = () => { S.activeProject = p.id; renderProjects(); };
    c.appendChild(el);
  }
}

function showNewProject() { document.getElementById('newProjectRow').classList.remove('hidden'); document.getElementById('newProjectId').focus(); }
function hideNewProject() { document.getElementById('newProjectRow').classList.add('hidden'); }
async function createProject() {
  const id = document.getElementById('newProjectId').value.trim();
  if (!id) return;
  await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
  document.getElementById('newProjectId').value = '';
  hideNewProject();
  loadProjects();
}

// ═══════════════════════════════════════════════════════════════
// Task Sidebar
// ═══════════════════════════════════════════════════════════════
function renderTaskSidebar() {
  const c = document.getElementById('taskListSidebar');
  c.innerHTML = '';
  const tasks = Object.values(S.tasks);
  if (tasks.length === 0) {
    c.innerHTML = '<div class="px-2 py-2 text-[9px] text-muted text-center">No tasks</div>';
    return;
  }
  for (const t of tasks) {
    const el = document.createElement('div');
    const isCurrent = t.id === S.currentTask && t.status === 'running';
    const icon = t.status === 'done' ? '<span class="text-ok">✓</span>' : t.status === 'skipped' ? '<span class="text-fail">✗</span>' : isCurrent ? '<span class="text-accent">▸</span>' : '<span class="text-muted">○</span>';
    el.className = 'px-2 py-1 rounded text-[10px] flex items-center gap-2 hover:bg-surface-3 cursor-pointer ' + (isCurrent ? 'bg-accent/5' : '');
    el.innerHTML = icon + '<span class="truncate flex-1 ' + (isCurrent ? 'text-gray-200' : 'text-muted') + '">' + esc(t.title || t.id) + '</span>' + (isCurrent && t.phase ? '<span class="text-[8px] text-accent bg-accent/10 px-1 rounded">' + t.phase + '</span>' : '');
    el.onclick = () => showTaskEvents(t.id);
    c.appendChild(el);
  }
}

function showTaskEvents(taskId) {
  const c = document.getElementById('events');
  c.innerHTML = '';
  const taskEvents = S.events.filter(e => e.taskId === taskId);
  for (const e of taskEvents) appendEventRow(e);
}

// ═══════════════════════════════════════════════════════════════
// Control Panel — Tools
// ═══════════════════════════════════════════════════════════════
async function loadTools() {
  const [toolsRes, recipesRes] = await Promise.all([
    fetch('/api/tools'),
    fetch('/api/recipes'),
  ]);
  const toolsData = await toolsRes.json();
  const recipesData = await recipesRes.json();
  S.tools = toolsData.tools;

  // Merge recipes into tools list as category 'recipe'
  for (const r of (recipesData.recipes || [])) {
    S.tools.push({
      id: 'recipe.' + r.id,
      name: r.name,
      category: 'recipe',
      description: r.description,
      params: (r.params || []).map(p => ({
        name: p.name,
        type: 'string',
        required: p.required,
        placeholder: p.description + (p.default ? ' [' + p.default + ']' : ''),
      })),
    });
  }
  renderTools();
}

function filterTools(cat) {
  S.toolFilter = cat;
  document.querySelectorAll('.tool-filter').forEach(b => {
    b.classList.toggle('active', b.dataset.filter === cat);
    if (b.dataset.filter === cat) b.style.outline = '1px solid rgba(99,102,241,0.5)';
    else b.style.outline = 'none';
  });
  renderTools();
}

function renderTools() {
  const grid = document.getElementById('toolsGrid');
  grid.innerHTML = '';
  const filtered = S.toolFilter === 'all' ? S.tools : S.tools.filter(t => t.category === S.toolFilter);

  for (const tool of filtered) {
    const card = document.createElement('div');
    card.className = 'tool-card border border-gray-800 rounded-lg p-3 bg-surface-2';
    card.id = 'tool-' + tool.id.replace('.', '-');

    let paramsHtml = '';
    if (tool.params && tool.params.length > 0) {
      paramsHtml = '<div class="mt-2 space-y-1">';
      for (const p of tool.params) {
        paramsHtml += '<input type="text" data-tool="' + tool.id + '" data-param="' + p.name + '" placeholder="' + (p.placeholder || p.name) + (p.required ? ' *' : '') + '" class="w-full bg-surface-3 border border-gray-700 rounded px-2 py-1 text-[10px] text-gray-200 focus:border-accent outline-none">';
      }
      paramsHtml += '</div>';
    }

    card.innerHTML =
      '<div class="flex items-center justify-between mb-1">' +
        '<div class="flex items-center gap-2">' +
          '<span class="cat-badge cat-' + tool.category + '">' + tool.category + '</span>' +
          '<span class="text-xs font-bold text-gray-200">' + tool.name + '</span>' +
        '</div>' +
        '<button onclick="runTool(\\''+tool.id+'\\')" class="px-2 py-0.5 rounded text-[9px] bg-accent/20 text-accent hover:bg-accent/30 font-bold">Run</button>' +
      '</div>' +
      '<div class="text-[10px] text-muted">' + tool.description + '</div>' +
      paramsHtml;

    grid.appendChild(card);
  }
}

async function runTool(toolId) {
  const card = document.getElementById('tool-' + toolId.replace('.', '-'));
  if (card) card.classList.add('tool-running');

  // Gather params
  const params = {};
  document.querySelectorAll('input[data-tool="' + toolId + '"]').forEach(inp => {
    if (inp.value.trim()) params[inp.dataset.param] = inp.value.trim();
  });

  try {
    const res = await fetch('/api/tools/' + toolId, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    const result = await res.json();
    showToolResult(toolId, result);
  } catch (err) {
    showToolResult(toolId, { ok: false, output: err.message, duration: 0 });
  } finally {
    if (card) card.classList.remove('tool-running');
  }
}

function showToolResult(toolId, result) {
  const panel = document.getElementById('toolResult');
  panel.classList.remove('hidden');
  document.getElementById('toolResultStatus').textContent = result.ok ? 'PASS' : 'FAIL';
  document.getElementById('toolResultStatus').className = 'cat-badge ' + (result.ok ? 'cat-test' : 'bg-fail/15 text-fail');
  document.getElementById('toolResultTime').textContent = toolId + ' — ' + result.duration + 'ms';
  document.getElementById('toolResultOutput').textContent = result.output || '(no output)';
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function hideToolResult() { document.getElementById('toolResult').classList.add('hidden'); }

// ═══════════════════════════════════════════════════════════════
// Chat
// ═══════════════════════════════════════════════════════════════
async function sendChat() {
  const inp = document.getElementById('chatInput');
  const prompt = inp.value.trim();
  if (!prompt) return;
  inp.value = '';

  addChatMessage('user', prompt);
  addChatMessage('assistant', '⏳ Thinking...');

  try {
    const res = await fetch('/api/tools/model.chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    const result = await res.json();
    // Replace thinking message
    const msgs = document.getElementById('chatMessages');
    msgs.lastChild.remove();
    addChatMessage('assistant', result.output || '(no response)');
  } catch (err) {
    const msgs = document.getElementById('chatMessages');
    msgs.lastChild.remove();
    addChatMessage('assistant', '❌ ' + err.message);
  }
}

function addChatMessage(role, text) {
  const c = document.getElementById('chatMessages');
  const el = document.createElement('div');
  const isUser = role === 'user';
  el.className = 'rounded-lg p-3 text-xs ' + (isUser ? 'bg-accent/10 border border-accent/20 ml-12' : 'bg-surface-2 border border-gray-800 mr-12');
  el.innerHTML = '<div class="text-[9px] text-muted mb-1 font-bold uppercase">' + role + '</div><pre class="text-gray-200">' + esc(text) + '</pre>';
  c.appendChild(el);
  c.scrollTop = c.scrollHeight;
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
  if (!canvas || !svg) return;

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
    const mx = (sx + tx) / 2;
    let path;
    if (tx < sx) {
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
        pill.onclick = (ev) => { ev.stopPropagation(); showGuardInLog(g, r); };
        guardDiv.appendChild(pill);
      }
      el.appendChild(guardDiv);
    }

    el.onclick = () => showNodeInLog(node);
    canvas.appendChild(el);
  }
}

function showGuardInLog(name, result) {
  if (!result) return;
  showEventDetailContent('Guard: ' + name, '<pre class="bg-surface-3 rounded p-3 text-[10px] border border-gray-800">' + esc(result.detail) + '</pre>');
}

function showNodeInLog(node) {
  let html = '<div class="space-y-2">';
  html += '<h3 class="font-bold text-accent text-xs">' + node.label + '</h3>';
  if (node.guards) {
    html += '<div class="text-[10px]">';
    const results = S.guardResults[node.id] || [];
    for (const g of node.guards) {
      const r = results.find(r => r.name === g);
      const icon = r ? (r.ok ? '✓' : '✗') : '○';
      const color = r ? (r.ok ? 'text-ok' : 'text-fail') : 'text-muted';
      html += '<div class="' + color + '">' + icon + ' ' + g;
      if (r && !r.ok) html += '<pre class="ml-3 text-[9px] text-fail/70">' + esc(r.detail) + '</pre>';
      html += '</div>';
    }
    html += '</div>';
  }
  html += '</div>';
  showEventDetailContent('Node: ' + node.label, html);
}

// ═══════════════════════════════════════════════════════════════
// Event Log (Right Panel)
// ═══════════════════════════════════════════════════════════════
function appendEventRow(e) {
  const container = document.getElementById('events');
  const row = document.createElement('div');
  row.className = 'fade-in flex items-start gap-2 py-0.5 px-1 rounded hover:bg-surface-2 cursor-pointer text-[10px]';
  row.onclick = () => showEventDetail(S.events.indexOf(e));

  const time = e.ts ? e.ts.split('T')[1].split('.')[0] : '';
  const { icon, color, summary } = fmtEvent(e);

  row.innerHTML =
    '<span class="text-muted text-[9px] w-12 flex-shrink-0">' + time + '</span>' +
    '<span class="w-3 text-center flex-shrink-0">' + icon + '</span>' +
    '<span class="' + color + ' w-20 flex-shrink-0 truncate font-semibold">' + e.type + '</span>' +
    '<span class="text-gray-400 truncate flex-1">' + esc(summary) + '</span>';

  container.appendChild(row);
  if (S.autoScroll) container.scrollTop = container.scrollHeight;
}

function clearEvents() { document.getElementById('events').innerHTML = ''; }

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
    case 'code_apply':       return { icon: '📝', color: 'text-ok',      summary: e.data.file + ' (' + e.data.chars + 'ch)' };
    case 'test_result':      return { icon: e.data.passed ? '✓' : '✗', color: e.data.passed ? 'text-ok' : 'text-fail', summary: (e.data.passedTests||0) + '/' + (e.data.totalTests||0) + ' pass' };
    case 'test_error_detail':return { icon: '🔍', color: 'text-fail',    summary: (e.data.details||[])[0] || '' };
    case 'file_diff':        return { icon: '±',  color: 'text-muted',   summary: e.data.file + ' +' + e.data.added + ' -' + e.data.removed };
    case 'retry':            return { icon: '↩',  color: 'text-warn',    summary: e.data.phase + ': ' + e.data.reason };
    case 'error':            return { icon: '❌', color: 'text-fail',    summary: e.data.message };
    default:                 return { icon: '·',  color: 'text-muted',   summary: JSON.stringify(e.data||{}).slice(0,60) };
  }
}

// ═══════════════════════════════════════════════════════════════
// Event Detail (bottom of right panel)
// ═══════════════════════════════════════════════════════════════
function showEventDetail(idx) {
  const e = S.events[idx];
  if (!e) return;

  let html = '<div class="space-y-2">';
  html += '<div class="flex items-center gap-2"><span class="cat-badge bg-accent/20 text-accent">' + e.type + '</span><span class="text-[9px] text-muted">' + e.ts + '</span></div>';

  switch (e.type) {
    case 'model_request':
      html += '<pre class="bg-surface-3 rounded p-2 text-[9px] max-h-[200px] overflow-y-auto border border-gray-800">' + esc(e.data.prompt||'').slice(0, 2000) + '</pre>';
      break;
    case 'model_done':
      html += '<pre class="bg-surface-3 rounded p-2 text-[9px] max-h-[200px] overflow-y-auto border border-gray-800">' + esc(e.data.output||'').slice(0, 2000) + '</pre>';
      if (e.data.thinking) html += '<pre class="bg-surface-3 rounded p-2 text-[9px] max-h-[100px] overflow-y-auto border border-warn/20 text-warn/60 mt-1">' + esc(e.data.thinking).slice(0, 500) + '</pre>';
      break;
    case 'test_result':
      html += '<pre class="bg-surface-3 rounded p-2 text-[9px] max-h-[200px] overflow-y-auto border border-gray-800">' + esc(e.data.output||'').slice(0, 2000) + '</pre>';
      break;
    case 'test_error_detail':
      html += '<pre class="bg-surface-3 rounded p-2 text-[9px] max-h-[200px] overflow-y-auto border border-fail/20 text-fail/80">' + esc((e.data.details||[]).join('\\n')) + '</pre>';
      break;
    case 'guard_result':
      html += '<pre class="bg-surface-3 rounded p-2 text-[9px] border border-gray-800">' + esc(e.data.detail||'') + '</pre>';
      break;
    case 'code_apply':
      html += '<pre class="bg-surface-3 rounded p-2 text-[9px] max-h-[200px] overflow-y-auto border border-gray-800">' + esc(e.data.content||e.data.diff||'(update)').slice(0, 2000) + '</pre>';
      break;
    default:
      html += '<pre class="bg-surface-3 rounded p-2 text-[9px] max-h-[200px] overflow-y-auto border border-gray-800">' + esc(JSON.stringify(e.data,null,2)) + '</pre>';
  }
  html += '</div>';
  showEventDetailContent(e.type, html);
}

function showEventDetailContent(title, html) {
  const panel = document.getElementById('eventDetail');
  panel.classList.remove('hidden');
  document.getElementById('eventDetailContent').innerHTML = html;
}

function closeEventDetail() { document.getElementById('eventDetail').classList.add('hidden'); }

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
  document.getElementById('scrollBtn').textContent = S.autoScroll ? '⬇ auto' : '⏸ paused';
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════
function esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ═══════════════════════════════════════════════════════════════
// Init
// ═══════════════════════════════════════════════════════════════
connect();
initGraph();
loadTools();
loadProjects();
</script>
</body>
</html>`;
}
