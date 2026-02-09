import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { and, eq, isNull } from "drizzle-orm";

import { db } from "@ctxpack/db";
import { indexJobs, resources } from "@ctxpack/db/schema";
import { isRemoteExecutionMode } from "@ctxpack/sandbox";

import type { Context } from "../context";
import { JobParamsSchema, JobSchema } from "./schemas/jobs";
import { ErrorSchema } from "./schemas/resources";

const jobsRouter = new OpenAPIHono<Context>();
const isRemoteMode = isRemoteExecutionMode();

const getJobRoute = createRoute({
  method: "get",
  path: "/api/jobs/{id}",
  tags: ["Jobs"],
  request: {
    params: JobParamsSchema,
  },
  responses: {
    200: {
      description: "Index job details",
      content: {
        "application/json": {
          schema: JobSchema,
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
      description: "Job not found",
      content: {
        "application/json": {
          schema: ErrorSchema,
        },
      },
    },
  },
});

jobsRouter.openapi(getJobRoute, async (c) => {
  const user = c.get("user");
  if (isRemoteMode && !user) {
    return c.json({ message: "Unauthorized" }, 401);
  }

  const { id } = c.req.valid("param");
  const resourceOwnerFilter = user
    ? eq(resources.userId, user.id)
    : isNull(resources.userId);
  const [row] = await db
    .select({
      id: indexJobs.id,
      resourceId: indexJobs.resourceId,
      status: indexJobs.status,
      jobType: indexJobs.jobType,
      progress: indexJobs.progress,
      error: indexJobs.error,
      warnings: indexJobs.warnings,
      totalFiles: indexJobs.totalFiles,
      processedFiles: indexJobs.processedFiles,
      startedAt: indexJobs.startedAt,
      completedAt: indexJobs.completedAt,
      createdAt: indexJobs.createdAt,
    })
    .from(indexJobs)
    .innerJoin(resources, eq(indexJobs.resourceId, resources.id))
    .where(and(eq(indexJobs.id, id), resourceOwnerFilter))
    .limit(1);

  if (!row || !row.resourceId) {
    return c.json({ message: "Job not found" }, 404);
  }

  return c.json(
    {
      id: row.id,
      resourceId: row.resourceId,
      status: row.status ?? "queued",
      jobType: row.jobType ?? "index",
      progress: row.progress ?? 0,
      error: row.error ?? null,
      warnings: Array.isArray(row.warnings) ? row.warnings : [],
      totalFiles: row.totalFiles ?? null,
      processedFiles: row.processedFiles ?? 0,
      startedAt: row.startedAt ? row.startedAt.toISOString() : null,
      completedAt: row.completedAt ? row.completedAt.toISOString() : null,
      createdAt: row.createdAt ? row.createdAt.toISOString() : null,
    },
    200,
  );
});

export { jobsRouter };
