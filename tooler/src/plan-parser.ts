import { readFileSync } from 'fs';
import type { Plan, Task } from './types.js';

/**
 * Parse a markdown plan file into structured tasks.
 *
 * Format:
 * # Plan Name
 * ## TASK-01: Title
 * Description text...
 * ### Test Hint
 * what the test should check
 * ### Implementation Hint
 * guidance for implementation
 * ### Files
 * - test: src/__tests__/foo.test.ts
 * - source: src/components/Foo.tsx
 * - create: src/types/foo.ts
 * - modify: src/App.tsx
 */
export function parsePlan(filepath: string): Plan {
  const content = readFileSync(filepath, 'utf-8');
  const lines = content.split('\n');

  let planName = 'Unnamed Plan';
  const tasks: Task[] = [];
  let current: Partial<Task> | null = null;
  let section = '';

  for (const line of lines) {
    // Plan title
    if (line.startsWith('# ') && !line.startsWith('## ')) {
      planName = line.slice(2).trim();
      continue;
    }

    // Task header
    const taskMatch = line.match(/^## (TASK-\d+):\s*(.+)/);
    if (taskMatch) {
      if (current) tasks.push(finalizeTask(current));
      current = {
        id: taskMatch[1],
        title: taskMatch[2],
        description: '',
        testHint: '',
        implementHint: '',
        filesToCreate: [],
        filesToModify: [],
        testFile: '',
        sourceFile: '',
      };
      section = 'description';
      continue;
    }

    if (!current) continue;

    // Section headers
    if (line.match(/^### Test Hint/i)) { section = 'testHint'; continue; }
    if (line.match(/^### Impl/i)) { section = 'implementHint'; continue; }
    if (line.match(/^### Files/i)) { section = 'files'; continue; }

    // File entries
    if (section === 'files') {
      const fileMatch = line.match(/^-\s*(test|source|create|modify):\s*(.+)/);
      if (fileMatch) {
        const [, type, path] = fileMatch;
        if (type === 'test') current.testFile = path.trim();
        else if (type === 'source') current.sourceFile = path.trim();
        else if (type === 'create') current.filesToCreate!.push(path.trim());
        else if (type === 'modify') current.filesToModify!.push(path.trim());
      }
      continue;
    }

    // Accumulate text
    if (section === 'description') current.description = (current.description || '') + line + '\n';
    if (section === 'testHint') current.testHint = (current.testHint || '') + line + '\n';
    if (section === 'implementHint') current.implementHint = (current.implementHint || '') + line + '\n';
  }

  if (current) tasks.push(finalizeTask(current));

  console.log(`[plan] Loaded "${planName}" with ${tasks.length} tasks`);
  return { name: planName, tasks };
}

function finalizeTask(partial: Partial<Task>): Task {
  return {
    id: partial.id || 'UNKNOWN',
    title: partial.title || 'Untitled',
    description: (partial.description || '').trim(),
    testHint: (partial.testHint || '').trim(),
    implementHint: (partial.implementHint || '').trim(),
    filesToCreate: partial.filesToCreate || [],
    filesToModify: partial.filesToModify || [],
    testFile: partial.testFile || '',
    sourceFile: partial.sourceFile || '',
  };
}
