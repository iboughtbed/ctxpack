import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { embed } from "ai";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { db } from "@repo/db";
import { chunks, resources } from "@repo/db/schema";
import { grepInSandbox, isRemoteExecutionMode } from "@repo/sandbox";

import type { ModelConfig, ProviderKeys } from "../context";
import { getEmbeddingModel } from "./models";
import {
  loadScopedResources,
  loadTextSearchableResources,
  loadVectorSearchableResources,
  normalizeResourceIds,
  normalizePath,
  normalizeScopedPaths,
  resolveResourceRootPath,
  type SearchResource,
} from "./resources";

export { loadScopedResources, type SearchResource } from "./resources";

const HYBRID_RRF_K = 60;
const CANDIDATE_MULTIPLIER = 4;
const MAX_TEXT_MATCHES_PER_RESOURCE = 400;
const TEXT_SEARCH_TIMEOUT_MS = 10_000;
const VECTOR_SEARCH_TIMEOUT_MS = 10_000;

export type SearchMode = "hybrid" | "text" | "vector";

export type SearchResult = {
  chunkId: string | null;
  resourceId: string;
  resourceName: string;
  filepath: string;
  lineStart: number;
  lineEnd: number;
  text: string;
  score: number;
  matchType: "text" | "vector" | "hybrid";
  matchSources: Array<"text" | "vector">;
};

type SearchInput = {
  userId: string | null;
  query: string;
  resourceIds?: string[];
  mode?: SearchMode;
  alpha?: number;
  topK?: number;
  providerKeys?: ProviderKeys;
  modelConfig?: ModelConfig;
};

type PartialSearchResult = Omit<SearchResult, "matchType" | "matchSources">;

type LocalGrepMatch = {
  filepath: string;
  line: number;
};

export async function hybridSearch(
  input: SearchInput,
): Promise<SearchResult[]> {
  const query = input.query.trim();
  if (!query) {
    return [];
  }

  const mode = input.mode ?? "hybrid";
  const topK = normalizeTopK(input.topK);
  const alpha = normalizeAlpha(input.alpha);
  const resourceIds = normalizeResourceIds(input.resourceIds);

  const textPromise =
    mode === "vector"
      ? Promise.resolve<PartialSearchResult[]>([])
      : withTimeout(
          runTextSearch({
            userId: input.userId,
            query,
            resourceIds,
            topK,
          }),
          TEXT_SEARCH_TIMEOUT_MS,
          "text search timed out",
        );

  const vectorPromise =
    mode === "text"
      ? Promise.resolve<PartialSearchResult[]>([])
      : withTimeout(
          runVectorSearch({
            userId: input.userId,
            query,
            resourceIds,
            topK,
            providerKeys: input.providerKeys,
            modelConfig: input.modelConfig,
          }),
          VECTOR_SEARCH_TIMEOUT_MS,
          "vector search timed out",
        );

  const [textSettled, vectorSettled] = await Promise.allSettled([
    textPromise,
    vectorPromise,
  ]);

  const textResults =
    textSettled.status === "fulfilled" ? textSettled.value : [];
  const vectorResults =
    vectorSettled.status === "fulfilled" ? vectorSettled.value : [];

  if (mode === "text" && textSettled.status === "rejected") {
    throw textSettled.reason;
  }

  if (mode === "vector" && vectorSettled.status === "rejected") {
    throw vectorSettled.reason;
  }

  if (mode !== "vector" && textSettled.status === "rejected") {
    console.error("[search] text search failed:", textSettled.reason);
  }

  if (mode !== "text" && vectorSettled.status === "rejected") {
    console.error("[search] vector search failed:", vectorSettled.reason);
  }

  if (mode === "text") {
    return textResults
      .slice(0, topK)
      .map((result) => ({
        ...result,
        matchType: "text",
        matchSources: ["text"],
      }));
  }

  if (mode === "vector") {
    return vectorResults
      .slice(0, topK)
      .map((result) => ({
        ...result,
        matchType: "vector",
        matchSources: ["vector"],
      }));
  }

  return mergeHybridResults(textResults, vectorResults, alpha, topK);
}

