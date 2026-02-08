import { runAsk } from "./rlm";
import { joinPath, toAbsolutePath } from "./runtime";
import type { RunMode } from "./types";

interface GroundTruth {
  secret: string;
}

function success(answer: string, secret: string): boolean {
  return answer.toLowerCase().includes(secret.toLowerCase());
}

export async function runBenchmark(contextPath: string, query: string): Promise<void> {
  const gtPath = joinPath(toAbsolutePath(contextPath), "ground-truth.json");
  const truth = JSON.parse(await Bun.file(gtPath).text()) as GroundTruth;

  const modes: RunMode[] = ["direct", "tool-only", "recursive"];

  for (const mode of modes) {
    const started = Date.now();
    try {
      const result = await runAsk({
        query,
        mode,
        contextPath,
      });

      const elapsedMs = Date.now() - started;
      const ok = success(result.answer, truth.secret);

      console.log(
        [
          `mode=${mode}`,
          `ok=${ok}`,
          `elapsedMs=${elapsedMs}`,
          `durationMs=${result.metrics.durationMs}`,
          `steps=${result.metrics.totalSteps}`,
          `in=${result.metrics.tokens.total.inputTokens}`,
          `out=${result.metrics.tokens.total.outputTokens}`,
          `tokens=${result.metrics.tokens.total.totalTokens}`,
          `confidence=${result.confidence.toFixed(2)}`,
          `log=${result.logPath}`,
        ].join(" "),
      );
    } catch (error) {
      const elapsedMs = Date.now() - started;
      const message = error instanceof Error ? error.message : String(error);
      console.log(`mode=${mode} ok=false elapsedMs=${elapsedMs} error=${JSON.stringify(message)}`);
    }
  }
}
