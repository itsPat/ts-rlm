const ALLOWED = new Set([
  "pwd",
  "ls",
  "find",
  "cat",
  "head",
  "tail",
  "wc",
  "sort",
  "uniq",
  "cut",
  "tr",
  "grep",
  "sed",
  "awk"
]);

const MAX_COMMAND_LENGTH = 2_000;
const BLOCKED_LITERAL_PATTERNS = ["$(", "`", ">", "<", "\n", "\r"];
const BLOCKED_WORD_PATTERNS = [
  /\b(?:rm|mv|chmod|chown|mkdir|touch|tee|curl|wget|git|bun|node|python|perl|ruby)\b/i,
  /\bxargs\b/i,
  /\bfind\b[\s\S]*\s-exec\b/i,
  /\bawk\b[\s\S]*\bsystem\s*\(/i,
];

function splitSegments(command: string): string[] {
  return command
    .split(/\|\||&&|\||;/g)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

export function validateReadOnlyCommand(command: string): string {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    throw new Error("Empty command is not allowed.");
  }

  if (trimmed.length > MAX_COMMAND_LENGTH) {
    throw new Error(`Command too long. Keep it under ${MAX_COMMAND_LENGTH} characters.`);
  }

  for (const token of BLOCKED_LITERAL_PATTERNS) {
    if (trimmed.includes(token)) {
      throw new Error(`Command blocked for safety: contains '${token}'.`);
    }
  }

  for (const pattern of BLOCKED_WORD_PATTERNS) {
    if (pattern.test(trimmed)) {
      throw new Error(`Command blocked for safety: matches '${pattern.source}'.`);
    }
  }

  for (const segment of splitSegments(trimmed)) {
    const base = segment.split(/\s+/)[0]?.trim();
    if (!base || !ALLOWED.has(base)) {
      throw new Error(`Command '${base}' is not in the read-only allowlist.`);
    }
  }

  return trimmed;
}
