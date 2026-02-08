import { readdir, readFile, stat } from "node:fs/promises";
import { join, normalize, relative, resolve } from "node:path";
import type { BatchResult, FileInput } from "code-chunk";
import { embedMany } from "ai";
import { chunkBatch } from "code-chunk";
import { and, asc, eq } from "drizzle-orm";

import type { IndexJobWarning } from "@repo/db/schema";
import type { SandboxIndexWarning } from "@repo/sandbox";
import { db } from "@repo/db";
import { chunks, indexJobs, resources } from "@repo/db/schema";
import {
  collectGitFileInputsInSandbox,
  shouldUseSandboxForGitIndexing,
} from "@repo/sandbox";

import type { ModelConfig, ProviderKeys } from "../context";
import {
  getGitResourcePath,
  listGitTrackedFiles,
  pathExists,
  prepareGitRepository,
  readGitHeadCommit,
  readRemoteBranchHead,
  toErrorMessage,
  toUnixPath,
} from "./git";
import { getEmbeddingModel } from "./models";

const MAX_FILE_SIZE_BYTES = 1024 * 1024;
const EMBEDDING_BATCH_SIZE = 100;
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
]);

const activeResourceQueues = new Set<string>();
const resourceRuntimeOverrides = new Map<
  string,
  {
    providerKeys?: ProviderKeys;
    modelConfig?: ModelConfig;
  }
>();

type ResourceRow = typeof resources.$inferSelect;
type JobType = "sync" | "index";

type IndexableChunk = {
  filepath: string;
  lineStart: number;
  lineEnd: number;
  text: string;
  contextualizedText: string;
  scope: unknown;
  entities: unknown;
  language: string | null;
};

type ResourceContentStatus = "missing" | "syncing" | "ready" | "failed";
type ResourceVectorStatus = "missing" | "indexing" | "ready" | "failed";

export function ensureResourceJobQueue(
  resourceId: string,
  providerKeys?: ProviderKeys,
  modelConfig?: ModelConfig,
): void {
  resourceRuntimeOverrides.set(resourceId, {
    providerKeys,
    modelConfig,
  });

  if (activeResourceQueues.has(resourceId)) {
    return;
  }

  activeResourceQueues.add(resourceId);
  void processResourceQueue(resourceId).finally(() => {
    activeResourceQueues.delete(resourceId);
    resourceRuntimeOverrides.delete(resourceId);
  });
}

async function processResourceQueue(resourceId: string): Promise<void> {
  while (true) {
    const [queuedJob] = await db
      .select({ id: indexJobs.id, jobType: indexJobs.jobType })
      .from(indexJobs)
      .where(
        and(
          eq(indexJobs.resourceId, resourceId),
          eq(indexJobs.status, "queued"),
        ),
      )
      .orderBy(asc(indexJobs.createdAt), asc(indexJobs.id))
      .limit(1);

    if (!queuedJob) {
      return;
    }

    const jobType = normalizeJobType(queuedJob.jobType);

    await db
      .update(indexJobs)
      .set({
        status: "running",
        progress: 0,
        error: null,
        startedAt: new Date(),
        completedAt: null,
        processedFiles: 0,
      })
      .where(eq(indexJobs.id, queuedJob.id));

    try {
      const runtime = resourceRuntimeOverrides.get(resourceId);
      if (jobType === "sync") {
        await runSyncJob(queuedJob.id, resourceId);
      } else {
        await runIndexJob(
          queuedJob.id,
          resourceId,
          runtime?.providerKeys,
          runtime?.modelConfig,
        );
      }
    } catch (error) {
      await markJobFailed(queuedJob.id, resourceId, jobType, error);
    }
  }
}

