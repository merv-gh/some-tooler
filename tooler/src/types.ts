// ── TDD State Machine Types ──────────────────────────────────

/** Top-level states */
export type TddPhase = 'writeTest' | 'verifyRed' | 'implement' | 'verifyGreen' | 'refactor' | 'verifyRefactor' | 'done' | 'skipped';

/** Sub-states for verification phases */
export type VerifyRedStep = 'checkFileExists' | 'checkCompiles' | 'checkTestRuns' | 'checkFailsOnAssertion' | 'checkTestSanity';
export type VerifyGreenStep = 'checkCompiles' | 'checkTestRuns' | 'checkAllPass';
export type VerifyRefactorStep = 'checkCompiles' | 'checkTestRuns' | 'checkAllPass';

/** Guard check result */
export interface GuardResult {
  ok: boolean;
  name: string;
  detail: string;
  fatal?: boolean;  // if true, skip task entirely
}

/** Ordered list of guards for a verification phase */
export interface VerifyChain {
  name: string;
  checks: GuardCheck[];
}

export interface GuardCheck {
  name: string;
  run: (ctx: StateContext) => GuardResult | Promise<GuardResult>;
}

// ── Domain Types ─────────────────────────────────────────────

export interface Task {
  id: string;
  title: string;
  description: string;
  testHint: string;
  implementHint: string;
  filesToCreate?: string[];
  filesToModify?: string[];
  testFile: string;
  sourceFile: string;
}

export interface Plan {
  name: string;
  tasks: Task[];
}

export interface TestResult {
  passed: boolean;
  totalTests: number;
  failedTests: number;
  passedTests: number;
  output: string;
  errorSummary: string;
  /** Parsed individual test failures */
  failures: TestFailure[];
}

export interface TestFailure {
  testName: string;
  expected: string;
  received: string;
  line: string;
}

export interface ModelResponse {
  content: string;
  tokensUsed: number;
}

export interface CodeBlock {
  filename?: string;
  code: string;
  language?: string;
}

// ── State Context ────────────────────────────────────────────

export interface StateContext {
  task: Task;
  phase: TddPhase;
  attempt: number;
  phaseAttempts: Record<TddPhase, number>;
  lastTestResult: TestResult | null;
  lastModelOutput: string;
  lastGuardResults: GuardResult[];
  existingCode: Record<string, string>;
  history: HistoryEntry[];
}

export interface HistoryEntry {
  phase: TddPhase;
  action: string;
  guardResults?: GuardResult[];
  timestamp: number;
}

// ── Config ───────────────────────────────────────────────────

export interface ToolerConfig {
  ollamaUrl: string;
  model: string;
  appDir: string;
  planFile: string;
  maxAttemptsPerPhase: number;
  maxAttemptsPerTask: number;
  logDir: string;
}
