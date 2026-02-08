import {
  normalizeScopedPaths,
  parseRipgrepJson,
} from "../internal/utils";
import type { SandboxGrepMatch, SandboxGrepParams } from "../types";
import { SANDBOX_REPO_PATH, runCommand, withGitSandbox } from "./shared";

export async function grepInSandbox(
  params: SandboxGrepParams,
): Promise<SandboxGrepMatch[]> {
  const { resource, pattern, paths, caseSensitive = true } = params;
  if (!resource.url) {
    throw new Error("Resource URL is required for sandbox grep");
  }

  return withGitSandbox(resource, async (sandbox) => {
    const scopedPaths = normalizeScopedPaths(paths);
    const args = [
      "-n",
      "--json",
      ...(caseSensitive ? [] : ["-i"]),
      pattern,
      ...(scopedPaths.length > 0 ? scopedPaths : ["."]),
    ];
    const output = await runCommand(sandbox, "rg", args, SANDBOX_REPO_PATH);
    return parseRipgrepJson(output.stdout);
  });
}

