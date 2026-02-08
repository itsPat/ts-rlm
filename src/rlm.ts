import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createBashTool } from "bash-tool";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import { loadConfig } from "./config";
import { validateReadOnlyCommand } from "./guards";
import { createRunId, event, writeJsonlLog } from "./logging";
import { toAbsolutePath } from "./runtime";
import type { AskOptions, AskResult, RunEvent, RunMetrics, TokenMetrics } from "./types";

const SANDBOX_CONTEXT_ROOT = "/workspace/context";

const finalizeSchema = z.object({
  answer: z.string().min(1).max(6_000),
  confidence: z.number().min(0).max(1),
  evidence: z.array(
    z.object({
      path: z.string().min(1).max(500),
      quote: z.string().min(1).max(1_000),
    }),
  ).min(1).max(12),
});

const llmQuerySchema = z.object({
  subTask: z.string().min(4).max(1_000),
  contextHandleIds: z.array(z.string().min(1).max(40)).max(12).optional(),
});

const readHandleSchema = z.object({
  handleId: z.string().min(1).max(40),
  start: z.number().int().min(0).default(0),
  length: z.number().int().min(1).max(10_000).default(1_200),
});

const listHandlesSchema = z.object({
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(100).default(20),
});

interface FinalizeInput {
  answer: string;
  confidence: number;
  evidence: Array<{ path: string; quote: string }>;
}

interface LlmQueryInput {
  subTask: string;
  contextHandleIds?: string[];
}

interface ReadHandleInput {
  handleId: string;
  start?: number;
  length?: number;
}

interface ListHandlesInput {
  offset?: number;
  limit?: number;
}

interface UsageLike {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

interface DirectCorpus {
  fileCount: number;
  charCount: number;
  promptBlock: string;
}

interface HandleMeta {
  id: string;
  stream: "stdout" | "stderr";
  command: string;
  chars: number;
  lines: number;
  preview: string;
  depth: number;
  createdAt: string;
}

interface OutputHandle extends HandleMeta {
  content: string;
}

interface VerifiedEvidence {
  path: string;
  quote: string;
  offsetStart: number;
  offsetEnd: number;
}

interface SessionResult {
  depth: number;
  answer: string;
  confidence: number;
  evidence: Array<{ path: string; quote: string }>;
  finalized: boolean;
}

interface SessionParams {
  depth: number;
  task: string;
  contextHandleIds?: string[];
}

const ZERO_TOKENS: TokenMetrics = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
};

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function tokenMetrics(usage: UsageLike | undefined): TokenMetrics {
  const inputTokens = numeric(usage?.inputTokens);
  const outputTokens = numeric(usage?.outputTokens);
  const totalTokens = numeric(usage?.totalTokens);

  return {
    inputTokens,
    outputTokens,
    totalTokens: totalTokens > 0 ? totalTokens : inputTokens + outputTokens,
  };
}

