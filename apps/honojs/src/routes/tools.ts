import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";

import { isRemoteExecutionMode } from "@ctxpack/sandbox";

import type { Context } from "../context";
import {
  loadTextSearchableResources,
  normalizePath,
  normalizeScopedPaths,
  resolveResourceRootPath,
} from "../lib/resources";
import { ErrorSchema } from "./schemas/resources";
import {
  ToolGlobRequestSchema,
  ToolGlobResponseSchema,
  ToolGrepRequestSchema,
  ToolGrepResponseSchema,
  ToolListRequestSchema,
  ToolListResponseSchema,
  ToolReadRequestSchema,
  ToolReadResponseSchema,
} from "./schemas/tools";

const toolsRouter = new OpenAPIHono<Context>();
const isRemoteMode = isRemoteExecutionMode();

/* ------------------------------------------------------------------ */
/*  Helper: load a single resource by ID with auth check               */
/* ------------------------------------------------------------------ */

async function loadResource(userId: string | null, resourceId: string) {
  const resources = await loadTextSearchableResources({
    userId,
    resourceIds: [resourceId],
  });
  if (resources.length === 0) {
    return null;
  }
  return resources[0]!;
}

function getResourceScopedPaths(resource: {
  searchPaths: string[] | null;
}): string[] {
  return normalizeScopedPaths(resource.searchPaths ?? null);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveScopedTargetDir(params: {
  rootPath: string;
  requestedPath?: string;
  scopedPaths: string[];
}): Promise<string | null> {
  const { rootPath, requestedPath, scopedPaths } = params;

  if (requestedPath) {
    const direct = join(rootPath, requestedPath);
    if (await pathExists(direct)) return direct;

    // If resource has a single scope, allow shorthand paths inside it:
    // `--path src` resolves to `<scope>/src`.
    if (scopedPaths.length === 1) {
      const scoped = join(rootPath, scopedPaths[0]!, requestedPath);
      if (await pathExists(scoped)) return scoped;
    }
    return null;
  }

  if (scopedPaths.length === 1) {
    const scoped = join(rootPath, scopedPaths[0]!);
    if (await pathExists(scoped)) return scoped;
  }

  return rootPath;
}

/* ------------------------------------------------------------------ */
/*  POST /api/tools/grep                                               */
/* ------------------------------------------------------------------ */

const grepRoute = createRoute({
  method: "post",
  path: "/api/tools/grep",
  tags: ["Tools"],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: ToolGrepRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Grep results",
      content: { "application/json": { schema: ToolGrepResponseSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Resource not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

toolsRouter.openapi(grepRoute, async (c) => {
  const user = c.get("user");
  if (isRemoteMode && !user) {
    return c.json({ message: "Unauthorized" }, 401);
  }

  const input = c.req.valid("json");
  const resource = await loadResource(user?.id ?? null, input.resourceId);
  if (!resource) {
    return c.json({ message: "Resource not found" }, 404);
  }

  const rootPath = await resolveResourceRootPath(resource);
  if (!rootPath) {
    return c.json({ message: "Resource path not available" }, 404);
  }

  const scopedPaths =
    normalizeScopedPaths(input.paths ?? null).length > 0
      ? normalizeScopedPaths(input.paths ?? null)
      : getResourceScopedPaths(resource);
  const useFixed = input.fixedStrings !== false;

  const args = [
    "rg",
    "--json",
    "--line-number",
    ...(useFixed ? ["--fixed-strings"] : []),
    ...(input.caseSensitive ? [] : ["-i"]),
    input.pattern,
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

  if (exitCode === 1) {
    return c.json({ matches: [] }, 200);
  }

  const matches: Array<{ filepath: string; line: number; text: string }> = [];
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
      // Skip malformed lines
    }
  }

  return c.json(
    { matches: matches.filter((m) => m.line > 0).slice(0, 100) },
    200,
  );
});

/* ------------------------------------------------------------------ */
/*  POST /api/tools/read                                               */
/* ------------------------------------------------------------------ */

const readRoute = createRoute({
  method: "post",
  path: "/api/tools/read",
  tags: ["Tools"],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: ToolReadRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "File content",
      content: { "application/json": { schema: ToolReadResponseSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Resource or file not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

toolsRouter.openapi(readRoute, async (c) => {
  const user = c.get("user");
  if (isRemoteMode && !user) {
    return c.json({ message: "Unauthorized" }, 401);
  }

  const input = c.req.valid("json");
  const resource = await loadResource(user?.id ?? null, input.resourceId);
  if (!resource) {
    return c.json({ message: "Resource not found" }, 404);
  }

  const rootPath = await resolveResourceRootPath(resource);
  if (!rootPath) {
    return c.json({ message: "Resource path not available" }, 404);
  }

  const scopedPaths = getResourceScopedPaths(resource);
  const directPath = join(rootPath, input.filepath);
  const fallbackScopedPath =
    scopedPaths.length === 1
      ? join(rootPath, scopedPaths[0]!, input.filepath)
      : null;
  let fullPath = directPath;
  let content: string;
  try {
    content = await readFile(directPath, "utf-8");
  } catch {
    if (!fallbackScopedPath) {
      return c.json({ message: `File not found: ${input.filepath}` }, 404);
    }
    try {
      content = await readFile(fallbackScopedPath, "utf-8");
      fullPath = fallbackScopedPath;
    } catch {
      return c.json({ message: `File not found: ${input.filepath}` }, 404);
    }
  }

  const allLines = content.split("\n");
  const totalLines = allLines.length;

  if (input.startLine || input.endLine) {
    const start = Math.max((input.startLine ?? 1) - 1, 0);
    const end = Math.min(input.endLine ?? totalLines, totalLines);
    content = allLines.slice(start, end).join("\n");
  }

  return c.json(
    {
      filepath: normalizePath(relative(rootPath, fullPath)),
      content,
      totalLines,
    },
    200,
  );
});

/* ------------------------------------------------------------------ */
/*  POST /api/tools/list                                               */
/* ------------------------------------------------------------------ */

const listRoute = createRoute({
  method: "post",
  path: "/api/tools/list",
  tags: ["Tools"],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: ToolListRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "File list",
      content: { "application/json": { schema: ToolListResponseSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Resource not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

toolsRouter.openapi(listRoute, async (c) => {
  const user = c.get("user");
  if (isRemoteMode && !user) {
    return c.json({ message: "Unauthorized" }, 401);
  }

  const input = c.req.valid("json");
  const resource = await loadResource(user?.id ?? null, input.resourceId);
  if (!resource) {
    return c.json({ message: "Resource not found" }, 404);
  }

  const rootPath = await resolveResourceRootPath(resource);
  if (!rootPath) {
    return c.json({ message: "Resource path not available" }, 404);
  }

  const scopedPaths = getResourceScopedPaths(resource);
  const targetDir = await resolveScopedTargetDir({
    rootPath,
    requestedPath: input.path,
    scopedPaths,
  });
  const MAX_FILES = 500;

  // Check that targetDir exists
  if (!targetDir || !(await pathExists(targetDir))) {
    return c.json({ message: `Path not found: ${input.path ?? "/"}` }, 404);
  }

  // Try git ls-files first
  try {
    const proc = Bun.spawn(
      ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
      { cwd: targetDir, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    const [exitCode, stdout] = await Promise.all([
      proc.exited,
      proc.stdout ? new Response(proc.stdout).text() : Promise.resolve(""),
      proc.stderr ? new Response(proc.stderr).text() : Promise.resolve(""),
    ]);
    if (exitCode === 0 && stdout.trim().length > 0) {
      const files = stdout
        .trim()
        .split("\n")
        .filter((f) => f.length > 0)
        .map(normalizePath)
        .slice(0, MAX_FILES);
      return c.json({ files }, 200);
    }
  } catch {
    // Fall through to readdir
  }

  const collected: string[] = [];
  const relativeBase =
    !input.path && scopedPaths.length === 1 && targetDir !== rootPath
      ? targetDir
      : targetDir;

  async function collect(dir: string): Promise<void> {
    if (collected.length >= MAX_FILES) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (collected.length >= MAX_FILES) return;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || entry.name === "node_modules")
          continue;
        await collect(fullPath);
      } else {
        collected.push(normalizePath(relative(relativeBase, fullPath)));
      }
    }
  }

  await collect(targetDir);
  return c.json({ files: collected }, 200);
});

/* ------------------------------------------------------------------ */
/*  POST /api/tools/glob                                               */
/* ------------------------------------------------------------------ */

const globRoute = createRoute({
  method: "post",
  path: "/api/tools/glob",
  tags: ["Tools"],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: ToolGlobRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Matched files",
      content: { "application/json": { schema: ToolGlobResponseSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Resource not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

toolsRouter.openapi(globRoute, async (c) => {
  const user = c.get("user");
  if (isRemoteMode && !user) {
    return c.json({ message: "Unauthorized" }, 401);
  }

  const input = c.req.valid("json");
  const resource = await loadResource(user?.id ?? null, input.resourceId);
  if (!resource) {
    return c.json({ message: "Resource not found" }, 404);
  }

  const rootPath = await resolveResourceRootPath(resource);
  if (!rootPath) {
    return c.json({ message: "Resource path not available" }, 404);
  }

  const scopedPaths = getResourceScopedPaths(resource);
  const MAX_FILES = 500;
  const glob = new Bun.Glob(input.pattern);
  const files: string[] = [];

  for await (const match of glob.scan({ cwd: rootPath, dot: false })) {
    if (match.includes("node_modules/") || match.startsWith(".git/")) continue;
    if (
      scopedPaths.length > 0 &&
      !scopedPaths.some(
        (scope) => match === scope || match.startsWith(`${scope}/`),
      )
    ) {
      continue;
    }
    files.push(normalizePath(match));
    if (files.length >= MAX_FILES) break;
  }

  files.sort();
  return c.json({ files }, 200);
});

export { toolsRouter };
