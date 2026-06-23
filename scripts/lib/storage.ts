import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { ensureParent } from "./paths.js";

export function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(path: string, value: unknown): void {
  ensureParent(path);
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

export function appendJsonl(path: string, row: unknown): void {
  ensureParent(path);
  appendFileSync(path, JSON.stringify(row) + "\n");
}

export function readJsonl<T>(path: string, limit = Number.POSITIVE_INFINITY): T[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  return lines.slice(-limit).flatMap((line) => {
    try {
      return [JSON.parse(line) as T];
    } catch {
      return [];
    }
  });
}