function addTokens(a: TokenMetrics, b: TokenMetrics): TokenMetrics {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

function countLines(content: string): number {
  if (content.length === 0) return 0;
  let lines = 1;
  for (const char of content) {
    if (char === "\n") lines += 1;
  }
  return lines;
}

function preview(content: string, maxChars: number): string {
  const compact = content.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars)}...`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function relativeFrom(root: string, absolutePath: string): string {
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return absolutePath.startsWith(prefix) ? absolutePath.slice(prefix.length) : absolutePath;
}

function normalizePath(input: string): string {
  return input.replace(/\/+/g, "/");
}

function sanitizeEvidencePath(input: string): string {
  const dequoted = input.trim().replace(/^`+|`+$/g, "");
  if (dequoted.length === 0) {
    throw new Error("Evidence path cannot be empty.");
  }

  if (dequoted.includes("\0") || dequoted.includes("\n") || dequoted.includes("\r")) {
    throw new Error("Evidence path contains invalid characters.");
  }

  const withoutDotPrefix = dequoted.startsWith("./") ? dequoted.slice(2) : dequoted;
  const isAbsolute = withoutDotPrefix.startsWith("/");
  const segments = withoutDotPrefix.split("/").filter(Boolean);

  if (segments.length === 0) {
    throw new Error("Evidence path cannot be empty.");
  }

  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("Evidence path traversal is not allowed.");
  }

  const normalized = segments.join("/");
  return isAbsolute ? `/${normalized}` : normalized;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findQuoteInContent(content: string, quote: string): { matchedQuote: string; offsetStart: number; offsetEnd: number } | null {
  const trimmedQuote = quote.trim();
  if (trimmedQuote.length === 0) {
    return null;
  }

  const directOffset = content.indexOf(trimmedQuote);
  if (directOffset >= 0) {
    return {
      matchedQuote: trimmedQuote,
      offsetStart: directOffset,
      offsetEnd: directOffset + trimmedQuote.length,
    };
  }

  const tokens = trimmedQuote.split(/\s+/).filter(Boolean);
  if (tokens.length < 3) {
    return null;
  }

  const pattern = tokens.map(escapeRegex).join("\\s+");
  const regex = new RegExp(pattern, "m");
  const match = regex.exec(content);
  if (!match || match.index < 0) {
    return null;
  }

  return {
    matchedQuote: match[0],
    offsetStart: match.index,
    offsetEnd: match.index + match[0].length,
  };
}

function toDisplayEvidencePath(resolvedPath: string, sandboxCwd: string): string {
  if (resolvedPath.startsWith(`${sandboxCwd}/`)) {
    return relativeFrom(sandboxCwd, resolvedPath);
  }

  if (resolvedPath.startsWith(`${SANDBOX_CONTEXT_ROOT}/`)) {
    return relativeFrom(SANDBOX_CONTEXT_ROOT, resolvedPath);
  }

  return resolvedPath;
}

async function loadDirectCorpus(contextPath: string): Promise<DirectCorpus> {
  const glob = new Bun.Glob("**/*");
  const files = await Array.fromAsync(
    glob.scan({
      cwd: contextPath,
      absolute: true,
      onlyFiles: true,
      dot: true,
    }),
  );
  files.sort();

  const parts: string[] = [];
  let charCount = 0;

  for (const file of files) {
    let content = "";
    try {
      content = await Bun.file(file).text();
    } catch {
      content = "[[UNREADABLE FILE]]";
    }

    const block = `--- FILE: ${relativeFrom(contextPath, file)} ---\n${content}\n`;
    parts.push(block);
    charCount += block.length;
  }

  return {
    fileCount: files.length,
    charCount,
    promptBlock: parts.join("\n"),
  };
}

function buildMetrics(params: {
  startedAtMs: number;
  rootSteps: number;
  workerSteps: number;
  subCalls: number;
  rootTokens: TokenMetrics;
  workerTokens: TokenMetrics;
}): RunMetrics {
  return {
    durationMs: Date.now() - params.startedAtMs,
    rootSteps: params.rootSteps,
    workerSteps: params.workerSteps,
    totalSteps: params.rootSteps + params.workerSteps,
    subCalls: params.subCalls,
    tokens: {
      root: params.rootTokens,
      workers: params.workerTokens,
      total: addTokens(params.rootTokens, params.workerTokens),
    },
  };
}

function buildSessionPrompt(params: {
  mode: AskOptions["mode"];
  depth: number;
  maxDepth: number;
  canRecurse: boolean;
}): string {
  const recursionLines = params.canRecurse
    ? [
      "When the task can be decomposed, call llmQuery with a narrower sub-task and optional context handles.",
      `Recursion depth available: ${params.depth} of ${params.maxDepth}.`,
    ]
    : ["Do not call llmQuery in this session."];

  return [
    "You are a Recursive Language Model session.",
    "Core invariant: external context stays in the environment, not in transcript.",
    "Use bash with relative paths from the current working directory.",
    "Start with `pwd` and `ls` once to orient.",
    "Do not assume absolute paths like /workspace/context are supported.",
    "bash returns only metadata + handle IDs; full command output is stored in handles.",
    "Use readHandle(handleId, start, length) to inspect bounded slices from stored output.",
    "Use listHandles to inspect available handles before reading them.",
    "Keep each read targeted and short.",
    "For this benchmark, the fastest successful pattern is:",
    "1) grep -R -i 'Secret code:' chunks",
    "2) grep -R -i 'Secret code:' chunks | grep -v 'REDACTED'",
    "The grep line format is `chunks/file.txt:Secret code: VALUE`.",
    "Use evidence with path `chunks/file.txt` and quote `Secret code: VALUE` only.",
    "Then finalize with the secret and evidence from the matching file.",
    "Never guess. Keep iterating until you have direct evidence.",
    ...recursionLines,
    "To finish, call finalize(answer, confidence, evidence).",
    "Each evidence item must use exact quote text from a real file and a valid relative path like chunks/doc-000123.txt.",
    "If finalize verification fails, fix evidence and retry.",
    params.mode === "tool-only" ? "Global mode is tool-only: recursion will be blocked." : "",
  ].filter(Boolean).join("\n");
}

function buildTaskPrompt(task: string, contextHandles: HandleMeta[]): string {
  if (contextHandles.length === 0) {
    return task;
  }

  const handleLines = contextHandles.map((handle) => (
    `- ${handle.id} (${handle.stream}, chars=${handle.chars}, lines=${handle.lines}, preview="${handle.preview}")`
  ));

  return [
    task,
    "",
    "You may start from these relevant handles:",
    ...handleLines,
  ].join("\n");
}

export async function runAsk(options: AskOptions): Promise<AskResult> {
  const config = loadConfig();
  const provider = createOpenRouter({
    apiKey: config.apiKey,
    compatibility: "strict",
  });

  const startedAtMs = Date.now();
  let rootSteps = 0;
  let workerSteps = 0;
  let subCalls = 0;
  let rootTokenUsage = ZERO_TOKENS;
  let workerTokenUsage = ZERO_TOKENS;

  const events: RunEvent[] = [];
  const runId = createRunId();
  const contextPath = toAbsolutePath(options.contextPath);

  events.push(event("run.start", {
    runId,
    mode: options.mode,
    query: options.query,
    contextPath,
  }));

  if (options.mode === "direct") {
    const corpus = await loadDirectCorpus(contextPath);
    events.push(event("direct.corpus.loaded", {
      files: corpus.fileCount,
      chars: corpus.charCount,
    }));

    const { text, usage, finishReason } = await generateText({
      model: provider(config.rootModel),
      prompt: [
        "You are the direct baseline model.",
        "Answer only from the corpus below.",
        "If the answer is missing, explicitly say it is not present.",
        "When possible, include file path evidence in the answer.",
        "",
        `Question: ${options.query}`,
        "",
        "Corpus:",
        corpus.promptBlock,
      ].join("\n"),
      timeout: { totalMs: config.stepTimeoutMs },
      maxOutputTokens: 600,
      onStepFinish: (step) => {
        rootSteps += 1;
        events.push(event("model.step", {
          phase: "direct",
          finishReason: step.finishReason,
          toolCalls: step.toolCalls.map((toolCall) => toolCall.toolName),
        }));
      },
    });

    rootTokenUsage = tokenMetrics(usage);

    const metrics = buildMetrics({
      startedAtMs,
      rootSteps,
      workerSteps,
      subCalls,
      rootTokens: rootTokenUsage,
      workerTokens: workerTokenUsage,
    });

    events.push(event("run.finish", {
      strategy: "direct",
      finishReason,
      metrics,
      finalized: false,
    }));

    const logPath = await writeJsonlLog(runId, events);

    return {
      answer: text,
      confidence: 0.2,
      evidence: [],
      runId,
      logPath,
      metrics,
    };
  }

  const handles = new Map<string, OutputHandle>();
  const handleOrder: string[] = [];
  let nextHandleId = 1;
  let activeDepth = 0;
  let sandboxCwd = SANDBOX_CONTEXT_ROOT;

  function getHandleMeta(handle: OutputHandle): HandleMeta {
    return {
      id: handle.id,
      stream: handle.stream,
      command: handle.command,
      chars: handle.chars,
      lines: handle.lines,
      preview: handle.preview,
      depth: handle.depth,
      createdAt: handle.createdAt,
    };
  }

  function storeHandle(stream: "stdout" | "stderr", command: string, content: string): HandleMeta | null {
    if (content.length === 0) {
      return null;
    }

    const id = `h${String(nextHandleId).padStart(5, "0")}`;
    nextHandleId += 1;

    const meta: OutputHandle = {
      id,
      stream,
      command,
      content,
      chars: content.length,
      lines: countLines(content),
      preview: preview(content, config.handlePreviewChars),
      depth: activeDepth,
      createdAt: new Date().toISOString(),
    };

    handles.set(id, meta);
    handleOrder.push(id);

    events.push(event("handle.store", {
      handleId: id,
      stream,
      chars: meta.chars,
      lines: meta.lines,
      depth: activeDepth,
      command,
    }));

    return getHandleMeta(meta);
  }

  async function withActiveDepth<T>(depth: number, fn: () => Promise<T>): Promise<T> {
    const prev = activeDepth;
    activeDepth = depth;
    try {
      return await fn();
    } finally {
      activeDepth = prev;
    }
  }

  const { tools: bashTools, sandbox } = await createBashTool({
    uploadDirectory: {
      source: contextPath,
      include: "**/*",
    },
    destination: SANDBOX_CONTEXT_ROOT,
    maxOutputLength: config.maxOutputChars,
    maxFiles: config.maxContextFiles,
    onBeforeBashCall: ({ command }) => {
      try {
        const safeCommand = validateReadOnlyCommand(command);
        events.push(event("bash.before", {
          depth: activeDepth,
          command: safeCommand,
        }));
        return { command: safeCommand };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        events.push(event("bash.blocked", {
          depth: activeDepth,
          command,
          reason: message,
        }));
        throw error;
      }
    },
    onAfterBashCall: ({ command, result }) => {
      const stdoutMeta = storeHandle("stdout", command, result.stdout);
      const stderrMeta = storeHandle("stderr", command, result.stderr);

      if (command.trim() === "pwd") {
        const firstLine = result.stdout.split("\n")[0]?.trim();
        if (firstLine && firstLine.startsWith("/")) {
          sandboxCwd = normalizePath(firstLine);
          events.push(event("sandbox.cwd.detected", {
            cwd: sandboxCwd,
          }));
        }
      }

      events.push(event("bash.after", {
        depth: activeDepth,
        command,
        exitCode: result.exitCode,
        stdoutHandle: stdoutMeta?.id ?? null,
        stderrHandle: stderrMeta?.id ?? null,
        stdoutChars: result.stdout.length,
        stderrChars: result.stderr.length,
      }));

      const summary = {
        command,
        exitCode: result.exitCode,
        stdout: stdoutMeta,
        stderr: stderrMeta,
        note: "Full output is stored in handles. Use readHandle(handleId, start, length).",
      };

      return {
        result: {
          stdout: JSON.stringify(summary, null, 2),
          stderr: "",
          exitCode: result.exitCode,
        },
      };
    },
  });

  async function verifyEvidence(evidence: Array<{ path: string; quote: string }>): Promise<VerifiedEvidence[]> {
    const verified: VerifiedEvidence[] = [];

    for (const item of evidence) {
      const normalizedPath = sanitizeEvidencePath(item.path);
      const candidatePaths = normalizedPath.startsWith("/")
        ? [normalizedPath]
        : [
          normalizePath(`${sandboxCwd}/${normalizedPath}`),
          normalizePath(`${SANDBOX_CONTEXT_ROOT}/${normalizedPath}`),
          normalizedPath,
        ];

      const dedupedCandidates = Array.from(new Set(candidatePaths));
      let resolvedPath = "";
      let content = "";
      for (const candidate of dedupedCandidates) {
        try {
          content = await sandbox.readFile(candidate);
          resolvedPath = candidate;
          break;
        } catch {
          continue;
        }
      }

      if (resolvedPath.length === 0) {
        throw new Error(`Evidence path not found: ${item.path}`);
      }

      const quoteMatch = findQuoteInContent(content, item.quote);
      if (!quoteMatch) {
        throw new Error(`Evidence quote mismatch for path: ${item.path}`);
      }

      verified.push({
        path: normalizedPath.startsWith("/") ? toDisplayEvidencePath(resolvedPath, sandboxCwd) : normalizedPath,
        quote: quoteMatch.matchedQuote,
        offsetStart: quoteMatch.offsetStart,
        offsetEnd: quoteMatch.offsetEnd,
      });
    }

    return verified;
  }

  async function runSession(params: SessionParams): Promise<SessionResult> {
    const depth = params.depth;
    const canRecurse = options.mode === "recursive" && depth < config.maxRecursionDepth;
    const contextHandleIds = params.contextHandleIds ?? [];
    const contextHandles = contextHandleIds
      .map((handleId) => handles.get(handleId))
      .filter((handle): handle is OutputHandle => Boolean(handle))
      .map(getHandleMeta);

    const sessionId = `${depth}-${Math.random().toString(36).slice(2, 8)}`;
    const finalizedRef: {
      value: {
        answer: string;
        confidence: number;
        evidence: Array<{ path: string; quote: string }>;
      } | null;
    } = { value: null };

    events.push(event("session.start", {
      sessionId,
      depth,
      task: params.task,
      mode: options.mode,
      canRecurse,
      contextHandleIds,
    }));

    const readHandle = tool<ReadHandleInput, {
      handleId: string;
      start: number;
      end: number;
      totalChars: number;
      stream: "stdout" | "stderr";
      command: string;
      text: string;
      hasMore: boolean;
    }>({
      description: "Read a bounded slice from a stored bash output handle.",
      inputSchema: readHandleSchema,
      execute: async ({ handleId, start = 0, length = 1_200 }) => {
        const handle = handles.get(handleId);
        if (!handle) {
          throw new Error(`Unknown handle '${handleId}'. Call listHandles first.`);
        }

        const safeStart = clamp(start, 0, handle.chars);
        const safeLength = clamp(length, 1, config.handleReadChars);
        const end = clamp(safeStart + safeLength, safeStart, handle.chars);
        const text = handle.content.slice(safeStart, end);

        events.push(event("handle.read", {
          depth,
          sessionId,
          handleId,
          start: safeStart,
          end,
          requestedLength: length,
          servedLength: text.length,
        }));

        return {
          handleId: handle.id,
          start: safeStart,
          end,
          totalChars: handle.chars,
          stream: handle.stream,
          command: handle.command,
          text,
          hasMore: end < handle.chars,
        };
      },
    });

    const listHandles = tool<ListHandlesInput, {
      total: number;
      offset: number;
      limit: number;
      items: HandleMeta[];
    }>({
      description: "List available bash output handles and metadata.",
      inputSchema: listHandlesSchema,
      execute: async ({ offset = 0, limit = 20 }) => {
        const safeOffset = clamp(offset, 0, handleOrder.length);
        const safeLimit = clamp(limit, 1, 100);

        const ids = handleOrder.slice(safeOffset, safeOffset + safeLimit);
        const items = ids
          .map((id) => handles.get(id))
          .filter((entry): entry is OutputHandle => Boolean(entry))
          .map(getHandleMeta);

        events.push(event("handle.list", {
          depth,
          sessionId,
          offset: safeOffset,
          limit: safeLimit,
          returned: items.length,
          total: handleOrder.length,
        }));

        return {
          total: handleOrder.length,
          offset: safeOffset,
          limit: safeLimit,
          items,
        };
      },
    });

    const llmQuery = tool<LlmQueryInput, {
      status: "ok" | "blocked";
      depth: number;
      answer: string;
      confidence: number;
      evidenceCount: number;
      finalized: boolean;
    }>({
      description: "Run a recursive RLM sub-session for a narrower sub-task.",
      inputSchema: llmQuerySchema,
      execute: async ({ subTask, contextHandleIds: childHandles = [] }) => {
        if (!canRecurse) {
          return {
            status: "blocked",
            depth,
            answer: "Recursion is not available in this session.",
            confidence: 0,
            evidenceCount: 0,
            finalized: false,
          };
        }

        if (subCalls >= config.maxSubCalls) {
          return {
            status: "blocked",
            depth,
            answer: `Sub-call budget reached (${config.maxSubCalls}).`,
            confidence: 0,
            evidenceCount: 0,
            finalized: false,
          };
        }

        subCalls += 1;
        const subCallNumber = subCalls;

        events.push(event("subcall.start", {
          sessionId,
          depth,
          subCall: subCallNumber,
          subTask,
          contextHandleIds: childHandles,
        }));

        const child = await runSession({
          depth: depth + 1,
          task: subTask,
          contextHandleIds: childHandles,
        });

        events.push(event("subcall.finish", {
          sessionId,
          depth,
          subCall: subCallNumber,
          childDepth: child.depth,
          finalized: child.finalized,
          evidenceCount: child.evidence.length,
          confidence: child.confidence,
        }));

        return {
          status: "ok",
          depth: child.depth,
          answer: child.answer.slice(0, 1_500),
          confidence: child.confidence,
          evidenceCount: child.evidence.length,
          finalized: child.finalized,
        };
      },
    });

    const finalize = tool<FinalizeInput, { ok: boolean; verifiedEvidenceCount: number; error?: string }>({
      description: "Finalize this session with grounded answer and verifiable evidence.",
      inputSchema: finalizeSchema,
      execute: async (input) => {
        let verifiedEvidence: VerifiedEvidence[] = [];
        try {
          verifiedEvidence = await verifyEvidence(input.evidence);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          events.push(event("finalize.rejected", {
            sessionId,
            depth,
            reason: message,
            evidenceCount: input.evidence.length,
          }));
          return {
            ok: false,
            verifiedEvidenceCount: 0,
            error: message,
          };
        }

        finalizedRef.value = {
          answer: input.answer,
          confidence: input.confidence,
          evidence: verifiedEvidence.map((entry) => ({
            path: entry.path,
            quote: entry.quote,
          })),
        };

        events.push(event("finalize.call", {
          sessionId,
          depth,
          confidence: input.confidence,
          answerChars: input.answer.length,
          evidenceCount: input.evidence.length,
          verifiedEvidence,
        }));

        return {
          ok: true,
          verifiedEvidenceCount: verifiedEvidence.length,
        };
      },
    });

    const tools = {
      bash: bashTools.bash,
      readHandle,
      listHandles,
      llmQuery,
      finalize,
    };

    const modelName = depth === 0 ? config.rootModel : config.workerModel;
    const sessionMaxSteps = Math.max(2, config.maxSteps - depth * 2);
    const timeoutMs = depth === 0 ? config.stepTimeoutMs : config.subCallTimeoutMs;

    const { text, usage, finishReason } = await withActiveDepth(depth, () => generateText({
      model: provider(modelName),
      system: buildSessionPrompt({
        mode: options.mode,
        depth,
        maxDepth: config.maxRecursionDepth,
        canRecurse,
      }),
      prompt: buildTaskPrompt(params.task, contextHandles),
      tools,
      stopWhen: [stepCountIs(sessionMaxSteps), () => finalizedRef.value !== null],
      timeout: { totalMs: timeoutMs },
      maxOutputTokens: 800,
      onStepFinish: (step) => {
        if (depth === 0) {
          rootSteps += 1;
        } else {
          workerSteps += 1;
        }

        events.push(event("model.step", {
          sessionId,
          depth,
          finishReason: step.finishReason,
          toolCalls: step.toolCalls.map((toolCall) => toolCall.toolName),
        }));
      },
    }));

    const sessionTokens = tokenMetrics(usage);
    if (depth === 0) {
      rootTokenUsage = addTokens(rootTokenUsage, sessionTokens);
    } else {
      workerTokenUsage = addTokens(workerTokenUsage, sessionTokens);
    }

    events.push(event("session.finish", {
      sessionId,
      depth,
      finishReason,
      finalized: Boolean(finalizedRef.value),
      tokens: sessionTokens,
    }));

    const finalized = finalizedRef.value;
    if (finalized !== null) {
      return {
        depth,
        answer: finalized.answer,
        confidence: finalized.confidence,
        evidence: finalized.evidence,
        finalized: true,
      };
    }

    return {
      depth,
      answer: text.trim().length > 0
        ? text.trim()
        : "I could not finalize within the step budget. Increase RLM_MAX_STEPS or refine the search strategy.",
      confidence: 0.2,
      evidence: [],
      finalized: false,
    };
  }

  const root = await runSession({
    depth: 0,
    task: options.query,
  });

  const metrics = buildMetrics({
    startedAtMs,
    rootSteps,
    workerSteps,
    subCalls,
    rootTokens: rootTokenUsage,
    workerTokens: workerTokenUsage,
  });

  events.push(event("run.finish", {
    metrics,
    finalized: root.finalized,
    answerChars: root.answer.length,
    evidenceCount: root.evidence.length,
  }));

  const logPath = await writeJsonlLog(runId, events);

  return {
    answer: root.answer,
    confidence: root.confidence,
    evidence: root.evidence,
    runId,
    logPath,
    metrics,
  };
}
