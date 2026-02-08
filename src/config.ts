import type { RlmConfig } from "./types";

function readInt(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadConfig(): RlmConfig {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("Missing OPENROUTER_API_KEY. Set it in your environment or .env file.");
  }

  return {
    apiKey,
    rootModel: process.env.RLM_ROOT_MODEL ?? "openai/gpt-4o-mini",
    workerModel: process.env.RLM_WORKER_MODEL ?? "openai/gpt-4o-mini",
    maxSteps: readInt("RLM_MAX_STEPS", 12),
    maxSubCalls: readInt("RLM_MAX_SUBCALLS", 4),
    maxRecursionDepth: readInt("RLM_MAX_RECURSION_DEPTH", 3),
    maxOutputChars: readInt("RLM_MAX_OUTPUT_CHARS", 10_000),
    handlePreviewChars: readInt("RLM_HANDLE_PREVIEW_CHARS", 160),
    handleReadChars: readInt("RLM_HANDLE_READ_CHARS", 2_000),
    maxContextFiles: readInt("RLM_MAX_CONTEXT_FILES", 10_000),
    stepTimeoutMs: readInt("RLM_STEP_TIMEOUT_MS", 60_000),
    subCallTimeoutMs: readInt("RLM_SUBCALL_TIMEOUT_MS", 30_000),
  };
}
