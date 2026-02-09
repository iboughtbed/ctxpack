import { z } from "@hono/zod-openapi";

/* ------------------------------------------------------------------ */
/*  Grep                                                               */
/* ------------------------------------------------------------------ */

export const ToolGrepRequestSchema = z
  .object({
    resourceId: z.uuid().openapi({
      description: "Resource ID to search in",
      example: "0f1b5b9f-61e4-4d3a-9a2e-9df4f2b7c1e1",
    }),
    pattern: z.string().min(1).openapi({
      description: "Search pattern (regex or fixed string)",
      example: "export function",
    }),
    paths: z
      .array(z.string())
      .optional()
      .openapi({
        description: "Optional subdirectory paths to scope the search",
        example: ["src"],
      }),
    caseSensitive: z.boolean().optional().openapi({
      description: "Case-sensitive search (default false)",
      example: false,
    }),
    fixedStrings: z.boolean().optional().openapi({
      description: "Treat pattern as literal string, not regex (default true)",
      example: true,
    }),
  })
  .openapi({ description: "Grep tool request" });

export const GrepMatchSchema = z
  .object({
    filepath: z.string().openapi({ description: "Matched file path" }),
    line: z.number().int().openapi({ description: "Matched line number" }),
    text: z.string().openapi({ description: "Matched line content" }),
  })
  .openapi({ description: "A single grep match" });

export const ToolGrepResponseSchema = z
  .object({
    matches: z.array(GrepMatchSchema).openapi({
      description: "Grep matches",
    }),
  })
  .openapi({ description: "Grep tool response" });

/* ------------------------------------------------------------------ */
/*  Read                                                               */
/* ------------------------------------------------------------------ */

export const ToolReadRequestSchema = z
  .object({
    resourceId: z.uuid().openapi({
      description: "Resource ID to read from",
      example: "0f1b5b9f-61e4-4d3a-9a2e-9df4f2b7c1e1",
    }),
    filepath: z.string().min(1).openapi({
      description: "File path relative to the resource root",
      example: "src/index.ts",
    }),
    startLine: z.number().int().min(1).optional().openapi({
      description: "Start line (1-indexed, inclusive)",
      example: 1,
    }),
    endLine: z.number().int().min(1).optional().openapi({
      description: "End line (1-indexed, inclusive)",
      example: 50,
    }),
  })
  .openapi({ description: "Read tool request" });

export const ToolReadResponseSchema = z
  .object({
    filepath: z.string().openapi({ description: "File path" }),
    content: z.string().openapi({ description: "File content" }),
    totalLines: z
      .number()
      .int()
      .openapi({ description: "Total lines in file" }),
  })
  .openapi({ description: "Read tool response" });

/* ------------------------------------------------------------------ */
/*  List                                                               */
/* ------------------------------------------------------------------ */

export const ToolListRequestSchema = z
  .object({
    resourceId: z.uuid().openapi({
      description: "Resource ID to list files in",
      example: "0f1b5b9f-61e4-4d3a-9a2e-9df4f2b7c1e1",
    }),
    path: z.string().optional().openapi({
      description: "Subdirectory path to list (default: root)",
      example: "src",
    }),
  })
  .openapi({ description: "List tool request" });

export const ToolListResponseSchema = z
  .object({
    files: z.array(z.string()).openapi({
      description: "List of file paths",
    }),
  })
  .openapi({ description: "List tool response" });

/* ------------------------------------------------------------------ */
/*  Glob                                                               */
/* ------------------------------------------------------------------ */

export const ToolGlobRequestSchema = z
  .object({
    resourceId: z.uuid().openapi({
      description: "Resource ID to search in",
      example: "0f1b5b9f-61e4-4d3a-9a2e-9df4f2b7c1e1",
    }),
    pattern: z.string().min(1).openapi({
      description: "Glob pattern to match files",
      example: "**/*.ts",
    }),
  })
  .openapi({ description: "Glob tool request" });

export const ToolGlobResponseSchema = z
  .object({
    files: z.array(z.string()).openapi({
      description: "Matched file paths",
    }),
  })
  .openapi({ description: "Glob tool response" });
