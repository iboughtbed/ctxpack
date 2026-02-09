import { z } from "@hono/zod-openapi";

export const ResourceTypeSchema = z.enum(["git", "local"]);
export const ResourceScopeSchema = z.enum(["project", "global"]);
export const ResourceListScopeSchema = z.enum(["project", "global", "all"]);

export const ResourceStatusSchema = z.enum([
  "pending",
  "indexing",
  "ready",
  "failed",
]);

export const ContentStatusSchema = z.enum([
  "missing",
  "syncing",
  "ready",
  "failed",
]);

export const VectorStatusSchema = z.enum([
  "missing",
  "indexing",
  "ready",
  "failed",
]);

export const IndexJobStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
]);

export const IndexJobTypeSchema = z.enum(["sync", "index"]);

export const ResourceSchema = z
  .object({
    id: z.uuid().openapi({
      description: "Resource ID (UUID)",
      example: "0f1b5b9f-61e4-4d3a-9a2e-9df4f2b7c1e1",
    }),
    userId: z.string().nullable().openapi({
      description: "Owner user ID",
      example: "user_123",
    }),
    name: z.string().openapi({
      description: "Resource name (unique per user)",
      example: "my-app",
    }),
    scope: ResourceScopeSchema.openapi({
      description: "Resource scope",
      example: "project",
    }),
    projectKey: z.string().nullable().openapi({
      description: "Project identifier when scope is project",
      example: "/home/user/my-project",
    }),
    type: ResourceTypeSchema.openapi({
      description: "Resource type",
      example: "git",
    }),
    url: z.string().nullable().openapi({
      description: "Git repository URL (required for git resources)",
      example: "https://github.com/acme/repo",
    }),
    path: z.string().nullable().openapi({
      description: "Local filesystem path (required for local resources)",
      example: "/data/repos/my-app",
    }),
    branch: z.string().nullable().openapi({
      description: "Git branch name",
      example: "main",
    }),
    commit: z.string().nullable().openapi({
      description: "Indexed commit SHA",
      example: "a1b2c3d",
    }),
    paths: z
      .array(z.string())
      .nullable()
      .openapi({
        description: "Optional paths filter for indexing",
        example: ["src/", "lib/"],
      }),
    notes: z.string().nullable().openapi({
      description: "Optional notes/description",
      example: "Main application",
    }),
    status: ResourceStatusSchema.openapi({
      description: "Indexing status",
      example: "ready",
    }),
    contentStatus: ContentStatusSchema.openapi({
      description: "Filesystem/text content materialization status",
      example: "ready",
    }),
    vectorStatus: VectorStatusSchema.openapi({
      description: "Vector indexing status",
      example: "ready",
    }),
    contentError: z.string().nullable().openapi({
      description: "Latest sync/content error",
      example: null,
    }),
    vectorError: z.string().nullable().openapi({
      description: "Latest vector indexing error",
      example: null,
    }),
    chunkCount: z.number().int().openapi({
      description: "Number of indexed chunks",
      example: 128,
    }),
    lastSyncedAt: z.iso.datetime().nullable().openapi({
      description: "Last successful content sync timestamp",
      example: "2026-02-08T18:35:00.000Z",
    }),
    lastIndexedAt: z.iso.datetime().nullable().openapi({
      description: "Last successful vector index timestamp",
      example: "2026-02-08T18:42:00.000Z",
    }),
    lastLocalCommit: z.string().nullable().openapi({
      description: "Last local git commit SHA seen for the resource",
      example: "c0ffee12cafe34f9aabbccddeeff001122334455",
    }),
    lastRemoteCommit: z.string().nullable().openapi({
      description: "Latest remote branch commit SHA from update checks",
      example: "d00dbeef1234567890abcdeffedcba0987654321",
    }),
    updateAvailable: z.boolean().openapi({
      description: "Whether remote git branch has updates available",
      example: false,
    }),
    lastUpdateCheckAt: z.iso.datetime().nullable().openapi({
      description: "Last background update-check timestamp",
      example: "2026-02-08T18:50:00.000Z",
    }),
    createdAt: z.iso.datetime().nullable().openapi({
      description: "Created timestamp (ISO 8601)",
      example: "2024-05-01T12:34:56.789Z",
    }),
    updatedAt: z.iso.datetime().nullable().openapi({
      description: "Last update timestamp (ISO 8601)",
      example: "2024-05-02T09:21:13.000Z",
    }),
  })
  .openapi({
    description: "Resource object",
  });

