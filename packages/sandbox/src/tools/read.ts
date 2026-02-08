import type { SandboxReadParams } from "../types";
import { SANDBOX_REPO_PATH, withGitSandbox } from "./shared";

export async function readFileInSandbox(params: SandboxReadParams): Promise<string> {
  const { resource, filepath, startLine, endLine } = params;
  if (!resource.url) {
    throw new Error("Resource URL is required for sandbox file read");
  }

  return withGitSandbox(resource, async (sandbox) => {
    const content = await sandbox.readFileToBuffer({
      path: filepath,
      cwd: SANDBOX_REPO_PATH,
    });
    if (!content) {
      throw new Error(`File not found: ${filepath}`);
    }

    const fullText = content.toString("utf8");
    if (!startLine && !endLine) {
      return fullText;
    }

    const lines = fullText.split("\n");
    const start = Math.max((startLine ?? 1) - 1, 0);
    const end = Math.min(endLine ?? lines.length, lines.length);
    return lines.slice(start, end).join("\n");
  });
}