async function runSyncJob(jobId: string, resourceId: string): Promise<void> {
  const [resource] = await db
    .select()
    .from(resources)
    .where(eq(resources.id, resourceId))
    .limit(1);

  if (!resource) {
    throw new Error("Resource not found");
  }

  const warnings: IndexJobWarning[] = [];

  await db
    .update(resources)
    .set({
      contentStatus: "syncing",
      contentError: null,
      status: "indexing",
    })
    .where(eq(resources.id, resourceId));

  let totalFiles = 0;

  if (resource.type === "git") {
    if (!resource.url) {
      throw new Error("Resource URL is required for git sync");
    }

    const repositoryPath = await prepareGitRepository({
      resourceId,
      url: resource.url,
      branch: resource.branch ?? "main",
      commit: resource.commit ?? null,
    });

    const trackedPaths = await listGitTrackedFiles(repositoryPath);
    const filteredPaths = filterBySearchPaths(
      trackedPaths,
      resource.searchPaths,
    );
    totalFiles = filteredPaths.length;

    const localCommit = await readGitHeadCommit(repositoryPath);
    const remoteCommit = await readRemoteBranchHead({
      url: resource.url,
      branch: resource.branch ?? "main",
    });

    await db
      .update(resources)
      .set({
        commit: localCommit,
        contentStatus: "ready",
        contentError: null,
        lastSyncedAt: new Date(),
        lastLocalCommit: localCommit,
        lastRemoteCommit: remoteCommit,
        updateAvailable:
          Boolean(localCommit) && Boolean(remoteCommit)
            ? localCommit !== remoteCommit
            : false,
        status: deriveLegacyStatus(
          "ready",
          normalizeVectorStatus(resource.vectorStatus),
        ),
      })
      .where(eq(resources.id, resourceId));
  } else {
    if (!resource.path) {
      throw new Error("Resource path is required for local sync");
    }

    const rootPath = resolve(resource.path);
    if (!(await pathExists(rootPath))) {
      throw new Error("Local resource path does not exist");
    }

    const localFiles = await walkLocalFiles(rootPath, warnings);
    const relativePaths = localFiles.map((filepath) =>
      toUnixPath(relative(rootPath, filepath)),
    );
    totalFiles = filterBySearchPaths(
      relativePaths,
      resource.searchPaths,
    ).length;

    const localCommit = await readGitHeadCommit(rootPath);

    await db
      .update(resources)
      .set({
        contentStatus: "ready",
        contentError: null,
        lastSyncedAt: new Date(),
        lastLocalCommit: localCommit,
        status: deriveLegacyStatus(
          "ready",
          normalizeVectorStatus(resource.vectorStatus),
        ),
      })
      .where(eq(resources.id, resourceId));
  }

  await db
    .update(indexJobs)
    .set({
      status: "completed",
      progress: 100,
      error: null,
      warnings,
      totalFiles,
      processedFiles: totalFiles,
      completedAt: new Date(),
    })
    .where(eq(indexJobs.id, jobId));
}

async function runIndexJob(
  jobId: string,
  resourceId: string,
  providerKeys?: ProviderKeys,
  modelConfig?: ModelConfig,
): Promise<void> {
  const [resource] = await db
    .select()
    .from(resources)
    .where(eq(resources.id, resourceId))
    .limit(1);

  if (!resource) {
    throw new Error("Resource not found");
  }

  const warnings: IndexJobWarning[] = [];

  await db
    .update(resources)
    .set({
      vectorStatus: "indexing",
      vectorError: null,
      status: "indexing",
    })
    .where(eq(resources.id, resourceId));

  const files = await collectFileInputs(resource, warnings);
  const totalFiles = files.length;

  await db
    .update(indexJobs)
    .set({
      totalFiles,
      processedFiles: 0,
      progress: totalFiles === 0 ? 95 : 10,
    })
    .where(eq(indexJobs.id, jobId));

  const chunkedResults =
    totalFiles === 0
      ? []
      : await chunkBatch(files, {
          maxChunkSize: 1500,
          contextMode: "full",
        });

  const allChunks = flattenChunkResults(chunkedResults, warnings);

  await db
    .update(indexJobs)
    .set({
      processedFiles: totalFiles,
      progress: totalFiles === 0 ? 95 : 40,
    })
    .where(eq(indexJobs.id, jobId));

  let insertedChunks = 0;

  if (allChunks.length > 0) {
    insertedChunks = await embedAndInsertChunks({
      resourceId,
      jobId,
      chunksToInsert: allChunks,
      warnings,
      providerKeys,
      modelConfig,
    });
  } else {
    await db.delete(chunks).where(eq(chunks.resourceId, resourceId));
  }

  await db
    .update(resources)
    .set({
      vectorStatus: "ready",
      vectorError: null,
      status: deriveLegacyStatus(
        normalizeContentStatus(resource.contentStatus),
        "ready",
      ),
      chunkCount: insertedChunks,
      lastIndexedAt: new Date(),
    })
    .where(eq(resources.id, resourceId));

  await db
    .update(indexJobs)
    .set({
      status: "completed",
      progress: 100,
      error: null,
      warnings,
      processedFiles: totalFiles,
      completedAt: new Date(),
    })
    .where(eq(indexJobs.id, jobId));
}