/* ------------------------------------------------------------------ */
/*  Context window parameters for filesystem-based text search          */
/* ------------------------------------------------------------------ */

/** Lines of context to include above/below each grep match range. */
const TEXT_CONTEXT_LINES = 15;
/** Max lines per context window to keep results reasonably sized. */
const TEXT_MAX_WINDOW_LINES = 60;
/**
 * Merge gap: matches within this many lines of each other in the same
 * file are merged into a single context window.
 */
const TEXT_MERGE_GAP = 10;

/* ------------------------------------------------------------------ */
/*  Filesystem-based text search                                        */
/* ------------------------------------------------------------------ */

async function runTextSearch(params: {
  userId: string | null;
  query: string;
  resourceIds: string[];
  topK: number;
}): Promise<PartialSearchResult[]> {
  const { userId, query, resourceIds, topK } = params;
  const scopedResources = await loadTextSearchableResources({
    userId,
    resourceIds,
  });

  if (scopedResources.length === 0) {
    return [];
  }

  const allResults: PartialSearchResult[] = [];

  for (const resource of scopedResources) {
    let matches: LocalGrepMatch[] = [];
    try {
      matches = await collectTextMatchesForResource({
        resource,
        query,
      });
    } catch (error) {
      console.error(
        `[search] text match collection failed for resource ${resource.id}:`,
        error,
      );
      continue;
    }

    if (matches.length === 0) {
      continue;
    }

    const rootPath = await resolveResourceRootPath(resource);
    if (!rootPath) {
      continue;
    }

    const contextResults = await readContextForMatches({
      rootPath,
      resourceId: resource.id,
      resourceName: resource.name,
      matches,
    });
    allResults.push(...contextResults);
  }

  // Sort by score descending (higher = more hits / earlier rank)
  allResults.sort((a, b) => b.score - a.score);

  return allResults.slice(0, topK * CANDIDATE_MULTIPLIER);
}

/* ------------------------------------------------------------------ */
/*  Read filesystem context around grep matches                         */
/* ------------------------------------------------------------------ */

type MatchRange = {
  filepath: string;
  lineStart: number;
  lineEnd: number;
  hits: number;
};

/**
 * Groups grep matches by file, merges nearby matches into ranges,
 * reads file content for each range, and returns scored results.
 */
async function readContextForMatches(params: {
  rootPath: string;
  resourceId: string;
  resourceName: string;
  matches: LocalGrepMatch[];
}): Promise<PartialSearchResult[]> {
  const { rootPath, resourceId, resourceName, matches } = params;

  // Group matches by filepath
  const byFile = new Map<string, number[]>();
  for (const match of matches) {
    const lines = byFile.get(match.filepath) ?? [];
    lines.push(match.line);
    byFile.set(match.filepath, lines);
  }

  // Merge nearby matches into ranges
  const ranges: MatchRange[] = [];
  for (const [filepath, lines] of byFile) {
    lines.sort((a, b) => a - b);
    let rangeStart = lines[0]!;
    let rangeEnd = lines[0]!;
    let hits = 1;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (line - rangeEnd <= TEXT_MERGE_GAP) {
        // Close enough to merge
        rangeEnd = line;
        hits += 1;
      } else {
        ranges.push({ filepath, lineStart: rangeStart, lineEnd: rangeEnd, hits });
        rangeStart = line;
        rangeEnd = line;
        hits = 1;
      }
    }
    ranges.push({ filepath, lineStart: rangeStart, lineEnd: rangeEnd, hits });
  }

  // Sort ranges by hit density (more hits first)
  ranges.sort((a, b) => b.hits - a.hits);

  // Read file content for each range
  const results: PartialSearchResult[] = [];
  // Cache file contents to avoid re-reading the same file
  const fileCache = new Map<string, string[]>();

  for (const [index, range] of ranges.entries()) {
    try {
      let fileLines = fileCache.get(range.filepath);
      if (!fileLines) {
        const fullPath = join(rootPath, range.filepath);
        const content = await readFile(fullPath, "utf8");
        fileLines = content.split("\n");
        fileCache.set(range.filepath, fileLines);
      }

      const totalLines = fileLines.length;
      const contextStart = Math.max(0, range.lineStart - 1 - TEXT_CONTEXT_LINES);
      const contextEnd = Math.min(
        totalLines,
        range.lineEnd + TEXT_CONTEXT_LINES,
      );

      // Cap the window size
      const windowEnd = Math.min(contextEnd, contextStart + TEXT_MAX_WINDOW_LINES);

      const text = fileLines.slice(contextStart, windowEnd).join("\n");
      if (!text.trim()) continue;

      // Score: RRF-style based on rank, boosted by hit count
      const rank = index + 1;
      const score =
        1 / (HYBRID_RRF_K + rank) + Math.min(range.hits, 5) * 0.0005;

      results.push({
        chunkId: null,
        resourceId,
        resourceName,
        filepath: range.filepath,
        lineStart: contextStart + 1, // 1-indexed
        lineEnd: windowEnd,
        text,
        score,
      });
    } catch {
      // File may have been deleted or be unreadable -- skip.
      continue;
    }
  }

  return results;
}

