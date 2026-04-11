import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from 'fs';
import { join, basename } from 'path';
import { execSync } from 'child_process';
import { trace } from './trace.js';

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
      tasksDone, tasksTotal,
    };
  }

  /** Create project from ready plan */
  createFromPlan(id: string, planContent: string): ProjectInfo {
    const path = join(this.root, id);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'plan.md'), planContent, 'utf-8');
    mkdirSync(join(path, '.tooler'), { recursive: true });
    trace.emit('task_start', { title: `Created project: ${id}` });
    return this.getProjectInfo(id)!;
  }

  /** Create empty project folder */
  createEmpty(id: string): ProjectInfo {
    const path = join(this.root, id);
    mkdirSync(path, { recursive: true });
    mkdirSync(join(path, '.tooler'), { recursive: true });
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
}