async function embedAndInsertChunks(params: {
  resourceId: string;
  jobId: string;
  chunksToInsert: IndexableChunk[];
  warnings: IndexJobWarning[];
  providerKeys?: ProviderKeys;
  modelConfig?: ModelConfig;
}): Promise<number> {
  const { resourceId, jobId, chunksToInsert, warnings, providerKeys, modelConfig } = params;
  const totalBatches = Math.ceil(chunksToInsert.length / EMBEDDING_BATCH_SIZE);
  let inserted = 0;
  let clearedExistingChunks = false;

  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex += 1) {
    const start = batchIndex * EMBEDDING_BATCH_SIZE;
    const batch = chunksToInsert.slice(start, start + EMBEDDING_BATCH_SIZE);
    if (batch.length === 0) {
      continue;
    }

    let embeddings: (number[] | undefined)[] = [];
    try {
      const result = await embedMany({
        model: getEmbeddingModel(modelConfig, providerKeys),
        values: batch.map((chunk) => chunk.contextualizedText),
      });
      embeddings = result.embeddings;
    } catch (error) {
      const message = toErrorMessage(error);
      console.warn(
        `[indexer] embedding failed for batch ${String(batchIndex + 1)}/${String(totalBatches)}, inserting chunks without embeddings: ${message}`,
      );
      warnings.push({
        filepath: batch[0]?.filepath ?? "<unknown>",
        stage: "embed",
        message: `Embedding failed (chunks stored without vectors): ${message}`,
      });
    }

    const rows: Array<typeof chunks.$inferInsert> = [];
    for (const [index, chunk] of batch.entries()) {
      const embedding = embeddings[index] ?? undefined;
      if (!embedding && embeddings.length > 0) {
        warnings.push({
          filepath: chunk.filepath,
          stage: "embed",
          message: "Embedding result missing for chunk",
        });
      }

      rows.push({
        resourceId,
        filepath: chunk.filepath,
        lineStart: chunk.lineStart,
        lineEnd: chunk.lineEnd,
        text: chunk.text,
        contextualizedText: chunk.contextualizedText,
        scope: chunk.scope,
        entities: chunk.entities,
        language: chunk.language,
        hash: hashChunk(chunk),
        embedding: embedding ?? null,
      } satisfies typeof chunks.$inferInsert);
    }

    if (rows.length > 0) {
      if (!clearedExistingChunks) {
        await db.delete(chunks).where(eq(chunks.resourceId, resourceId));
        clearedExistingChunks = true;
      }
      await db.insert(chunks).values(rows);
      inserted += rows.length;
    }

    const progress = 40 + Math.floor(((batchIndex + 1) / totalBatches) * 55);
    await db
      .update(indexJobs)
      .set({ progress: Math.min(progress, 95) })
      .where(eq(indexJobs.id, jobId));
  }

  return inserted;
}

async function collectFileInputs(
  resource: ResourceRow,
  warnings: IndexJobWarning[],
): Promise<FileInput[]> {
  if (resource.type === "git") {
    return collectGitFileInputs(resource, warnings);
  }

  return collectLocalFileInputs(resource, warnings);
}