async function runVectorSearch(params: {
  userId: string | null;
  query: string;
  resourceIds: string[];
  topK: number;
  providerKeys?: ProviderKeys;
  modelConfig?: ModelConfig;
}): Promise<PartialSearchResult[]> {
  const { userId, query, resourceIds, topK, providerKeys, modelConfig } = params;
  const scopedResources = await loadVectorSearchableResources({
    userId,
    resourceIds,
  });
  if (scopedResources.length === 0) {
    return [];
  }
  const scopedResourceIds = scopedResources.map((resource) => resource.id);

  const queryEmbedding = await embed({
    model: getEmbeddingModel(modelConfig, providerKeys),
    value: query,
  });
  const queryVectorLiteral = `'[${queryEmbedding.embedding.join(",")}]'::vector`;
  const queryVector = sql.raw(queryVectorLiteral);

  const whereCondition = and(
    userId ? eq(resources.userId, userId) : isNull(resources.userId),
    eq(resources.vectorStatus, "ready"),
    inArray(chunks.resourceId, scopedResourceIds),
    sql`${chunks.embedding} is not null`,
  );
  const distanceExpr = sql<number>`${chunks.embedding} <=> ${queryVector}`;
  const scoreExpr = sql<number>`1 - (${distanceExpr})`;

  const rows = await db
    .select({
      chunkId: chunks.id,
      resourceId: chunks.resourceId,
      resourceName: resources.name,
      filepath: chunks.filepath,
      lineStart: chunks.lineStart,
      lineEnd: chunks.lineEnd,
      text: chunks.text,
      score: scoreExpr,
    })
    .from(chunks)
    .innerJoin(resources, eq(chunks.resourceId, resources.id))
    .where(whereCondition)
    .orderBy(distanceExpr)
    .limit(topK * CANDIDATE_MULTIPLIER);

  return rows
    .filter((row) => row.resourceId !== null)
    .map((row) => ({
      chunkId: row.chunkId,
      resourceId: row.resourceId as string,
      resourceName: row.resourceName,
      filepath: normalizePath(row.filepath),
      lineStart: row.lineStart,
      lineEnd: row.lineEnd,
      text: row.text,
      score: Number(row.score ?? 0),
    }));
}

