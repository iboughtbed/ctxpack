import type { GitSandboxResource, SandboxLike } from "../types";
import { SANDBOX_REPO_PATH, SANDBOX_ROOT_PATH } from "../config";
import { toErrorMessage } from "../internal/utils";
import { createSandbox } from "../providers";

export { SANDBOX_REPO_PATH };

export async function runCommand(
  sandbox: SandboxLike,
  command: string,
  args: string[],
  cwd?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const result = await sandbox.runCommand(command, args, cwd);
  if (result.exitCode !== 0) {
    throw new Error(
      `Sandbox command failed (${command}): ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result;
}

export async function withGitSandbox<T>(
  resource: GitSandboxResource,
  fn: (sandbox: SandboxLike) => Promise<T>,
): Promise<T> {
  if (!resource.url) {
    throw new Error("Resource URL is required for sandbox operations");
  }

  const sandbox = await createSandbox();
  try {
    await checkoutRepository(sandbox, resource);
    return await fn(sandbox);
  } finally {
    try {
      await sandbox.stop();
    } catch {
      // Ignore cleanup errors.
    }
  }
}

export async function checkoutRepository(
  sandbox: SandboxLike,
  resource: GitSandboxResource,
): Promise<void> {
  if (!resource.url) {
    throw new Error("Cannot checkout repository without URL");
  }

  await runCommand(sandbox, "mkdir", ["-p", SANDBOX_ROOT_PATH]);
  await runCommand(sandbox, "rm", ["-rf", SANDBOX_REPO_PATH]);

  const cloneArgs = ["clone", "--depth", "1"];
  if (resource.branch) {
    cloneArgs.push("--branch", resource.branch);
  }
  cloneArgs.push(resource.url, SANDBOX_REPO_PATH);

  await runCommand(sandbox, "git", cloneArgs, SANDBOX_ROOT_PATH);

  if (resource.commit) {
    await runCommand(
      sandbox,
      "git",
      ["fetch", "--depth", "1", "origin", resource.commit],
      SANDBOX_REPO_PATH,
    );
    await runCommand(
      sandbox,
      "git",
      ["checkout", "--force", resource.commit],
      SANDBOX_REPO_PATH,
    );
  }
}

export async function listTrackedFiles(
  sandbox: SandboxLike,
): Promise<string[]> {
  const output = await runCommand(
    sandbox,
    "git",
    ["ls-files", "-z"],
    SANDBOX_REPO_PATH,
  );
  return output.stdout
    .split("\0")
    .map((filepath) => filepath.trim())
    .filter((filepath) => filepath.length > 0);
}

export function buildSandboxScanError(error: unknown): string {
  return toErrorMessage(error);
}
