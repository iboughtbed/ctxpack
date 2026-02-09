import type { SandboxListParams } from "../types";
import { filterBySearchPaths } from "../internal/utils";
import { listTrackedFiles, withGitSandbox } from "./shared";

export async function listFilesInSandbox(
  params: SandboxListParams,
): Promise<string[]> {
  const { resource, paths } = params;
  if (!resource.url) {
    throw new Error("Resource URL is required for sandbox file listing");
  }

  return withGitSandbox(resource, async (sandbox) => {
    const trackedFiles = await listTrackedFiles(sandbox);
    return filterBySearchPaths(trackedFiles, paths ?? resource.searchPaths);
  });
}