export const ResourceListSchema = z.array(ResourceSchema).openapi({
  description: "List of resources",
});

export const ResourceParamsSchema = z
  .object({
    id: z.uuid().openapi({
      description: "Resource ID (UUID)",
      param: { name: "id", in: "path" },
      example: "0f1b5b9f-61e4-4d3a-9a2e-9df4f2b7c1e1",
    }),
  })
  .openapi({
    description: "Path params for resource routes",
  });

export const ResourceCreateSchema = z
  .object({
    name: z.string().min(1).openapi({
      description: "Resource name (unique per user)",
      example: "my-app",
    }),
    scope: ResourceScopeSchema.default("project").openapi({
      description: "Resource scope",
      example: "project",
    }),
    projectKey: z.string().min(1).optional().openapi({
      description: "Project identifier when scope is project",
      example: "/home/user/my-project",
    }),
    type: ResourceTypeSchema.openapi({
      description: "Resource type",
      example: "git",
    }),
    url: z.url().optional().openapi({
      description: "Git repository URL (required for git resources)",
      example: "https://github.com/acme/repo",
    }),
    path: z.string().min(1).optional().openapi({
      description: "Local filesystem path (required for local resources)",
      example: "/data/repos/my-app",
    }),
    branch: z.string().min(1).optional().openapi({
      description: "Git branch name",
      example: "main",
    }),
    commit: z.string().min(1).optional().openapi({
      description: "Specific commit SHA to index",
      example: "a1b2c3d",
    }),
    paths: z
      .array(z.string())
      .optional()
      .openapi({
        description: "Optional paths filter for indexing",
        example: ["src/", "lib/"],
      }),
    notes: z.string().optional().openapi({
      description: "Optional notes/description",
      example: "Main application",
    }),
  })
  .superRefine((value, ctx) => {
    if (value.type === "git" && !value.url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "url is required when type is git",
        path: ["url"],
      });
    }

    if (value.type === "local" && !value.path) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "path is required when type is local",
        path: ["path"],
      });
    }

    if (value.scope === "project" && !value.projectKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "projectKey is required when scope is project",
        path: ["projectKey"],
      });
    }
  })
  .openapi({
    description: "Payload to create a resource",
  });

export const ResourceListQuerySchema = z
  .object({
    scope: ResourceListScopeSchema.optional().openapi({
      description: "Scope filter (defaults to all)",
      example: "project",
      param: { name: "scope", in: "query" },
    }),
    projectKey: z.string().optional().openapi({
      description: "Project identifier when scope=project",
      example: "/home/user/my-project",
      param: { name: "projectKey", in: "query" },
    }),
  })
  .superRefine((value, ctx) => {
    if (value.scope === "project" && !value.projectKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "projectKey is required when scope is project",
        path: ["projectKey"],
      });
    }
  })
  .openapi({
    description: "Query params for listing resources",
  });

export const ErrorSchema = z
  .object({
    message: z.string().openapi({
      description: "Error message",
      example: "Resource not found",
    }),
  })
  .openapi({
    description: "Error response",
  });

export const IndexTriggerResponseSchema = z
  .object({
    jobId: z.uuid().openapi({
      description: "Created index job ID",
      example: "a15c44ab-c9ec-4a55-a75a-6c0ca3d30ffd",
    }),
    resourceId: z.uuid().openapi({
      description: "Resource ID targeted for indexing",
      example: "0f1b5b9f-61e4-4d3a-9a2e-9df4f2b7c1e1",
    }),
    status: IndexJobStatusSchema.openapi({
      description: "Initial index job status",
      example: "queued",
    }),
    jobType: IndexJobTypeSchema.openapi({
      description: "Queued job type",
      example: "index",
    }),
  })
  .openapi({
    description: "Response returned when an indexing job is queued",
  });
