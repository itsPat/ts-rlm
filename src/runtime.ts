import { $ } from "bun";

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

export function joinPath(base: string, ...parts: string[]): string {
  const normalizedBase = trimTrailingSlash(base);
  if (parts.length === 0) return normalizedBase;
  const normalizedParts = parts.map(trimSlashes).filter(Boolean);
  return `${normalizedBase}/${normalizedParts.join("/")}`;
}

export function toAbsolutePath(input: string): string {
  if (input.startsWith("/")) return input;
  const cwd = trimTrailingSlash(process.cwd());
  const cleaned = input.startsWith("./") ? input.slice(2) : input;
  return joinPath(cwd, cleaned);
}

export async function ensureDir(dir: string): Promise<void> {
  await $`mkdir -p ${dir}`;
}
