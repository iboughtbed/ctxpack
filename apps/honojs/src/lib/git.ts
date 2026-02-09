import { mkdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const CTXPACK_HOME = process.env.CTXPACK_HOME ?? join(homedir(), ".ctxpack");
export const REPO_STORAGE_PATH =
  process.env.REPO_STORAGE_PATH ?? join(CTXPACK_HOME, "repos");

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export function toUnixPath(input: string): string {
  return input.replaceAll("\\", "/");
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function getGitResourcePath(resourceId: string): string {
  return resolve(REPO_STORAGE_PATH, resourceId);
}

export async function runBunCommand(
  argv: string[],
  cwd?: string,
): Promise<string> {
  const proc = Bun.spawn(argv, {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    proc.stdout ? new Response(proc.stdout).text() : Promise.resolve(""),
    proc.stderr ? new Response(proc.stderr).text() : Promise.resolve(""),
  ]);

  if (exitCode === 0) {
    return stdout;
  }

  const output =
    stderr.trim() || stdout.trim() || `exit code ${String(exitCode)}`;
  throw new Error(`${argv.join(" ")} failed: ${output}`);
}

export async function runGit(args: string[], cwd?: string): Promise<string> {
  return runBunCommand(["git", ...args], cwd);
}

export async function prepareGitRepository(params: {
  resourceId: string;
  url: string;
  branch: string;
  commit: string | null;
}): Promise<string> {
  const { resourceId, url, branch, commit } = params;
  const repositoryPath = getGitResourcePath(resourceId);

  await mkdir(REPO_STORAGE_PATH, { recursive: true });

  const hasGitDirectory = await pathExists(join(repositoryPath, ".git"));
  if (!hasGitDirectory) {
    if (await pathExists(repositoryPath)) {
      await rm(repositoryPath, { recursive: true, force: true });
    }
    try {
      await runGit(
        [
          "clone",
          "--depth",
          "1",
          "--single-branch",
          "--branch",
          branch,
          url,
          repositoryPath,
        ],
        undefined,
      );
    } catch {
      await runGit(["clone", "--depth", "1", url, repositoryPath], undefined);
    }
  } else {
    await runGit(["-C", repositoryPath, "remote", "set-url", "origin", url]);
  }

  if (commit) {
    await runGit([
      "-C",
      repositoryPath,
      "fetch",
      "--depth",
      "1",
      "origin",
      commit,
    ]);
    await runGit(["-C", repositoryPath, "checkout", "--force", commit]);
    return repositoryPath;
  }

  try {
    await runGit([
      "-C",
      repositoryPath,
      "fetch",
      "--depth",
      "1",
      "origin",
      branch,
    ]);
  } catch {
    await runGit(["-C", repositoryPath, "fetch", "--depth", "1", "origin"]);
  }

  try {
    await runGit([
      "-C",
      repositoryPath,
      "checkout",
      "--force",
      "-B",
      branch,
      `origin/${branch}`,
    ]);
  } catch {
    await runGit(["-C", repositoryPath, "checkout", "--force", branch]);
  }

  return repositoryPath;
}

export async function listGitTrackedFiles(
  repositoryPath: string,
): Promise<string[]> {
  const output = await runGit(["-C", repositoryPath, "ls-files", "-z"]);
  return output
    .split("\0")
    .map((filepath) => filepath.trim())
    .filter((filepath) => filepath.length > 0)
    .map(toUnixPath);
}

export async function readGitHeadCommit(
  repositoryPath: string,
): Promise<string | null> {
  try {
    const output = await runGit(["-C", repositoryPath, "rev-parse", "HEAD"]);
    const commit = output.trim();
    return commit.length > 0 ? commit : null;
  } catch {
    return null;
  }
}

export async function readRemoteBranchHead(params: {
  url: string;
  branch: string;
}): Promise<string | null> {
  const { url, branch } = params;
  try {
    const output = await runGit(["ls-remote", "--heads", url, branch]);
    const line = output
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    if (!line) return null;
    const [sha] = line.split(/\s+/);
    return sha && sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
}
