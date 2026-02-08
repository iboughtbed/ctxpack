import { homedir } from "node:os";
import { join } from "node:path";

import type { RemoteGitIndexingStrategy, SandboxProvider } from "./types";

const CTXPACK_HOME = process.env.CTXPACK_HOME ?? join(homedir(), ".ctxpack");

export const SANDBOX_ROOT_PATH =
  process.env.CTXPACK_SANDBOX_ROOT_PATH ?? join(CTXPACK_HOME, "sandbox");
export const SANDBOX_REPO_PATH =
  process.env.CTXPACK_SANDBOX_REPO_PATH ?? join(SANDBOX_ROOT_PATH, "repo");
export const DEFAULT_MAX_FILE_SIZE_BYTES = 1024 * 1024;
export const VERCEL_SANDBOX_RUNTIME =
  process.env.VERCEL_SANDBOX_RUNTIME ?? "node22";
export const VERCEL_SANDBOX_TIMEOUT_MS = parseNumber(
  process.env.VERCEL_SANDBOX_TIMEOUT_MS,
  300000,
);
export const DAYTONA_SANDBOX_TIMEOUT_SECONDS = parseNumber(
  process.env.DAYTONA_SANDBOX_TIMEOUT_SECONDS,
  120,
);

export function getSandboxProvider(): SandboxProvider {
  const provider = (process.env.CTXPACK_SANDBOX_PROVIDER ?? "vercel").toLowerCase();
  return provider === "daytona" ? "daytona" : "vercel";
}

export function isRemoteExecutionMode(): boolean {
  const mode = (
    process.env.CTXPACK_EXECUTION_MODE ??
    process.env.CTXPACK_MODE ??
    "local"
  ).toLowerCase();
  return mode === "remote";
}

export function getRemoteGitIndexingStrategy(): RemoteGitIndexingStrategy {
  const strategy = (
    process.env.CTXPACK_REMOTE_GIT_INDEXING_STRATEGY ??
    process.env.CTXPACK_REMOTE_GIT_STRATEGY ??
    "persistent"
  ).toLowerCase();

  return strategy === "sandbox" ? "sandbox" : "persistent";
}

export function shouldUseSandboxForGitIndexing(): boolean {
  return (
    isRemoteExecutionMode() && getRemoteGitIndexingStrategy() === "sandbox"
  );
}

export function parseNumber(
  value: string | undefined,
  fallback: number,
): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return parsed;
}

export function parseBoolean(
  value: string | undefined,
  fallback: boolean,
): boolean {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}
