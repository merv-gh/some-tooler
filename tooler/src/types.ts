// TDD State Machine
export type TddState = 'WRITE_TEST' | 'VERIFY_RED' | 'IMPLEMENT' | 'VERIFY_GREEN' | 'REFACTOR' | 'VERIFY_REFACTOR' | 'DONE';

export interface Task {
  id: string;
  title: string;
  description: string;
  testHint: string;       // what the test should verify
  implementHint: string;  // guidance for implementation
  filesToCreate?: string[];
  filesToModify?: string[];
  testFile: string;       // where the test goes
  sourceFile: string;     // where the implementation goes
}

export interface Plan {
  name: string;
  tasks: Task[];
}

export interface TestResult {
  passed: boolean;
  totalTests: number;
  failedTests: number;
  newTestsAdded: boolean;
  output: string;
  errorSummary: string;
}

export interface ModelResponse {
  content: string;
  tokensUsed: number;
}

export interface StateContext {
  task: Task;
  state: TddState;
  attempt: number;
  maxAttempts: number;
  lastTestResult: TestResult | null;
  lastModelOutput: string;
  existingCode: Record<string, string>;  // filepath -> content
  history: HistoryEntry[];
}

export interface HistoryEntry {
  state: TddState;
  action: string;
  result: string;
  timestamp: number;
}

export interface ToolerConfig {
  ollamaUrl: string;
  model: string;
  appDir: string;
  planFile: string;
  maxAttemptsPerState: number;
  maxAttemptsPerTask: number;
  testCommand: string;
  unitTestCommand: string;
  logDir: string;
}
