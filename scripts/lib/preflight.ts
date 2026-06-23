import { accessSync, constants, existsSync } from "node:fs";
import { getPolygonProvider } from "./polygon-rpc.js";
import { DATA_DIR, ensureStateDirs, PATHS, RUNTIME_DIR } from "./paths.js";
import { killSwitchActive } from "./orphan-monitor.js";

export type PreflightResult = {
  ok: boolean;
  checkedAt: string;
  failures: string[];
  warnings: string[];
};

function hasAnyEnv(...keys: string[]): boolean {
  return keys.some((key) => Boolean(process.env[key]?.trim()));
}

function writable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export async function runPreflight(options: { requireLive?: boolean; requireLlm?: boolean } = {}): Promise<PreflightResult> {
  ensureStateDirs();
  const failures: string[] = [];
  const warnings: string[] = [];
  if (!writable(DATA_DIR)) failures.push(`data_dir_not_writable:${DATA_DIR}`);
  if (!writable(RUNTIME_DIR)) failures.push(`runtime_dir_not_writable:${RUNTIME_DIR}`);
  if (killSwitchActive()) failures.push(`kill_switch_active:${PATHS.killSwitch}`);

  if (options.requireLive) {
    if (!hasAnyEnv("POLYMARKET_PROXY_WALLET_ADDRESS", "POLYMARKET_FUNDER_ADDRESS")) failures.push("missing_polymarket_wallet_env");
    if (!hasAnyEnv("RELAYER_API_KEY", "POLYMARKET_CLOB_API_KEY", "POLY_BUILDER_API_KEY")) failures.push("missing_polymarket_auth_env");
    if (!hasAnyEnv("POLYGON_RPC_URLS", "POLYGON_RPC_URL", "RPC_URL")) warnings.push("using_public_polygon_rpc_fallbacks");
  }

  if (options.requireLlm && !hasAnyEnv("DEEPSEEK_API_KEY", "ANTHROPIC_API_KEY")) {
    failures.push("missing_deepseek_api_key");
  }

  try {
    await getPolygonProvider().getBlockNumber();
  } catch (error) {
    failures.push(`polygon_rpc_unhealthy:${error instanceof Error ? error.message : String(error)}`);
  }

  if (!existsSync(PATHS.lockFile)) warnings.push("lock_file_not_present_until_engine_start");
  return { ok: failures.length === 0, checkedAt: new Date().toISOString(), failures, warnings };
}