async function collectTextMatchesForResource(params: {
  resource: SearchResource;
  query: string;
}): Promise<LocalGrepMatch[]> {
  const { resource, query } = params;

  if (isRemoteExecutionMode() && resource.type === "git" && resource.url) {
    const sandboxMatches = await grepInSandbox({
      resource: {
        id: resource.id,
        url: resource.url,
        branch: resource.branch,
        commit: resource.commit,
        searchPaths: resource.searchPaths,
      },
      pattern: query,
      paths: resource.searchPaths ?? undefined,
      caseSensitive: false,
    });

    return sandboxMatches
      .map((match) => ({
        filepath: normalizePath(match.filepath),
        line: match.line,
      }))
      .filter((match) => match.line > 0)
      .slice(0, MAX_TEXT_MATCHES_PER_RESOURCE);
  }

  const rootPath = await resolveResourceRootPath(resource);
  if (!rootPath) {
    return [];
  }

  return runLocalGrep({
    rootPath,
    query,
    paths: resource.searchPaths,
  });
}

/* ------------------------------------------------------------------ */
/*  Keyword extraction for text search                                 */
/* ------------------------------------------------------------------ */

const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "shall",
  "should", "may", "might", "must", "can", "could", "to", "of", "in",
  "for", "on", "with", "at", "by", "from", "as", "into", "through",
  "during", "before", "after", "about", "between", "under", "above",
  "how", "what", "when", "where", "which", "who", "whom", "why",
  "this", "that", "these", "those", "it", "its", "my", "your", "our",
  "their", "his", "her", "and", "or", "not", "but", "if", "then",
  "than", "so", "no", "up", "out", "just", "also", "very",
  "i", "me", "we", "you", "he", "she", "they", "them",
  "use", "using", "used",
]);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extract meaningful keywords from a natural-language query.
 * Returns individual tokens suitable for regex alternation search.
 * Preserves dot-separated identifiers (e.g. "Effect.gen") as single terms.
 */
function extractSearchKeywords(query: string): string[] {
  // Split on whitespace, then clean each token
  const rawTokens = query.split(/\s+/).filter(Boolean);
  const keywords: string[] = [];

  for (const raw of rawTokens) {
    // Strip leading/trailing punctuation but keep internal dots/underscores/hyphens
    const cleaned = raw
      .replace(/^[^a-zA-Z0-9_.]+/, "")
      .replace(/[^a-zA-Z0-9_.]+$/, "");
    if (cleaned.length < 2) continue;
    if (STOP_WORDS.has(cleaned.toLowerCase())) continue;
    keywords.push(cleaned);
  }

  return [...new Set(keywords)];
}

async function runLocalGrep(params: {
  rootPath: string;
  query: string;
  paths: string[] | null;
}): Promise<LocalGrepMatch[]> {
  const { rootPath, query, paths } = params;
  const scopedPaths = normalizeScopedPaths(paths);

  const keywords = extractSearchKeywords(query);

  let rgPattern: string;
  let useFixed: boolean;

  if (keywords.length === 0) {
    // Fallback: use the raw query as a fixed string
    rgPattern = query;
    useFixed = true;
  } else if (keywords.length === 1) {
    // Single keyword: use fixed-string matching (fast, simple)
    rgPattern = keywords[0]!;
    useFixed = true;
  } else {
    // Multiple keywords: regex alternation so we match ANY keyword
    // This finds files containing "Effect" OR "Hono" OR "integration" etc.
    // Chunks with more keyword hits get ranked higher by the scoring layer.
    rgPattern = keywords.map(escapeRegex).join("|");
    useFixed = false;
  }

  const proc = Bun.spawn(
    [
      "rg",
      "--json",
      "--line-number",
      ...(useFixed ? ["--fixed-strings"] : []),
      "--smart-case",
      // Exclude non-code files that pollute search results
      "--glob=!*.lock",
      "--glob=!*.lockb",
      "--glob=!bun.lock",
      "--glob=!bun.lockb",
      "--glob=!package-lock.json",
      "--glob=!yarn.lock",
      "--glob=!pnpm-lock.yaml",
      "--glob=!*.min.js",
      "--glob=!*.min.css",
      "--glob=!*.map",
      "--glob=!*.snap",
      "--glob=!node_modules",
      "--glob=!.git",
      "--glob=!dist",
      "--glob=!build",
      "--glob=!.next",
      "--glob=!.turbo",
      "--glob=!coverage",
      rgPattern,
      ...(scopedPaths.length > 0 ? scopedPaths : ["."]),
    ],
    {
      cwd: rootPath,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    proc.stdout ? new Response(proc.stdout).text() : Promise.resolve(""),
    proc.stderr ? new Response(proc.stderr).text() : Promise.resolve(""),
  ]);

  if (exitCode === 1) {
    return [];
  }

  if (exitCode !== 0) {
    const output =
      stderr.trim() || stdout.trim() || `exit code ${String(exitCode)}`;
    throw new Error(`rg search failed: ${output}`);
  }

  return parseRipgrepJson(stdout).slice(0, MAX_TEXT_MATCHES_PER_RESOURCE);
}

