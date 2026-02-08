import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { and, eq, inArray, isNull, or } from "drizzle-orm";

import { db } from "@repo/db";
import { resources } from "@repo/db/schema";
import { REPO_STORAGE_PATH } from "./git";

export type SearchResource = {
  id: string;
  name: string;
  type: "git" | "local";
  url: string | null;
  path: string | null;
  branch: string | null;
  commit: string | null;
  searchPaths: string[] | null;
};

export async function loadScopedResources(params: {
  userId: string | null;
  resourceIds: string[];
}): Promise<SearchResource[]> {
  const { userId, resourceIds } = params;
  return db
    .select({
      id: resources.id,
      name: resources.name,
      type: resources.type,
      url: resources.url,
      path: resources.path,
      branch: resources.branch,
      commit: resources.commit,
      searchPaths: resources.searchPaths,
    })
    .from(resources)
    .where(
      and(
        userId ? eq(resources.userId, userId) : isNull(resources.userId),
        or(
          eq(resources.contentStatus, "ready"),
          eq(resources.vectorStatus, "ready"),
        ),
        resourceIds.length > 0 ? inArray(resources.id, resourceIds) : undefined,
      ),
    );
}

/**
 * Loads resources that have a resolvable filesystem path, regardless of
 * indexing status. Used by text search which only needs the filesystem
 * (grep / read), not chunks or embeddings. Resources with status "failed"
 * are excluded because their path may be invalid.
 */
export async function loadTextSearchableResources(params: {
  userId: string | null;
  resourceIds: string[];
}): Promise<SearchResource[]> {
  const { userId, resourceIds } = params;
  return db
    .select({
      id: resources.id,
      name: resources.name,
      type: resources.type,
      url: resources.url,
      path: resources.path,
      branch: resources.branch,
      commit: resources.commit,
      searchPaths: resources.searchPaths,
    })
    .from(resources)
    .where(
      and(
        userId ? eq(resources.userId, userId) : isNull(resources.userId),
        eq(resources.contentStatus, "ready"),
        resourceIds.length > 0 ? inArray(resources.id, resourceIds) : undefined,
      ),
    );
}

export async function loadVectorSearchableResources(params: {
  userId: string | null;
  resourceIds: string[];
}): Promise<SearchResource[]> {
  const { userId, resourceIds } = params;
  return db
    .select({
      id: resources.id,
      name: resources.name,
      type: resources.type,
      url: resources.url,
      path: resources.path,
      branch: resources.branch,
      commit: resources.commit,
      searchPaths: resources.searchPaths,
    })
    .from(resources)
    .where(
      and(
        userId ? eq(resources.userId, userId) : isNull(resources.userId),
        eq(resources.vectorStatus, "ready"),
        resourceIds.length > 0 ? inArray(resources.id, resourceIds) : undefined,
      ),
    );
}

export async function resolveResourceRootPath(
  resource: SearchResource,
): Promise<string | null> {
  const rootPath =
    resource.type === "local"
      ? resource.path
        ? resolve(resource.path)
        : null
      : resolve(REPO_STORAGE_PATH, resource.id);

  if (!rootPath) {
    return null;
  }

  if (!(await pathExists(rootPath))) {
    return null;
  }

  return rootPath;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export function normalizePath(filePath: string): string {
  return filePath.replaceAll("\\", "/");
}

export function normalizeScopedPaths(paths: string[] | null): string[] {
  if (!paths || paths.length === 0) {
    return [];
  }

  const scoped = paths
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) =>
      p
        .replaceAll("\\", "/")
        .replace(/^\.\//, "")
        .replace(/^\/+/, "")
        .replace(/\/+$/, ""),
    )
    .filter((p) => p.length > 0);

  return [...new Set(scoped)];
}

export function normalizeResourceIds(
  resourceIds: string[] | undefined,
): string[] {
  if (!resourceIds || resourceIds.length === 0) {
    return [];
  }
  return [
    ...new Set(resourceIds.map((resourceId) => resourceId.trim())),
  ].filter((resourceId) => resourceId.length > 0);
}
