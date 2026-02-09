import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { tool } from "ai";
import { z } from "zod";

import type { ModelConfig, ProviderKeys } from "../context";
import type { SearchResource } from "./resources";
import type { SearchResult } from "./search";
import {
  normalizePath,
  normalizeScopedPaths,
  resolveResourceRootPath,
} from "./resources";
import { hybridSearch } from "./search";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type AgentToolContext = {
  userId: string | null;
  resourceIds: string[];
  resources: SearchResource[];
  searchDefaults?: {
    mode?: "hybrid" | "text" | "vector";
    alpha?: number;
    topK?: number;
  };
  providerKeys?: ProviderKeys;
  modelConfig?: ModelConfig;
};

export type GrepMatch = {
  filepath: string;
  line: number;
  text: string;
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const MAX_GREP_MATCHES = 50;
const MAX_FILE_LIST = 500;
const MAX_READ_LINES = 500;
const SEARCH_PREVIEW_LINES = 12;
const SEARCH_PREVIEW_CHARS = 600;

function findResourceById(
  resources: SearchResource[],
  resourceId: string,
): SearchResource | undefined {
  return resources.find((r) => r.id === resourceId);
}

function requireResource(
  resources: SearchResource[],
  resourceId: string,
): SearchResource {
  const resource = findResourceById(resources, resourceId);
  if (!resource) {
    throw new Error(
      `Resource "${resourceId}" not found. Available: ${resources.map((r) => `${r.name} (${r.id})`).join(", ")}`,
    );
  }
  return resource;
}

async function requireRootPath(resource: SearchResource): Promise<string> {
  const rootPath = await resolveResourceRootPath(resource);
  if (!rootPath) {
    throw new Error(
      `Cannot resolve filesystem path for resource "${resource.name}" (${resource.id})`,
    );
  }
  return rootPath;
}

function getResourceScopedPaths(resource: SearchResource): string[] {
  return normalizeScopedPaths(resource.searchPaths ?? null);
}

async function resolveScopedTargetDir(params: {
  rootPath: string;
  requestedPath?: string;
  scopedPaths: string[];
}): Promise<string> {
  const { rootPath, requestedPath, scopedPaths } = params;

  if (requestedPath) {
    const direct = join(rootPath, requestedPath);
    try {
      await stat(direct);
      return direct;
    } catch {
      if (scopedPaths.length === 1) {
        const scoped = join(rootPath, scopedPaths[0]!, requestedPath);
        try {
          await stat(scoped);
          return scoped;
        } catch {
          // Fall through to error.
        }
      }
      throw new Error(`Path not found: ${requestedPath}`);
    }
  }

  if (scopedPaths.length === 1) {
    const scoped = join(rootPath, scopedPaths[0]!);
    try {
      await stat(scoped);
      return scoped;
    } catch {
      // Fall back to root.
    }
  }

  return rootPath;
}

function parseRipgrepJsonLines(stdout: string): GrepMatch[] {
  const matches: GrepMatch[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as {
        type?: string;
        data?: {
          path?: { text?: string };
          line_number?: number;
          lines?: { text?: string };
        };
      };
      if (parsed.type !== "match" || !parsed.data?.path?.text) continue;
      matches.push({
        filepath: normalizePath(parsed.data.path.text),
        line: parsed.data.line_number ?? 0,
        text: (parsed.data.lines?.text ?? "").trimEnd(),
      });
    } catch {
      // Ignore malformed lines.
    }
  }
  return matches.filter((m) => m.line > 0);
}

