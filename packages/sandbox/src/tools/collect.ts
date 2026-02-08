import { DEFAULT_MAX_FILE_SIZE_BYTES } from "../config";
import { filterBySearchPaths } from "../internal/utils";
import type {
  GitSandboxResource,
  IndexableFileInput,
  SandboxIndexWarning,
} from "../types";
import { SANDBOX_REPO_PATH, listTrackedFiles, withGitSandbox } from "./shared";

export async function collectGitFileInputsInSandbox(params: {
  resource: GitSandboxResource;
  warnings: SandboxIndexWarning[];
  maxFileSizeBytes?: number;
}): Promise<IndexableFileInput[]> {
  const {
    resource,
    warnings,
    maxFileSizeBytes = DEFAULT_MAX_FILE_SIZE_BYTES,
  } = params;
  if (!resource.url) {
    warnings.push({
      filepath: "",
      stage: "scan",
      message: "Resource URL is required for git indexing",
    });
    return [];
  }

  return withGitSandbox(resource, async (sandbox) => {
    const trackedFiles = await listTrackedFiles(sandbox);
    const filteredFiles = filterBySearchPaths(trackedFiles, resource.searchPaths);
    const fileInputs: IndexableFileInput[] = [];

    for (const filepath of filteredFiles) {
      try {
        const content = await sandbox.readFileToBuffer({
          path: filepath,
          cwd: SANDBOX_REPO_PATH,
        });
        if (!content) {
          warnings.push({
            filepath,
            stage: "read",
            message: "File not found in sandbox",
          });
          continue;
        }

        if (content.length > maxFileSizeBytes) {
          warnings.push({
            filepath,
            stage: "read",
            message: `Skipped file larger than ${maxFileSizeBytes} bytes`,
          });
          continue;
        }

        if (content.includes(0)) {
          warnings.push({
            filepath,
            stage: "read",
            message: "Skipped binary file",
          });
          continue;
        }

        fileInputs.push({
          filepath,
          code: content.toString("utf8"),
        });
      } catch (error) {
        warnings.push({
          filepath,
          stage: "read",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return fileInputs;
  });
}

