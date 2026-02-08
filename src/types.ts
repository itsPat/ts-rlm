export type RunMode = "recursive" | "tool-only" | "direct";

export interface RlmConfig {
  apiKey: string;
  rootModel: string;
  workerModel: string;
  maxSteps: number;
  maxSubCalls: number;
  maxRecursionDepth: number;
  maxOutputChars: number;
  handlePreviewChars: number;
  handleReadChars: number;
  maxContextFiles: number;
  stepTimeoutMs: number;
  subCallTimeoutMs: number;
}

export interface AskOptions {
  query: string;
  contextPath: string;
  mode: RunMode;
}

export interface SeedOptions {
  contextPath: string;
  docs: number;
  secret: string;
  secretDoc: number;
}

export interface RunEvent {
  ts: string;
  type: string;
  [key: string]: unknown;
}

export interface TokenMetrics {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface RunMetrics {
  durationMs: number;
  rootSteps: number;
  workerSteps: number;
  totalSteps: number;
  subCalls: number;
  tokens: {
    root: TokenMetrics;
    workers: TokenMetrics;
    total: TokenMetrics;
  };
}

export interface AskResult {
  answer: string;
  evidence: Array<{ path: string; quote: string }>;
  confidence: number;
  runId: string;
  logPath: string;
  metrics: RunMetrics;
}