function parseRipgrepJson(stdout: string): LocalGrepMatch[] {
  const matches: LocalGrepMatch[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) {
      continue;
    }

    try {
      const parsed = JSON.parse(line) as {
        type?: string;
        data?: {
          path?: { text?: string };
          line_number?: number;
        };
      };

      if (parsed.type !== "match" || !parsed.data?.path?.text) {
        continue;
      }

      matches.push({
        filepath: normalizePath(parsed.data.path.text),
        line: parsed.data.line_number ?? 0,
      });
    } catch {
      // Ignore malformed lines.
    }
  }

  return matches.filter((match) => match.line > 0);
}

/**
 * Returns a stable dedup key for a search result. Text results have no
 * chunkId so we fall back to a composite of resource + file + line range.
 */
function resultKey(result: PartialSearchResult): string {
  if (result.chunkId) return result.chunkId;
  return `${result.resourceId}:${result.filepath}:${String(result.lineStart)}`;
}

function mergeHybridResults(
  textResults: PartialSearchResult[],
  vectorResults: PartialSearchResult[],
  alpha: number,
  topK: number,
): SearchResult[] {
  const merged = new Map<
    string,
    PartialSearchResult & {
      textRank: number | null;
      vectorRank: number | null;
    }
  >();

  for (const [index, result] of textResults.entries()) {
    const key = resultKey(result);
    merged.set(key, {
      ...result,
      textRank: index + 1,
      vectorRank: null,
    });
  }

  for (const [index, result] of vectorResults.entries()) {
    const rank = index + 1;
    const key = resultKey(result);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, {
        ...result,
        textRank: null,
        vectorRank: rank,
      });
      continue;
    }

    merged.set(key, {
      ...existing,
      vectorRank:
        existing.vectorRank === null
          ? rank
          : Math.min(existing.vectorRank, rank),
    });
  }

  return [...merged.values()]
    .map((result) => {
      const textScore =
        result.textRank === null ? 0 : 1 / (HYBRID_RRF_K + result.textRank);
      const vectorScore =
        result.vectorRank === null ? 0 : 1 / (HYBRID_RRF_K + result.vectorRank);
      const score = alpha * vectorScore + (1 - alpha) * textScore;
      const hasText = result.textRank !== null;
      const hasVector = result.vectorRank !== null;
      const matchType: SearchResult["matchType"] =
        hasText && hasVector ? "hybrid" : hasVector ? "vector" : "text";

      return {
        chunkId: result.chunkId,
        resourceId: result.resourceId,
        resourceName: result.resourceName,
        filepath: result.filepath,
        lineStart: result.lineStart,
        lineEnd: result.lineEnd,
        text: result.text,
        score,
        matchType,
        matchSources: [
          ...(hasText ? (["text"] as const) : []),
          ...(hasVector ? (["vector"] as const) : []),
        ],
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

function normalizeTopK(topK: number | undefined): number {
  if (!topK) {
    return 10;
  }
  return Math.min(Math.max(topK, 1), 50);
}

function normalizeAlpha(alpha: number | undefined): number {
  if (typeof alpha !== "number" || Number.isNaN(alpha)) {
    return 0.5;
  }
  return Math.min(Math.max(alpha, 0), 1);
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}