async function collectGitFileInputs(
  resource: ResourceRow,
  warnings: IndexJobWarning[],
): Promise<FileInput[]> {
  if (shouldUseSandboxForGitIndexing()) {
    const sandboxWarnings: SandboxIndexWarning[] = [];
    const files = await collectGitFileInputsInSandbox({
      resource,
      warnings: sandboxWarnings,
      maxFileSizeBytes: MAX_FILE_SIZE_BYTES,
    });
    warnings.push(...sandboxWarnings);
    return files;
  }

  if (!resource.url) {
    warnings.push({
      filepath: "",
      stage: "scan",
      message: "Resource URL is required for git indexing",
    });
    return [];
  }

  const repositoryPath = getGitResourcePath(resource.id);
  if (!(await pathExists(repositoryPath))) {
    warnings.push({
      filepath: repositoryPath,
      stage: "sync",
      message: "Git resource is not materialized. Run sync first.",
    });
    return [];
  }

  const trackedPaths = await listGitTrackedFiles(repositoryPath);
  const filteredPaths = filterBySearchPaths(trackedPaths, resource.searchPaths);
  return readIndexableFiles({
    rootPath: repositoryPath,
    relativePaths: filteredPaths,
    warnings,
  });
}

async function collectLocalFileInputs(
  resource: ResourceRow,
  warnings: IndexJobWarning[],
): Promise<FileInput[]> {
  if (!resource.path) {
    warnings.push({
      filepath: "",
      stage: "scan",
      message: "Resource path is required for local indexing",
    });
    return [];
  }

  const rootPath = resolve(resource.path);
  if (!(await pathExists(rootPath))) {
    warnings.push({
      filepath: rootPath,
      stage: "scan",
      message: "Local resource path does not exist",
    });
    return [];
  }

  const allFiles = await walkLocalFiles(rootPath, warnings);
  const relativePaths = allFiles.map((filepath) =>
    toUnixPath(relative(rootPath, filepath)),
  );
  const filteredPaths = filterBySearchPaths(
    relativePaths,
    resource.searchPaths,
  );

  return readIndexableFiles({
    rootPath,
    relativePaths: filteredPaths,
    warnings,
  });
}

async function walkLocalFiles(
  rootPath: string,
  warnings: IndexJobWarning[],
): Promise<string[]> {
  const output: string[] = [];
  const stack = [rootPath];

  while (stack.length > 0) {
    const currentPath = stack.pop();
    if (!currentPath) {
      continue;
    }

    try {
      const entries = await readdir(currentPath, {
        withFileTypes: true,
        encoding: "utf8",
      });
      for (const entry of entries) {
        const entryPath = join(currentPath, entry.name);
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) {
            continue;
          }
          stack.push(entryPath);
          continue;
        }

        if (entry.isFile()) {
          output.push(entryPath);
        }
      }
    } catch (error) {
      warnings.push({
        filepath: currentPath,
        stage: "scan",
        message: toErrorMessage(error),
      });
    }
  }

  return output;
}

async function readIndexableFiles(params: {
  rootPath: string;
  relativePaths: string[];
  warnings: IndexJobWarning[];
}): Promise<FileInput[]> {
  const { rootPath, relativePaths, warnings } = params;
  const files: FileInput[] = [];

  for (const filepath of relativePaths) {
    const absolutePath = join(rootPath, filepath);

    try {
      const fileStat = await stat(absolutePath);
      if (!fileStat.isFile()) {
        continue;
      }

      if (fileStat.size > MAX_FILE_SIZE_BYTES) {
        warnings.push({
          filepath,
          stage: "read",
          message: `Skipped file larger than ${MAX_FILE_SIZE_BYTES} bytes`,
        });
        continue;
      }

      const buffer = await readFile(absolutePath);
      if (buffer.includes(0)) {
        warnings.push({
          filepath,
          stage: "read",
          message: "Skipped binary file",
        });
        continue;
      }

      files.push({
        filepath,
        code: buffer.toString("utf8"),
      });
    } catch (error) {
      warnings.push({
        filepath,
        stage: "read",
        message: toErrorMessage(error),
      });
    }
  }

  return files;
}

