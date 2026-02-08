import { z } from "@hono/zod-openapi";

export const JobStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
]);

export const JobTypeSchema = z.enum(["sync", "index"]);

export const JobWarningSchema = z
  .object({
    filepath: z.string().openapi({
      description: "File path associated with the warning",
      example: "src/index.ts",
    }),
    stage: z.enum(["scan", "read", "chunk", "embed", "sync", "remote-check"]).openapi({
      description: "Indexing stage that produced this warning",
      example: "read",
    }),
    message: z.string().openapi({
      description: "Warning details",
      example: "Skipped binary file",
    }),
  })
  .openapi({
    description: "Job warning entry",
  });

export const JobParamsSchema = z
  .object({
    id: z.uuid().openapi({
      description: "Index job ID",
      param: { name: "id", in: "path" },
      example: "a15c44ab-c9ec-4a55-a75a-6c0ca3d30ffd",
    }),
  })
  .openapi({
    description: "Path params for jobs route",
  });

export const JobSchema = z
  .object({
    id: z.uuid().openapi({
      description: "Index job ID",
      example: "a15c44ab-c9ec-4a55-a75a-6c0ca3d30ffd",
    }),
    resourceId: z.uuid().openapi({
      description: "Resource ID",
      example: "0f1b5b9f-61e4-4d3a-9a2e-9df4f2b7c1e1",
    }),
    status: JobStatusSchema.openapi({
      description: "Current job status",
      example: "running",
    }),
    jobType: JobTypeSchema.openapi({
      description: "Job kind",
      example: "index",
    }),
    progress: z.number().int().openapi({
      description: "Progress percentage (0-100)",
      example: 67,
    }),
    error: z.string().nullable().openapi({
      description: "Error details for failed jobs",
      example: null,
    }),
    warnings: z.array(JobWarningSchema).openapi({
      description: "Non-fatal warnings captured during indexing",
      example: [],
    }),
    totalFiles: z.number().int().nullable().openapi({
      description: "Total number of discovered files for the job",
      example: 140,
    }),
    processedFiles: z.number().int().openapi({
      description: "Processed files count",
      example: 140,
    }),
    startedAt: z.iso.datetime().nullable().openapi({
      description: "Job start timestamp (ISO 8601)",
      example: "2026-02-06T10:45:00.000Z",
    }),
    completedAt: z.iso.datetime().nullable().openapi({
      description: "Job completion timestamp (ISO 8601)",
      example: "2026-02-06T10:46:10.000Z",
    }),
    createdAt: z.iso.datetime().nullable().openapi({
      description: "Job creation timestamp (ISO 8601)",
      example: "2026-02-06T10:44:59.500Z",
    }),
  })
  .openapi({
    description: "Indexing job details",
  });
