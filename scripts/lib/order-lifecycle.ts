import type { LifecycleStep, SportsArbPackage } from "./types.js";

export function markLifecycle(pkg: SportsArbPackage, step: LifecycleStep, nowMs = Date.now()): SportsArbPackage {
  const previousTimestamps = Object.entries(pkg.timestamps)
    .filter(([key]) => key !== "updated")
    .map(([, value]) => value ? Date.parse(value) : NaN)
    .filter(Number.isFinite);
  const previous = previousTimestamps.length ? Math.max(...previousTimestamps) : nowMs;
  return {
    ...pkg,
    lifecycleMs: { ...pkg.lifecycleMs, [step]: nowMs - previous },
    timestamps: { ...pkg.timestamps, [step]: new Date(nowMs).toISOString(), updated: new Date(nowMs).toISOString() },
  };
}

export function lifecycleDurationMs(pkg: SportsArbPackage): number {
  return Object.values(pkg.lifecycleMs).reduce((sum, value) => sum + (typeof value === "number" ? value : 0), 0);
}