function flattenChunkResults(
  results: BatchResult[],
  warnings: IndexJobWarning[],
): IndexableChunk[] {
  const flattened: IndexableChunk[] = [];

  for (const result of results) {
    if (result.error || !result.chunks) {
      warnings.push({
        filepath: result.filepath,
        stage: "chunk",
        message: result.error?.message ?? "Chunking failed",
      });
      continue;
    }

    for (const chunk of result.chunks) {
      flattened.push({
        filepath: result.filepath,
        lineStart: chunk.lineRange.start,
        lineEnd: chunk.lineRange.end,
        text: chunk.text,
        contextualizedText: chunk.contextualizedText,
        scope: chunk.context.scope,
        entities: chunk.context.entities,
        language: chunk.context.language ?? null,
      });
    }
  }

  return flattened;
}

function filterBySearchPaths(
  paths: string[],
  searchPaths: string[] | null,
): string[] {
  if (!searchPaths || searchPaths.length === 0) {
    return paths;
  }

  const normalizedSearchPaths = searchPaths
    .map((searchPath) => normalizeSearchPath(searchPath))
    .filter((searchPath) => searchPath.length > 0);

  if (normalizedSearchPaths.length === 0) {
    return paths;
  }

  return paths.filter((filepath) => {
    const normalizedFilepath = normalizeSearchPath(filepath);
    return normalizedSearchPaths.some(
      (prefix) =>
        normalizedFilepath === prefix ||
        normalizedFilepath.startsWith(`${prefix}/`),
    );
  });
}

function normalizeSearchPath(input: string): string {
  const normalized = toUnixPath(normalize(input));
  return normalized
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

function hashChunk(chunk: IndexableChunk): string {
  return new Bun.CryptoHasher("sha256")
    .update(
      `${chunk.filepath}:${chunk.lineStart}:${chunk.lineEnd}:${chunk.contextualizedText}`,
    )
    .digest("hex");
}

function normalizeJobType(jobType: string | null): JobType {
  return jobType === "sync" ? "sync" : "index";
}

function normalizeContentStatus(status: string | null): ResourceContentStatus {
  if (status === "syncing" || status === "ready" || status === "failed") {
    return status;
  }
  return "missing";
}

function normalizeVectorStatus(status: string | null): ResourceVectorStatus {
  if (status === "indexing" || status === "ready" || status === "failed") {
    return status;
  }
  return "missing";
}

function deriveLegacyStatus(
  contentStatus: ResourceContentStatus,
  vectorStatus: ResourceVectorStatus,
): "pending" | "indexing" | "ready" | "failed" {
  if (contentStatus === "failed" || vectorStatus === "failed") {
    return "failed";
  }
  if (contentStatus === "syncing" || vectorStatus === "indexing") {
    return "indexing";
  }
  if (contentStatus === "ready" && vectorStatus === "ready") {
    return "ready";
  }
  return "pending";
}

async function markJobFailed(
  jobId: string,
  resourceId: string,
  jobType: JobType,
  error: unknown,
): Promise<void> {
  const message = toErrorMessage(error);

  await db
    .update(indexJobs)
    .set({
      status: "failed",
      error: message,
      progress: 100,
      completedAt: new Date(),
    })
    .where(eq(indexJobs.id, jobId));

  const [resource] = await db
    .select({
      contentStatus: resources.contentStatus,
      vectorStatus: resources.vectorStatus,
    })
    .from(resources)
    .where(eq(resources.id, resourceId))
    .limit(1);

  const currentContent = normalizeContentStatus(
    resource?.contentStatus ?? null,
  );
  const currentVector = normalizeVectorStatus(resource?.vectorStatus ?? null);

  if (jobType === "sync") {
    await db
      .update(resources)
      .set({
        contentStatus: "failed",
        contentError: message,
        status: deriveLegacyStatus("failed", currentVector),
      })
      .where(eq(resources.id, resourceId));
    return;
  }

  await db
    .update(resources)
    .set({
      vectorStatus: "failed",
      vectorError: message,
      status: deriveLegacyStatus(currentContent, "failed"),
    })
    .where(eq(resources.id, resourceId));
}
