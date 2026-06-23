import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function ensureParent(path: string) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function appendJsonl(path: string, row: unknown) {
  ensureParent(path);
  appendFileSync(path, JSON.stringify(row) + "\n");
}

export function writeJson(path: string, value: unknown) {
  ensureParent(path);
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}
