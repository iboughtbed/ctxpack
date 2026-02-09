import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { and, eq, isNull } from "drizzle-orm";

import { db } from "@ctxpack/db";
import { indexJobs, resources } from "@ctxpack/db/schema";
import { isRemoteExecutionMode } from "@ctxpack/sandbox";

import type { Context } from "../context";
import { ensureResourceJobQueue } from "../lib/indexer";
import {
  ErrorSchema,
  IndexTriggerResponseSchema,
  ResourceCreateSchema,
  ResourceListQuerySchema,
  ResourceListSchema,
  ResourceParamsSchema,
  ResourceSchema,
} from "./schemas/resources";

const resourcesRouter = new OpenAPIHono<Context>();
const isRemoteMode = isRemoteExecutionMode();

type ResourceRow = typeof resources.$inferSelect;
type ContextUser = Context["Variables"]["user"];

const toResource = (row: ResourceRow) => ({
  id: row.id,
  userId: row.userId ?? null,
  name: row.name,
  scope: row.scope ?? "global",
  projectKey: row.projectKey || null,
  type: row.type,
  url: row.url ?? null,
  path: row.path ?? null,
  branch: row.branch ?? null,
  commit: row.commit ?? null,
  paths: row.searchPaths ?? null,
  notes: row.notes ?? null,
  status: row.status ?? "pending",
  contentStatus: row.contentStatus ?? "missing",
  vectorStatus: row.vectorStatus ?? "missing",
  contentError: row.contentError ?? null,
  vectorError: row.vectorError ?? null,
  chunkCount: row.chunkCount ?? 0,
  lastSyncedAt: row.lastSyncedAt ? row.lastSyncedAt.toISOString() : null,
  lastIndexedAt: row.lastIndexedAt ? row.lastIndexedAt.toISOString() : null,
  lastLocalCommit: row.lastLocalCommit ?? null,
  lastRemoteCommit: row.lastRemoteCommit ?? null,
  updateAvailable: row.updateAvailable ?? false,
  lastUpdateCheckAt: row.lastUpdateCheckAt
    ? row.lastUpdateCheckAt.toISOString()
    : null,
  createdAt: row.createdAt ? row.createdAt.toISOString() : null,
  updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
});

function ownerFilter(user: ContextUser) {
  return user ? eq(resources.userId, user.id) : isNull(resources.userId);
}

function scopeFilter(
  scope: "project" | "global" | "all" | undefined,
  projectKey: string | undefined,
) {
  if (scope === "project") {
    return and(
      eq(resources.scope, "project"),
      eq(resources.projectKey, projectKey ?? ""),
    );
  }
  if (scope === "global") {
    return eq(resources.scope, "global");
  }
  return undefined;
}

const listResourcesRoute = createRoute({
  method: "get",
  path: "/api/resources",
  tags: ["Resources"],
  request: {
    query: ResourceListQuerySchema,
  },
  responses: {
    200: {
      description: "List resources for the current user",
      content: {
        "application/json": {
          schema: ResourceListSchema,
        },
      },
    },
    401: {
      description: "Unauthorized",
      content: {
        "application/json": {
          schema: ErrorSchema,
        },
      },
    },
  },
});

resourcesRouter.openapi(listResourcesRoute, async (c) => {
  const user = c.get("user");
  if (isRemoteMode && !user) {
    return c.json({ message: "Unauthorized" }, 401);
  }

  const { scope, projectKey } = c.req.valid("query");
  const owner = ownerFilter(user);
  const scoped = scopeFilter(scope, projectKey);
  const rows = await db
    .select()
    .from(resources)
    .where(scoped ? and(owner, scoped) : owner);

  return c.json(rows.map(toResource), 200);
});

