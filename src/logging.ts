import type { RunEvent } from "./types";
import { ensureDir, joinPath, toAbsolutePath } from "./runtime";

export function createRunId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function event(type: string, payload: Record<string, unknown> = {}): RunEvent {
  return {
    ts: new Date().toISOString(),
    type,
    ...payload,
  };
}

export async function writeJsonlLog(runId: string, events: RunEvent[]): Promise<string> {
  const dir = toAbsolutePath("./runs");
  await ensureDir(dir);
  const logPath = joinPath(dir, `${runId}.jsonl`);
  const jsonl = events.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  await Bun.write(logPath, jsonl);
  return logPath;
}
