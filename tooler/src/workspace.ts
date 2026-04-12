import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from 'fs';
import { join, basename } from 'path';
import { execSync } from 'child_process';
import { trace } from './trace.js';
import { ScriptManager } from './project-scripts.js';

// ═══════════════════════════════════════════════════════════════
// Workspace — manages multiple projects under a root dir
// ═══════════════════════════════════════════════════════════════

export interface ProjectInfo {
  id: string;           // folder name
  path: string;         // absolute path
  name: string;         // display name from plan or package.json
  status: 'idle' | 'running' | 'done' | 'error';
  hasplan: boolean;
  hasPkg: boolean;
  hasScripts: boolean;
  tasksDone: number;
  tasksTotal: number;
}

export class Workspace {
  private root: string;

  constructor(root: string) {
    this.root = root;
    if (!existsSync(root)) mkdirSync(root, { recursive: true });
  }

  /** List all projects in workspace */
  list(): ProjectInfo[] {
    const entries = readdirSync(this.root, { withFileTypes: true });
    return entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map(e => this.getProjectInfo(e.name))
      .filter(Boolean) as ProjectInfo[];
  }

  /** Get info for one project */
  getProjectInfo(id: string): ProjectInfo | null {
    const path = join(this.root, id);
    if (!existsSync(path)) return null;

    const planPath = join(path, 'plan.md');
    const pkgPath = join(path, 'package.json');
    const scriptsPath = join(path, '.scripts');
    const progressPath = join(path, '.tooler', 'progress.json');

    let name = id;
    if (existsSync(pkgPath)) {
      try { name = JSON.parse(readFileSync(pkgPath, 'utf-8')).name || id; } catch { /* */ }
    }
    if (existsSync(planPath)) {
      try {
        const first = readFileSync(planPath, 'utf-8').split('\n').find(l => l.startsWith('# '));
        if (first) name = first.slice(2).trim();
      } catch { /* */ }
    }

    let tasksDone = 0, tasksTotal = 0;
    if (existsSync(progressPath)) {
      try {
        const p = JSON.parse(readFileSync(progressPath, 'utf-8'));
        tasksDone = p.completedTasks?.length || 0;
        tasksTotal = tasksDone + (p.skippedTasks?.length || 0);
      } catch { /* */ }
    }

    return {
      id, path, name,
      status: 'idle',
      hasplan: existsSync(planPath),
      hasPkg: existsSync(pkgPath),
      hasScripts: existsSync(scriptsPath),
      tasksDone, tasksTotal,
    };
  }

  /** Create project from ready plan */
  createFromPlan(id: string, planContent: string): ProjectInfo {
    const path = join(this.root, id);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'plan.md'), planContent, 'utf-8');
    mkdirSync(join(path, '.tooler'), { recursive: true });
    this.prepopulateProject(path);
    trace.emit('task_start', { title: `Created project: ${id}` });
    return this.getProjectInfo(id)!;
  }

  /** Create empty project folder with working defaults */
  createEmpty(id: string): ProjectInfo {
    const path = join(this.root, id);
    mkdirSync(path, { recursive: true });
    mkdirSync(join(path, '.tooler'), { recursive: true });
    this.prepopulateProject(path);
    return this.getProjectInfo(id)!;
  }

  /** Get project path */
  projectPath(id: string): string {
    return join(this.root, id);
  }

  /** Check project exists */
  exists(id: string): boolean {
    return existsSync(join(this.root, id));
  }

  // ── Private ────────────────────────────────────────────────

  /**
   * Prepopulate a new project with minimal working structure.
   * Ensures "no setup command found" never happens on fresh project.
   */
  private prepopulateProject(projectPath: string): void {
    // 1. Create package.json if missing
    const pkgPath = join(projectPath, 'package.json');
    if (!existsSync(pkgPath)) {
      const name = basename(projectPath);
      writeFileSync(pkgPath, JSON.stringify({
        name,
        version: '0.1.0',
        private: true,
        type: 'module',
        scripts: {
          test: 'vitest --run',
          dev: 'vite',
          build: 'tsc && vite build',
          lint: 'eslint src/ --ext .ts,.tsx',
        },
        devDependencies: {},
      }, null, 2), 'utf-8');
    }

    // 2. Write .scripts/ with working defaults
    const sm = new ScriptManager(projectPath);
    sm.writeDefaults();

    // 3. Create src/ dir
    const srcDir = join(projectPath, 'src');
    if (!existsSync(srcDir)) mkdirSync(srcDir, { recursive: true });
  }
}