const createResourceRoute = createRoute({
  method: "post",
  path: "/api/resources",
  tags: ["Resources"],
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: ResourceCreateSchema,
        },
      },
    },
  },
  responses: {
    201: {
      description: "Create a resource",
      content: {
        "application/json": {
          schema: ResourceSchema,
        },
      },
    },
    401: {
      description: "Unauthorized",
      content: {
        "application/json": {
          schema: ErrorSchema,
        },
      },
    },
    409: {
      description: "Resource name already exists",
      content: {
        "application/json": {
          schema: ErrorSchema,
        },
      },
    },
  },
});

resourcesRouter.openapi(createResourceRoute, async (c) => {
  const user = c.get("user");
  if (isRemoteMode && !user) {
    return c.json({ message: "Unauthorized" }, 401);
  }

  const input = c.req.valid("json");
  const normalizedProjectKey =
    input.scope === "project" ? (input.projectKey ?? "") : "";
  const existing = await db
    .select({ id: resources.id })
    .from(resources)
    .where(
      and(
        ownerFilter(user),
        eq(resources.name, input.name),
        eq(resources.scope, input.scope),
        eq(resources.projectKey, normalizedProjectKey),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    return c.json({ message: "Resource name already exists" }, 409);
  }

  const values = {
    userId: user?.id ?? null,
    name: input.name,
    scope: input.scope,
    projectKey: normalizedProjectKey,
    type: input.type,
    url: input.url ?? null,
    path: input.path ?? null,
    commit: input.commit ?? null,
    searchPaths: input.paths ?? null,
    notes: input.notes ?? null,
    contentStatus: input.type === "local" ? "ready" : "missing",
    vectorStatus: "missing",
    lastSyncedAt: input.type === "local" ? new Date() : null,
    status: "pending",
    ...(input.branch ? { branch: input.branch } : {}),
  } satisfies typeof resources.$inferInsert;

  const inserted = await db.insert(resources).values(values).returning();
  const resource = inserted[0];
  if (!resource) {
    throw new Error("Failed to create resource");
  }

  return c.json(toResource(resource), 201);
});

const getResourceRoute = createRoute({
  method: "get",
  path: "/api/resources/{id}",
  tags: ["Resources"],
  request: {
    params: ResourceParamsSchema,
  },
  responses: {
    200: {
      description: "Get a resource",
      content: {
        "application/json": {
          schema: ResourceSchema,
        },
      },
    },
    401: {
      description: "Unauthorized",
      content: {
        "application/json": {
          schema: ErrorSchema,
        },
      },
    },
    404: {
      description: "Resource not found",
      content: {
        "application/json": {
          schema: ErrorSchema,
        },
      },
    },
  },
});

resourcesRouter.openapi(getResourceRoute, async (c) => {
  const user = c.get("user");
  if (isRemoteMode && !user) {
    return c.json({ message: "Unauthorized" }, 401);
  }

  const { id } = c.req.valid("param");
  const rows = await db
    .select()
    .from(resources)
    .where(and(ownerFilter(user), eq(resources.id, id)))
    .limit(1);

  const resource = rows[0];
  if (!resource) {
    return c.json({ message: "Resource not found" }, 404);
  }

  return c.json(toResource(resource), 200);
});

const deleteResourceRoute = createRoute({
  method: "delete",
  path: "/api/resources/{id}",
  tags: ["Resources"],
  request: {
    params: ResourceParamsSchema,
  },
  responses: {
    204: {
      description: "Resource deleted",
    },
    401: {
      description: "Unauthorized",
      content: {
        "application/json": {
          schema: ErrorSchema,
        },
      },
    },
    404: {
      description: "Resource not found",
      content: {
        "application/json": {
          schema: ErrorSchema,
        },
      },
    },
  },
});

resourcesRouter.openapi(deleteResourceRoute, async (c) => {
  const user = c.get("user");
  if (isRemoteMode && !user) {
    return c.json({ message: "Unauthorized" }, 401);
  }

  const { id } = c.req.valid("param");
  const deleted = await db
    .delete(resources)
    .where(and(ownerFilter(user), eq(resources.id, id)))
    .returning({ id: resources.id });

  if (deleted.length === 0) {
    return c.json({ message: "Resource not found" }, 404);
  }

  return c.body(null, 204);
});

const indexResourceRoute = createRoute({
  method: "post",
  path: "/api/resources/{id}/index",
  tags: ["Resources"],
  request: {
    params: ResourceParamsSchema,
  },
  responses: {
    202: {
      description: "Index job queued",
      content: {
        "application/json": {
          schema: IndexTriggerResponseSchema,
        },
      },
    },
    401: {
      description: "Unauthorized",
      content: {
        "application/json": {
          schema: ErrorSchema,
        },
      },
    },
    404: {
      description: "Resource not found",
      content: {
        "application/json": {
          schema: ErrorSchema,
        },
      },
    },
  },
});

resourcesRouter.openapi(indexResourceRoute, async (c) => {
  const user = c.get("user");
  if (isRemoteMode && !user) {
    return c.json({ message: "Unauthorized" }, 401);
  }

  const { id } = c.req.valid("param");
  const [resource] = await db
    .select({ id: resources.id })
    .from(resources)
    .where(and(ownerFilter(user), eq(resources.id, id)))
    .limit(1);

  if (!resource) {
    return c.json({ message: "Resource not found" }, 404);
  }

  const [job] = await db
    .insert(indexJobs)
    .values({
      resourceId: resource.id,
      status: "queued",
      jobType: "index",
      progress: 0,
      warnings: [],
    })
    .returning({
      id: indexJobs.id,
      resourceId: indexJobs.resourceId,
      status: indexJobs.status,
      jobType: indexJobs.jobType,
    });

  if (!job) {
    throw new Error("Failed to create index job");
  }

  ensureResourceJobQueue(
    resource.id,
    c.get("providerKeys"),
    c.get("modelConfig"),
  );

  return c.json(
    {
      jobId: job.id,
      resourceId: job.resourceId ?? resource.id,
      status: job.status ?? "queued",
      jobType: job.jobType ?? "index",
    },
    202,
  );
});

const syncResourceRoute = createRoute({
  method: "post",
  path: "/api/resources/{id}/sync",
  tags: ["Resources"],
  request: {
    params: ResourceParamsSchema,
  },
  responses: {
    202: {
      description: "Sync job queued",
      content: {
        "application/json": {
          schema: IndexTriggerResponseSchema,
        },
      },
    },
    401: {
      description: "Unauthorized",
      content: {
        "application/json": {
          schema: ErrorSchema,
        },
      },
    },
    404: {
      description: "Resource not found",
      content: {
        "application/json": {
          schema: ErrorSchema,
        },
      },
    },
  },
});

resourcesRouter.openapi(syncResourceRoute, async (c) => {
  const user = c.get("user");
  if (isRemoteMode && !user) {
    return c.json({ message: "Unauthorized" }, 401);
  }

  const { id } = c.req.valid("param");
  const [resource] = await db
    .select({ id: resources.id })
    .from(resources)
    .where(and(ownerFilter(user), eq(resources.id, id)))
    .limit(1);

  if (!resource) {
    return c.json({ message: "Resource not found" }, 404);
  }

  const [job] = await db
    .insert(indexJobs)
    .values({
      resourceId: resource.id,
      status: "queued",
      jobType: "sync",
      progress: 0,
      warnings: [],
    })
    .returning({
      id: indexJobs.id,
      resourceId: indexJobs.resourceId,
      status: indexJobs.status,
      jobType: indexJobs.jobType,
    });

  if (!job) {
    throw new Error("Failed to create sync job");
  }

  ensureResourceJobQueue(
    resource.id,
    c.get("providerKeys"),
    c.get("modelConfig"),
  );

  return c.json(
    {
      jobId: job.id,
      resourceId: job.resourceId ?? resource.id,
      status: job.status ?? "queued",
      jobType: job.jobType ?? "sync",
    },
    202,
  );
});

export { resourcesRouter };
