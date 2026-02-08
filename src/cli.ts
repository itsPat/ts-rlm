import { runBenchmark } from "./benchmark";
import { runAsk } from "./rlm";
import { seedContext } from "./seed";
import type { RunMode } from "./types";

function readFlag(args: string[], ...names: string[]): string | undefined {
  for (const name of names) {
    const idx = args.indexOf(name);
    if (idx >= 0 && idx + 1 < args.length) {
      return args[idx + 1];
    }
  }
  return undefined;
}

function toInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function usage(): void {
  console.log("RLM prototype CLI");
  console.log("");
  console.log("Commands:");
  console.log("  bun run seed [--context ./context] [--docs 2000] [--secret PURPLE-GRAPE] [--secret-doc 842]");
  console.log("  bun run ask --query \"find the secret code\" [--mode recursive|tool-only|direct] [--context ./context]");
  console.log("  bun run bench [--query \"find the secret code\"] [--context ./context]");
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  const command = args[0];

  if (!command || command === "-h" || command === "--help") {
    usage();
    return;
  }

  const contextPath = readFlag(args, "--context", "-c") ?? "./context";

  if (command === "seed") {
    const docs = toInt(readFlag(args, "--docs"), 2000);
    const secret = readFlag(args, "--secret") ?? "PURPLE-GRAPE";
    const secretDoc = toInt(readFlag(args, "--secret-doc"), 842);

    await seedContext({
      contextPath,
      docs,
      secret,
      secretDoc,
    });

    console.log(`Seeded context at ${contextPath} with ${Math.max(docs, secretDoc + 1)} docs.`);
    return;
  }

  if (command === "ask") {
    const query = readFlag(args, "--query", "-q");
    if (!query) {
      throw new Error("Missing --query for ask command.");
    }

    const mode = (readFlag(args, "--mode", "-m") ?? "recursive") as RunMode;
    if (!["recursive", "tool-only", "direct"].includes(mode)) {
      throw new Error(`Invalid --mode '${mode}'.`);
    }

    const result = await runAsk({ query, mode, contextPath });
    console.log(`answer: ${result.answer}`);
    console.log(`confidence: ${result.confidence.toFixed(2)}`);
    console.log(`duration_ms: ${result.metrics.durationMs}`);
    console.log(`steps: root=${result.metrics.rootSteps} worker=${result.metrics.workerSteps} total=${result.metrics.totalSteps}`);
    console.log(
      `tokens: in=${result.metrics.tokens.total.inputTokens} out=${result.metrics.tokens.total.outputTokens} total=${result.metrics.tokens.total.totalTokens}`,
    );
    if (result.evidence.length > 0) {
      console.log("evidence:");
      for (const item of result.evidence) {
        console.log(`- ${item.path}: ${item.quote}`);
      }
    }
    console.log(`run log: ${result.logPath}`);
    return;
  }

  if (command === "bench") {
    const query = readFlag(args, "--query", "-q") ?? "Search the context and find the secret code.";
    await runBenchmark(contextPath, query);
    return;
  }

  throw new Error(`Unknown command '${command}'.`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exit(1);
});
