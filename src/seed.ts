import type { SeedOptions } from "./types";
import { ensureDir, joinPath, toAbsolutePath } from "./runtime";

function pad(num: number): string {
  return num.toString().padStart(6, "0");
}

export async function seedContext(options: SeedOptions): Promise<void> {
  const root = toAbsolutePath(options.contextPath);
  const chunksDir = joinPath(root, "chunks");

  await ensureDir(chunksDir);

  const total = Math.max(options.docs, options.secretDoc + 1);
  for (let i = 0; i < total; i++) {
    const secretLine = i === options.secretDoc
      ? `Secret code: ${options.secret}`
      : "Secret code: REDACTED";

    const content = [
      `Document ${i}`,
      `Section: ${i % 17}`,
      `Topic: synthetic-context-${i % 9}`,
      secretLine,
      `Checksum: ctx-${(i * 7919) % 100000}`,
    ].join("\n");

    const filePath = joinPath(chunksDir, `doc-${pad(i)}.txt`);
    await Bun.write(filePath, content);
  }

  await Bun.write(
    joinPath(root, "ground-truth.json"),
    JSON.stringify(
      {
        docs: total,
        secret: options.secret,
        secretDoc: options.secretDoc,
        secretFile: `chunks/doc-${pad(options.secretDoc)}.txt`,
      },
      null,
      2,
    ),
  );
}