async function collectFilesRecursive(
  dir: string,
  rootDir: string,
  limit: number,
  collected: string[],
): Promise<void> {
  if (collected.length >= limit) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (collected.length >= limit) return;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      await collectFilesRecursive(fullPath, rootDir, limit, collected);
    } else {
      collected.push(normalizePath(relative(rootDir, fullPath)));
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Tool factory                                                       */
/* ------------------------------------------------------------------ */

export function createAgentTools(ctx: AgentToolContext) {
  return {
    search: tool({
      description: [
        "Search across ALL indexed resources for relevant code chunks.",
        `Mode: ${ctx.searchDefaults?.mode ? `"${ctx.searchDefaults.mode}" (locked by user)` : "hybrid (text + vector)"}.`,
        "IMPORTANT: Use SHORT keyword queries (2-4 words). NOT full sentences.",
        "Good: 'Effect generators', 'Hono middleware route'. Bad: 'How to integrate Effect into Hono.js routes with middleware'.",
        "Returns ranked code snippets with file paths and line numbers.",
      ].join(" "),
      inputSchema: z.object({
        query: z
          .string()
          .describe(
            "Short keyword query (2-4 words). e.g. 'Effect.gen usage', 'Hono route handler'",
          ),
        mode: z
          .enum(["hybrid", "text", "vector"])
          .optional()
          .describe(
            ctx.searchDefaults?.mode
              ? `Locked to "${ctx.searchDefaults.mode}" by user`
              : "Search strategy: hybrid (default), text, or vector",
          ),
        topK: z
          .number()
          .int()
          .min(1)
          .max(30)
          .optional()
          .describe("Number of results (default 10)"),
      }),
      execute: async ({ query, mode, topK }) => {
        const results = await hybridSearch({
          userId: ctx.userId,
          query,
          resourceIds: ctx.resourceIds,
          mode: ctx.searchDefaults?.mode ?? mode ?? "hybrid",
          alpha: ctx.searchDefaults?.alpha,
          topK: ctx.searchDefaults?.topK ?? topK ?? 8,
          providerKeys: ctx.providerKeys,
          modelConfig: ctx.modelConfig,
        });

        // Return previews to conserve context window.
        // The agent should use `read` to get full file content.
        return results.map((r) => {
          const lines = r.text.split("\n");
          const isTruncated =
            lines.length > SEARCH_PREVIEW_LINES ||
            r.text.length > SEARCH_PREVIEW_CHARS;
          const preview = isTruncated
            ? lines
                .slice(0, SEARCH_PREVIEW_LINES)
                .join("\n")
                .slice(0, SEARCH_PREVIEW_CHARS) +
              `\n... (${lines.length} total lines, use read to see full content)`
            : r.text;

          return {
            resourceId: r.resourceId,
            resourceName: r.resourceName,
            filepath: r.filepath,
            lineStart: r.lineStart,
            lineEnd: r.lineEnd,
            preview,
            score: r.score,
          };
        });
      },
    }),

    grep: tool({
      description: [
        "Search for exact patterns in a resource's files using ripgrep.",
        "Best for: function names, type names, imports, specific identifiers, error messages.",
        "Use INSTEAD of search when you know the exact symbol (e.g. 'Effect.gen', 'createMiddleware', 'app.get').",
        "If resourceId is omitted and only one resource is available, it is used automatically.",
      ].join(" "),
      inputSchema: z.object({
        pattern: z.string().describe("Search pattern (regex or fixed string)"),
        resourceId: z
          .string()
          .optional()
          .describe("Resource ID to search in (optional if only one resource)"),
        paths: z
          .array(z.string())
          .optional()
          .describe("Optional subdirectory paths to scope the search"),
        caseSensitive: z
          .boolean()
          .optional()
          .describe("Case-sensitive search (default false)"),
        fixedStrings: z
          .boolean()
          .optional()
          .describe(
            "Treat pattern as a literal string, not regex (default true)",
          ),
      }),
      execute: async ({
        pattern,
        resourceId,
        paths,
        caseSensitive,
        fixedStrings,
      }): Promise<GrepMatch[]> => {
        const resource = resourceId
          ? requireResource(ctx.resources, resourceId)
          : ctx.resources.length === 1
            ? ctx.resources[0]!
            : (() => {
                throw new Error(
                  "Multiple resources available. Specify resourceId.",
                );
              })();

        const rootPath = await requireRootPath(resource);
        const scopedPaths =
          normalizeScopedPaths(paths ?? null).length > 0
            ? normalizeScopedPaths(paths ?? null)
            : getResourceScopedPaths(resource);
        const useFixed = fixedStrings !== false;

        const args = [
          "rg",
          "--json",
          "--line-number",
          ...(useFixed ? ["--fixed-strings"] : []),
          ...(caseSensitive ? [] : ["-i"]),
          pattern,
          ...(scopedPaths.length > 0 ? scopedPaths : ["."]),
        ];

        const proc = Bun.spawn(args, {
          cwd: rootPath,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });

        const [exitCode, stdout] = await Promise.all([
          proc.exited,
          proc.stdout ? new Response(proc.stdout).text() : Promise.resolve(""),
          proc.stderr ? new Response(proc.stderr).text() : Promise.resolve(""),
        ]);

        if (exitCode === 1) return [];
        if (exitCode !== 0 && exitCode !== 1) {
          throw new Error(`rg exited with code ${String(exitCode)}`);
        }

        return parseRipgrepJsonLines(stdout)
          .slice(0, MAX_GREP_MATCHES)
          .map((m) => ({
            ...m,
            text: m.text.length > 200 ? m.text.slice(0, 200) + "..." : m.text,
          }));
      },
    }),

    read: tool({
      description: [
        "Read file contents from a resource. This is your primary tool for getting actual code and documentation.",
        "Always read files discovered via search/grep/list/glob to get full context.",
        "Use startLine/endLine for large files — read the relevant section, not the whole file.",
        "If resourceId is omitted and only one resource is available, it is used automatically.",
      ].join(" "),
      inputSchema: z.object({
        resourceId: z
          .string()
          .optional()
          .describe("Resource ID (optional if only one resource)"),
        filepath: z
          .string()
          .describe("File path relative to the resource root"),
        startLine: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Start line (1-indexed, inclusive)"),
        endLine: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("End line (1-indexed, inclusive)"),
      }),
      execute: async ({
        resourceId,
        filepath,
        startLine,
        endLine,
      }): Promise<{
        filepath: string;
        content: string;
        totalLines: number;
      }> => {
        const resource = resourceId
          ? requireResource(ctx.resources, resourceId)
          : ctx.resources.length === 1
            ? ctx.resources[0]!
            : (() => {
                throw new Error(
                  "Multiple resources available. Specify resourceId.",
                );
              })();

        const rootPath = await requireRootPath(resource);
        const scopedPaths = getResourceScopedPaths(resource);
        const directPath = join(rootPath, filepath);
        const fallbackScopedPath =
          scopedPaths.length === 1
            ? join(rootPath, scopedPaths[0]!, filepath)
            : null;
        let fullPath = directPath;

        let content: string;
        try {
          content = await readFile(directPath, "utf-8");
        } catch {
          if (!fallbackScopedPath) {
            throw new Error(`File not found: ${filepath}`);
          }
          try {
            content = await readFile(fallbackScopedPath, "utf-8");
            fullPath = fallbackScopedPath;
          } catch {
            throw new Error(`File not found: ${filepath}`);
          }
        }

        const allLines = content.split("\n");
        const totalLines = allLines.length;

        if (startLine || endLine) {
          const start = Math.max((startLine ?? 1) - 1, 0);
          const end = Math.min(endLine ?? totalLines, totalLines);
          const sliced = allLines.slice(start, end);
          if (sliced.length > MAX_READ_LINES) {
            return {
              filepath: normalizePath(relative(rootPath, fullPath)),
              content:
                sliced.slice(0, MAX_READ_LINES).join("\n") +
                `\n... (truncated, showing ${MAX_READ_LINES} of ${sliced.length} requested lines)`,
              totalLines,
            };
          }
          return {
            filepath: normalizePath(relative(rootPath, fullPath)),
            content: sliced.join("\n"),
            totalLines,
          };
        }

        if (allLines.length > MAX_READ_LINES) {
          return {
            filepath: normalizePath(relative(rootPath, fullPath)),
            content:
              allLines.slice(0, MAX_READ_LINES).join("\n") +
              `\n... (truncated, showing ${MAX_READ_LINES} of ${totalLines} total lines)`,
            totalLines,
          };
        }

        return {
          filepath: normalizePath(relative(rootPath, fullPath)),
          content,
          totalLines,
        };
      },
    }),

    list: tool({
      description: [
        "List files in a resource directory. Use this EARLY to understand project structure.",
        "Start with the root (path='') to see top-level layout, then drill into relevant directories.",
        "Look for: examples/, docs/, src/, packages/, README.md, and other documentation files.",
        "If resourceId is omitted and only one resource is available, it is used automatically.",
      ].join(" "),
      inputSchema: z.object({
        resourceId: z
          .string()
          .optional()
          .describe("Resource ID (optional if only one resource)"),
        path: z
          .string()
          .optional()
          .describe("Subdirectory path to list (default: root)"),
      }),
      execute: async ({ resourceId, path }): Promise<{ files: string[] }> => {
        const resource = resourceId
          ? requireResource(ctx.resources, resourceId)
          : ctx.resources.length === 1
            ? ctx.resources[0]!
            : (() => {
                throw new Error(
                  "Multiple resources available. Specify resourceId.",
                );
              })();

        const rootPath = await requireRootPath(resource);
        const targetDir = await resolveScopedTargetDir({
          rootPath,
          requestedPath: path,
          scopedPaths: getResourceScopedPaths(resource),
        });

        // Check that targetDir exists
        try {
          await stat(targetDir);
        } catch {
          throw new Error(`Path not found: ${path ?? "/"}`);
        }

        // Try git ls-files first for git repos
        try {
          const proc = Bun.spawn(
            ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
            {
              cwd: targetDir,
              stdin: "ignore",
              stdout: "pipe",
              stderr: "pipe",
            },
          );

          const [exitCode, stdout] = await Promise.all([
            proc.exited,
            proc.stdout
              ? new Response(proc.stdout).text()
              : Promise.resolve(""),
            proc.stderr
              ? new Response(proc.stderr).text()
              : Promise.resolve(""),
          ]);

          if (exitCode === 0 && stdout.trim().length > 0) {
            const files = stdout
              .trim()
              .split("\n")
              .filter((f) => f.length > 0)
              .map(normalizePath)
              .slice(0, MAX_FILE_LIST);
            return { files };
          }
        } catch {
          // Fall through to readdir
        }

        const collected: string[] = [];
        await collectFilesRecursive(
          targetDir,
          targetDir,
          MAX_FILE_LIST,
          collected,
        );
        return { files: collected };
      },
    }),

    glob: tool({
      description: [
        "Find files matching a glob pattern in a resource.",
        "Good for: finding all files of a type ('**/*.ts'), examples ('**/example*'), docs ('**/*.md'), configs ('**/package.json').",
        "If resourceId is omitted and only one resource is available, it is used automatically.",
      ].join(" "),
      inputSchema: z.object({
        resourceId: z
          .string()
          .optional()
          .describe("Resource ID (optional if only one resource)"),
        pattern: z
          .string()
          .describe("Glob pattern to match files (e.g. '**/*.ts')"),
      }),
      execute: async ({
        resourceId,
        pattern,
      }): Promise<{ files: string[] }> => {
        const resource = resourceId
          ? requireResource(ctx.resources, resourceId)
          : ctx.resources.length === 1
            ? ctx.resources[0]!
            : (() => {
                throw new Error(
                  "Multiple resources available. Specify resourceId.",
                );
              })();

        const rootPath = await requireRootPath(resource);
        const scopedPaths = getResourceScopedPaths(resource);
        const glob = new Bun.Glob(pattern);
        const files: string[] = [];

        for await (const match of glob.scan({
          cwd: rootPath,
          dot: false,
        })) {
          if (match.includes("node_modules/") || match.startsWith(".git/")) {
            continue;
          }
          if (
            scopedPaths.length > 0 &&
            !scopedPaths.some(
              (scope) => match === scope || match.startsWith(`${scope}/`),
            )
          ) {
            continue;
          }
          files.push(normalizePath(match));
          if (files.length >= MAX_FILE_LIST) break;
        }

        files.sort();
        return { files };
      },
    }),
  };
}
